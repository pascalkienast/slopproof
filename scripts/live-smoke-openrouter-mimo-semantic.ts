#!/usr/bin/env node

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  analyzePullRequestPatch,
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  buildGenerationContextV1,
  type GenerationContextV1,
} from "@understandproof/analysis";
import {
  HetznerLearningMaterialProvider,
  HetznerPracticeCoachProvider,
  HetznerProofQuestionProvider,
  type SemanticProviderInvocationMetadataV1,
} from "@understandproof/providers";
import { createSemanticGenerationService } from "../apps/worker/src/semantic-generation";
import {
  LiveSmokeError,
  requireSmokeEnvironment,
  runGuardedLiveSmoke,
} from "./lib/live-smoke.mjs";

const MIMO_MODEL = "xiaomi/mimo-v2.5";
const ROUNDS = 3;
const FORBIDDEN_PROOF_CONTENT = Object.freeze([
  "reserved-proof-content-sentinel-f7d635c28f4d",
]);

async function main(): Promise<void> {
  const configuration = requireSmokeEnvironment(process.env, {
    GENERATION_PROVIDER: "openrouter",
    GENERATION_BASE_URL: undefined,
    GENERATION_API_KEY: undefined,
    LEARNING_MODEL: MIMO_MODEL,
    PRACTICE_MODEL: MIMO_MODEL,
    PROOF_QUESTION_MODEL: MIMO_MODEL,
  });
  const providerConfiguration = {
    provider: "openrouter" as const,
    baseUrl: configuration.GENERATION_BASE_URL,
    apiKey: configuration.GENERATION_API_KEY,
    model: MIMO_MODEL,
  };
  const service = createSemanticGenerationService({
    learningMaterialProvider: new HetznerLearningMaterialProvider(
      providerConfiguration,
    ),
    practiceCoachProvider: new HetznerPracticeCoachProvider(
      providerConfiguration,
    ),
    proofQuestionProvider: new HetznerProofQuestionProvider(
      providerConfiguration,
    ),
    clock: {
      now: () => new Date(),
      monotonicNowMs: () => performance.now(),
    },
  });
  const generationContext = representativeGenerationContext();

  for (let round = 0; round < ROUNDS; round += 1) {
    const [learning, proof] = await Promise.all([
      service.generateLearningBundle({
        ...requestBase(generationContext, `learning:${String(round)}`),
        requestVersion: "generate-learning-bundle-v1",
        practiceQuestionCount: 3,
        forbiddenProofContent: FORBIDDEN_PROOF_CONTENT,
      }),
      service.generateProofQuestionPlan({
        ...requestBase(generationContext, `proof:${String(round)}`),
        requestVersion: "generate-proof-question-plan-v1",
        questionBudget: 4,
      }),
    ]);
    assertGenerated("learning", learning.providerMetadata, learning.degraded);
    assertGenerated("proof", proof.providerMetadata, proof.degraded);

    const practiceQuestion = learning.artifact.practiceQuestions[0];
    if (practiceQuestion === undefined) {
      throw new LiveSmokeError("semantic_learning_failed");
    }
    const feedback = await service.generatePracticeFeedback({
      ...requestBase(generationContext, `practice:${String(round)}`),
      requestVersion: "generate-practice-feedback-v1",
      practiceQuestion,
      contributorAnswer: {
        trust: "untrusted",
        source: "contributor_answer",
        content:
          "The bounded hunk replaces legacy retry handling with an audited no-store policy and raises the retry cap to three.",
      },
      forbiddenProofContent: FORBIDDEN_PROOF_CONTENT,
    });
    assertGenerated("practice", feedback.providerMetadata, feedback.degraded);
  }
}

function assertGenerated(
  purpose: "learning" | "practice" | "proof",
  metadata: SemanticProviderInvocationMetadataV1,
  degraded: boolean,
): void {
  if (
    degraded ||
    metadata.outcome !== "generated" ||
    metadata.invocationCount !== 1 ||
    metadata.provider !== "openrouter" ||
    metadata.model !== MIMO_MODEL
  ) {
    throw new LiveSmokeError(`semantic_${purpose}_failed`);
  }
}

function requestBase(
  generationContext: GenerationContextV1,
  seedMaterial: string,
) {
  const createdAt = new Date();
  return {
    schemaVersion: "1" as const,
    generationContext,
    artifactSeed: createHash("sha256").update(seedMaterial).digest("hex"),
    artifactCreatedAt: createdAt,
    deadlineAt: new Date(createdAt.getTime() + 3 * 60_000),
    deleteAfter: new Date(createdAt.getTime() + 60 * 60_000),
  };
}

function representativeGenerationContext(): GenerationContextV1 {
  const files = Array.from({ length: 10 }, (_, fileIndex) => {
    const patch = Array.from({ length: 3 }, (_, hunkIndex) => {
      const start = hunkIndex * 100 + 1;
      const removed = Array.from(
        { length: 18 },
        (_, lineIndex) =>
          `-export const policy_${String(fileIndex)}_${String(hunkIndex)}_${String(lineIndex)} = legacyPolicy({ retries: 2, audit: false, cache: "private" });`,
      );
      const added = Array.from(
        { length: 18 },
        (_, lineIndex) =>
          `+export const policy_${String(fileIndex)}_${String(hunkIndex)}_${String(lineIndex)} = boundedPolicy({ retries: 3, audit: true, cache: "no-store" });`,
      );
      return [
        `@@ -${String(start)},18 +${String(start)},18 @@ export function policy_${String(fileIndex)}_${String(hunkIndex)}() {`,
        ...removed,
        ...added,
      ].join("\n");
    }).join("\n");
    return {
      sha: createHash("sha1")
        .update(`semantic-smoke-file:${String(fileIndex)}`)
        .digest("hex"),
      gitKind: "blob" as const,
      filename: `src/features/feature-${String(fileIndex).padStart(2, "0")}/policy.ts`,
      previousFilename: null,
      status: "modified" as const,
      additions: 54,
      deletions: 54,
      changes: 108,
      patch,
    };
  });
  const bounded = buildBoundedRevisionSourceV1({
    githubPullRequestId: "999001",
    number: 999,
    state: "open",
    draft: false,
    title: "Harden thirty bounded retry and audit transitions",
    body: "Replace legacy retry policies with audited no-store behavior across ten modules.",
    authorId: "999002",
    authorLogin: "semantic-smoke-contributor",
    headSha: "2".repeat(40),
    baseSha: "1".repeat(40),
    changedFiles: files.length,
    isFork: false,
    files,
    limitsHit: {
      files: false,
      patchBytes: false,
      patchUnavailable: false,
    },
  });
  const context = buildGenerationContextV1({
    revisionId: "10000000-0000-4000-8000-000000000901",
    analysisSnapshotId: "10000000-0000-4000-8000-000000000902",
    boundedSource: bounded,
    analysis: analyzePullRequestPatch(boundedRevisionSourcePatch(bounded)),
    excerpts: [],
  });
  if (
    context.allowedAnchorIds.length !== 30 ||
    context.usage.providerBytes < 90_000 ||
    context.usage.providerBytes > 180_000
  ) {
    throw new LiveSmokeError("invalid_fixture");
  }
  return context;
}

process.exitCode = await runGuardedLiveSmoke({
  name: "openrouter-mimo-semantic",
  action: main,
});
