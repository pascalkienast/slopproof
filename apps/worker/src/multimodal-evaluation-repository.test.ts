import {
  PayloadCipher,
  multimodalJudgeCandidateHashV1,
  type ProofEvaluationV1,
} from "@understandproof/providers";
import type { DatabaseConnection } from "@understandproof/db";
import { describe, expect, it, vi } from "vitest";
import type { MultimodalProofEvaluationV1 } from "./multimodal-judge-service";
import {
  MultimodalEvaluationPersistenceError,
  PostgresMultimodalEvaluationRepository,
  decryptMultimodalEvaluationSidecarV1,
  multimodalEvaluationAadV1,
  type MultimodalEvaluationAadBindingV1,
} from "./multimodal-evaluation-repository";

const ids = {
  attempt: "91000000-0000-4000-8000-000000000001",
  revision: "91000000-0000-4000-8000-000000000002",
  evaluation: "91000000-0000-4000-8000-000000000003",
  transcript: "91000000-0000-4000-8000-000000000004",
  question: "91000000-0000-4000-8000-000000000005",
  criterion: "91000000-0000-4000-8000-000000000006",
  sentinel: "91000000-0000-4000-8000-000000000007",
} as const;
const headSha = "9".repeat(40);
const inputHash = "a".repeat(64);
const completedAt = new Date("2026-08-13T01:00:00.000Z");
const createdAt = new Date("2026-08-13T01:00:01.000Z");
const deleteAfter = new Date("2026-08-14T01:00:00.000Z");

describe("authoritative multimodal evaluation sidecar", () => {
  it("round-trips both exact Date paths and preserves unavailable evidence", () => {
    const cipher = cipherFixture();
    const evaluation = multimodalEvaluationFixture();
    const binding = bindingFixture();
    const envelope = cipher.encryptJson(
      evaluation,
      multimodalEvaluationAadV1(binding),
    );

    const loaded = decryptMultimodalEvaluationSidecarV1(
      cipher,
      envelope,
      binding,
    );

    expect(loaded.createdAt).toEqual(createdAt);
    expect(loaded.invocationMetadata.completedAt).toEqual(completedAt);
    expect(loaded.candidate.questionEvaluations[0]).toEqual(
      evaluation.candidate.questionEvaluations[0],
    );
    expect(loaded.candidate.questionEvaluations[0]).toMatchObject({
      criterionResults: [expect.objectContaining({ result: "not_evaluable" })],
      contradictions: ["transcript_conflicts_with_patch_evidence"],
      uncertainty: ["criterion_requires_maintainer_assessment"],
    });
  });

  it("authenticates every AAD identity field independently", () => {
    const cipher = cipherFixture();
    const evaluation = multimodalEvaluationFixture();
    const binding = bindingFixture();
    const envelope = cipher.encryptJson(
      evaluation,
      multimodalEvaluationAadV1(binding),
    );
    const variants: MultimodalEvaluationAadBindingV1[] = [
      { ...binding, attemptId: "92000000-0000-4000-8000-000000000001" },
      { ...binding, revisionId: "92000000-0000-4000-8000-000000000002" },
      { ...binding, headSha: "8".repeat(40) },
      { ...binding, evaluationId: "92000000-0000-4000-8000-000000000003" },
      { ...binding, transcriptId: "92000000-0000-4000-8000-000000000004" },
      { ...binding, inputHash: "b".repeat(64) },
    ];

    for (const variant of variants) {
      expect(() =>
        decryptMultimodalEvaluationSidecarV1(cipher, envelope, variant),
      ).toThrow(MultimodalEvaluationPersistenceError);
    }
  });

  it("wipes the mutable plaintext buffer even after strict Date revival", () => {
    const bytes = Buffer.from(
      JSON.stringify(multimodalEvaluationFixture()),
      "utf8",
    );
    const cipher = { decrypt: vi.fn(() => bytes) };

    expect(
      decryptMultimodalEvaluationSidecarV1(cipher, {}, bindingFixture()),
    ).toMatchObject({ attemptId: ids.attempt });
    expect([...bytes]).toEqual(new Array(bytes.byteLength).fill(0));
  });

  it("rolls the compatibility row back if sidecar insertion crashes", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (statement: string) => {
        statements.push(statement);
        if (statement.includes("FROM multimodal_evaluation_sidecars_v1")) {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("SELECT id FROM evaluations")) {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("INSERT INTO evaluations")) {
          return { rows: [{ id: ids.evaluation }], rowCount: 1 };
        }
        if (
          statement.includes("INSERT INTO multimodal_evaluation_sidecars_v1")
        ) {
          throw new Error("synthetic sidecar insertion crash");
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const cipher = cipherFixture();
    const compatibility = compatibilityFixture(cipher);
    const repository = new PostgresMultimodalEvaluationRepository(
      {
        pool: { connect: vi.fn(async () => client) },
      } as unknown as DatabaseConnection,
      cipher,
    );

    await expect(
      repository.persistPair({
        multimodalEvaluation: multimodalEvaluationFixture(),
        evaluationInputHash: inputHash,
        transcriptId: ids.transcript,
        deleteAfter,
        compatibilityEvaluation: compatibility.bundle,
        downstreamJob: {
          schemaVersion: "1",
          idempotencyKey: "gate6:persist-pair:crash",
          attemptId: ids.attempt,
          evaluationId: ids.evaluation,
          expectedHeadSha: headSha,
        },
      }),
    ).rejects.toBeInstanceOf(MultimodalEvaluationPersistenceError);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("fails closed on a legacy compatibility-only row during pre-provider replay lookup", async () => {
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes("FROM multimodal_evaluation_sidecars_v1")) {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("SELECT id FROM evaluations")) {
          return { rows: [{ id: ids.evaluation }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const repository = new PostgresMultimodalEvaluationRepository(
      {
        pool: { connect: vi.fn(async () => client) },
      } as unknown as DatabaseConnection,
      cipherFixture(),
    );

    await expect(
      repository.loadExistingAndSchedule({
        attemptId: ids.attempt,
        transcriptId: ids.transcript,
        expectedHeadSha: headSha,
        downstreamJobBase: {
          schemaVersion: "1",
          idempotencyKey: "gate6:legacy-fail-closed",
          attemptId: ids.attempt,
          expectedHeadSha: headSha,
        },
      }),
    ).rejects.toThrow(
      "Compatibility evaluation exists without its authoritative sidecar",
    );
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO evaluations"),
      expect.anything(),
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects a future provider completion timestamp before DB or encryption", async () => {
    const connect = vi.fn();
    const encryptJson = vi.fn();
    const cipher = cipherFixture();
    const compatibility = compatibilityFixture(cipher);
    const repository = new PostgresMultimodalEvaluationRepository(
      { pool: { connect } } as unknown as DatabaseConnection,
      {
        encryptJson,
        decrypt: cipher.decrypt.bind(cipher),
      } as unknown as PayloadCipher,
    );
    const evaluation = multimodalEvaluationFixture();
    evaluation.invocationMetadata.completedAt = new Date(
      "2099-01-01T00:00:00.000Z",
    );

    await expect(
      repository.persistPair({
        multimodalEvaluation: evaluation,
        evaluationInputHash: inputHash,
        transcriptId: ids.transcript,
        deleteAfter,
        compatibilityEvaluation: compatibility.bundle,
        downstreamJob: {
          schemaVersion: "1",
          idempotencyKey: "gate6:future-completion-rejected",
          attemptId: ids.attempt,
          evaluationId: ids.evaluation,
          expectedHeadSha: headSha,
        },
      }),
    ).rejects.toBeInstanceOf(MultimodalEvaluationPersistenceError);
    expect(connect).not.toHaveBeenCalled();
    expect(encryptJson).not.toHaveBeenCalled();
  });

  it("rejects compatibility that coerces not_evaluable into not_met", async () => {
    const connect = vi.fn();
    const cipher = cipherFixture();
    const compatibility = compatibilityFixture(cipher);
    compatibility.plaintext.questionEvaluations[0]!.rubricFindings = [
      {
        criterionId: ids.criterion,
        result: "not_met",
        reason: "Dishonest legacy coercion.",
      },
    ];
    compatibility.bundle.encryptedPayload = JSON.stringify(
      cipher.encryptJson(
        compatibility.plaintext,
        `slopproof:evaluation:v1:${ids.attempt}:${ids.evaluation}`,
      ),
    );
    const repository = new PostgresMultimodalEvaluationRepository(
      { pool: { connect } } as unknown as DatabaseConnection,
      cipher,
    );

    await expect(
      repository.persistPair({
        multimodalEvaluation: multimodalEvaluationFixture(),
        evaluationInputHash: inputHash,
        transcriptId: ids.transcript,
        deleteAfter,
        compatibilityEvaluation: compatibility.bundle,
        downstreamJob: {
          schemaVersion: "1",
          idempotencyKey: "gate6:dishonest-compatibility-rejected",
          attemptId: ids.attempt,
          evaluationId: ids.evaluation,
          expectedHeadSha: headSha,
        },
      }),
    ).rejects.toThrow(
      "Compatibility evaluation misrepresents unavailable evidence",
    );
    expect(connect).not.toHaveBeenCalled();
  });
});

function bindingFixture(): MultimodalEvaluationAadBindingV1 {
  return {
    attemptId: ids.attempt,
    revisionId: ids.revision,
    headSha,
    evaluationId: ids.evaluation,
    transcriptId: ids.transcript,
    inputHash,
  };
}

function multimodalEvaluationFixture(): MultimodalProofEvaluationV1 {
  const candidate = {
    schemaVersion: "1" as const,
    candidateVersion: "multimodal-judge-candidate-v1" as const,
    recommendation: "review_required" as const,
    questionEvaluations: [
      {
        questionId: ids.question,
        criterionResults: [
          {
            criterionId: ids.criterion,
            result: "not_evaluable" as const,
            supportedPatchAnchorIds: [],
            reason: "question_evidence_insufficient" as const,
          },
        ],
        contradictions: ["transcript_conflicts_with_patch_evidence" as const],
        uncertainty: ["criterion_requires_maintainer_assessment" as const],
      },
    ],
    privateReason: "stored_criteria_not_fully_supported" as const,
    warnings: ["frames_unavailable" as const],
  };
  return {
    schemaVersion: "1",
    evaluationVersion: "multimodal-proof-evaluation-v1",
    attemptId: ids.attempt,
    revisionId: ids.revision,
    headSha,
    candidate,
    invocationMetadata: {
      schemaVersion: "1",
      provider: "hetzner",
      model: `private-multimodal-model-v2-${"x".repeat(70)}`,
      promptVersion: "proof-judge-system-v2",
      outputSchemaVersion: "multimodal-judge-candidate-v1",
      inputHash,
      outputHash: multimodalJudgeCandidateHashV1(candidate),
      tokenUsage: { inputTokens: 120, outputTokens: 40 },
      latencyMs: 500,
      invocationCount: 1,
      outcome: "generated",
      degraded: false,
      completedAt,
    },
    frameWarnings: ["frames_unavailable"],
    workflowOutcome: "review_required",
    manualReviewRequired: true,
    createdAt,
  };
}

function compatibilityFixture(cipher: PayloadCipher) {
  const plaintext: ProofEvaluationV1 = {
    schemaVersion: "1",
    evaluationVersion: "proof-evaluation-v1",
    attemptId: ids.attempt,
    revisionId: ids.revision,
    headSha,
    provider: "multimodal-compatibility-v1",
    model: "manual-review-projection-v1",
    systemInstructionVersion: "proof-judge-system-v1",
    recommendation: "review_required",
    questionEvaluations: [
      {
        questionId: ids.question,
        outcome: "not_evaluable",
        rubricFindings: [
          {
            criterionId: ids.sentinel,
            result: "met",
            reason:
              "Compatibility-only sentinel; consult authoritative sidecar.",
          },
        ],
        supportedPatchAnchorIds: [],
        reason: "Compatibility-only manual-review projection.",
      },
    ],
    privateReason: "Compatibility-only projection; maintainer review required.",
    warnings: ["authoritative_multimodal_sidecar_required"],
    createdAt,
  };
  const envelope = cipher.encryptJson(
    plaintext,
    `slopproof:evaluation:v1:${ids.attempt}:${ids.evaluation}`,
  );
  return {
    plaintext,
    bundle: {
      schemaVersion: "1" as const,
      payloadKind: "proof_evaluation" as const,
      evaluationId: ids.evaluation,
      attemptId: ids.attempt,
      provider: plaintext.provider,
      model: plaintext.model,
      promptVersion: plaintext.systemInstructionVersion,
      evaluationSchemaVersion: plaintext.evaluationVersion,
      rubricVersion: "rubric-v1" as const,
      recommendation: "review_required" as const,
      encryptedPayload: JSON.stringify(envelope),
      deleteAfter,
    },
  };
}

function cipherFixture(): PayloadCipher {
  let nonce = 0;
  return new PayloadCipher(new Uint8Array(32).fill(0x63), (length) => {
    nonce += 1;
    return new Uint8Array(length).fill(nonce);
  });
}
