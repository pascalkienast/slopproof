import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import {
  FinalizeRecordingSchema,
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
  verifyProviderPartList,
  type RecordingManifest,
} from "@slopproof/media";
import {
  RepositoryPolicyV1Schema,
  resolveEffectiveRecordingLimits,
  type EffectiveRecordingLimits,
} from "@slopproof/policy";
import {
  persistValidatedRecording,
  type DatabaseConnection,
  type JobPayload,
} from "@slopproof/db";
import { TECHNICAL_RETRY_GITHUB_CHECK } from "@slopproof/github";
import type { S3EvidenceStore } from "@slopproof/storage";
import type { PgBoss } from "pg-boss";
import {
  authenticateRecordingFinalization,
  streamDecryptedRecording,
} from "./recording-reader";
import type { CheckIntentWriter } from "./revision-preparation";

export type MediaFinalizerDependencies = {
  database: DatabaseConnection;
  queue: PgBoss;
  checkIntents: CheckIntentWriter;
  storage: S3EvidenceStore;
  privateKeyPath: string;
  ffprobePath: string;
};

export type MediaFinalizationFailureDependencies = Pick<
  MediaFinalizerDependencies,
  "checkIntents" | "database" | "storage"
>;

export type MediaFinalizationStage =
  | "authenticate"
  | "provider_parts"
  | "complete_upload"
  | "verify_object"
  | "open_object"
  | "decrypt_and_probe"
  | "persist_recording";

export type MediaFinalizationRow = {
  upload_session_id: string;
  upload_state: string;
  provider_upload_id: string;
  object_key: string;
  object_id: string;
  finalize_envelope: unknown;
  attempt_id: string;
  attempt_status: string;
  revision_id: string;
  head_sha: string;
  is_current: boolean;
  pull_request_state: string;
  repository_status: string;
  installation_status: string;
  material_id: string;
  key_id: string;
  evidence_delete_after: Date | null;
  policy: unknown;
};

export async function finalizeMediaUpload(
  rawJob: JobPayload<"media.finalize-upload">,
  dependencies: MediaFinalizerDependencies,
): Promise<void> {
  const row = await loadFinalization(rawJob, dependencies.database);
  const finalization = FinalizeRecordingSchema.parse(row.finalize_envelope);
  const manifest = finalization.manifest;
  const limits = assertBinding(rawJob, row, manifest);

  let completedObject = row.upload_state === "completed";
  let stage: MediaFinalizationStage = "authenticate";
  try {
    const encryptionKey = await authenticateRecordingFinalization(
      finalization,
      {
        materialId: row.material_id,
        keyId: row.key_id,
      },
      dependencies.privateKeyPath,
    );

    if (!completedObject) {
      let providerParts;
      try {
        stage = "provider_parts";
        providerParts = await dependencies.storage.listParts(
          row.object_key,
          row.provider_upload_id,
        );
      } catch {
        const existing = await dependencies.storage.headObject(row.object_key);
        if (existing.byteLength !== manifest.totalObjectBytes)
          throw new Error("object size mismatch");
        completedObject = true;
      }
      if (providerParts) {
        verifyProviderPartList(
          manifest.parts,
          finalization.uploadedParts,
          providerParts,
        );
        stage = "complete_upload";
        await dependencies.storage.completeMultipartUpload({
          objectKey: row.object_key,
          uploadId: row.provider_upload_id,
          parts: finalization.uploadedParts,
        });
        completedObject = true;
      }
    }

    stage = "verify_object";
    const head = await dependencies.storage.headObject(row.object_key);
    if (head.byteLength !== manifest.totalObjectBytes) {
      throw new Error("completed object size mismatch");
    }
    stage = "open_object";
    const objectStream = await dependencies.storage.getObjectStream(
      row.object_key,
    );
    stage = "decrypt_and_probe";
    const media = await validateAndDecryptToFfprobe(
      objectStream,
      manifest,
      encryptionKey,
      dependencies.ffprobePath,
    );
    if (media.durationMs > limits.maximumDurationMs) {
      throw new Error("recording exceeds the frozen repository duration limit");
    }
    stage = "persist_recording";
    await persistRecordingAndQueueProviderWork(
      row,
      finalization,
      media,
      dependencies,
    );
  } catch (error) {
    await recordMediaFinalizationFailure(
      row,
      completedObject,
      error,
      dependencies,
      stage,
    );
  }
}

async function loadFinalization(
  job: JobPayload<"media.finalize-upload">,
  database: DatabaseConnection,
): Promise<MediaFinalizationRow> {
  const result = await database.pool.query<MediaFinalizationRow>(
    `SELECT upload.id AS upload_session_id, upload.state AS upload_state,
            upload.provider_upload_id, upload.object_key, upload.object_id,
            upload.finalize_envelope, attempt.id AS attempt_id,
            attempt.status AS attempt_status, attempt.revision_id,
            attempt.head_sha,
            attempt.evidence_delete_after, revision.is_current,
            pull_request.state AS pull_request_state,
            repository.status AS repository_status,
            installation.status AS installation_status,
            material.id AS material_id, material.key_id,
            repository_policy.policy
     FROM upload_sessions upload
     JOIN attempts attempt ON attempt.id = upload.attempt_id
     JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
     JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
       AND pull_request.repository_id = attempt.repository_id
     JOIN repositories repository ON repository.id = attempt.repository_id
     JOIN installations installation ON installation.id = repository.installation_id
     JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
     JOIN repository_policies repository_policy
       ON repository_policy.id = proof_plan.repository_policy_id
     JOIN wrapping_materials material
       ON material.attempt_id = attempt.id AND material.object_id = upload.object_id
     WHERE upload.id = $1 AND attempt.id = $2`,
    [job.uploadSessionId, job.attemptId],
  );
  const row = result.rows[0];
  if (!row || row.finalize_envelope === null)
    throw new Error("pending finalization not found");
  return row;
}

function assertBinding(
  job: JobPayload<"media.finalize-upload">,
  row: MediaFinalizationRow,
  manifest: RecordingManifest,
): EffectiveRecordingLimits {
  const limits = assertFrozenMediaLimits(row, manifest);
  if (
    row.attempt_status !== "processing" ||
    !row.is_current ||
    row.pull_request_state !== "open" ||
    row.repository_status !== "active" ||
    row.installation_status !== "active" ||
    row.evidence_delete_after === null ||
    row.evidence_delete_after <= new Date() ||
    row.head_sha !== job.expectedHeadSha ||
    manifest.attemptId !== row.attempt_id ||
    manifest.headSha !== row.head_sha ||
    manifest.objectId !== row.object_id ||
    manifest.wrapping.materialId !== row.material_id ||
    manifest.wrapping.keyId !== row.key_id
  ) {
    throw new Error("finalization binding no longer authorizes processing");
  }
  return limits;
}

export function assertFrozenMediaLimits(
  row: Pick<MediaFinalizationRow, "policy" | "evidence_delete_after">,
  manifest: Pick<RecordingManifest, "durationMs" | "totalObjectBytes">,
): EffectiveRecordingLimits {
  const limits = resolveEffectiveRecordingLimits(
    RepositoryPolicyV1Schema.parse(row.policy),
    {
      maximumDurationMs: MAX_RECORDING_DURATION_MS,
      maximumUploadBytes: MAX_RECORDING_OBJECT_BYTES,
    },
  );
  if (
    row.evidence_delete_after === null ||
    manifest.durationMs > limits.maximumDurationMs ||
    manifest.totalObjectBytes > limits.maximumUploadBytes
  ) {
    throw new Error("finalization exceeds frozen repository policy");
  }
  return limits;
}

async function validateAndDecryptToFfprobe(
  stream: ReadableStream<Uint8Array>,
  manifest: RecordingManifest,
  encryptionKey: CryptoKey,
  ffprobePath: string,
): Promise<{ durationMs: number; videoCodec: string; audioCodec: string }> {
  const probe = startFfprobe(ffprobePath);
  return runFfprobePipeline(
    async (onPlaintext) =>
      streamDecryptedRecording(stream, manifest, encryptionKey, onPlaintext),
    probe,
  );
}

export type FfprobeMetadata = {
  durationMs: number;
  videoCodec: string;
  audioCodec: string;
};

const MAX_FFPROBE_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_FFPROBE_PACKETS = 100_000;

export type FfprobeHandle = {
  child: Pick<ReturnType<typeof spawn>, "kill">;
  stdin: Writable;
  result: Promise<FfprobeMetadata>;
};

/**
 * Observes the probe result immediately. If streaming fails first, killing the
 * child can reject that promise asynchronously; awaiting the captured outcome
 * prevents it from becoming an unhandled process-level rejection.
 */
export async function runFfprobePipeline(
  writePlaintext: (
    onPlaintext: (bytes: Uint8Array) => Promise<void>,
  ) => Promise<void>,
  probe: FfprobeHandle,
): Promise<FfprobeMetadata> {
  let stdinError: unknown;
  const onStdinError = (error: unknown) => {
    stdinError ??= error;
  };
  probe.stdin.on("error", onStdinError);
  const probeOutcome = probe.result.then(
    (value) => ({ status: "fulfilled", value }) as const,
    (error: unknown) => ({ status: "rejected", error }) as const,
  );
  try {
    await writePlaintext(async (plaintext) => {
      await writeAll(probe.stdin, plaintext);
    });
    probe.stdin.end();
    const outcome = await probeOutcome;
    if (outcome.status === "rejected") throw outcome.error;
    if (stdinError) throw stdinError;
    return outcome.value;
  } catch (error) {
    probe.child.kill("SIGKILL");
    await probeOutcome;
    throw error;
  } finally {
    probe.stdin.off("error", onStdinError);
  }
}

export function buildFfprobeArguments(): string[] {
  return [
    "-v",
    "error",
    "-cpucount",
    "1",
    "-max_alloc",
    "134217728",
    "-probesize",
    "16777216",
    "-analyzeduration",
    "30000000",
    "-threads",
    "1",
    "-protocol_whitelist",
    "pipe",
    "-show_entries",
    "format=format_name:stream=codec_type,codec_name:packet=pts_time,duration_time",
    "-of",
    "compact=p=1:nk=0",
    "pipe:0",
  ];
}

export function parseFfprobeCompactOutput(output: string): FfprobeMetadata {
  if (Buffer.byteLength(output, "utf8") > MAX_FFPROBE_OUTPUT_BYTES) {
    throw new Error("ffprobe packet metadata exceeded its byte limit");
  }
  const streams: {
    codecType: string | undefined;
    codecName: string | undefined;
  }[] = [];
  let formatName: string | undefined;
  let packetCount = 0;
  let maximumPacketEndSeconds = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [section, ...rawFields] = line.split("|");
    const fields = new Map<string, string>();
    for (const rawField of rawFields) {
      const separator = rawField.indexOf("=");
      if (separator <= 0) continue;
      fields.set(rawField.slice(0, separator), rawField.slice(separator + 1));
    }
    if (section === "packet") {
      packetCount += 1;
      if (packetCount > MAX_FFPROBE_PACKETS) {
        throw new Error("ffprobe packet count exceeded its limit");
      }
      const ptsSeconds = Number(fields.get("pts_time"));
      const durationSeconds = Number(fields.get("duration_time"));
      if (Number.isFinite(ptsSeconds)) {
        maximumPacketEndSeconds = Math.max(
          maximumPacketEndSeconds,
          ptsSeconds +
            (Number.isFinite(durationSeconds) && durationSeconds > 0
              ? durationSeconds
              : 0),
        );
      }
      continue;
    }
    if (section === "stream") {
      streams.push({
        codecType: fields.get("codec_type"),
        codecName: fields.get("codec_name"),
      });
      continue;
    }
    if (section === "format") formatName = fields.get("format_name");
  }
  const videoStreams = streams.filter((stream) => stream.codecType === "video");
  const audioStreams = streams.filter((stream) => stream.codecType === "audio");
  if (
    packetCount === 0 ||
    !Number.isFinite(maximumPacketEndSeconds) ||
    maximumPacketEndSeconds <= 0 ||
    maximumPacketEndSeconds * 1_000 > MAX_RECORDING_DURATION_MS ||
    streams.length !== 2 ||
    videoStreams.length !== 1 ||
    videoStreams[0]?.codecName !== "vp8" ||
    audioStreams.length !== 1 ||
    audioStreams[0]?.codecName !== "opus" ||
    !formatName
      ?.split(",")
      .some((name) => name === "matroska" || name === "webm")
  ) {
    throw new Error(
      "ffprobe metadata does not match the supported recording profile",
    );
  }
  return {
    durationMs: Math.round(maximumPacketEndSeconds * 1_000),
    videoCodec: "vp8",
    audioCodec: "opus",
  };
}

function startFfprobe(path: string): FfprobeHandle {
  const child = spawn(path, buildFfprobeArguments(), {
    stdio: "pipe",
    env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", LANG: "C" },
  });
  let stdout = "";
  let stdoutBytes = 0;
  let stdoutTooLarge = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (stdoutTooLarge || stdoutBytes + chunkBytes > MAX_FFPROBE_OUTPUT_BYTES) {
      stdoutTooLarge = true;
      child.kill("SIGKILL");
      return;
    }
    stdoutBytes += chunkBytes;
    stdout += chunk;
  });
  child.stderr.resume();
  const result = new Promise<{
    durationMs: number;
    videoCodec: string;
    audioCodec: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (stdoutTooLarge || code !== 0) {
        reject(
          new Error(
            stdoutTooLarge
              ? "ffprobe packet metadata exceeded its byte limit"
              : `ffprobe rejected media with exit code ${String(code)}`,
          ),
        );
        return;
      }
      try {
        resolve(parseFfprobeCompactOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
  return { child, stdin: child.stdin, result };
}

async function writeAll(stream: Writable, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

async function persistRecordingAndQueueProviderWork(
  row: MediaFinalizationRow,
  finalization: ReturnType<typeof FinalizeRecordingSchema.parse>,
  media: { durationMs: number },
  dependencies: MediaFinalizerDependencies,
): Promise<void> {
  const recordingObjectId = randomUUID();
  await persistValidatedRecording(
    dependencies.database.db,
    dependencies.queue,
    {
      recordingObjectId,
      uploadSessionId: row.upload_session_id,
      attemptId: row.attempt_id,
      expectedHeadSha: row.head_sha,
      objectKey: row.object_key,
      wrappedDataKey: finalization.wrappedKey.wrappedKeyBase64url,
      wrappedKeySha256: finalization.wrappedKey.wrappedKeySha256,
      wrappingMaterialId: row.material_id,
      protocolVersion: "SP-RC1",
      algorithm: "AES-256-GCM",
      byteLength: finalization.manifest.totalObjectBytes,
      durationMs: media.durationMs,
      codec: finalization.manifest.codec,
      manifestHash: finalization.manifestDigest,
    },
  );
}

export async function recordMediaFinalizationFailure(
  row: MediaFinalizationRow,
  completedObject: boolean,
  error: unknown,
  dependencies: MediaFinalizationFailureDependencies,
  stage: MediaFinalizationStage = "decrypt_and_probe",
): Promise<void> {
  if (completedObject) {
    await dependencies.storage
      .deleteObject(row.object_key)
      .catch(() => undefined);
  } else {
    await dependencies.storage
      .abortMultipartUpload(row.object_key, row.provider_upload_id)
      .catch(() => undefined);
  }
  const errorClass = error instanceof Error ? error.name : "UnknownError";
  const client = await dependencies.database.pool.connect();
  try {
    await client.query("BEGIN");
    const attempt = await client.query<{ status: string }>(
      "SELECT status FROM attempts WHERE id = $1 FOR UPDATE",
      [row.attempt_id],
    );
    if (attempt.rows[0]?.status === "processing") {
      await client.query(
        `INSERT INTO attempt_transitions
          (attempt_id, idempotency_key, from_status, to_status,
           expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
         VALUES ($1, $2, 'processing', 'technical_retry', $3, $3,
                 'worker', 'system', now()) ON CONFLICT DO NOTHING`,
        [row.attempt_id, `media-failed:${row.upload_session_id}`, row.head_sha],
      );
      await client.query(
        `UPDATE attempts SET status = 'technical_retry', completed_at = now(),
             updated_at = now() WHERE id = $1`,
        [row.attempt_id],
      );
      await dependencies.checkIntents.write(client, {
        revisionId: row.revision_id,
        headSha: row.head_sha,
        ...TECHNICAL_RETRY_GITHUB_CHECK,
        summary: `technical retry required for head ${row.head_sha}`,
        reason: "technical_retry",
        idempotencyKey: `media-failed:${row.upload_session_id}`,
      });
    }
    await client.query(
      `UPDATE upload_sessions SET state = 'failed', updated_at = now() WHERE id = $1`,
      [row.upload_session_id],
    );
    await client.query(
      `UPDATE wrapping_materials SET destroyed_at = COALESCE(destroyed_at, now())
       WHERE id = $1`,
      [row.material_id],
    );
    await client.query(
      `INSERT INTO audit_events (actor_id, action, object_type, object_id, metadata)
       VALUES ('worker', 'evidence.rejected', 'attempt', $1,
               jsonb_build_object('errorClass', $2::text,
                                  'errorStage', $3::text))`,
      [row.attempt_id, errorClass, stage],
    );
    await client.query("COMMIT");
  } catch (databaseError) {
    await client.query("ROLLBACK");
    throw databaseError;
  } finally {
    client.release();
  }
}
