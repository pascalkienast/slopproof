import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { SlopProofDatabase } from "./client";
import { expediteJobInTransaction } from "./jobs";
import { auditEvents, recordingObjects, uploadSessions } from "./schema";

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
    const authorization = await transaction.execute<{
      delete_after: Date;
    }>(sql`
      SELECT attempt.evidence_delete_after AS delete_after
        FROM attempts attempt
        JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
        JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
          AND pull_request.repository_id = attempt.repository_id
        JOIN repositories repository ON repository.id = attempt.repository_id
        JOIN installations installation ON installation.id = repository.installation_id
        JOIN upload_sessions upload ON upload.id = ${input.uploadSessionId}
          AND upload.attempt_id = attempt.id
          AND upload.object_key = ${input.objectKey}
        JOIN wrapping_materials material ON material.id = ${input.wrappingMaterialId}
          AND material.attempt_id = attempt.id
          AND material.object_id = upload.object_id
       WHERE attempt.id = ${input.attemptId}
         AND attempt.status = 'processing'
         AND attempt.head_sha = ${input.expectedHeadSha}
         AND revision.is_current = true
         AND pull_request.state = 'open'
         AND repository.status = 'active'
         AND installation.status = 'active'
         AND attempt.evidence_delete_after > clock_timestamp()
         AND upload.state IN ('pending_finalization', 'completed')
         AND upload.manifest_digest = ${input.manifestHash}
         AND upload.finalize_envelope IS NOT NULL
       FOR UPDATE OF attempt, revision, pull_request, repository, installation,
                     upload, material
    `);
    const deleteAfter = authorization.rows[0]?.delete_after;
    if (!deleteAfter) {
      throw new Error("Validated recording is no longer authorized");
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
    const created = inserted[0]?.id !== undefined;
    let recordingObjectId = inserted[0]?.id;
    if (!recordingObjectId) {
      const existing = await transaction
        .select({
          id: recordingObjects.id,
          objectKey: recordingObjects.objectKey,
          wrappedDataKey: recordingObjects.wrappedDataKey,
          wrappedKeySha256: recordingObjects.wrappedKeySha256,
          wrappingMaterialId: recordingObjects.wrappingMaterialId,
          protocolVersion: recordingObjects.protocolVersion,
          algorithm: recordingObjects.algorithm,
          byteLength: recordingObjects.byteLength,
          durationMs: recordingObjects.durationMs,
          codec: recordingObjects.codec,
          manifestHash: recordingObjects.manifestHash,
          deleteAfter: recordingObjects.deleteAfter,
          deletedAt: recordingObjects.deletedAt,
        })
        .from(recordingObjects)
        .where(eq(recordingObjects.attemptId, input.attemptId))
        .limit(1);
      const exact = existing[0];
      if (
        exact?.objectKey !== input.objectKey ||
        exact.wrappedDataKey !== input.wrappedDataKey ||
        exact.wrappedKeySha256 !== input.wrappedKeySha256 ||
        exact.wrappingMaterialId !== input.wrappingMaterialId ||
        exact.protocolVersion !== input.protocolVersion ||
        exact.algorithm !== input.algorithm ||
        exact.byteLength !== input.byteLength ||
        exact.durationMs !== input.durationMs ||
        exact.codec !== input.codec ||
        exact.manifestHash !== input.manifestHash ||
        exact.deleteAfter.getTime() !== deleteAfter.getTime() ||
        exact.deletedAt !== null
      ) {
        throw new Error("Validated recording replay conflicts with storage");
      }
      recordingObjectId = exact.id;
    }
    if (!recordingObjectId) {
      throw new Error("Validated recording was not persisted");
    }
    await transaction
      .update(uploadSessions)
      .set({ state: "completed", updatedAt: new Date() })
      .where(eq(uploadSessions.id, input.uploadSessionId));
    if (created) {
      await transaction.insert(auditEvents).values({
        actorId: "worker",
        action: "evidence.validated",
        objectType: "attempt",
        objectId: input.attemptId,
        metadata: { protocol: input.protocolVersion },
      });
    }
    await expediteJobInTransaction(
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
