import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { SlopProofDatabase } from "./client";
import { enqueueJobInTransaction } from "./jobs";
import {
  attempts,
  auditEvents,
  recordingObjects,
  uploadSessions,
} from "./schema";

export async function persistValidatedRecording(
  database: SlopProofDatabase,
  queue: PgBoss,
  input: {
    recordingObjectId: string;
    uploadSessionId: string;
    attemptId: string;
    expectedHeadSha: string;
    objectKey: string;
    wrappedDataKey: string;
    wrappedKeySha256: string;
    wrappingMaterialId: string;
    protocolVersion: string;
    algorithm: string;
    byteLength: number;
    durationMs: number;
    codec: string;
    manifestHash: string;
  },
): Promise<string> {
  return database.transaction(async (transaction) => {
    const deadline = await transaction
      .select({ deleteAfter: attempts.evidenceDeleteAfter })
      .from(attempts)
      .where(eq(attempts.id, input.attemptId))
      .limit(1);
    const deleteAfter = deadline[0]?.deleteAfter;
    if (!deleteAfter) {
      throw new Error("Accepted evidence deadline is missing");
    }
    const inserted = await transaction
      .insert(recordingObjects)
      .values({
        id: input.recordingObjectId,
        attemptId: input.attemptId,
        objectKey: input.objectKey,
        wrappedDataKey: input.wrappedDataKey,
        wrappedKeySha256: input.wrappedKeySha256,
        wrappingMaterialId: input.wrappingMaterialId,
        protocolVersion: input.protocolVersion,
        algorithm: input.algorithm,
        byteLength: input.byteLength,
        durationMs: input.durationMs,
        codec: input.codec,
        manifestHash: input.manifestHash,
        deleteAfter,
      })
      .onConflictDoNothing({ target: recordingObjects.attemptId })
      .returning({ id: recordingObjects.id });
    let recordingObjectId = inserted[0]?.id;
    if (!recordingObjectId) {
      const existing = await transaction
        .select({ id: recordingObjects.id })
        .from(recordingObjects)
        .where(eq(recordingObjects.attemptId, input.attemptId))
        .limit(1);
      recordingObjectId = existing[0]?.id;
    }
    if (!recordingObjectId) {
      throw new Error("Validated recording was not persisted");
    }
    await transaction
      .update(uploadSessions)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(uploadSessions.id, input.uploadSessionId));
    await transaction.insert(auditEvents).values({
      actorId: "worker",
      action: "evidence.validated",
      objectType: "attempt",
      objectId: input.attemptId,
      metadata: { protocol: input.protocolVersion },
    });
    await enqueueJobInTransaction(
      queue,
      transaction,
      "media.extract-transcript",
      {
        schemaVersion: "1",
        idempotencyKey: `media-transcript:${input.manifestHash}`,
        attemptId: input.attemptId,
        recordingObjectId,
        expectedHeadSha: input.expectedHeadSha,
      },
    );
    return recordingObjectId;
  });
}
