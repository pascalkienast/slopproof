import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseConnection } from "@slopproof/db";
import {
  AuthoritativeMultimodalEvaluationV1Schema,
  PayloadCipher,
  PrivateReviewContextV2Schema,
  ProofEvaluationV1Schema,
  TranscriptV1Schema,
  multimodalJudgeCandidateHashV1,
} from "@slopproof/providers";
import { describe, expect, it, vi } from "vitest";
import { framePayloadAad } from "./frame-selection";
import { handleReviewContextRequest } from "./review-context";

const ATTEMPT_ID = "61000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "61000000-0000-4000-8000-000000000002";
const TRANSCRIPT_ID = "61000000-0000-4000-8000-000000000003";
const EVALUATION_ID = "61000000-0000-4000-8000-000000000004";
const QUESTION_ID = "61000000-0000-4000-8000-000000000005";
const CRITERION_ID = "61000000-0000-4000-8000-000000000006";
const FRAME_ID = "61000000-0000-4000-8000-000000000007";
const FRAME_REFERENCE = "61000000-0000-4000-8000-000000000008";
const REVISION_ID = "61000000-0000-4000-8000-000000000009";
const JTI = "61000000-0000-4000-8000-000000000010";
const SIDECAR_ID = "61000000-0000-4000-8000-000000000012";
const SECRET = "review-context-capability-secret-00000000";
const NOW = new Date("2026-08-12T12:00:00.000Z");

describe("private worker review context", () => {
  it("rechecks a one-use capability and returns decrypted structured evidence", async () => {
    let nonce = 1;
    const cipher = new PayloadCipher(new Uint8Array(32).fill(4), (length) => {
      const value = new Uint8Array(length);
      value[length - 1] = nonce++;
      return value;
    });
    const transcript = TranscriptV1Schema.parse({
      schemaVersion: "1",
      transcriptVersion: "transcript-v1",
      id: TRANSCRIPT_ID,
      attemptId: ATTEMPT_ID,
      provider: "local-fake",
      model: "fixture-v1",
      language: "en",
      durationMs: 5_000,
      sourceSha256: "a".repeat(64),
      segments: [
        {
          id: "61000000-0000-4000-8000-000000000011",
          questionId: QUESTION_ID,
          startMs: 0,
          endMs: 5_000,
          speaker: "contributor",
          text: {
            trust: "untrusted",
            source: "transcript",
            content: "The transaction rolls back before publishing state.",
          },
        },
      ],
      createdAt: NOW,
    });
    const evaluation = ProofEvaluationV1Schema.parse({
      schemaVersion: "1",
      evaluationVersion: "proof-evaluation-v1",
      attemptId: ATTEMPT_ID,
      revisionId: REVISION_ID,
      headSha: "b".repeat(40),
      provider: "local-fake",
      model: "fixture-v1",
      systemInstructionVersion: "proof-judge-system-v1",
      recommendation: "pass",
      questionEvaluations: [
        {
          questionId: QUESTION_ID,
          outcome: "met",
          rubricFindings: [
            {
              criterionId: CRITERION_ID,
              result: "met",
              reason: "The answer identifies rollback and publication order.",
            },
          ],
          supportedPatchAnchorIds: ["a0"],
          reason: "The explanation is bound to the changed transaction path.",
        },
      ],
      privateReason: "All stored rubric points were addressed.",
      warnings: [],
      createdAt: NOW,
    });
    const encryptedTranscript = JSON.stringify(
      cipher.encryptJson(
        transcript,
        `slopproof:transcript:v1:${ATTEMPT_ID}:${TRANSCRIPT_ID}`,
      ),
    );
    const encryptedEvaluation = JSON.stringify(
      cipher.encryptJson(
        evaluation,
        `slopproof:evaluation:v1:${ATTEMPT_ID}:${EVALUATION_ID}`,
      ),
    );
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      ...new TextEncoder().encode("private-frame"),
      0xff,
      0xd9,
    ]);
    const encryptedFrame = new TextEncoder().encode(
      JSON.stringify(
        cipher.encrypt(jpeg, framePayloadAad(ATTEMPT_ID, FRAME_REFERENCE)),
      ),
    );
    const frameHash = createHash("sha256").update(encryptedFrame).digest("hex");
    const frameKey = `provider-frame/${FRAME_REFERENCE}/${frameHash}/320x180`;
    const authoritative = AuthoritativeMultimodalEvaluationV1Schema.parse({
      schemaVersion: "1",
      evaluationVersion: "multimodal-proof-evaluation-v1",
      attemptId: ATTEMPT_ID,
      revisionId: REVISION_ID,
      headSha: "b".repeat(40),
      candidate: {
        schemaVersion: "1",
        candidateVersion: "multimodal-judge-candidate-v1",
        recommendation: "review_required",
        questionEvaluations: [
          {
            questionId: QUESTION_ID,
            criterionResults: [
              {
                criterionId: CRITERION_ID,
                result: "not_evaluable",
                supportedPatchAnchorIds: [],
                reason: "question_evidence_insufficient",
              },
            ],
            contradictions: ["transcript_conflicts_with_patch_evidence"],
            uncertainty: ["criterion_requires_maintainer_assessment"],
          },
        ],
        privateReason: "stored_criteria_not_fully_supported",
        warnings: ["frames_unavailable"],
      },
      invocationMetadata: {
        schemaVersion: "1",
        provider: "hetzner-inference",
        model: "judge-model",
        promptVersion: "proof-judge-system-v2",
        outputSchemaVersion: "multimodal-judge-candidate-v1",
        inputHash: "c".repeat(64),
        outputHash: "0".repeat(64),
        tokenUsage: null,
        latencyMs: 50,
        invocationCount: 1,
        outcome: "generated",
        degraded: false,
        completedAt: NOW,
      },
      frameWarnings: [],
      workflowOutcome: "review_required",
      manualReviewRequired: true,
      createdAt: NOW,
    });
    authoritative.invocationMetadata.outputHash =
      multimodalJudgeCandidateHashV1(authoritative.candidate);
    const sidecarAad = [
      "slopproof",
      "multimodal-evaluation-sidecar",
      "v1",
      ATTEMPT_ID,
      REVISION_ID,
      "b".repeat(40),
      EVALUATION_ID,
      TRANSCRIPT_ID,
      authoritative.invocationMetadata.inputHash,
    ].join(":");
    const encryptedSidecar = cipher.encryptJson(authoritative, sidecarAad);
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("SELECT attempt.id AS attempt_id")) {
        return {
          rows: [
            {
              attempt_id: ATTEMPT_ID,
              repository_id: REPOSITORY_ID,
              revision_id: REVISION_ID,
              head_sha: "b".repeat(40),
              delete_after: new Date("2026-08-13T12:00:00.000Z"),
              transcript_id: TRANSCRIPT_ID,
              encrypted_transcript: encryptedTranscript,
              evaluation_id: EVALUATION_ID,
              encrypted_evaluation: encryptedEvaluation,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM multimodal_evaluation_sidecars_v1")) {
        return {
          rows: [
            {
              sidecar_id: deterministicSidecarId(
                authoritative.invocationMetadata.inputHash,
              ),
              attempt_id: ATTEMPT_ID,
              revision_id: REVISION_ID,
              head_sha: "b".repeat(40),
              evaluation_id: EVALUATION_ID,
              transcript_id: TRANSCRIPT_ID,
              provider: authoritative.invocationMetadata.provider,
              model: authoritative.invocationMetadata.model,
              prompt_version: authoritative.invocationMetadata.promptVersion,
              evaluation_version: authoritative.evaluationVersion,
              output_schema_version:
                authoritative.invocationMetadata.outputSchemaVersion,
              input_hash: authoritative.invocationMetadata.inputHash,
              output_hash: authoritative.invocationMetadata.outputHash,
              encrypted_payload: encryptedSidecar,
              provider_completed_at: NOW,
              delete_after: new Date("2026-08-13T12:00:00.000Z"),
              deleted_at: null,
              created_at: NOW,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM frame_selections")) {
        return {
          rows: [
            {
              id: FRAME_ID,
              timestamp_ms: 2_500,
              reason_code: "transcript_alignment",
              object_key: frameKey,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("AS active")) {
        return { rows: [{ active: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = {
      query: clientQuery,
      release: vi.fn(),
    };
    const database = {
      pool: {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
      },
    } as unknown as DatabaseConnection;
    const token = capabilityToken();
    const request = {
      url: `/internal/review/context/${ATTEMPT_ID}`,
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    } as IncomingMessage;
    let status = 0;
    let responseBody = "";
    const response = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
      },
      end(chunk?: string) {
        responseBody = chunk ?? "";
      },
      destroy: vi.fn(),
    } as unknown as ServerResponse;

    const handled = await handleReviewContextRequest(request, response, {
      database,
      storage: {
        getObjectStream: vi.fn(async () => new Blob([encryptedFrame]).stream()),
      },
      payloadCipher: cipher,
      capabilitySecret: SECRET,
      now: () => NOW,
    });

    expect(handled).toBe(true);
    expect(status).toBe(200);
    const context = PrivateReviewContextV2Schema.parse(
      JSON.parse(responseBody),
    );
    expect(context.transcript.segments[0]?.text.content).toContain(
      "rolls back",
    );
    expect(
      context.compatibilityEvaluation.questionEvaluations[0]?.outcome,
    ).toBe("met");
    expect(
      context.authoritativeEvaluation?.candidate.questionEvaluations[0],
    ).toMatchObject({
      criterionResults: [
        expect.objectContaining({
          criterionId: CRITERION_ID,
          result: "not_evaluable",
        }),
      ],
      contradictions: ["transcript_conflicts_with_patch_evidence"],
      uncertainty: ["criterion_requires_maintainer_assessment"],
    });
    expect(Buffer.from(context.frames[0]!.imageBase64, "base64")).toEqual(
      Buffer.from(jpeg),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("evidence.context.started"),
      ["demo-maintainer", ATTEMPT_ID, JTI],
    );
  });

  it("fails closed on tampered authoritative metadata instead of using compatibility as authority", async () => {
    const cipher = new PayloadCipher(new Uint8Array(32).fill(4));
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT attempt.id AS attempt_id")) {
        return {
          rows: [
            {
              attempt_id: ATTEMPT_ID,
              repository_id: REPOSITORY_ID,
              revision_id: REVISION_ID,
              head_sha: "b".repeat(40),
              delete_after: new Date("2026-08-13T12:00:00.000Z"),
              transcript_id: TRANSCRIPT_ID,
              encrypted_transcript: encryptedTranscriptFixture(cipher),
              evaluation_id: EVALUATION_ID,
              encrypted_evaluation: encryptedCompatibilityFixture(cipher),
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM multimodal_evaluation_sidecars_v1")) {
        return {
          rows: [
            {
              sidecar_id: SIDECAR_ID,
              attempt_id: ATTEMPT_ID,
              revision_id: REVISION_ID,
              head_sha: "b".repeat(40),
              evaluation_id: EVALUATION_ID,
              transcript_id: TRANSCRIPT_ID,
              provider: "hetzner-inference",
              model: "judge-model",
              prompt_version: "proof-judge-system-v2",
              evaluation_version: "multimodal-proof-evaluation-v1",
              output_schema_version: "multimodal-judge-candidate-v1",
              input_hash: "c".repeat(64),
              output_hash: "d".repeat(64),
              encrypted_payload: {},
              provider_completed_at: NOW,
              delete_after: new Date("2026-08-13T12:00:00.000Z"),
              deleted_at: null,
              created_at: NOW,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const response = responseFixture();

    await handleReviewContextRequest(requestFixture(), response.value, {
      database: databaseFixture(clientQuery),
      storage: { getObjectStream: vi.fn() },
      payloadCipher: cipher,
      capabilitySecret: SECRET,
      now: () => NOW,
    });

    expect(response.status()).toBe(403);
    expect(response.body()).toBe(JSON.stringify({ error: "forbidden" }));
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQuery).not.toHaveBeenCalledWith("COMMIT");
  });

  it("rechecks current lifecycle and retention in the locked query before decrypting", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT attempt.id AS attempt_id")) {
        expect(sql).toContain("attempt.status = 'review_required'");
        expect(sql).toContain("revision.is_current = true");
        expect(sql).toContain("pull_request.state = 'open'");
        expect(sql).toContain("repository.status = 'active'");
        expect(sql).toContain("installation.status = 'active'");
        expect(sql).toContain("recording.delete_after > clock_timestamp()");
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const decrypt = vi.fn();
    const storage = { getObjectStream: vi.fn() };
    const response = responseFixture();

    await handleReviewContextRequest(requestFixture(), response.value, {
      database: databaseFixture(clientQuery),
      storage,
      payloadCipher: { decrypt } as never,
      capabilitySecret: SECRET,
      now: () => NOW,
    });

    expect(response.status()).toBe(403);
    expect(decrypt).not.toHaveBeenCalled();
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it("expires a pending storage acquisition before decrypting and cancels a late stream", async () => {
    vi.useFakeTimers();
    try {
      const cipher = new PayloadCipher(new Uint8Array(32).fill(4));
      const decrypt = vi.spyOn(cipher, "decrypt");
      const frameKey = `provider-frame/${FRAME_REFERENCE}/${"a".repeat(64)}/320x180`;
      const clientQuery = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT attempt.id AS attempt_id")) {
          return {
            rows: [
              {
                attempt_id: ATTEMPT_ID,
                repository_id: REPOSITORY_ID,
                revision_id: REVISION_ID,
                head_sha: "b".repeat(40),
                delete_after: new Date("2026-08-13T12:00:00.000Z"),
                transcript_id: TRANSCRIPT_ID,
                encrypted_transcript: encryptedTranscriptFixture(cipher),
                evaluation_id: EVALUATION_ID,
                encrypted_evaluation: encryptedCompatibilityFixture(cipher),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM multimodal_evaluation_sidecars_v1")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM frame_selections")) {
          return {
            rows: [
              {
                id: FRAME_ID,
                timestamp_ms: 500,
                reason_code: "transcript_alignment",
                object_key: frameKey,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      let resolveAcquisition:
        ((stream: ReadableStream<Uint8Array>) => void) | undefined;
      const acquisition = new Promise<ReadableStream<Uint8Array>>((resolve) => {
        resolveAcquisition = resolve;
      });
      const storage = { getObjectStream: vi.fn(() => acquisition) };
      const response = responseFixture();

      const handling = handleReviewContextRequest(
        requestFixture(),
        response.value,
        {
          database: databaseFixture(clientQuery),
          storage,
          payloadCipher: cipher,
          capabilitySecret: SECRET,
          now: () => new Date(NOW.getTime() + vi.getTimerCount() * 0),
        },
      );
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(storage.getObjectStream).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30_000);
      await handling;

      expect(response.status()).toBe(403);
      expect(response.body()).toBe(JSON.stringify({ error: "forbidden" }));
      expect(decrypt).not.toHaveBeenCalled();
      expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(clientQuery).not.toHaveBeenCalledWith("COMMIT");

      const cancel = vi.fn(async () => undefined);
      resolveAcquisition?.({ cancel } as unknown as ReadableStream<Uint8Array>);
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back by the deadline when both a frame read and its cancellation remain pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const cipher = new PayloadCipher(new Uint8Array(32).fill(4));
      const frameKey = `provider-frame/${FRAME_REFERENCE}/${"a".repeat(64)}/320x180`;
      const clientQuery = vi.fn(async (sql: string) => {
        if (sql.includes("SELECT attempt.id AS attempt_id")) {
          return {
            rows: [
              {
                attempt_id: ATTEMPT_ID,
                repository_id: REPOSITORY_ID,
                revision_id: REVISION_ID,
                head_sha: "b".repeat(40),
                delete_after: new Date("2026-08-13T12:00:00.000Z"),
                transcript_id: TRANSCRIPT_ID,
                encrypted_transcript: encryptedTranscriptFixture(cipher),
                evaluation_id: EVALUATION_ID,
                encrypted_evaluation: encryptedCompatibilityFixture(cipher),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM multimodal_evaluation_sidecars_v1")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM frame_selections")) {
          return {
            rows: [
              {
                id: FRAME_ID,
                timestamp_ms: 500,
                reason_code: "transcript_alignment",
                object_key: frameKey,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const release = vi.fn();
      const client = { query: clientQuery, release };
      const database = {
        pool: {
          connect: vi.fn(async () => client),
          query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
        },
      } as unknown as DatabaseConnection;
      const read = vi.fn(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
      );
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const releaseLock = vi.fn();
      const stream = {
        getReader: () => ({ read, cancel, releaseLock }),
        cancel: vi.fn(async () => undefined),
      } as unknown as ReadableStream<Uint8Array>;
      const response = responseFixture();

      const handling = handleReviewContextRequest(
        requestFixture(),
        response.value,
        {
          database,
          storage: { getObjectStream: vi.fn(async () => stream) },
          payloadCipher: cipher,
          capabilitySecret: SECRET,
          now: () => new Date(),
        },
      );
      for (let index = 0; index < 50; index += 1) await Promise.resolve();
      expect(read).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30_000);
      await handling;

      expect(cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
      expect(clientQuery).not.toHaveBeenCalledWith("COMMIT");
      expect(release).toHaveBeenCalledOnce();
      expect(response.status()).toBe(403);
      expect(response.body()).toBe(JSON.stringify({ error: "forbidden" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

function databaseFixture(clientQuery: ReturnType<typeof vi.fn>) {
  const client = { query: clientQuery, release: vi.fn() };
  return {
    pool: {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    },
  } as unknown as DatabaseConnection;
}

function requestFixture() {
  return {
    url: `/internal/review/context/${ATTEMPT_ID}`,
    method: "GET",
    headers: { authorization: `Bearer ${capabilityToken()}` },
  } as IncomingMessage;
}

function responseFixture() {
  let status = 0;
  let body = "";
  return {
    value: {
      headersSent: false,
      writeHead(code: number) {
        status = code;
      },
      end(chunk?: string) {
        body = chunk ?? "";
      },
      destroy: vi.fn(),
    } as unknown as ServerResponse,
    status: () => status,
    body: () => body,
  };
}

function encryptedTranscriptFixture(cipher: PayloadCipher): string {
  return JSON.stringify(
    cipher.encryptJson(
      TranscriptV1Schema.parse({
        schemaVersion: "1",
        transcriptVersion: "transcript-v1",
        id: TRANSCRIPT_ID,
        attemptId: ATTEMPT_ID,
        provider: "local-fake",
        model: "fixture-v1",
        language: "en",
        durationMs: 1_000,
        sourceSha256: "a".repeat(64),
        segments: [
          {
            id: "61000000-0000-4000-8000-000000000011",
            questionId: QUESTION_ID,
            startMs: 0,
            endMs: 1_000,
            speaker: "contributor",
            text: { trust: "untrusted", source: "transcript", content: "x" },
          },
        ],
        createdAt: NOW,
      }),
      `slopproof:transcript:v1:${ATTEMPT_ID}:${TRANSCRIPT_ID}`,
    ),
  );
}

function encryptedCompatibilityFixture(cipher: PayloadCipher): string {
  return JSON.stringify(
    cipher.encryptJson(
      ProofEvaluationV1Schema.parse({
        schemaVersion: "1",
        evaluationVersion: "proof-evaluation-v1",
        attemptId: ATTEMPT_ID,
        revisionId: REVISION_ID,
        headSha: "b".repeat(40),
        provider: "multimodal-compatibility-v1",
        model: "manual-review-projection-v1",
        systemInstructionVersion: "proof-judge-system-v1",
        recommendation: "review_required",
        questionEvaluations: [
          {
            questionId: QUESTION_ID,
            outcome: "not_evaluable",
            rubricFindings: [
              {
                criterionId: CRITERION_ID,
                result: "met",
                reason: "Compatibility sentinel only",
              },
            ],
            supportedPatchAnchorIds: [],
            reason: "Consult authoritative sidecar",
          },
        ],
        privateReason: "Compatibility-only projection",
        warnings: ["authoritative_multimodal_sidecar_required"],
        createdAt: NOW,
      }),
      `slopproof:evaluation:v1:${ATTEMPT_ID}:${EVALUATION_ID}`,
    ),
  );
}

function deterministicSidecarId(inputHash: string): string {
  const value = `multimodal-sidecar-v1:${ATTEMPT_ID}:${REVISION_ID}:${"b".repeat(40)}:${EVALUATION_ID}:${TRANSCRIPT_ID}:${inputHash}`;
  const bytes = createHash("sha256")
    .update(value, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function capabilityToken(): string {
  const document = JSON.stringify({
    version: 1,
    attemptId: ATTEMPT_ID,
    repositoryId: REPOSITORY_ID,
    actorId: "demo-maintainer",
    jti: JTI,
    expiresAt: "2026-08-12T12:00:30.000Z",
  });
  const signature = createHmac("sha256", SECRET)
    .update(document, "utf8")
    .digest("base64url");
  return `${Buffer.from(document).toString("base64url")}.${signature}`;
}
