import type { AttemptStatus } from "@slopproof/domain";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@slopproof/policy";
import {
  LocalFakeMultimodalJudgeProvider,
  LocalFakeTranscriptionProvider,
  PayloadCipher,
  ProofEvaluationV1Schema,
  ProviderError,
  TranscriptV1Schema,
  multimodalJudgeCandidateHashV1,
  multimodalJudgeProviderInputHashV1,
  type FakeTranscriptionRequestV1,
  type FrameSelectionMetadataV1,
  type InlineMultimodalJudgeProvider,
  type MultimodalJudgeCandidateV1,
  type MultimodalJudgeProviderInputV1,
  type MultimodalJudgeProvider,
  type ProviderClock,
  type ProviderContextV1,
  type ProofEvaluationV1,
  type TranscriptV1,
  type TranscriptionProvider,
} from "@slopproof/providers";
import { describe, expect, it, vi } from "vitest";
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
  createGate5MultimodalJudgeBoundary,
  createProviderPipelineHandlers,
  decryptVersionedProviderPayload,
  decodeProviderPayloadKeyBase64,
  type ProviderFrameSelectionAdapter,
  type ProviderPipelineDependencies,
} from "./provider-pipeline";
import type {
  MultimodalEvaluationRepository,
  MultimodalEvaluationReplayInput,
  PersistMultimodalEvaluationPairInput,
  PersistedMultimodalEvaluationPair,
} from "./multimodal-evaluation-repository";
import {
  runMultimodalJudgeEvaluation,
  type MultimodalProofEvaluationV1,
} from "./multimodal-judge-service";

describe("Gate 5 multimodal startup boundary", () => {
  const clock: ProviderClock = { now: () => NOW };

  it("keeps the deterministic fake confined to the local profile", () => {
    expect(createGate5MultimodalJudgeBoundary("fake", clock)).toBeInstanceOf(
      LocalFakeMultimodalJudgeProvider,
    );
  });

  it("starts production without a fake and fails the deferred judge closed", async () => {
    const provider = createGate5MultimodalJudgeBoundary("hetzner", clock);

    expect(provider).not.toBeInstanceOf(LocalFakeMultimodalJudgeProvider);
    await expect(
      provider.evaluate({} as never, {} as never),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      disposition: "review",
    });
  });
});

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "10000000-0000-4000-8000-000000000002";
const REPOSITORY_ID = "10000000-0000-4000-8000-000000000003";
const RECORDING_ID = "10000000-0000-4000-8000-000000000004";
const QUESTION_ID = "10000000-0000-4000-8000-000000000005";
const FRAME_ID = "10000000-0000-4000-8000-000000000006";
const DERIVATIVE_ID = "10000000-0000-4000-8000-000000000007";
const SECOND_QUESTION_ID = "10000000-0000-4000-8000-000000000008";
const STORED_TRANSCRIPT_ID = "10000000-0000-4000-8000-000000000009";
const STORED_EVALUATION_ID = "10000000-0000-4000-8000-000000000010";
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

const secondQuestion: StoredProofQuestionV1 = {
  ...question,
  id: SECOND_QUESTION_ID,
  ordinal: 1,
  prompt: "Explain the externally observable behavior after recovery.",
};

class InMemoryRepository implements ProviderPipelineRepository {
  status: AttemptStatus = "processing";
  isCurrent = true;
  privateAccessEligible = true;
  deleteAfter = DELETE_AFTER;
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
      privateAccessEligible: this.privateAccessEligible,
      deleteAfter: this.deleteAfter,
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
      ...(this.transcript === undefined
        ? {}
        : { existingTranscript: this.transcript }),
    };
  }

  async persistTranscript(bundle: EncryptedTranscriptBundleV1): Promise<{
    status: "created" | "replayed";
    transcript: EncryptedTranscriptBundleV1;
  }> {
    if (this.transcript !== undefined) {
      return {
        status: "replayed",
        transcript: this.transcript,
      };
    }
    this.transcript = bundle;
    return { status: "created", transcript: bundle };
  }

  async schedulePersistedTranscript(): Promise<boolean> {
    return false;
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
      ...(this.evaluation === undefined
        ? {}
        : { existingEvaluation: this.evaluation }),
    };
  }

  async persistEvaluation(bundle: EncryptedEvaluationBundleV1): Promise<{
    status: "created" | "replayed";
    evaluation: EncryptedEvaluationBundleV1;
  }> {
    if (this.evaluation !== undefined) {
      return {
        status: "replayed",
        evaluation: this.evaluation,
      };
    }
    this.evaluation = bundle;
    return { status: "created", evaluation: bundle };
  }

  async schedulePersistedEvaluation(): Promise<boolean> {
    return false;
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

class InMemoryMultimodalEvaluationRepository implements MultimodalEvaluationRepository {
  existing: PersistedMultimodalEvaluationPair | null = null;
  persisted: PersistMultimodalEvaluationPairInput | undefined;
  readonly loadExistingAndSchedule = vi.fn(
    async (_input: MultimodalEvaluationReplayInput) => this.existing,
  );

  readonly persistPair = vi.fn(
    async (input: PersistMultimodalEvaluationPairInput) => {
      this.persisted = input;
      return {
        status: "created" as const,
        sidecarId: "10000000-0000-4000-8000-000000000099",
        multimodalEvaluation: input.multimodalEvaluation,
        compatibilityEvaluation: input.compatibilityEvaluation,
        downstreamScheduled: true,
      };
    },
  );
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

function transcriptFixture(
  input: {
    id?: string;
    segments?: TranscriptV1["segments"];
  } = {},
): TranscriptV1 {
  return TranscriptV1Schema.parse({
    schemaVersion: "1",
    transcriptVersion: "transcript-v1",
    id: input.id ?? "20000000-0000-4000-8000-000000000001",
    attemptId: ATTEMPT_ID,
    provider: "test-provider",
    model: "test-model-v1",
    language: "en",
    durationMs: 20_000,
    sourceSha256: MANIFEST_HASH,
    segments: input.segments ?? [
      {
        id: "20000000-0000-4000-8000-000000000002",
        questionId: QUESTION_ID,
        startMs: 0,
        endMs: 20_000,
        speaker: "contributor",
        text: {
          trust: "untrusted",
          source: "transcript",
          content: "A question-bound transcript fixture.",
        },
      },
    ],
    createdAt: NOW,
  });
}

function storedTranscriptBundle(): EncryptedTranscriptBundleV1 {
  return {
    schemaVersion: "1",
    payloadKind: "transcript",
    transcriptId: STORED_TRANSCRIPT_ID,
    attemptId: ATTEMPT_ID,
    provider: "stored-provider",
    transcriptSchemaVersion: "transcript-v1",
    encryptedPayload: "stored-encrypted-transcript",
    deleteAfter: DELETE_AFTER,
  };
}

function storedEvaluationBundle(): EncryptedEvaluationBundleV1 {
  return {
    schemaVersion: "1",
    payloadKind: "proof_evaluation",
    evaluationId: STORED_EVALUATION_ID,
    attemptId: ATTEMPT_ID,
    provider: "stored-provider",
    model: "stored-model",
    promptVersion: "proof-judge-system-v1",
    evaluationSchemaVersion: "proof-evaluation-v1",
    rubricVersion: "rubric-v1",
    recommendation: "pass",
    encryptedPayload: "stored-encrypted-evaluation",
    deleteAfter: DELETE_AFTER,
  };
}

function gate6EvaluationJob(transcriptId: string) {
  return {
    schemaVersion: "1" as const,
    idempotencyKey: "provider-test:gate6-evaluation",
    attemptId: ATTEMPT_ID,
    transcriptId,
    expectedHeadSha: SHA,
  };
}

function storedMultimodalEvaluationFixture(): MultimodalProofEvaluationV1 {
  const candidate: MultimodalJudgeCandidateV1 = {
    schemaVersion: "1",
    candidateVersion: "multimodal-judge-candidate-v1",
    recommendation: "review_required",
    questionEvaluations: [
      {
        questionId: QUESTION_ID,
        criterionResults: [
          {
            criterionId: deterministicTestCriterionId(),
            result: "not_evaluable",
            supportedPatchAnchorIds: [],
            reason: "question_evidence_unavailable",
          },
        ],
        contradictions: [],
        uncertainty: ["criterion_requires_maintainer_assessment"],
      },
    ],
    privateReason: "automated_evaluation_unavailable",
    warnings: ["frames_unavailable"],
  };
  return {
    schemaVersion: "1",
    evaluationVersion: "multimodal-proof-evaluation-v1",
    attemptId: ATTEMPT_ID,
    revisionId: REVISION_ID,
    headSha: SHA,
    candidate,
    invocationMetadata: {
      schemaVersion: "1",
      provider: "hetzner-inference",
      model: "judge-text",
      promptVersion: "proof-judge-system-v2",
      outputSchemaVersion: "multimodal-judge-candidate-v1",
      inputHash: "d".repeat(64),
      outputHash: multimodalJudgeCandidateHashV1(candidate),
      tokenUsage: null,
      latencyMs: 0,
      invocationCount: 0,
      outcome: "fallback",
      degraded: true,
      completedAt: NOW,
    },
    frameWarnings: ["frames_unavailable"],
    workflowOutcome: "review_required",
    manualReviewRequired: true,
    createdAt: NOW,
  };
}

function deterministicTestCriterionId(): string {
  return "10000000-0000-4000-8000-000000000098";
}

function gate6InlineFrameFixture() {
  return {
    id: FRAME_ID,
    timestampMs: 2_000,
    reasonCode: "transcript_alignment" as const,
    width: 320 as const,
    height: 180 as const,
    mediaType: "image/jpeg" as const,
    jpegBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  };
}

function unknownIdInlineProvider(): InlineMultimodalJudgeProvider & {
  evaluate: ReturnType<typeof vi.fn>;
} {
  const descriptor = {
    provider: "hetzner-inference",
    model: "judge-text",
    visionModel: "judge-vision",
  };
  return {
    descriptor,
    evaluate: vi.fn(async (input: MultimodalJudgeProviderInputV1) => {
      const candidate: MultimodalJudgeCandidateV1 = {
        schemaVersion: "1",
        candidateVersion: "multimodal-judge-candidate-v1",
        recommendation: "pass",
        questionEvaluations: [
          {
            questionId: "10000000-0000-4000-8000-000000000097",
            criterionResults: [
              {
                criterionId: input.questions[0]!.criteria[0]!.id,
                result: "met",
                supportedPatchAnchorIds: ["a0"],
                reason: "patch_evidence_supports_criterion",
              },
            ],
            contradictions: [],
            uncertainty: [],
          },
        ],
        privateReason: "all_stored_criteria_supported",
        warnings: [],
      };
      return {
        candidate,
        metadata: {
          schemaVersion: "1" as const,
          provider: descriptor.provider,
          model: descriptor.visionModel,
          promptVersion: "proof-judge-system-v2" as const,
          outputSchemaVersion: "multimodal-judge-candidate-v1" as const,
          inputHash: multimodalJudgeProviderInputHashV1(input),
          outputHash: multimodalJudgeCandidateHashV1(candidate),
          tokenUsage: null,
          latencyMs: 1,
          invocationCount: 1 as const,
          outcome: "generated" as const,
          degraded: false,
          completedAt: NOW,
        },
      };
    }),
  };
}

describe("provider worker pipeline", () => {
  it("uses authenticated recording intervals for production transcription without synthetic slicing", async () => {
    const base = fixture();
    const originalLoad = base.repository.loadTranscriptExtraction.bind(
      base.repository,
    );
    const source = {
      attemptId: ATTEMPT_ID,
      sourceSha256: MANIFEST_HASH,
      questionIntervals: [
        {
          questionId: QUESTION_ID,
          ordinal: 0,
          startMs: 125,
          endMs: 20_000,
        },
      ],
    } as never;
    base.repository.loadTranscriptExtraction = async () => ({
      ...(await originalLoad()),
      recordingAudio: {
        objectKey: "private/recordings/ciphertext.bin",
        source,
      },
    });
    const access = { openCiphertext: vi.fn() };
    const transcribe = vi.fn(async () =>
      TranscriptV1Schema.parse({
        schemaVersion: "1",
        transcriptVersion: "transcript-v1",
        id: "20000000-0000-4000-8000-000000000001",
        attemptId: ATTEMPT_ID,
        provider: "openrouter",
        model: "openai/whisper-large-v3-turbo",
        language: "en",
        durationMs: 20_000,
        sourceSha256: MANIFEST_HASH,
        segments: [
          {
            id: "20000000-0000-4000-8000-000000000002",
            questionId: QUESTION_ID,
            startMs: 125,
            endMs: 20_000,
            speaker: "contributor",
            text: {
              trust: "untrusted",
              source: "transcript",
              content: "A question-bound production transcript fixture.",
            },
          },
        ],
        createdAt: NOW,
      }),
    );
    const handlers = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: base.dispatcher,
      payloadCipher: base.payloadCipher,
      recordingTranscription: {
        adapter: { transcribe },
        ciphertextAccess: vi.fn(() => access),
      },
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: new LocalFakeMultimodalJudgeProvider({ now: () => NOW }),
      clock: { now: () => NOW },
    });

    const outcome = await handlers.extractTranscript(extractJob);

    expect(outcome.outcome).toBe("completed");
    expect(transcribe).toHaveBeenCalledWith(
      source,
      access,
      expect.objectContaining({ attemptId: ATTEMPT_ID }),
    );
    expect(base.repository.transcript?.provider).toBe("openrouter");
  });

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

  it("replays a crash-persisted transcript by its stored ID without provider or cipher access", async () => {
    const transcribe = vi.fn();
    const ciphertextAccess = vi.fn();
    const base = fixture({
      recordingTranscription: {
        adapter: { transcribe },
        ciphertextAccess,
      },
    });
    base.repository.transcript = storedTranscriptBundle();
    const persistTranscript = vi.spyOn(base.repository, "persistTranscript");
    const encryptJson = vi.spyOn(base.payloadCipher, "encryptJson");
    const decrypt = vi.spyOn(base.payloadCipher, "decrypt");

    const replay = await base.handlers.extractTranscript({
      ...extractJob,
      idempotencyKey: "provider-test:crash-replay",
    });

    expect(replay).toMatchObject({
      outcome: "replayed",
      artifactId: STORED_TRANSCRIPT_ID,
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(ciphertextAccess).not.toHaveBeenCalled();
    expect(encryptJson).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(persistTranscript).not.toHaveBeenCalled();
    expect(base.dispatcher.jobs).toEqual([
      expect.objectContaining({
        name: "media.select-frames",
        payload: expect.objectContaining({
          transcriptId: STORED_TRANSCRIPT_ID,
        }),
      }),
    ]);
  });

  it("replays a crash-persisted evaluation by its stored ID without judge or private payload access", async () => {
    const evaluate = vi.fn();
    const base = fixture({ judgeProvider: { evaluate } });
    base.repository.transcript = storedTranscriptBundle();
    base.repository.evaluation = storedEvaluationBundle();
    const persistEvaluation = vi.spyOn(base.repository, "persistEvaluation");
    const schedulePersistedEvaluation = vi.spyOn(
      base.repository,
      "schedulePersistedEvaluation",
    );
    const encryptJson = vi.spyOn(base.payloadCipher, "encryptJson");
    const decrypt = vi.spyOn(base.payloadCipher, "decrypt");

    const replay = await base.handlers.runEvaluation({
      schemaVersion: "1",
      idempotencyKey: "provider-test:evaluation-crash-replay",
      attemptId: ATTEMPT_ID,
      transcriptId: STORED_TRANSCRIPT_ID,
      expectedHeadSha: SHA,
    });

    expect(replay).toMatchObject({
      outcome: "replayed",
      artifactId: STORED_EVALUATION_ID,
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(encryptJson).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(persistEvaluation).not.toHaveBeenCalled();
    expect(schedulePersistedEvaluation).toHaveBeenCalledOnce();
    expect(base.dispatcher.jobs).toEqual([
      expect.objectContaining({
        name: "evaluation.apply-policy",
        payload: expect.objectContaining({
          evaluationId: STORED_EVALUATION_ID,
        }),
      }),
    ]);
  });

  it("persists a transcript before dispatch failure so replay never repeats transcription", async () => {
    const transcribe = vi.fn(async () => transcriptFixture());
    const failingDispatcher: ProviderPipelineDispatcher = {
      async enqueue() {
        throw new Error("synthetic downstream queue outage");
      },
    };
    const base = fixture({
      transcriptionProvider: { transcribe },
      dispatcher: failingDispatcher,
    });

    await expect(base.handlers.extractTranscript(extractJob)).rejects.toThrow(
      "synthetic downstream queue outage",
    );
    const storedId = base.repository.transcript?.transcriptId;
    expect(storedId).toBeDefined();
    const recoveryDispatcher = new MemoryDispatcher();
    const recovery = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: recoveryDispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: { transcribe },
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: new LocalFakeMultimodalJudgeProvider({ now: () => NOW }),
      clock: { now: () => NOW },
    });

    const replay = await recovery.extractTranscript({
      ...extractJob,
      idempotencyKey: "provider-test:dispatch-recovery",
    });

    expect(replay).toMatchObject({ outcome: "replayed", artifactId: storedId });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(recoveryDispatcher.jobs[0]).toMatchObject({
      name: "media.select-frames",
      payload: { transcriptId: storedId },
    });
  });

  it("persists an evaluation before dispatch failure so replay never repeats judging", async () => {
    const base = fixture();
    await base.handlers.extractTranscript(extractJob);
    await base.handlers.selectFrames(base.dispatcher.jobs[0]?.payload);
    const evaluationJob = base.dispatcher.jobs[1]?.payload;
    const localJudge = new LocalFakeMultimodalJudgeProvider({ now: () => NOW });
    const evaluate = vi.fn(localJudge.evaluate.bind(localJudge));
    const failingDispatcher: ProviderPipelineDispatcher = {
      async enqueue() {
        throw new Error("synthetic policy queue outage");
      },
    };
    const failing = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: failingDispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider({
        now: () => NOW,
      }),
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: { evaluate },
      clock: { now: () => NOW },
    });

    await expect(failing.runEvaluation(evaluationJob)).rejects.toThrow(
      "synthetic policy queue outage",
    );
    const storedId = base.repository.evaluation?.evaluationId;
    expect(storedId).toBeDefined();
    const recoveryDispatcher = new MemoryDispatcher();
    const recovery = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: recoveryDispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider({
        now: () => NOW,
      }),
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: { evaluate },
      clock: { now: () => NOW },
    });

    const replay = await recovery.runEvaluation(evaluationJob);

    expect(replay).toMatchObject({ outcome: "replayed", artifactId: storedId });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(recoveryDispatcher.jobs[0]).toMatchObject({
      name: "evaluation.apply-policy",
      payload: { evaluationId: storedId },
    });
  });

  it("does not access an adapter when private evidence is already expired", async () => {
    const transcribe = vi.fn();
    const ciphertextAccess = vi.fn();
    const base = fixture({
      recordingTranscription: {
        adapter: { transcribe },
        ciphertextAccess,
      },
    });
    base.repository.deleteAfter = NOW;
    const persistTranscript = vi.spyOn(base.repository, "persistTranscript");

    const outcome = await base.handlers.extractTranscript({
      ...extractJob,
      idempotencyKey: "provider-test:expired-at-load",
    });

    expect(outcome.outcome).toBe("stale");
    expect(transcribe).not.toHaveBeenCalled();
    expect(ciphertextAccess).not.toHaveBeenCalled();
    expect(persistTranscript).not.toHaveBeenCalled();
    expect(base.dispatcher.jobs).toEqual([]);
  });

  it("caps the provider deadline at deleteAfter and persists nothing when extraction crosses it", async () => {
    const deleteAfter = new Date(NOW.getTime() + 1_000);
    let currentTime = NOW;
    const transcribe = vi.fn(
      async (
        _input: FakeTranscriptionRequestV1,
        context: ProviderContextV1,
      ): Promise<TranscriptV1> => {
        expect(context.deadlineAt).toEqual(deleteAfter);
        currentTime = deleteAfter;
        return transcriptFixture();
      },
    );
    const base = fixture({
      transcriptionProvider: { transcribe },
      clock: { now: () => currentTime },
      providerTimeoutMs: 60_000,
    });
    base.repository.deleteAfter = deleteAfter;
    const persistTranscript = vi.spyOn(base.repository, "persistTranscript");

    const outcome = await base.handlers.extractTranscript({
      ...extractJob,
      idempotencyKey: "provider-test:crosses-retention-deadline",
    });

    expect(outcome.outcome).toBe("stale");
    expect(transcribe).toHaveBeenCalledOnce();
    expect(persistTranscript).not.toHaveBeenCalled();
    expect(base.repository.transcript).toBeUndefined();
    expect(base.dispatcher.jobs).toEqual([]);
  });

  it("uses uneven authenticated question intervals for the local fake transcript", async () => {
    const base = fixture();
    const originalLoad = base.repository.loadTranscriptExtraction.bind(
      base.repository,
    );
    base.repository.loadTranscriptExtraction = async () => ({
      ...(await originalLoad()),
      questions: [question, secondQuestion],
      recordingAudio: {
        objectKey: "private/recordings/ciphertext.bin",
        source: {
          attemptId: ATTEMPT_ID,
          sourceSha256: MANIFEST_HASH,
          questionIntervals: [
            {
              schemaVersion: "1",
              intervalVersion: "proof-question-interval-v1",
              questionId: QUESTION_ID,
              ordinal: 0,
              startMs: 250,
              endMs: 2_250,
              recordedDurationMs: 20_000,
              source: "mobile_navigation_v1",
            },
            {
              schemaVersion: "1",
              intervalVersion: "proof-question-interval-v1",
              questionId: SECOND_QUESTION_ID,
              ordinal: 1,
              startMs: 2_250,
              endMs: 20_000,
              recordedDurationMs: 20_000,
              source: "mobile_navigation_v1",
            },
          ],
        } as never,
      },
    });

    const outcome = await base.handlers.extractTranscript({
      ...extractJob,
      idempotencyKey: "provider-test:uneven-authenticated-intervals",
    });
    const bundle = base.repository.transcript;
    expect(outcome.outcome).toBe("completed");
    expect(bundle).toBeDefined();
    const transcript = decryptVersionedProviderPayload(
      base.payloadCipher,
      bundle?.encryptedPayload ?? "",
      `slopproof:transcript:v1:${ATTEMPT_ID}:${bundle?.transcriptId ?? ""}`,
      TranscriptV1Schema,
    );

    expect(
      transcript.segments.map(({ questionId, startMs, endMs }) => ({
        questionId,
        startMs,
        endMs,
      })),
    ).toEqual([
      { questionId: QUESTION_ID, startMs: 250, endMs: 2_250 },
      { questionId: SECOND_QUESTION_ID, startMs: 2_250, endMs: 20_000 },
    ]);
  });

  it("makes every private stage stale without external effects when lifecycle access is ineligible", async () => {
    const transcribe = vi.fn();
    const select = vi.fn();
    const evaluate = vi.fn();
    const base = fixture({
      transcriptionProvider: { transcribe },
      frameSelectionAdapter: { select },
      judgeProvider: { evaluate },
    });
    base.repository.privateAccessEligible = false;
    base.repository.transcript = storedTranscriptBundle();
    base.repository.evaluation = storedEvaluationBundle();
    const decrypt = vi.spyOn(base.payloadCipher, "decrypt");
    const encryptJson = vi.spyOn(base.payloadCipher, "encryptJson");
    const transition = vi.spyOn(base.repository, "transitionToReviewRequired");

    const outcomes = await Promise.all([
      base.handlers.extractTranscript({
        ...extractJob,
        idempotencyKey: "provider-test:ineligible-extract",
      }),
      base.handlers.selectFrames({
        schemaVersion: "1",
        idempotencyKey: "provider-test:ineligible-select",
        attemptId: ATTEMPT_ID,
        recordingObjectId: RECORDING_ID,
        transcriptId: STORED_TRANSCRIPT_ID,
        expectedHeadSha: SHA,
      }),
      base.handlers.runEvaluation({
        schemaVersion: "1",
        idempotencyKey: "provider-test:ineligible-evaluate",
        attemptId: ATTEMPT_ID,
        transcriptId: STORED_TRANSCRIPT_ID,
        expectedHeadSha: SHA,
      }),
      base.handlers.applyPolicy({
        schemaVersion: "1",
        idempotencyKey: "provider-test:ineligible-apply",
        attemptId: ATTEMPT_ID,
        evaluationId: STORED_EVALUATION_ID,
        expectedHeadSha: SHA,
      }),
    ]);

    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      "stale",
      "stale",
      "stale",
      "stale",
    ]);
    expect(transcribe).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(encryptJson).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(base.dispatcher.jobs).toEqual([]);
  });

  it("does not commit policy when retention expires after decrypt and before the transition", async () => {
    const base = fixture();
    await base.handlers.extractTranscript(extractJob);
    await base.handlers.selectFrames(base.dispatcher.jobs[0]?.payload);
    await base.handlers.runEvaluation(base.dispatcher.jobs[1]?.payload);
    const policyPayload = base.dispatcher.jobs[2]?.payload;
    let clockReads = 0;
    const transition = vi.spyOn(base.repository, "transitionToReviewRequired");
    const handlers = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: base.dispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider({
        now: () => NOW,
      }),
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: new LocalFakeMultimodalJudgeProvider({ now: () => NOW }),
      clock: {
        now: () => (clockReads++ === 0 ? NOW : DELETE_AFTER),
      },
    });

    const outcome = await handlers.applyPolicy(policyPayload);

    expect(outcome.outcome).toBe("stale");
    expect(transition).not.toHaveBeenCalled();
    expect(base.repository.status).toBe("processing");
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
          {
            telemetry: {
              lastFailureKind: "invalid_output",
              httpStatusClass: null,
              transportAttemptCount: 1,
            },
          },
        );
      },
    };
    const transition = vi.spyOn(base.repository, "transitionToReviewRequired");
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
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        providerErrorCode: "INVALID_OUTPUT",
        providerFailureTelemetry: {
          lastFailureKind: "invalid_output",
          httpStatusClass: null,
          transportAttemptCount: 1,
        },
      }),
    );
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

  it("routes retryable provider failures to finite technical retry", async () => {
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

    const outcome = await base.handlers.extractTranscript(extractJob);

    expect(outcome.outcome).toBe("technical_retry");
    expect(base.repository.status).toBe("technical_retry");
    expect(base.repository.transitions).toEqual(["PROVIDER_UNAVAILABLE"]);
  });

  it("runs the frozen Gate 6 service once and persists missing frames as authoritative not_evaluable review", async () => {
    const base = fixture();
    await base.handlers.extractTranscript(extractJob);
    base.dispatcher.jobs.length = 0;
    const sidecars = new InMemoryMultimodalEvaluationRepository();
    const provider: InlineMultimodalJudgeProvider = {
      descriptor: {
        provider: "hetzner-inference",
        model: "judge-text",
        visionModel: "judge-vision",
      },
      evaluate: vi.fn(),
    };
    const storage = { getObjectStream: vi.fn() };
    const evaluate = vi.fn(runMultimodalJudgeEvaluation);
    const handlers = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: base.dispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider({
        now: () => NOW,
      }),
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: createGate5MultimodalJudgeBoundary("hetzner", {
        now: () => NOW,
      }),
      multimodalJudge: {
        provider,
        repository: sidecars,
        frameStorage: storage,
        evaluate,
      },
      clock: { now: () => NOW },
    });

    const outcome = await handlers.runEvaluation(
      gate6EvaluationJob(base.repository.transcript!.transcriptId),
    );

    expect(outcome.outcome).toBe("completed");
    expect(evaluate).toHaveBeenCalledOnce();
    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    const authoritative = sidecars.persisted?.multimodalEvaluation;
    expect(authoritative).toMatchObject({
      workflowOutcome: "review_required",
      manualReviewRequired: true,
      candidate: {
        recommendation: "review_required",
        questionEvaluations: [
          {
            criterionResults: expect.arrayContaining([
              expect.objectContaining({
                criterionId: expect.any(String),
                result: "not_evaluable",
              }),
            ]),
          },
        ],
      },
    });
    expect(sidecars.persisted?.evaluationInputHash).toBe(
      authoritative?.invocationMetadata.inputHash,
    );
    const compatibility = decryptVersionedProviderPayload(
      base.payloadCipher,
      sidecars.persisted?.compatibilityEvaluation.encryptedPayload ?? "",
      `slopproof:evaluation:v1:${ATTEMPT_ID}:${sidecars.persisted?.compatibilityEvaluation.evaluationId ?? ""}`,
      ProofEvaluationV1Schema,
    );
    expect(compatibility.recommendation).toBe("review_required");
    expect(compatibility.questionEvaluations[0]).toMatchObject({
      questionId: QUESTION_ID,
      outcome: "not_evaluable",
      rubricFindings: [
        {
          result: "met",
          reason: "Compatibility-only sentinel; consult authoritative sidecar.",
        },
      ],
    });
    expect(
      compatibility.questionEvaluations[0]?.rubricFindings[0]?.criterionId,
    ).not.toBe(
      authoritative?.candidate.questionEvaluations[0]?.criterionResults[0]
        ?.criterionId,
    );
    const serviceInput = evaluate.mock.calls[0]?.[0];
    expect(serviceInput).toMatchObject({
      attemptId: ATTEMPT_ID,
      revisionId: REVISION_ID,
      headSha: SHA,
    });
    expect(JSON.stringify(serviceInput)).not.toContain(REPOSITORY_ID);
    expect(JSON.stringify(serviceInput)).not.toMatch(
      /author|identity|practice/i,
    );
  });

  it("replays the exact authoritative sidecar before transcript, frame, or provider access", async () => {
    const base = fixture();
    await base.handlers.extractTranscript(extractJob);
    base.dispatcher.jobs.length = 0;
    const sidecars = new InMemoryMultimodalEvaluationRepository();
    const compatibilityEvaluation = {
      ...storedEvaluationBundle(),
      recommendation: "review_required" as const,
    };
    sidecars.existing = {
      sidecarId: "10000000-0000-4000-8000-000000000099",
      multimodalEvaluation: storedMultimodalEvaluationFixture(),
      compatibilityEvaluation,
      downstreamScheduled: true,
    };
    const provider = {
      descriptor: {
        provider: "hetzner-inference",
        model: "judge-text",
        visionModel: "judge-vision",
      },
      evaluate: vi.fn(),
    } satisfies InlineMultimodalJudgeProvider;
    const storage = { getObjectStream: vi.fn() };
    const evaluate = vi.fn(runMultimodalJudgeEvaluation);
    const decrypt = vi.spyOn(base.payloadCipher, "decrypt");
    const handlers = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: base.dispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider({
        now: () => NOW,
      }),
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: createGate5MultimodalJudgeBoundary("hetzner", {
        now: () => NOW,
      }),
      multimodalJudge: {
        provider,
        repository: sidecars,
        frameStorage: storage,
        evaluate,
      },
      clock: { now: () => NOW },
    });

    const outcome = await handlers.runEvaluation(
      gate6EvaluationJob(base.repository.transcript!.transcriptId),
    );

    expect(outcome).toMatchObject({
      outcome: "replayed",
      artifactId: STORED_EVALUATION_ID,
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(sidecars.persistPair).not.toHaveBeenCalled();
    expect(base.dispatcher.jobs).toEqual([]);
  });

  it("fails closed to maintainer review when the judge returns unknown IDs", async () => {
    const base = fixture();
    await base.handlers.extractTranscript(extractJob);
    base.dispatcher.jobs.length = 0;
    const sidecars = new InMemoryMultimodalEvaluationRepository();
    const provider = unknownIdInlineProvider();
    const evaluate = vi.fn(
      (
        input: Parameters<typeof runMultimodalJudgeEvaluation>[0],
        context: Parameters<typeof runMultimodalJudgeEvaluation>[1],
        dependencies: Parameters<typeof runMultimodalJudgeEvaluation>[2],
      ) =>
        runMultimodalJudgeEvaluation(input, context, {
          ...dependencies,
          loadFrames: vi.fn(async () => ({
            frames: [gate6InlineFrameFixture()],
            warnings: [],
          })),
        }),
    );
    const handlers = createProviderPipelineHandlers({
      repository: base.repository,
      dispatcher: base.dispatcher,
      payloadCipher: base.payloadCipher,
      transcriptionProvider: new LocalFakeTranscriptionProvider({
        now: () => NOW,
      }),
      frameSelectionAdapter: new OneFrameAdapter(),
      judgeProvider: createGate5MultimodalJudgeBoundary("hetzner", {
        now: () => NOW,
      }),
      multimodalJudge: {
        provider,
        repository: sidecars,
        frameStorage: { getObjectStream: vi.fn() },
        evaluate,
      },
      clock: { now: () => NOW },
    });

    const outcome = await handlers.runEvaluation(
      gate6EvaluationJob(base.repository.transcript!.transcriptId),
    );

    expect(outcome.outcome).toBe("manual_review");
    expect(provider.evaluate).toHaveBeenCalledOnce();
    expect(sidecars.persisted).toBeUndefined();
    expect(base.repository.status).toBe("review_required");
    expect(base.repository.transitions).toEqual(["provider_manual_review"]);
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
