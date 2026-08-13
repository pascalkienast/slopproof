import type { PgBoss } from "pg-boss";
import { and, eq, sql } from "drizzle-orm";
import type { SlopProofDatabase } from "./client";
import { expediteJobInTransaction } from "./jobs";
import {
  attemptTransitions,
  attempts,
  installations,
  pullRequests,
  pullRequestRevisions,
  repositories,
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
    questionIntervals?: readonly {
      schemaVersion: "1";
      intervalVersion: "proof-question-interval-v1";
      questionId: string;
      ordinal: number;
      startMs: number;
      endMs: number;
      recordedDurationMs: number;
      source: "mobile_navigation_v1";
    }[];
    recordingDurationMs?: number;
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
        pullRequestState: pullRequests.state,
        repositoryStatus: repositories.status,
        installationStatus: installations.status,
      })
      .from(uploadSessions)
      .innerJoin(attempts, eq(attempts.id, uploadSessions.attemptId))
      .innerJoin(
        pullRequestRevisions,
        eq(pullRequestRevisions.id, attempts.revisionId),
      )
      .innerJoin(
        pullRequests,
        eq(pullRequests.id, pullRequestRevisions.pullRequestId),
      )
      .innerJoin(repositories, eq(repositories.id, attempts.repositoryId))
      .innerJoin(
        installations,
        eq(installations.id, repositories.installationId),
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
      row.pullRequestState !== "open" ||
      row.repositoryStatus !== "active" ||
      row.installationStatus !== "active" ||
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
      const exactIntervals = await transaction.execute<{ exact: boolean }>(
        input.questionIntervals === undefined
          ? sql`SELECT NOT EXISTS (
                  SELECT 1 FROM proof_question_interval_sets
                   WHERE attempt_id = ${input.attemptId}
                ) AS exact`
          : sql`SELECT EXISTS (
                  SELECT 1 FROM proof_question_interval_sets
                   WHERE attempt_id = ${input.attemptId}
                     AND upload_session_id = ${input.uploadSessionId}
                     AND manifest_digest = ${input.manifestDigest}
                     AND recorded_duration_ms = ${input.recordingDurationMs ?? -1}
                     AND intervals = ${JSON.stringify(input.questionIntervals)}::jsonb
                ) AS exact`,
      );
      if (exactIntervals.rows[0]?.exact !== true) {
        throw new UploadFinalizationConflictError();
      }
      await expediteJobInTransaction(
        queue,
        transaction,
        "media.finalize-upload",
        {
          schemaVersion: "1",
          idempotencyKey: `media-finalize:${input.manifestDigest}`,
          attemptId: input.attemptId,
          uploadSessionId: input.uploadSessionId,
          expectedHeadSha: input.expectedHeadSha,
        },
      );
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
    if (input.questionIntervals !== undefined) {
      if (
        input.recordingDurationMs === undefined ||
        input.questionIntervals.length === 0
      ) {
        throw new UploadFinalizationConflictError();
      }
      await transaction.execute(
        sql`INSERT INTO proof_question_interval_sets
              (attempt_id, upload_session_id, manifest_digest,
               interval_version, maximum_question_duration_ms,
               recorded_duration_ms, intervals)
            VALUES (
              ${input.attemptId}, ${input.uploadSessionId},
              ${input.manifestDigest}, 'proof-question-interval-v1', 120000,
              ${input.recordingDurationMs},
              ${JSON.stringify(input.questionIntervals)}::jsonb
            )`,
      );
    }
    await expediteJobInTransaction(
      queue,
      transaction,
      "media.finalize-upload",
      {
        schemaVersion: "1",
        idempotencyKey: `media-finalize:${input.manifestDigest}`,
        attemptId: input.attemptId,
        uploadSessionId: input.uploadSessionId,
        expectedHeadSha: input.expectedHeadSha,
      },
    );
    return { replay: false };
  });
}
