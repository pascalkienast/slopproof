import { createHash, randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrateDatabase,
  persistGithubRevisionSourceInTransaction,
  startJobQueue,
  type DatabaseConnection,
} from "@slopproof/db";
import {
  analyzePullRequestPatch,
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  buildGenerationContextV1,
  type GenerationContextV1,
} from "@slopproof/analysis";
import {
  PayloadCipher,
  ProviderError,
  type LearningMaterialProvider,
  type PracticeCoachProvider,
  type ProofQuestionProvider,
} from "@slopproof/providers";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@slopproof/policy";
import { deterministicLearningFallbackV1 } from "@slopproof/questions";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { persistGenerationContextV1InTransaction } from "../../apps/worker/src/generation-context-repository";
import { createSemanticGenerationService } from "../../apps/worker/src/semantic-generation";
import { createSemanticGenerationJobHandlers } from "../../apps/worker/src/semantic-generation-jobs";
import { PostgresSemanticGenerationRepository } from "../../apps/worker/src/semantic-generation-repository";
import { PgBossSemanticTransactionalScheduler } from "../../apps/worker/src/semantic-generation-scheduler";
import type {
  SemanticProofReadyWriter,
  SemanticTransactionalScheduler,
} from "../../apps/worker/src/semantic-generation-contracts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe("Gate 4 semantic persistence and served Proof V2", () => {
  let database: DatabaseConnection;
  let generationContextId: string;
  let generationContext: GenerationContextV1;
  let repository: PostgresSemanticGenerationRepository;
  let handlers: ReturnType<typeof createSemanticGenerationJobHandlers>;
  let scheduler: SemanticTransactionalScheduler;
  let proofReady: SemanticProofReadyWriter;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        semantic_practice_capability_uses, semantic_practice_rate_limits,
        semantic_provider_invocations, semantic_proof_plans_v2,
        semantic_practice_feedback, semantic_practice_answers,
        practice_sessions, semantic_learning_bundles,
        semantic_generation_runs, semantic_generation_budgets,
        audit_events, attempts, proof_questions, proof_plans,
        generation_contexts, analysis_snapshots, github_revision_sources,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations
      RESTART IDENTITY CASCADE
    `);
    const seeded = await seed(database);
    generationContextId = seeded.generationContextId;
    generationContext = seeded.context;
    scheduler = schedulerFixture();
    proofReady = {
      write: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    repository = new PostgresSemanticGenerationRepository(
      database,
      new PayloadCipher(Buffer.alloc(32, 7)),
      scheduler,
      proofReady,
    );
    handlers = createSemanticGenerationJobHandlers({
      repository,
      service: createSemanticGenerationService({
        learningMaterialProvider: unavailableProvider(),
        practiceCoachProvider: unavailableProvider(),
        proofQuestionProvider: unavailableProvider(),
        clock: { now: () => new Date(), monotonicNowMs: () => 1 },
      }),
    });
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await repository.scheduleRevisionSemanticGeneration(client, {
        repositoryId: IDS.repository,
        revisionId: IDS.revision,
        generationContextId,
        repositoryPolicyId: IDS.policy,
        headSha: HEAD,
        questionBudget: 2,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("does not consume the Learning generate deadline while waiting for Proof", async () => {
    await expect(
      handlers["semantic.generate-learning"](learningJob(generationContextId)),
    ).resolves.toEqual({ outcome: "proof_pending" });
    await expect(
      database.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM semantic_generation_runs
          WHERE purpose = 'learning_material'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const beforeEligible = await database.pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const proof = await handlers["semantic.generate-proof-questions"](
      proofJob(generationContextId),
    );
    expect(proof).toMatchObject({ outcome: "created" });

    await expect(
      generatedLearningHandlers(repository, generationContext)[
        "semantic.generate-learning"
      ](learningJob(generationContextId)),
    ).resolves.toMatchObject({ outcome: "created", degraded: false });

    const learningRun = await database.pool.query<{
      created_at: Date;
      window_seconds: number;
      invocation_count: number;
      outcome: string;
    }>(
      `SELECT run.created_at,
              extract(epoch FROM (run.deadline_at - run.created_at))::int
                AS window_seconds,
              invocation.invocation_count,
              invocation.outcome
         FROM semantic_generation_runs run
         JOIN semantic_provider_invocations invocation
           ON invocation.run_id = run.id
        WHERE run.purpose = 'learning_material'`,
    );
    expect(learningRun.rows).toHaveLength(1);
    expect(learningRun.rows[0]?.window_seconds).toBe(480);
    expect(learningRun.rows[0]?.invocation_count).toBe(1);
    expect(learningRun.rows[0]?.outcome).toBe("generated");
    expect(learningRun.rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(
      beforeEligible.rows[0]!.now.getTime(),
    );
  });

  it("stores degraded Learning privately without serving it as Practice", async () => {
    await expect(
      handlers["semantic.generate-learning"](learningJob(generationContextId)),
    ).resolves.toEqual({ outcome: "proof_pending" });
    await expect(
      database.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM semantic_learning_bundles",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const proof = await handlers["semantic.generate-proof-questions"](
      proofJob(generationContextId),
    );
    expect(proof).toMatchObject({ outcome: "created" });
    await handlers["semantic.generate-learning"](
      learningJob(generationContextId),
    );

    const stored = await database.pool.query<{
      encrypted_payload: string;
      provider: string;
      input_hash: string;
      provider_failure: Record<string, unknown>;
    }>(
      `SELECT bundle.encrypted_payload, invocation.provider, invocation.input_hash,
              audit.metadata AS provider_failure
         FROM semantic_learning_bundles bundle
         JOIN semantic_provider_invocations invocation ON invocation.run_id = bundle.run_id
         JOIN audit_events audit
           ON audit.object_type = 'semantic_generation_run'
          AND audit.object_id = invocation.run_id::text
          AND audit.action = 'semantic.provider_failed'`,
    );
    expect(stored.rows[0]?.encrypted_payload).not.toContain("changed hunk");
    expect(stored.rows[0]?.input_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(stored.rows[0]?.provider_failure).toEqual({
      schemaVersion: "semantic-provider-failure-v1",
      failureCode: "PROVIDER_UNAVAILABLE",
      lastFailureKind: "upstream_unavailable",
      httpStatusClass: "5xx",
      transportAttemptCount: 3,
    });
    expect(JSON.stringify(stored.rows[0]?.provider_failure)).not.toContain(
      "offline provider unavailable",
    );

    const view = await repository.readPracticeView({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      userId: AUTHOR,
    });
    expect(view).toMatchObject({
      state: "generation_failed",
      revisionId: IDS.revision,
      headSha: HEAD,
    });

    const served = await database.pool.query<{
      status: string;
      plan_version: string;
      question_count: number;
      anchor: unknown;
      rubric: unknown;
    }>(
      `SELECT attempt.status, plan.plan_version,
              count(question.id) OVER ()::int AS question_count,
              question.diff_anchor AS anchor, question.rubric
         FROM attempts attempt
         JOIN proof_plans plan ON plan.id = attempt.proof_plan_id
         JOIN proof_questions question ON question.proof_plan_id = plan.id
        ORDER BY question.ordinal`,
    );
    expect(served.rows).toHaveLength(2);
    expect(served.rows[0]).toMatchObject({
      status: "ready",
      plan_version: "proof-planner-v2",
      question_count: 2,
      anchor: expect.objectContaining({ evidence: expect.any(String) }),
      rubric: {
        requiredPoints: expect.any(Array),
        rejectsGenericAnswer: true,
      },
    });
    expect(proofReady.write).toHaveBeenCalledTimes(1);

    const replay = await handlers["semantic.generate-proof-questions"](
      proofJob(generationContextId),
    );
    expect(replay).toMatchObject({ outcome: "replayed" });
    await expect(
      database.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM attempts",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("persists deterministic fallback metadata after a retry older than fifteen minutes", async () => {
    await handlers["semantic.generate-proof-questions"](
      proofJob(generationContextId),
    );
    const delayedNow = new Date(Date.now() + 16 * 60_000);
    const delayedHandlers = createSemanticGenerationJobHandlers({
      repository,
      service: createSemanticGenerationService({
        learningMaterialProvider: unavailableProvider(),
        practiceCoachProvider: unavailableProvider(),
        proofQuestionProvider: unavailableProvider(),
        clock: { now: () => delayedNow, monotonicNowMs: () => 1 },
      }),
    });

    await expect(
      delayedHandlers["semantic.generate-learning"](
        learningJob(generationContextId),
      ),
    ).resolves.toMatchObject({ outcome: "created", degraded: true });
    const invocation = await database.pool.query<{
      invocation_count: number;
      delay_seconds: number;
    }>(
      `SELECT invocation.invocation_count,
              extract(epoch FROM (invocation.completed_at - run.created_at))::int
                AS delay_seconds
         FROM semantic_provider_invocations invocation
         JOIN semantic_generation_runs run ON run.id = invocation.run_id
        WHERE invocation.purpose = 'learning_material'`,
    );
    expect(invocation.rows[0]?.invocation_count).toBe(0);
    expect(invocation.rows[0]?.delay_seconds).toBeGreaterThanOrEqual(15 * 60);
  });

  it("repairs a frozen-Proof collision once and persists only a collision-free Learning fallback", async () => {
    await handlers["semantic.generate-proof-questions"](
      proofJob(generationContextId),
    );
    const served = await database.pool.query<{ prompt: string }>(
      `SELECT question.prompt
         FROM attempts attempt
         JOIN proof_questions question
           ON question.proof_plan_id = attempt.proof_plan_id
        WHERE attempt.revision_id = $1
        ORDER BY question.ordinal
        LIMIT 1`,
      [IDS.revision],
    );
    const frozenProofPrompt = served.rows[0]!.prompt;
    const validLearning = deterministicLearningFallbackV1(generationContext, 3);
    const collidingLearning = {
      ...validLearning,
      practiceQuestions: [
        {
          ...validLearning.practiceQuestions[0]!,
          prompt: frozenProofPrompt,
        },
        ...validLearning.practiceQuestions.slice(1),
      ],
    };
    const generate = vi.fn(async (input: unknown) => {
      expect(JSON.stringify(input)).not.toContain(frozenProofPrompt);
      return { output: collidingLearning, tokenUsage: null };
    });
    const repair = vi.fn(async (input: unknown) => {
      expect(JSON.stringify(input)).not.toContain(frozenProofPrompt);
      return { output: collidingLearning, tokenUsage: null };
    });
    const collisionHandlers = createSemanticGenerationJobHandlers({
      repository,
      service: createSemanticGenerationService({
        learningMaterialProvider: {
          descriptor: { provider: "collision-test", model: "collision-test" },
          generate,
          repair,
        },
        practiceCoachProvider: unavailableProvider(),
        proofQuestionProvider: unavailableProvider(),
        clock: { now: () => new Date(), monotonicNowMs: () => 1 },
      }),
    });

    await expect(
      collisionHandlers["semantic.generate-learning"](
        learningJob(generationContextId),
      ),
    ).resolves.toMatchObject({ outcome: "created", degraded: true });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
    const view = await repository.readPracticeView({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      userId: AUTHOR,
    });
    expect(view.state).toBe("generation_failed");
    await expect(
      database.pool.query(
        `SELECT invocation_count, outcome, degraded
           FROM semantic_provider_invocations
          WHERE purpose = 'learning_material'`,
      ),
    ).resolves.toMatchObject({
      rows: [{ invocation_count: 2, outcome: "fallback", degraded: true }],
    });
  });

  it("allows Learning from a fully served legacy Proof while keeping its content private", async () => {
    const legacyPlanId = randomUUID();
    const legacyAttemptId = randomUUID();
    const legacyPrompts = [
      "Explain the legacy served cache-miss contract at this exact changed hunk.",
      "Describe one legacy served failure boundary at this exact changed hunk.",
    ];
    const anchor = generationContext.anchors[0]!;
    const legacyAnchor = {
      id: anchor.id,
      file: anchor.filename.content,
      hunkHeader: anchor.hunkHeader.content,
      oldStart: anchor.oldStart,
      newStart: anchor.newStart,
      changedLines: anchor.changedLines,
      evidence: anchor.evidence.content,
    };
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO proof_plans
           (id, revision_id, generation_context_id, repository_policy_id,
            plan_version, deterministic_seed, risk_explanation,
            question_budget, plan_hash, status)
         VALUES ($1, $2, $3, $4, 'proof-planner-v1', 'legacy-served',
                 '{}'::jsonb, 2, $5, 'ready')`,
        [
          legacyPlanId,
          IDS.revision,
          generationContextId,
          IDS.policy,
          hash(`legacy:${legacyPlanId}`),
        ],
      );
      for (const [index, prompt] of legacyPrompts.entries()) {
        await client.query(
          `INSERT INTO proof_questions
             (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
           VALUES ($1, $2, $3, 'explain', $4, $5::jsonb, $6::jsonb, true)`,
          [
            randomUUID(),
            legacyPlanId,
            index,
            prompt,
            JSON.stringify(legacyAnchor),
            JSON.stringify({
              requiredPoints: [
                `Legacy criterion ${String(index + 1)} requires the concrete changed behavior.`,
                `Legacy criterion ${String(index + 1)} requires one observable consequence.`,
              ],
              rejectsGenericAnswer: true,
            }),
          ],
        );
      }
      await client.query(
        `INSERT INTO attempts
           (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
            status, nonce_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7,
                 clock_timestamp() + interval '8 hours')`,
        [
          legacyAttemptId,
          IDS.repository,
          IDS.revision,
          AUTHOR,
          legacyPlanId,
          HEAD,
          hash(`legacy-nonce:${legacyAttemptId}`),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const generatedHandlers = generatedLearningHandlers(
      repository,
      generationContext,
    );
    await expect(
      generatedHandlers["semantic.generate-learning"](
        learningJob(generationContextId),
      ),
    ).resolves.toMatchObject({ outcome: "created", degraded: false });
    const view = await repository.readPracticeView({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      userId: AUTHOR,
    });
    if (view.state !== "ready") throw new Error("Legacy Learning not ready");
    expect(JSON.stringify(view.learning)).not.toContain(legacyPrompts[0]);
    expect(view.learning.practiceQuestions).toHaveLength(3);
  });

  it("binds Practice to the exact author, encrypts answers, and shreds on invalidation", async () => {
    await handlers["semantic.generate-proof-questions"](
      proofJob(generationContextId),
    );
    await generatedLearningHandlers(repository, generationContext)[
      "semantic.generate-learning"
    ](learningJob(generationContextId));
    const bundle = await database.pool.query<{ id: string; run_id: string }>(
      "SELECT id, run_id FROM semantic_learning_bundles",
    );
    const bundleId = bundle.rows[0]!.id;
    await expect(
      repository.startPracticeSession({
        repositoryId: IDS.repository,
        revisionId: IDS.revision,
        generationContextId,
        learningBundleId: bundleId,
        userId: "foreign-user",
        actorKeyHash: "1".repeat(64),
      }),
    ).rejects.toThrow("Learning bundle is unavailable");

    const obsoleteRunId = randomUUID();
    const obsoleteBundleId = randomUUID();
    await database.pool.query(
      `INSERT INTO semantic_generation_runs
         (id, idempotency_key, purpose, repository_id, revision_id,
          generation_context_id, artifact_seed, question_count, created_at,
          deadline_at, delete_after, completed_at, artifact_id, degraded)
       SELECT $1, $2, purpose, repository_id, revision_id,
              generation_context_id, artifact_seed, question_count,
              created_at - interval '1 second', deadline_at - interval '1 second',
              delete_after - interval '1 second', completed_at, $3, degraded
         FROM semantic_generation_runs
        WHERE id = $4`,
      [
        obsoleteRunId,
        `semantic.learning.obsolete-test:${generationContextId}`,
        obsoleteBundleId,
        bundle.rows[0]!.run_id,
      ],
    );
    await database.pool.query(
      `INSERT INTO semantic_learning_bundles
         (id, run_id, repository_id, revision_id, generation_context_id,
          head_sha, context_hash, schema_version, content_hash,
          generation_outcome, encrypted_payload, delete_after, created_at)
       SELECT $1, $2, repository_id, revision_id, generation_context_id,
              head_sha, context_hash, schema_version, content_hash,
              generation_outcome, encrypted_payload,
              delete_after - interval '1 second',
              created_at - interval '1 second'
         FROM semantic_learning_bundles
        WHERE id = $3`,
      [obsoleteBundleId, obsoleteRunId, bundleId],
    );
    const obsoleteSession = await repository.startPracticeSession({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      learningBundleId: obsoleteBundleId,
      userId: AUTHOR,
      actorKeyHash: "2".repeat(64),
    });
    const session = await repository.startPracticeSession({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      learningBundleId: bundleId,
      userId: AUTHOR,
      actorKeyHash: "3".repeat(64),
    });
    expect(session.sessionId).not.toBe(obsoleteSession.sessionId);
    await expect(
      database.pool.query<{
        learning_bundle_id: string;
        invalidated_at: Date | null;
      }>(
        `SELECT learning_bundle_id, invalidated_at
           FROM practice_sessions
          WHERE id = $1`,
        [obsoleteSession.sessionId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          learning_bundle_id: obsoleteBundleId,
          invalidated_at: expect.any(Date),
        },
      ],
    });
    const ready = await repository.readPracticeView({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      userId: AUTHOR,
      practiceSessionId: session.sessionId,
    });
    if (ready.state !== "ready" || ready.practiceSession === null) {
      throw new Error("Practice view not ready");
    }
    const question = ready.practiceSession.questions[0]!;
    const submitted = await repository.submitPracticeAnswer({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      practiceSessionId: session.sessionId,
      practiceQuestionId: question.id,
      userId: AUTHOR,
      actorKeyHash: "4".repeat(64),
      answer: {
        trust: "untrusted",
        source: "contributor_answer",
        content: "I compare the removed and added cache-miss behavior.",
      },
    });
    const answer = await database.pool.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM semantic_practice_answers",
    );
    expect(answer.rows[0]?.encrypted_payload).not.toContain("cache-miss");
    const audits = await database.pool.query(
      "SELECT metadata FROM audit_events",
    );
    expect(JSON.stringify(audits.rows)).not.toContain("cache-miss");
    const pending = await repository.readPracticeView({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      userId: AUTHOR,
      practiceSessionId: session.sessionId,
    });
    if (pending.state !== "ready" || pending.practiceSession === null) {
      throw new Error("Pending Practice view not ready");
    }
    expect(pending.practiceSession.pendingQuestionIds).toEqual([question.id]);
    expect(pending.practiceSession.answersByQuestionId).toEqual({
      [question.id]: "I compare the removed and added cache-miss behavior.",
    });

    await handlers["semantic.generate-practice-feedback"]({
      schemaVersion: "1",
      idempotencyKey: `semantic.practice.feedback:${submitted.answerId}`,
      artifactKind: "practice_feedback_v1",
      revisionId: IDS.revision,
      generationContextId,
      expectedHeadSha: HEAD,
      practiceSessionId: session.sessionId,
      practiceQuestionId: question.id,
      practiceAnswerId: submitted.answerId,
    });
    const withFeedback = await repository.readPracticeView({
      repositoryId: IDS.repository,
      revisionId: IDS.revision,
      generationContextId,
      userId: AUTHOR,
      practiceSessionId: session.sessionId,
    });
    if (
      withFeedback.state !== "ready" ||
      withFeedback.practiceSession === null
    ) {
      throw new Error("Feedback Practice view not ready");
    }
    expect(withFeedback.practiceSession.pendingQuestionIds).toEqual([]);
    expect(withFeedback.practiceSession.answersByQuestionId[question.id]).toBe(
      "I compare the removed and added cache-miss behavior.",
    );
    expect(
      withFeedback.practiceSession.feedbackByQuestionId[question.id]?.createdAt,
    ).toBeInstanceOf(Date);

    await database.pool.query(
      `UPDATE pull_request_revisions
          SET is_current = false, invalidated_at = clock_timestamp()
        WHERE id = $1`,
      [IDS.revision],
    );
    const shredded = await database.pool.query<{
      bundle_payload: string | null;
      answer_payload: string | null;
      feedback_payload: string | null;
      session_deleted: Date | null;
    }>(
      `SELECT bundle.encrypted_payload AS bundle_payload,
              answer.encrypted_payload AS answer_payload,
              feedback.encrypted_payload AS feedback_payload,
              session.deleted_at AS session_deleted
         FROM semantic_learning_bundles bundle
         JOIN practice_sessions session ON session.learning_bundle_id = bundle.id
         JOIN semantic_practice_answers answer ON answer.practice_session_id = session.id
         JOIN semantic_practice_feedback feedback ON feedback.practice_session_id = session.id`,
    );
    expect(shredded.rows[0]).toMatchObject({
      bundle_payload: null,
      answer_payload: null,
      feedback_payload: null,
      session_deleted: expect.any(Date),
    });
    await expect(
      repository.readPracticeView({
        repositoryId: IDS.repository,
        revisionId: IDS.revision,
        generationContextId,
        userId: AUTHOR,
      }),
    ).resolves.toEqual({ state: "unavailable" });
  });

  it("enforces capability JTI one-use and lifecycle atomically", async () => {
    const inserted = await database.pool.query(
      `INSERT INTO semantic_practice_capability_uses
         (jti, repository_id, revision_id, actor_key_hash, action, expires_at)
       VALUES ($1, $2, $3, $4, 'read', clock_timestamp() + interval '5 minutes')
       ON CONFLICT DO NOTHING RETURNING jti`,
      [IDS.capability, IDS.repository, IDS.revision, "4".repeat(64)],
    );
    const replay = await database.pool.query(
      `INSERT INTO semantic_practice_capability_uses
         (jti, repository_id, revision_id, actor_key_hash, action, expires_at)
       VALUES ($1, $2, $3, $4, 'read', clock_timestamp() + interval '5 minutes')
       ON CONFLICT DO NOTHING RETURNING jti`,
      [IDS.capability, IDS.repository, IDS.revision, "4".repeat(64)],
    );
    expect(inserted.rowCount).toBe(1);
    expect(replay.rowCount).toBe(0);
    await database.pool.query(
      "UPDATE installations SET status = 'suspended', suspended_at = now() WHERE id = $1",
      [IDS.installation],
    );
    await expect(
      database.pool.query(
        `INSERT INTO semantic_practice_capability_uses
           (jti, repository_id, revision_id, actor_key_hash, action, expires_at)
         VALUES ($1, $2, $3, $4, 'read', clock_timestamp() + interval '5 minutes')`,
        [
          "83000000-0000-4000-8000-000000000099",
          IDS.repository,
          IDS.revision,
          "5".repeat(64),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("fails a queued semantic job closed after installation suspension", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider must not be called");
    });
    const guardedHandlers = createSemanticGenerationJobHandlers({
      repository,
      service: createSemanticGenerationService({
        learningMaterialProvider: {
          descriptor: { provider: "guarded", model: "guarded" },
          generate,
          repair: generate,
        },
        practiceCoachProvider: unavailableProvider(),
        proofQuestionProvider: unavailableProvider(),
        clock: { now: () => new Date(), monotonicNowMs: () => 1 },
      }),
    });
    await database.pool.query(
      "UPDATE installations SET status = 'suspended', suspended_at = now() WHERE id = $1",
      [IDS.installation],
    );

    await expect(
      guardedHandlers["semantic.generate-learning"](
        learningJob(generationContextId),
      ),
    ).resolves.toEqual({ outcome: "stale" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("sweeps durable incomplete budgets back into both semantic singletons", async () => {
    vi.mocked(scheduler.recoverOrExpedite).mockClear();
    await expect(
      repository.sweepDueSemanticPrivate(new Date(), 10),
    ).resolves.toEqual({ scanned: 1, requeued: 2 });
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledTimes(2);
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledWith(
      expect.anything(),
      "semantic.generate-learning",
      expect.objectContaining({ generationContextId }),
    );
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledWith(
      expect.anything(),
      "semantic.generate-proof-questions",
      expect.objectContaining({ generationContextId }),
    );
  });

  it("sweeps Learning but never replaces an already issued Legacy Attempt", async () => {
    await database.pool.query(
      `INSERT INTO attempts
         (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
          status, nonce_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7,
               clock_timestamp() + interval '8 hours')`,
      [
        "83000000-0000-4000-8000-000000000090",
        IDS.repository,
        IDS.revision,
        AUTHOR,
        IDS.deterministicPlan,
        HEAD,
        "f".repeat(64),
      ],
    );
    vi.mocked(scheduler.recoverOrExpedite).mockClear();

    await expect(
      repository.sweepDueSemanticPrivate(new Date(), 10),
    ).resolves.toEqual({ scanned: 1, requeued: 1 });
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledTimes(1);
    expect(scheduler.recoverOrExpedite).toHaveBeenCalledWith(
      expect.anything(),
      "semantic.generate-learning",
      expect.objectContaining({ generationContextId }),
    );
  });

  it("persists a fresh private-expiry singleton at the future deletion deadline", async () => {
    const queue = await startJobQueue(databaseUrl!);
    try {
      const transactionalScheduler = new PgBossSemanticTransactionalScheduler(
        queue,
      );
      const artifactId = randomUUID();
      const deleteAfter = new Date(Date.now() + 6 * 60 * 60_000);
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await transactionalScheduler.recoverOrExpedite(
          client,
          "semantic.expire-private",
          {
            schemaVersion: "1",
            idempotencyKey: `semantic.expire.learning_bundle_v1:${artifactId}`,
            revisionId: IDS.revision,
            artifactId,
            artifactKind: "learning_bundle_v1",
          },
          deleteAfter,
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const persisted = await database.pool.query<{ start_after: Date }>(
        `SELECT start_after
           FROM pgboss.job
          WHERE name = 'semantic.expire-private'
            AND data->>'artifactId' = $1`,
        [artifactId],
      );
      expect(persisted.rows).toHaveLength(1);
      expect(
        Math.abs(
          persisted.rows[0]!.start_after.getTime() - deleteAfter.getTime(),
        ),
      ).toBeLessThan(1_000);
      expect(persisted.rows[0]!.start_after.getTime()).toBeGreaterThan(
        Date.now() + 5 * 60 * 60_000,
      );
    } finally {
      await queue.stop();
    }
  });

  it("reopens the same tuple with a fresh Attempt from the exact stored V2 plan", async () => {
    const first = await handlers["semantic.generate-proof-questions"](
      proofJob(generationContextId),
    );
    expect(first).toMatchObject({ outcome: "created" });
    await database.pool.query(
      `UPDATE pull_requests SET state = 'closed' WHERE id = $1`,
      [IDS.pullRequest],
    );
    await database.pool.query(
      `UPDATE attempts
          SET status = 'invalidated', invalidated_at = now(),
              completed_at = now(), created_at = now() - interval '9 hours',
              expires_at = now() - interval '1 hour'
        WHERE revision_id = $1`,
      [IDS.revision],
    );
    await database.pool.query(
      `UPDATE pull_requests SET state = 'open' WHERE id = $1`,
      [IDS.pullRequest],
    );

    const recoveryScheduler = schedulerFixture();
    const recoveryProofReady: SemanticProofReadyWriter = {
      write: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    };
    const recoveredRepository = new PostgresSemanticGenerationRepository(
      database,
      new PayloadCipher(Buffer.alloc(32, 7)),
      recoveryScheduler,
      recoveryProofReady,
    );
    const recoveredHandlers = createSemanticGenerationJobHandlers({
      repository: recoveredRepository,
      service: createSemanticGenerationService({
        learningMaterialProvider: unavailableProvider(),
        practiceCoachProvider: unavailableProvider(),
        proofQuestionProvider: unavailableProvider(),
        clock: { now: () => new Date(), monotonicNowMs: () => 1 },
      }),
    });
    const recovered = await recoveredHandlers[
      "semantic.generate-proof-questions"
    ](proofJob(generationContextId));
    expect(recovered).toMatchObject({ outcome: "recovered" });
    const attempts = await database.pool.query<{
      id: string;
      proof_plan_id: string;
      status: string;
      lifetime_seconds: number;
    }>(
      `SELECT id, proof_plan_id, status,
              extract(epoch FROM (expires_at - created_at))::int AS lifetime_seconds
         FROM attempts
        ORDER BY created_at, id`,
    );
    expect(attempts.rows).toHaveLength(2);
    expect(attempts.rows[0]?.status).toBe("invalidated");
    expect(attempts.rows[1]).toMatchObject({
      status: "ready",
      proof_plan_id: attempts.rows[0]?.proof_plan_id,
    });
    expect(attempts.rows[1]?.id).not.toBe(attempts.rows[0]?.id);
    expect(attempts.rows[1]?.lifetime_seconds).toBeGreaterThanOrEqual(28_799);
    expect(recoveryProofReady.write).toHaveBeenCalledTimes(1);
  });
});

const IDS = {
  installation: "83000000-0000-4000-8000-000000000001",
  repository: "83000000-0000-4000-8000-000000000002",
  pullRequest: "83000000-0000-4000-8000-000000000003",
  revision: "83000000-0000-4000-8000-000000000004",
  analysis: "83000000-0000-4000-8000-000000000005",
  policy: "83000000-0000-4000-8000-000000000006",
  deterministicPlan: "83000000-0000-4000-8000-000000000007",
  capability: "83000000-0000-4000-8000-000000000008",
} as const;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const AUTHOR = "8305";

function learningJob(generationContextId: string) {
  return {
    schemaVersion: "1" as const,
    idempotencyKey: `semantic.learning.v3:${generationContextId}`,
    artifactKind: "learning_bundle_v1" as const,
    revisionId: IDS.revision,
    generationContextId,
    expectedHeadSha: HEAD,
  };
}

function generatedLearningHandlers(
  repository: PostgresSemanticGenerationRepository,
  context: GenerationContextV1,
) {
  const output = deterministicLearningFallbackV1(context, 3);
  const generate = async () => ({ output, tokenUsage: null });
  return createSemanticGenerationJobHandlers({
    repository,
    service: createSemanticGenerationService({
      learningMaterialProvider: {
        descriptor: { provider: "generated-test", model: "generated-test" },
        generate,
        repair: generate,
      },
      practiceCoachProvider: unavailableProvider(),
      proofQuestionProvider: unavailableProvider(),
      clock: { now: () => new Date(), monotonicNowMs: () => 1 },
    }),
  });
}

function proofJob(generationContextId: string) {
  return {
    schemaVersion: "1" as const,
    idempotencyKey: `semantic.proof.v2:${IDS.analysis}`,
    artifactKind: "proof_question_plan_v2" as const,
    revisionId: IDS.revision,
    generationContextId,
    expectedHeadSha: HEAD,
  };
}

function unavailableProvider(): LearningMaterialProvider &
  PracticeCoachProvider &
  ProofQuestionProvider {
  return {
    descriptor: { provider: "offline-fake", model: "deterministic" },
    async generate() {
      throw new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "retryable",
        "offline provider unavailable",
        {
          telemetry: {
            lastFailureKind: "upstream_unavailable",
            httpStatusClass: "5xx",
            transportAttemptCount: 3,
          },
        },
      );
    },
    async repair() {
      throw new Error("repair unavailable");
    },
  };
}

function schedulerFixture(): SemanticTransactionalScheduler {
  return {
    schedule: vi.fn(async () => undefined),
    recoverOrExpedite: vi.fn(async () => undefined),
    scheduleAttemptExpiry: vi.fn(async () => undefined),
  };
}

async function seed(database: DatabaseConnection) {
  const source = {
    githubPullRequestId: "8304",
    number: 44,
    state: "open" as const,
    draft: false,
    title: "Harden cache lookup",
    body: "Return an explicit cache miss.",
    authorId: AUTHOR,
    authorLogin: "contributor",
    headSha: HEAD,
    baseSha: BASE,
    changedFiles: 1,
    isFork: false,
    files: [
      {
        sha: "d".repeat(40),
        filename: "src/cache.ts",
        previousFilename: null,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch:
          "@@ -1,1 +1,1 @@\n-return cache.get(key) ?? '';\n+return cache.get(key) ?? null;",
        gitKind: "blob" as const,
      },
    ],
    limitsHit: { files: false, patchBytes: false, patchUnavailable: false },
  };
  const bounded = buildBoundedRevisionSourceV1(source);
  const patch = boundedRevisionSourcePatch(bounded);
  const analysis = analyzePullRequestPatch(patch);
  const context = buildGenerationContextV1({
    revisionId: IDS.revision,
    analysisSnapshotId: IDS.analysis,
    boundedSource: bounded,
    analysis,
  });
  const policyJson = JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1);
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO installations
         (id, github_installation_id, account_id, account_login, status)
       VALUES ($1, '8301', '8302', 'acme', 'active')`,
      [IDS.installation],
    );
    await client.query(
      `INSERT INTO repositories
         (id, installation_id, github_repository_id, owner, name,
          default_branch, active_policy_version, status)
       VALUES ($1, $2, '8303', 'acme', 'cache', 'main', 1, 'active')`,
      [IDS.repository, IDS.installation],
    );
    await client.query(
      `INSERT INTO repository_policies
         (id, repository_id, version, schema_version, policy, policy_hash,
          created_by, activated_at)
       VALUES ($1, $2, 1, '1', $3::jsonb, $4, 'test', now())`,
      [IDS.policy, IDS.repository, policyJson, hash(policyJson)],
    );
    await client.query(
      `INSERT INTO pull_requests
         (id, repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, '8304', 44, $3, 'open')`,
      [IDS.pullRequest, IDS.repository, AUTHOR],
    );
    await client.query(
      `INSERT INTO pull_request_revisions
         (id, pull_request_id, head_sha, base_sha, is_current)
       VALUES ($1, $2, $3, $4, true)`,
      [IDS.revision, IDS.pullRequest, HEAD, BASE],
    );
    await persistGithubRevisionSourceInTransaction(client, {
      revisionId: IDS.revision,
      fetchedAt: new Date(),
      source,
    });
    await client.query(
      `INSERT INTO analysis_snapshots
         (id, revision_id, analyzer_version, diff_hash, snapshot, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'ready')`,
      [
        IDS.analysis,
        IDS.revision,
        analysis.analyzerVersion,
        hash(JSON.stringify(patch)),
        JSON.stringify(analysis),
      ],
    );
    const persisted = await persistGenerationContextV1InTransaction(
      client,
      context,
    );
    await client.query(
      `INSERT INTO proof_plans
         (id, revision_id, generation_context_id, repository_policy_id,
          plan_version, deterministic_seed, risk_explanation,
          question_budget, plan_hash, status)
       VALUES ($1, $2, $3, $4, 'proof-planner-v1', 'seed', '{}'::jsonb,
               2, $5, 'analysis_only')`,
      [
        IDS.deterministicPlan,
        IDS.revision,
        persisted.id,
        IDS.policy,
        "e".repeat(64),
      ],
    );
    await client.query("COMMIT");
    return { generationContextId: persisted.id, context };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
