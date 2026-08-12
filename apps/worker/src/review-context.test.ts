import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseConnection } from "@slopproof/db";
import {
  PayloadCipher,
  PrivateReviewContextV1Schema,
  ProofEvaluationV1Schema,
  TranscriptV1Schema,
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
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT attempt.id AS attempt_id")) {
        return {
          rows: [
            {
              attempt_id: ATTEMPT_ID,
              repository_id: REPOSITORY_ID,
              attempt_status: "review_required",
              is_current: true,
              recording_deleted_at: null,
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
    const context = PrivateReviewContextV1Schema.parse(
      JSON.parse(responseBody),
    );
    expect(context.transcript.segments[0]?.text.content).toContain(
      "rolls back",
    );
    expect(context.evaluation.questionEvaluations[0]?.outcome).toBe("met");
    expect(Buffer.from(context.frames[0]!.imageBase64, "base64")).toEqual(
      Buffer.from(jpeg),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("evidence.context.started"),
      ["demo-maintainer", ATTEMPT_ID, JTI],
    );
  });
});

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
