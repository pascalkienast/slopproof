import type { PgBoss } from "pg-boss";
import { and, eq } from "drizzle-orm";
import type { SlopProofDatabase } from "./client";
import { enqueueJobInTransaction } from "./jobs";
import {
  attemptTransitions,
  attempts,
  pullRequestRevisions,
  uploadSessions,
} from "./schema";

export class UploadFinalizationConflictError extends Error {
  readonly code = "UPLOAD_FINALIZATION_CONFLICT" as const;
}

export async function persistPendingUploadFinalization(
  database: SlopProofDatabase,
  queue: PgBoss,
  input: {
    uploadSessionId: string;
    attemptId: string;
    expectedHeadSha: string;
    manifestDigest: string;
    finalizeEnvelope: Record<string, unknown>;
    actorId: string;
    idempotencyKey: string;
    evidenceDeleteAfter: Date;
  },
): Promise<{ replay: boolean }> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select({
        uploadState: uploadSessions.state,
        uploadExpiresAt: uploadSessions.expiresAt,
        storedDigest: uploadSessions.manifestDigest,
        attemptId: attempts.id,
        attemptStatus: attempts.status,
        evidenceDeleteAfter: attempts.evidenceDeleteAfter,
        headSha: attempts.headSha,
        isCurrent: pullRequestRevisions.isCurrent,
      })
      .from(uploadSessions)
      .innerJoin(attempts, eq(attempts.id, uploadSessions.attemptId))
      .innerJoin(
        pullRequestRevisions,
        eq(pullRequestRevisions.id, attempts.revisionId),
      )
      .where(
        and(
          eq(uploadSessions.id, input.uploadSessionId),
          eq(attempts.id, input.attemptId),
        ),
      )
      .for("update");
    const row = rows[0];
    if (
      !row ||
      row.headSha !== input.expectedHeadSha ||
      !row.isCurrent ||
      row.uploadExpiresAt <= new Date()
    ) {
      throw new UploadFinalizationConflictError();
    }
    if (
      row.uploadState === "pending_finalization" &&
      row.storedDigest === input.manifestDigest &&
      row.attemptStatus === "processing" &&
      row.evidenceDeleteAfter !== null
    ) {
      return { replay: true };
    }
    if (
      row.uploadState !== "active" ||
      row.attemptStatus !== "uploading" ||
      row.evidenceDeleteAfter !== null ||
      !Number.isFinite(input.evidenceDeleteAfter.getTime()) ||
      input.evidenceDeleteAfter <= new Date()
    ) {
      throw new UploadFinalizationConflictError();
    }

    await transaction
      .update(uploadSessions)
      .set({
        state: "pending_finalization",
        manifestDigest: input.manifestDigest,
        finalizeEnvelope: input.finalizeEnvelope,
        updatedAt: new Date(),
      })
      .where(eq(uploadSessions.id, input.uploadSessionId));
    await transaction
      .insert(attemptTransitions)
      .values({
        attemptId: input.attemptId,
        idempotencyKey: input.idempotencyKey,
        fromStatus: "uploading",
        toStatus: "processing",
        expectedHeadSha: input.expectedHeadSha,
        currentHeadSha: input.expectedHeadSha,
        actorId: input.actorId,
        actorRole: "author",
        occurredAt: new Date(),
      })
      .onConflictDoNothing();
    await transaction
      .update(attempts)
      .set({
        status: "processing",
        evidenceDeleteAfter: input.evidenceDeleteAfter,
        updatedAt: new Date(),
      })
      .where(eq(attempts.id, input.attemptId));
    await enqueueJobInTransaction(queue, transaction, "media.finalize-upload", {
      schemaVersion: "1",
      idempotencyKey: `media-finalize:${input.manifestDigest}`,
      attemptId: input.attemptId,
      uploadSessionId: input.uploadSessionId,
      expectedHeadSha: input.expectedHeadSha,
    });
    return { replay: false };
  });
}
