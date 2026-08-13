import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@slopproof/policy";
import {
  buildFfprobeArguments,
  assertFrozenMediaLimits,
  parseFfprobeCompactOutput,
  recordMediaFinalizationFailure,
  runFfprobePipeline,
  type MediaFinalizationFailureDependencies,
  type MediaFinalizationRow,
  type MediaFinalizationStage,
} from "./media-finalize";
import type { WorkerCheckIntentWriterInput } from "./revision-preparation";

const row: MediaFinalizationRow = {
  upload_session_id: "10000000-0000-4000-8000-000000000001",
  upload_state: "pending_finalization",
  provider_upload_id: "provider-upload",
  object_key: "evidence/v1/ciphertext",
  object_id: "10000000-0000-4000-8000-000000000002",
  finalize_envelope: {},
  attempt_id: "10000000-0000-4000-8000-000000000003",
  attempt_status: "processing",
  revision_id: "10000000-0000-4000-8000-000000000005",
  head_sha: "a".repeat(40),
  is_current: true,
  pull_request_state: "open",
  repository_status: "active",
  installation_status: "active",
  material_id: "10000000-0000-4000-8000-000000000004",
  key_id: "local:test",
  evidence_delete_after: new Date("2030-01-02T00:00:00.000Z"),
  policy: DEFAULT_REPOSITORY_POLICY_V1,
};

describe("media finalization failure handling", () => {
  it("enforces the frozen repository limits and accepted deadline", () => {
    expect(
      assertFrozenMediaLimits(row, {
        durationMs: 60_000,
        totalObjectBytes: 1_000_000,
      }),
    ).toMatchObject({
      maximumDurationMs: 480_000,
      maximumUploadBytes: 134_217_728,
    });
    expect(() =>
      assertFrozenMediaLimits(
        {
          ...row,
          policy: {
            ...DEFAULT_REPOSITORY_POLICY_V1,
            proof: {
              ...DEFAULT_REPOSITORY_POLICY_V1.proof,
              maximumDurationSeconds: 30,
              maximumUploadBytes: 1_024,
            },
          },
        },
        { durationMs: 30_001, totalObjectBytes: 1_025 },
      ),
    ).toThrow("frozen repository policy");
    expect(() =>
      assertFrozenMediaLimits(
        { ...row, evidence_delete_after: null },
        { durationMs: 1_000, totalObjectBytes: 1_000 },
      ),
    ).toThrow("frozen repository policy");
  });

  it("persists a technical retry with typed, value-free stage diagnostics", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      async query(statement: string) {
        queries.push(statement);
        if (
          statement.includes("jsonb_build_object") &&
          (!statement.includes("$2::text") || !statement.includes("$3::text"))
        ) {
          throw new Error("could not determine JSON parameter types");
        }
        if (statement.includes("SELECT status FROM attempts")) {
          return { rows: [{ status: "processing" }] };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {
        released = true;
      },
    };
    const deleted: string[] = [];
    const checkIntents: WorkerCheckIntentWriterInput[] = [];
    const dependencies = {
      database: {
        pool: {
          async connect() {
            return client;
          },
        },
      },
      storage: {
        async deleteObject(objectKey: string) {
          deleted.push(objectKey);
        },
        async abortMultipartUpload() {},
      },
      checkIntents: {
        async write(_client: unknown, input: WorkerCheckIntentWriterInput) {
          checkIntents.push(input);
        },
      },
    } as unknown as MediaFinalizationFailureDependencies;

    await recordMediaFinalizationFailure(
      row,
      true,
      new Error("synthetic invalid media"),
      dependencies,
      "decrypt_and_probe",
    );

    expect(deleted).toEqual([row.object_key]);
    expect(checkIntents).toEqual([
      {
        revisionId: row.revision_id,
        headSha: row.head_sha,
        status: "completed",
        conclusion: "neutral",
        summary: `technical retry required for head ${row.head_sha}`,
        reason: "technical_retry",
        idempotencyKey: `media-failed:${row.upload_session_id}`,
      },
    ]);
    expect(
      queries.some(
        (query) => query.includes("$2::text") && query.includes("$3::text"),
      ),
    ).toBe(true);
    expect(queries.at(-1)).toBe("COMMIT");
    expect(released).toBe(true);
  });

  it.each<MediaFinalizationStage>([
    "authenticate",
    "provider_parts",
    "complete_upload",
    "verify_object",
    "open_object",
    "decrypt_and_probe",
    "persist_recording",
  ])("accepts the bounded diagnostic stage %s", async (stage) => {
    const parameters: unknown[][] = [];
    const client = {
      async query(statement: string, values?: unknown[]) {
        if (values) parameters.push(values);
        if (statement.includes("SELECT status FROM attempts")) {
          return { rows: [{ status: "technical_retry" }] };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const dependencies = {
      database: {
        pool: {
          async connect() {
            return client;
          },
        },
      },
      storage: { async deleteObject() {}, async abortMultipartUpload() {} },
      checkIntents: { async write() {} },
    } as unknown as MediaFinalizationFailureDependencies;

    await recordMediaFinalizationFailure(
      row,
      true,
      new TypeError("private detail"),
      dependencies,
      stage,
    );

    expect(parameters).toContainEqual([row.attempt_id, "TypeError", stage]);
    expect(JSON.stringify(parameters)).not.toContain("private detail");
  });
});

describe("ffprobe process lifecycle", () => {
  it("starts the decoder with bounded CPU discovery, allocation, probing, and threads", () => {
    expect(buildFfprobeArguments()).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(buildFfprobeArguments()).toEqual(
      expect.arrayContaining([
        "format=format_name:stream=codec_type,codec_name:packet=pts_time,duration_time",
        "compact=p=1:nk=0",
      ]),
    );
  });

  it("derives the authoritative duration from a complete packet timeline", () => {
    expect(
      parseFfprobeCompactOutput(
        [
          "packet|pts_time=-0.007000|duration_time=0.020000",
          "packet|pts_time=41.000000|duration_time=0.018000",
          "stream|codec_name=vp8|codec_type=video",
          "stream|codec_name=opus|codec_type=audio",
          "format|format_name=matroska,webm",
        ].join("\n"),
      ),
    ).toEqual({
      durationMs: 41_018,
      videoCodec: "vp8",
      audioCodec: "opus",
    });
    expect(() =>
      parseFfprobeCompactOutput(
        [
          "packet|pts_time=481.000000|duration_time=0.020000",
          "stream|codec_name=vp8|codec_type=video",
          "stream|codec_name=opus|codec_type=audio",
          "format|format_name=matroska,webm",
        ].join("\n"),
      ),
    ).toThrow("supported recording profile");
  });

  it("observes the probe rejection caused by killing it after a stream error", async () => {
    const streamError = new Error("ciphertext authentication failed");
    const probeError = new Error("ffprobe killed");
    let rejectProbe: ((error: unknown) => void) | undefined;
    const result = new Promise<never>((_resolve, reject) => {
      rejectProbe = reject;
    });
    const signals: (NodeJS.Signals | number | undefined)[] = [];

    const pipeline = runFfprobePipeline(
      async () => {
        throw streamError;
      },
      {
        child: {
          kill(signal) {
            signals.push(signal);
            rejectProbe?.(probeError);
            return true;
          },
        },
        stdin: new PassThrough(),
        result,
      },
    );

    await expect(pipeline).rejects.toBe(streamError);
    expect(signals).toEqual(["SIGKILL"]);
  });
});
