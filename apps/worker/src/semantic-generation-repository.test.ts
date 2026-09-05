import {
  analyzePullRequestPatch,
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  buildGenerationContextV1,
} from "@understandproof/analysis";
import type { DatabaseConnection, JobPayload } from "@understandproof/db";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { PostgresSemanticGenerationRepository } from "./semantic-generation-repository";
import type {
  SemanticProofReadyWriter,
  SemanticTransactionalScheduler,
} from "./semantic-generation-contracts";

describe("Gate 4 persistence boundary", () => {
  it("heals semantic scheduling through recover-or-expedite and freezes budget exactly", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("INSERT INTO semantic_generation_budgets")) {
        return { rowCount: 1, rows: [{ generation_context_id: IDS.context }] };
      }
      if (statement.includes("FROM semantic_generation_budgets")) {
        return {
          rowCount: 1,
          rows: [
            {
              repository_id: IDS.repository,
              revision_id: IDS.revision,
              repository_policy_id: IDS.policy,
              head_sha: HEAD,
              question_budget: 3,
              budget_version: "semantic-generation-budget-v1",
            },
          ],
        };
      }
      if (statement.includes("AS should_schedule")) {
        return {
          rowCount: 1,
          rows: [{ proof_ready: false, should_schedule: true }],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const scheduler = schedulerFixture();
    const repository = repositoryFixture(query, scheduler);

    const outcome = await repository.scheduleRevisionSemanticGeneration(
      { query } as unknown as PoolClient,
      {
        repositoryId: IDS.repository,
        revisionId: IDS.revision,
        generationContextId: IDS.context,
        repositoryPolicyId: IDS.policy,
        headSha: HEAD,
        questionBudget: 3,
      },
    );

    expect(outcome).toBe("created");
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledTimes(1);
    expect(scheduler.recoverOrExpedite).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "semantic.generate-proof-questions",
      expect.objectContaining({
        revisionId: IDS.revision,
        generationContextId: IDS.context,
        expectedHeadSha: HEAD,
      }),
    );
  });

  it("rejects Practice answers over the exact UTF-8 byte ceiling before DB access", async () => {
    const query = vi.fn();
    const repository = repositoryFixture(query, schedulerFixture());

    await expect(
      repository.submitPracticeAnswer({
        repositoryId: IDS.repository,
        revisionId: IDS.revision,
        generationContextId: IDS.context,
        practiceSessionId: IDS.session,
        practiceQuestionId: IDS.question,
        userId: "author-1",
        actorKeyHash: "a".repeat(64),
        answer: {
          trust: "untrusted",
          source: "contributor_answer",
          content: "🧪".repeat(1_001),
        },
      }),
    ).rejects.toThrow("UTF-8 byte limit");
    expect(query).not.toHaveBeenCalled();
  });

  it("replaces an active Practice session when a newer Learning bundle is selected", async () => {
    const previousSessionId = IDS.session;
    const previousBundleId = IDS.bundle;
    const nextBundleId = "82000000-0000-4000-8000-000000000008";
    const deleteAfter = new Date("2026-08-14T00:00:00.000Z");
    const now = new Date("2026-08-13T00:00:00.000Z");
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("SELECT clock_timestamp() AS now")) {
        return { rows: [{ now }], rowCount: 1 };
      }
      if (statement.includes("count(*)::int AS event_count")) {
        return {
          rows: [{ event_count: 0, retry_after: null }],
          rowCount: 1,
        };
      }
      if (
        statement.includes("FROM semantic_learning_bundles bundle") &&
        statement.includes("bundle.id = $1")
      ) {
        return {
          rows: [
            {
              head_sha: HEAD,
              context_hash: "b".repeat(64),
              delete_after: deleteAfter,
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("SELECT id, learning_bundle_id, delete_after")) {
        return {
          rows: [
            {
              id: previousSessionId,
              learning_bundle_id: previousBundleId,
              delete_after: deleteAfter,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = repositoryFixture(query, schedulerFixture());

    const started = await repository.startPracticeSession({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId: IDS.context,
      learningBundleId: nextBundleId,
      userId: "author-1",
      actorKeyHash: "c".repeat(64),
    });

    expect(started.sessionId).not.toBe(previousSessionId);
    expect(started.deleteAfter).toEqual(deleteAfter);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET invalidated_at = clock_timestamp()"),
      [previousSessionId],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO practice_sessions"),
      expect.arrayContaining([nextBundleId]),
    );
  });

  it("returns unavailable without decrypting when actor/lifecycle binding is absent", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const decryptJson = vi.fn();
    const repository = new PostgresSemanticGenerationRepository(
      databaseFixture(query),
      { encryptJson: vi.fn(), decryptJson },
      schedulerFixture(),
      proofReadyFixture(),
    );

    await expect(
      repository.readPracticeView({
        repositoryId: IDS.repository,
        revisionId: IDS.revision,
        generationContextId: IDS.context,
        userId: "foreign-author",
      }),
    ).resolves.toEqual({ state: "unavailable" });
    expect(decryptJson).not.toHaveBeenCalled();
    const bindingCall = (query.mock.calls as unknown[][]).find((call) =>
      String(call.at(0) ?? "").includes("FROM semantic_generation_budgets"),
    );
    const firstStatement = String(bindingCall?.at(0) ?? "");
    expect(firstStatement).toContain("pull_request.author_id = $4");
    expect(firstStatement).toContain("repository.status = 'active'");
    expect(firstStatement).toContain("installation.status = 'active'");
  });

  it("requeues every due private artifact via the failed-singleton healing port", async () => {
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement === "BEGIN" || statement === "COMMIT") {
          return { rows: [], rowCount: 0 };
        }
        if (statement.includes("FROM (")) {
          return {
            rowCount: 1,
            rows: [
              {
                artifact_id: IDS.bundle,
                revision_id: IDS.revision,
                artifact_kind: "learning_bundle_v1",
                delete_after: new Date("2026-08-13T00:00:00.000Z"),
              },
            ],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const scheduler = schedulerFixture();
    const repository = new PostgresSemanticGenerationRepository(
      {
        pool: {
          connect: vi.fn(async () => client),
        },
      } as unknown as DatabaseConnection,
      { encryptJson: vi.fn(), decryptJson: vi.fn() },
      scheduler,
      proofReadyFixture(),
    );

    await expect(
      repository.sweepDueSemanticPrivate(new Date("2026-08-13T00:01:00.000Z")),
    ).resolves.toEqual({ scanned: 1, requeued: 1 });
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledWith(
      expect.anything(),
      "semantic.expire-private",
      expect.objectContaining({
        artifactId: IDS.bundle,
        artifactKind: "learning_bundle_v1",
      }),
      new Date("2026-08-13T00:00:00.000Z"),
    );
  });

  it("heals incomplete Learning and Proof singletons from durable active budgets", async () => {
    const client = {
      query: vi.fn(async (statement: string) => {
        if (statement.includes("FROM semantic_generation_budgets budget")) {
          return {
            rowCount: 1,
            rows: [
              {
                generation_context_id: IDS.context,
                revision_id: IDS.revision,
                head_sha: HEAD,
                needs_learning: true,
                needs_proof: true,
              },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const scheduler = schedulerFixture();
    const repository = new PostgresSemanticGenerationRepository(
      {
        pool: { connect: vi.fn(async () => client) },
      } as unknown as DatabaseConnection,
      { encryptJson: vi.fn(), decryptJson: vi.fn() },
      scheduler,
      proofReadyFixture(),
    );

    await expect(
      repository.sweepDueSemanticPrivate(new Date("2026-08-13T00:01:00.000Z")),
    ).resolves.toEqual({ scanned: 1, requeued: 2 });
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledWith(
      expect.anything(),
      "semantic.generate-learning",
      expect.objectContaining({ generationContextId: IDS.context }),
    );
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledWith(
      expect.anything(),
      "semantic.generate-proof-questions",
      expect.objectContaining({ generationContextId: IDS.context }),
    );
  });

  it("does not enqueue semantic Proof over an already issued Legacy Attempt", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("INSERT INTO semantic_generation_budgets")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("FROM semantic_generation_budgets")) {
        return {
          rowCount: 1,
          rows: [
            {
              repository_id: IDS.repository,
              revision_id: IDS.revision,
              repository_policy_id: IDS.policy,
              head_sha: HEAD,
              question_budget: 3,
              budget_version: "semantic-generation-budget-v1",
            },
          ],
        };
      }
      if (statement.includes("AS should_schedule")) {
        return {
          rowCount: 1,
          rows: [{ proof_ready: true, should_schedule: false }],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const scheduler = schedulerFixture();
    const repository = repositoryFixture(query, scheduler);

    await expect(
      repository.scheduleRevisionSemanticGeneration(
        { query } as unknown as PoolClient,
        {
          repositoryId: IDS.repository,
          revisionId: IDS.revision,
          generationContextId: IDS.context,
          repositoryPolicyId: IDS.policy,
          headSha: HEAD,
          questionBudget: 3,
        },
      ),
    ).resolves.toBe("replayed");
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledTimes(1);
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledWith(
      expect.anything(),
      "semantic.generate-learning",
      expect.anything(),
    );
  });

  it("does not insert a Learning run while frozen Proof content is pending", async () => {
    const query = reserveRunQueryFixture({ proofReady: false });
    const repository = repositoryFixture(query, schedulerFixture());

    await expect(
      repository.reserveRun("semantic.generate-learning", learningPayload()),
    ).resolves.toBe("proof_pending");
    expect(
      query.mock.calls.some((call) =>
        String(call.at(0) ?? "").includes(
          "INSERT INTO semantic_generation_runs",
        ),
      ),
    ).toBe(false);
  });

  it("arms the full Learning deadline only after frozen Proof content exists", async () => {
    const now = new Date("2026-08-19T15:46:12.000Z");
    const query = reserveRunQueryFixture({ proofReady: true, now });
    const repository = repositoryFixture(query, schedulerFixture());

    const reserved = await repository.reserveRun(
      "semantic.generate-learning",
      learningPayload(),
    );

    expect(reserved).not.toBe("stale");
    expect(reserved).not.toBe("proof_pending");
    if (reserved === "stale" || reserved === "proof_pending") return;
    expect(reserved.createdAt).toEqual(now);
    expect(reserved.deadlineAt).toEqual(new Date(now.getTime() + 8 * 60_000));
    expect(reserved.completedArtifactId).toBeNull();
    const insert = query.mock.calls.find((call) =>
      String(call.at(0) ?? "").includes("INSERT INTO semantic_generation_runs"),
    );
    expect(insert?.at(1)).toEqual(
      expect.arrayContaining([now, new Date(now.getTime() + 8 * 60_000)]),
    );
  });
});

const IDS = {
  repository: "82000000-0000-4000-8000-000000000001",
  revision: "82000000-0000-4000-8000-000000000002",
  context: "82000000-0000-4000-8000-000000000003",
  policy: "82000000-0000-4000-8000-000000000004",
  session: "82000000-0000-4000-8000-000000000005",
  question: "82000000-0000-4000-8000-000000000006",
  bundle: "82000000-0000-4000-8000-000000000007",
} as const;
const HEAD = "a".repeat(40);

function schedulerFixture(): SemanticTransactionalScheduler & {
  schedule: ReturnType<typeof vi.fn>;
  recoverOrExpedite: ReturnType<typeof vi.fn>;
  scheduleAttemptExpiry: ReturnType<typeof vi.fn>;
} {
  return {
    schedule: vi.fn(async () => undefined),
    recoverOrExpedite: vi.fn(async () => undefined),
    scheduleAttemptExpiry: vi.fn(async () => undefined),
  };
}

function proofReadyFixture(): SemanticProofReadyWriter {
  return {
    write: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
}

function databaseFixture(query: ReturnType<typeof vi.fn>): DatabaseConnection {
  return {
    pool: {
      query,
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    },
  } as unknown as DatabaseConnection;
}

function repositoryFixture(
  query: ReturnType<typeof vi.fn>,
  scheduler: SemanticTransactionalScheduler,
) {
  return new PostgresSemanticGenerationRepository(
    databaseFixture(query),
    { encryptJson: vi.fn(), decryptJson: vi.fn() },
    scheduler,
    proofReadyFixture(),
  );
}

function learningPayload(): JobPayload<"semantic.generate-learning"> {
  return {
    schemaVersion: "1",
    idempotencyKey: `semantic.learning.v3:${IDS.context}`,
    artifactKind: "learning_bundle_v1",
    revisionId: IDS.revision,
    generationContextId: IDS.context,
    expectedHeadSha: HEAD,
  };
}

function reserveRunQueryFixture(input: {
  proofReady: boolean;
  now?: Date;
}): ReturnType<typeof vi.fn> {
  const now = input.now ?? new Date("2026-08-19T15:41:35.000Z");
  const context = generationContextFixture();
  let inserted: unknown[] | undefined;
  return vi.fn(async (statement: string, values: unknown[] = []) => {
    if (
      statement === "BEGIN" ||
      statement === "COMMIT" ||
      statement === "ROLLBACK" ||
      statement.includes("pg_advisory_xact_lock")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (statement.includes("FROM generation_contexts context")) {
      return {
        rowCount: 1,
        rows: [
          {
            repository_id: IDS.repository,
            revision_id: IDS.revision,
            generation_context_id: IDS.context,
            author_id: "author-1",
            repository_policy_id: IDS.policy,
            head_sha: HEAD,
            context_hash: context.contextHash,
            context,
            question_budget: 3,
            is_current: true,
            pull_request_state: "open",
          },
        ],
      };
    }
    if (statement.includes("SELECT clock_timestamp() AS now")) {
      return { rows: [{ now }], rowCount: 1 };
    }
    if (statement.includes("FROM proof_plans plan")) {
      return input.proofReady
        ? {
            rowCount: 1,
            rows: [
              {
                semantic_plan: null,
                legacy_questions: [
                  {
                    prompt: "Explain the exact cache-miss return change.",
                    rubric: {
                      requiredPoints: [
                        "Name the previous empty-string fallback.",
                        "Name the new null miss return.",
                      ],
                    },
                  },
                ],
              },
            ],
          }
        : { rows: [], rowCount: 0 };
    }
    if (statement.includes("INSERT INTO semantic_generation_runs")) {
      inserted = values;
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes("FROM semantic_generation_runs")) {
      if (inserted === undefined) return { rows: [], rowCount: 0 };
      return {
        rowCount: 1,
        rows: [
          {
            id: "82000000-0000-4000-8000-000000000099",
            idempotency_key: inserted[0],
            purpose: inserted[1],
            repository_id: inserted[2],
            revision_id: inserted[3],
            generation_context_id: inserted[4],
            practice_session_id: inserted[5],
            practice_question_id: inserted[6],
            practice_answer_id: inserted[7],
            artifact_seed: inserted[8],
            question_count: inserted[9],
            created_at: inserted[10],
            deadline_at: inserted[11],
            delete_after: inserted[12],
            artifact_id: null,
          },
        ],
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

function generationContextFixture() {
  const bounded = buildBoundedRevisionSourceV1({
    githubPullRequestId: "8201",
    number: 8,
    state: "open",
    draft: false,
    title: "Return an explicit cache miss",
    body: "Replace the empty-string fallback with null.",
    authorId: "8205",
    authorLogin: "contributor",
    headSha: HEAD,
    baseSha: "b".repeat(40),
    changedFiles: 1,
    isFork: false,
    files: [
      {
        sha: "c".repeat(40),
        gitKind: "blob" as const,
        filename: "src/cache.ts",
        previousFilename: null,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch:
          "@@ -1,1 +1,1 @@\n-return cache.get(key) ?? '';\n+return cache.get(key) ?? null;",
      },
    ],
    limitsHit: {
      files: false,
      patchBytes: false,
      patchUnavailable: false,
    },
  });
  const analysis = analyzePullRequestPatch(boundedRevisionSourcePatch(bounded));
  return buildGenerationContextV1({
    revisionId: IDS.revision,
    analysisSnapshotId: IDS.context,
    boundedSource: bounded,
    analysis,
  });
}
