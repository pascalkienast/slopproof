import type { AttemptStatus } from "@slopproof/domain";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@slopproof/policy";
import {
  LocalFakeMultimodalJudgeProvider,
  LocalFakeTranscriptionProvider,
  PayloadCipher,
  ProofEvaluationV1Schema,
  ProviderError,
  TranscriptV1Schema,
  type FrameSelectionMetadataV1,
  type MultimodalJudgeProvider,
  type ProviderClock,
  type ProofEvaluationV1,
  type TranscriptionProvider,
} from "@slopproof/providers";
import { describe, expect, it } from "vitest";
import {
  type EncryptedEvaluationBundleV1,
  type EncryptedTranscriptBundleV1,
  type EvaluationPolicyContextV1,
  type EvaluationRunContextV1,
  type FrameSelectionContextV1,
  type FrameSelectionStageBundleV1,
  type ProviderPipelineDispatcher,
  type ProviderPipelineJobName,
  type ProviderPipelineJobPayload,
  type ProviderPipelineRepository,
  type StoredProofQuestionV1,
  type TranscriptExtractionContextV1,
} from "./provider-pipeline-contracts";
import {
  EmptyLocalFrameSelectionAdapter,
  createProviderPipelineHandlers,
  decryptVersionedProviderPayload,
  decodeProviderPayloadKeyBase64,
  type ProviderFrameSelectionAdapter,
  type ProviderPipelineDependencies,
} from "./provider-pipeline";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "10000000-0000-4000-8000-000000000002";
const REPOSITORY_ID = "10000000-0000-4000-8000-000000000003";
const RECORDING_ID = "10000000-0000-4000-8000-000000000004";
const QUESTION_ID = "10000000-0000-4000-8000-000000000005";
const FRAME_ID = "10000000-0000-4000-8000-000000000006";
const DERIVATIVE_ID = "10000000-0000-4000-8000-000000000007";
const SHA = "a".repeat(40);
const MANIFEST_HASH = "b".repeat(64);
const FRAME_HASH = "c".repeat(64);
const NOW = new Date("2026-08-12T11:00:00.000Z");
const DELETE_AFTER = new Date("2026-08-13T11:00:00.000Z");

const question: StoredProofQuestionV1 = {
  id: QUESTION_ID,
  ordinal: 0,
  prompt:
    "Explain the transaction boundary and how rollback restores a safe state.",
  diffAnchor: {
    id: "a0",
    file: "src/transaction.ts",
    hunkHeader: "@@ -1,1 +1,1 @@",
    oldStart: 1,
    newStart: 1,
    changedLines: 2,
    evidence: "Patch content remains untrusted input data.",
  },
  rubric: {
    requiredPoints: [
      "Explains the transaction boundary and rollback behavior.",
      "Identifies the observable recovery behavior after rollback.",
    ],
    rejectsGenericAnswer: true,
  },
};

class InMemoryRepository implements ProviderPipelineRepository {
  status: AttemptStatus = "processing";
  isCurrent = true;
  transcript: EncryptedTranscriptBundleV1 | undefined;
  frameSelection: FrameSelectionMetadataV1 = {
    schemaVersion: "1",
    selectionVersion: "frame-selection-v1",
    attemptId: ATTEMPT_ID,
    recordingDurationMs: 20_000,
    frames: [],
  };
  evaluation: EncryptedEvaluationBundleV1 | undefined;
  transitions: string[] = [];

  private binding() {
    return {
      attemptId: ATTEMPT_ID,
      revisionId: REVISION_ID,
      repositoryId: REPOSITORY_ID,
      headSha: SHA,
      status: this.status,
      isCurrent: this.isCurrent,
      deleteAfter: DELETE_AFTER,
    };
  }

  async loadTranscriptExtraction(): Promise<TranscriptExtractionContextV1> {
    return {
      schemaVersion: "1",
      ...this.binding(),
      recordingObjectId: RECORDING_ID,
      recordingDurationMs: 20_000,
      recordingManifestHash: MANIFEST_HASH,
      questions: [question],
    };
  }

  async persistTranscript(
    bundle: EncryptedTranscriptBundleV1,
  ): Promise<"created" | "replayed"> {
    if (this.transcript !== undefined) return "replayed";
    this.transcript = bundle;
    return "created";
  }

  async loadFrameSelection(): Promise<FrameSelectionContextV1> {
    if (this.transcript === undefined) throw new Error("missing transcript");
    return {
      schemaVersion: "1",
      ...this.binding(),
      recordingObjectId: RECORDING_ID,
      recordingDurationMs: 20_000,
      transcript: this.transcript,
    };
  }

  async persistFrameSelection(
    bundle: FrameSelectionStageBundleV1,
  ): Promise<"created" | "replayed"> {
    const existed = this.frameSelection.frames.length > 0;
    this.frameSelection = bundle.metadata;
    return existed ? "replayed" : "created";
  }

  async loadEvaluationRun(): Promise<EvaluationRunContextV1> {
    if (this.transcript === undefined) throw new Error("missing transcript");
    return {
      schemaVersion: "1",
      ...this.binding(),
      transcript: this.transcript,
      questions: [question],
      frameSelection: this.frameSelection,
    };
  }

  async persistEvaluation(
    bundle: EncryptedEvaluationBundleV1,
  ): Promise<"created" | "replayed"> {
    if (this.evaluation !== undefined) return "replayed";
    this.evaluation = bundle;
    return "created";
  }

  async loadEvaluationPolicy(): Promise<EvaluationPolicyContextV1> {
    if (this.evaluation === undefined) throw new Error("missing evaluation");
    return {
      schemaVersion: "1",
      ...this.binding(),
      evaluation: this.evaluation,
      repositoryPolicy: DEFAULT_REPOSITORY_POLICY_V1,
    };
  }

  async transitionToReviewRequired(input: {
    reason: "valid_policy" | "provider_manual_review";
  }): Promise<"updated" | "replayed" | "stale"> {
    if (
      !this.isCurrent ||
      !["processing", "review_required"].includes(this.status)
    ) {
      return "stale";
    }
    if (this.status === "review_required") return "replayed";
    this.status = "review_required";
    this.transitions.push(input.reason);
    return "updated";
  }

  async transitionToTechnicalRetry(input: {
    errorClass: string;
  }): Promise<"updated" | "replayed" | "stale"> {
    if (
      !this.isCurrent ||
      !["processing", "technical_retry"].includes(this.status)
    ) {
      return "stale";
    }
    if (this.status === "technical_retry") return "replayed";
    this.status = "technical_retry";
    this.transitions.push(input.errorClass);
    return "updated";
  }
}

class MemoryDispatcher implements ProviderPipelineDispatcher {
  readonly jobs: {
    name: ProviderPipelineJobName;
    payload: ProviderPipelineJobPayload;
  }[] = [];

  async enqueue(
    name: ProviderPipelineJobName,
    payload: ProviderPipelineJobPayload,
  ): Promise<void> {
    this.jobs.push({ name, payload });
  }
}

class OneFrameAdapter implements ProviderFrameSelectionAdapter {
  async select(input: {
    attemptId: string;
    recordingDurationMs: number;
  }): Promise<FrameSelectionMetadataV1> {
    return {
      schemaVersion: "1",
      selectionVersion: "frame-selection-v1",
      attemptId: input.attemptId,
      recordingDurationMs: input.recordingDurationMs,
      frames: [
        {
          id: FRAME_ID,
          timestampMs: 5_000,
          reasonCode: "answer_midpoint",
          reason: "Synthetic encrypted frame metadata for the worker test.",
          encryptedDerivativeRef: DERIVATIVE_ID,
          ciphertextSha256: FRAME_HASH,
          width: 640,
          height: 360,
        },
      ],
    };
  }
}

function sequenceNonceSource() {
  let nonce = 0;
  return (length: number) => new Uint8Array(length).fill(++nonce);
}

function fixture(overrides: Partial<ProviderPipelineDependencies> = {}) {
  const repository = new InMemoryRepository();
  const dispatcher = new MemoryDispatcher();
  const clock: ProviderClock = { now: () => NOW };
  const payloadCipher = new PayloadCipher(
    new Uint8Array(32).fill(9),
    sequenceNonceSource(),
  );
  const dependencies: ProviderPipelineDependencies = {
    repository,
    dispatcher,
    payloadCipher,
    transcriptionProvider: new LocalFakeTranscriptionProvider(clock),
    frameSelectionAdapter: new OneFrameAdapter(),
    judgeProvider: new LocalFakeMultimodalJudgeProvider(clock),
    clock,
    ...overrides,
  };
  return {
    repository,
    dispatcher,
    payloadCipher,
    handlers: createProviderPipelineHandlers(dependencies),
  };
}

const extractJob = {
  schemaVersion: "1" as const,
  idempotencyKey: "provider-test:extract",
  attemptId: ATTEMPT_ID,
  recordingObjectId: RECORDING_ID,
  expectedHeadSha: SHA,
};

describe("provider worker pipeline", () => {
  it("runs the four stages, encrypts sensitive DB payloads and always ends in review", async () => {
    const { handlers, repository, dispatcher, payloadCipher } = fixture();

    const extracted = await handlers.extractTranscript(extractJob);
    expect(extracted.outcome).toBe("completed");
    expect(repository.transcript?.encryptedPayload).not.toContain(
      "transaction boundary",
    );
    const transcript = decryptVersionedProviderPayload(
      payloadCipher,
      repository.transcript?.encryptedPayload ?? "",
      `slopproof:transcript:v1:${ATTEMPT_ID}:${repository.transcript?.transcriptId ?? ""}`,
      TranscriptV1Schema,
    );
    expect(transcript.segments[0]?.text.content).toContain(
      "transaction boundary",
    );
    expect(dispatcher.jobs[0]?.name).toBe("media.select-frames");

    const selectPayload = dispatcher.jobs[0]?.payload;
    const selected = await handlers.selectFrames(selectPayload);
    expect(selected.outcome).toBe("completed");
    expect(repository.frameSelection.frames).toHaveLength(1);
    expect(dispatcher.jobs[1]?.name).toBe("evaluation.run");

    const evaluationPayload = dispatcher.jobs[1]?.payload;
    const evaluated = await handlers.runEvaluation(evaluationPayload);
    expect(evaluated.outcome).toBe("completed");
    expect(repository.evaluation?.recommendation).toBe("pass");
    expect(repository.evaluation?.encryptedPayload).not.toContain(
      "questionEvaluations",
    );
    const evaluation = decryptVersionedProviderPayload(
      payloadCipher,
      repository.evaluation?.encryptedPayload ?? "",
      `slopproof:evaluation:v1:${ATTEMPT_ID}:${repository.evaluation?.evaluationId ?? ""}`,
      ProofEvaluationV1Schema,
    );
    expect(evaluation.recommendation).toBe("pass");
    expect(dispatcher.jobs[2]?.name).toBe("evaluation.apply-policy");

    const policyPayload = dispatcher.jobs[2]?.payload;
    const applied = await handlers.applyPolicy(policyPayload);
    expect(applied.outcome).toBe("completed");
    expect(repository.status).toBe("review_required");
    expect(repository.transitions).toEqual(["valid_policy"]);
    expect(dispatcher.jobs.map((job) => job.name)).toEqual([
      "media.select-frames",
      "evaluation.run",
      "evaluation.apply-policy",
    ]);
  });

  it("replays deterministic transcript persistence and never processes a stale SHA", async () => {
    const { handlers, repository, dispatcher } = fixture();
    await handlers.extractTranscript(extractJob);
    const replay = await handlers.extractTranscript(extractJob);
    expect(replay.outcome).toBe("replayed");

    repository.isCurrent = false;
    const stale = await handlers.extractTranscript({
      ...extractJob,
      idempotencyKey: "provider-test:stale",
    });
    expect(stale.outcome).toBe("stale");
    expect(dispatcher.jobs).toHaveLength(2);
  });

  it("routes review-class provider output errors to manual review", async () => {
    const base = fixture();
    await base.handlers.extractTranscript(extractJob);
    const judge: MultimodalJudgeProvider = {
      async evaluate(): Promise<ProofEvaluationV1> {
        throw new ProviderError(
          "INVALID_OUTPUT",
          "review",
          "synthetic invalid provider output",
        );
      },
    };
    const handlers = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: base.dispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider({
        now: () => NOW,
      }),
      frameSelectionAdapter: new EmptyLocalFrameSelectionAdapter(),
      judgeProvider: judge,
      clock: { now: () => NOW },
    });
    const transcriptId = base.repository.transcript?.transcriptId;
    const outcome = await handlers.runEvaluation({
      schemaVersion: "1",
      idempotencyKey: "provider-test:manual-review",
      attemptId: ATTEMPT_ID,
      transcriptId,
      expectedHeadSha: SHA,
    });

    expect(outcome.outcome).toBe("manual_review");
    expect(base.repository.status).toBe("review_required");
    expect(base.repository.transitions).toEqual(["provider_manual_review"]);
  });

  it("routes terminal provider failures to technical retry", async () => {
    const terminalProvider: TranscriptionProvider = {
      async transcribe() {
        throw new ProviderError(
          "INVALID_INPUT",
          "terminal",
          "synthetic terminal input",
        );
      },
    };
    const base = fixture({ transcriptionProvider: terminalProvider });
    const outcome = await base.handlers.extractTranscript(extractJob);

    expect(outcome.outcome).toBe("technical_retry");
    expect(base.repository.status).toBe("technical_retry");
    expect(base.repository.transitions).toEqual(["INVALID_INPUT"]);
  });

  it("rethrows retryable provider failures for pg-boss retry", async () => {
    const retryableProvider: TranscriptionProvider = {
      async transcribe() {
        throw new ProviderError(
          "PROVIDER_UNAVAILABLE",
          "retryable",
          "synthetic outage",
        );
      },
    };
    const base = fixture({ transcriptionProvider: retryableProvider });

    await expect(
      base.handlers.extractTranscript(extractJob),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      disposition: "retryable",
    });
    expect(base.repository.status).toBe("processing");
    expect(base.repository.transitions).toEqual([]);
  });

  it("strictly rejects unknown job data before external effects", async () => {
    const base = fixture();
    await expect(
      base.handlers.extractTranscript({
        ...extractJob,
        checkConclusion: "success",
      }),
    ).rejects.toThrow();
    expect(base.repository.transcript).toBeUndefined();
    expect(base.dispatcher.jobs).toEqual([]);
  });
});

describe("worker payload-key configuration", () => {
  it("accepts only canonical base64 encoding of exactly 32 bytes", () => {
    const encoded = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    expect(decodeProviderPayloadKeyBase64(encoded)).toEqual(
      new Uint8Array(32).fill(7),
    );
    expect(() => decodeProviderPayloadKeyBase64("not-a-secret-key")).toThrow(
      "PROVIDER_PAYLOAD_KEY_BASE64",
    );
    expect(() =>
      decodeProviderPayloadKeyBase64(
        Buffer.from(new Uint8Array(31)).toString("base64"),
      ),
    ).toThrow("PROVIDER_PAYLOAD_KEY_BASE64");
  });
});
