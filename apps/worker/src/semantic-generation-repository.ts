import { createHash, randomUUID } from "node:crypto";
import {
  type DatabaseConnection,
  type JobPayload,
  reserveSemanticPracticeRateLimit,
} from "@slopproof/db";
import {
  GenerationContextV1Schema,
  type GenerationContextV1,
} from "@slopproof/analysis";
import {
  ContributorPracticeAnswerV1Schema,
  SemanticProviderFailureV1Schema,
  SemanticProviderInvocationMetadataV1Schema,
  type SemanticProviderFailureV1,
  type SemanticProviderInvocationMetadataV1,
} from "@slopproof/providers";
import {
  ForbiddenProofContentV1Schema,
  LearningBundleV1Schema,
  PracticeFeedbackV1Schema,
  ProofQuestionPlanV2Schema,
  proofQuestionsContentV1,
  type ForbiddenProofContentV1,
  type LearningBundleV1,
  type PracticeFeedbackV1,
  type ProofQuestionPlanV2,
} from "@slopproof/questions";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { SemanticGenerationResultV1 } from "./semantic-generation";
import {
  semanticPrivateAad,
  type SemanticCipher,
  type SemanticGenerationRepository,
  type SemanticRunContext,
  type SemanticProofReadyWriter,
  type SemanticTransactionalScheduler,
  type ScheduleRevisionSemanticGenerationInput,
  type ReadPracticeViewInput,
  type PracticeView,
  type StartPracticeSessionInput,
  type SubmitPracticeAnswerInput,
} from "./semantic-generation-contracts";

const MAX_PRACTICE_ANSWER_BYTES = 4_000;
const GENERATION_DEADLINE_MS = 8 * 60_000;
const PRIVATE_RETENTION_MS = 24 * 60 * 60_000;
const ATTEMPT_LIFETIME_MS = 8 * 60 * 60_000;
const LEARNING_GENERATION_IDEMPOTENCY_VERSION = "v3";

type RunLookupRow = {
  repository_id: string;
  revision_id: string;
  generation_context_id: string;
  author_id: string;
  repository_policy_id: string;
  head_sha: string;
  context_hash: string;
  context: unknown;
  question_budget: number;
  is_current: boolean;
  pull_request_state: string;
};

type RunRow = {
  id: string;
  idempotency_key: string;
  purpose: string;
  repository_id: string;
  revision_id: string;
  generation_context_id: string;
  practice_session_id: string | null;
  practice_question_id: string | null;
  practice_answer_id: string | null;
  artifact_seed: string;
  question_count: number;
  created_at: Date;
  deadline_at: Date;
  delete_after: Date;
  artifact_id: string | null;
};

export class PostgresSemanticGenerationRepository implements SemanticGenerationRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly cipher: SemanticCipher,
    private readonly scheduler: SemanticTransactionalScheduler,
    private readonly proofReady: SemanticProofReadyWriter,
  ) {}

  async scheduleRevisionSemanticGeneration(
    client: PoolClient,
    input: ScheduleRevisionSemanticGenerationInput,
  ): Promise<"created" | "replayed"> {
    if (
      !uuid(input.repositoryId) ||
      !uuid(input.revisionId) ||
      !uuid(input.generationContextId) ||
      !uuid(input.repositoryPolicyId) ||
      !/^[0-9a-f]{40}$/u.test(input.headSha) ||
      !Number.isInteger(input.questionBudget) ||
      input.questionBudget < 1 ||
      input.questionBudget > 5
    ) {
      throw new Error("Semantic generation budget input is invalid.");
    }
    const inserted = await client.query(
      `INSERT INTO semantic_generation_budgets
         (generation_context_id, repository_id, revision_id,
          repository_policy_id, head_sha, question_budget, budget_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'semantic-generation-budget-v1')
       ON CONFLICT (generation_context_id) DO NOTHING
       RETURNING generation_context_id`,
      [
        input.generationContextId,
        input.repositoryId,
        input.revisionId,
        input.repositoryPolicyId,
        input.headSha,
        input.questionBudget,
      ],
    );
    const exact = await client.query<{
      repository_id: string;
      revision_id: string;
      repository_policy_id: string;
      head_sha: string;
      question_budget: number;
      budget_version: string;
    }>(
      `SELECT repository_id, revision_id, repository_policy_id, head_sha,
              question_budget, budget_version
         FROM semantic_generation_budgets
        WHERE generation_context_id = $1
        FOR SHARE`,
      [input.generationContextId],
    );
    const row = exact.rows[0];
    if (
      row === undefined ||
      row.repository_id !== input.repositoryId ||
      row.revision_id !== input.revisionId ||
      row.repository_policy_id !== input.repositoryPolicyId ||
      row.head_sha !== input.headSha ||
      row.question_budget !== input.questionBudget ||
      row.budget_version !== "semantic-generation-budget-v1"
    ) {
      throw new Error("Semantic generation budget replay conflicts.");
    }
    const proofEligibility = await client.query<{
      proof_ready: boolean;
      should_schedule: boolean;
    }>(
      `SELECT EXISTS (
          SELECT 1
            FROM proof_plans plan
           WHERE plan.revision_id = $1
             AND plan.generation_context_id = $2
             AND plan.status = 'ready'
             AND plan.question_budget = $3
             AND (SELECT count(*)::int FROM proof_questions question
                   WHERE question.proof_plan_id = plan.id) = plan.question_budget
        ) AS proof_ready,
        (
          NOT EXISTS (
            SELECT 1 FROM check_runs check_run
             WHERE check_run.revision_id = $1
               AND check_run.intent_reason = 'preparation_failed'
          ) AND (
            NOT EXISTS (
              SELECT 1 FROM attempts WHERE revision_id = $1
            )
            OR EXISTS (
              SELECT 1 FROM semantic_generation_runs
               WHERE generation_context_id = $2
                 AND purpose = 'proof_questions'
                 AND completed_at IS NOT NULL
            )
          )
        ) AS should_schedule`,
      [input.revisionId, input.generationContextId, input.questionBudget],
    );
    if (proofEligibility.rows[0]?.proof_ready === true) {
      await this.scheduler.recoverOrExpedite(
        client,
        "semantic.generate-learning",
        learningJob(input),
      );
    } else if (proofEligibility.rows[0]?.should_schedule === true) {
      await this.scheduler.recoverOrExpedite(
        client,
        "semantic.generate-proof-questions",
        {
          schemaVersion: "1",
          idempotencyKey: `semantic.proof.v2:${input.generationContextId}`,
          artifactKind: "proof_question_plan_v2",
          revisionId: input.revisionId,
          generationContextId: input.generationContextId,
          expectedHeadSha: input.headSha,
        },
      );
    }
    return (inserted.rowCount ?? 0) === 1 ? "created" : "replayed";
  }

  async loadFrozenProofContent(
    run: SemanticRunContext,
  ): Promise<ForbiddenProofContentV1 | "pending"> {
    return readFrozenProofContent(this.database.pool, {
      revisionId: run.revisionId,
      generationContextId: run.generationContextId,
      authorId: run.authorId,
      headSha: run.generationContext.headSha,
    });
  }

  async failProofPreparation(
    payload: JobPayload<"semantic.generate-proof-questions">,
    errorClass: string,
  ): Promise<"failed" | "stale"> {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(errorClass)) {
      throw new Error("Proof preparation error class is invalid.");
    }
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`semantic-proof:${payload.revisionId}`],
      );
      const current = await client.query<{ current: boolean }>(
        `SELECT (
            revision.is_current = true
            AND revision.head_sha = $3
            AND pull_request.state = 'open'
            AND budget.generation_context_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM attempts attempt
               WHERE attempt.revision_id = revision.id
            )
          ) AS current
           FROM pull_request_revisions revision
           JOIN pull_requests pull_request
             ON pull_request.id = revision.pull_request_id
           JOIN semantic_generation_budgets budget
             ON budget.revision_id = revision.id
            AND budget.head_sha = revision.head_sha
          WHERE revision.id = $1
          FOR UPDATE OF revision, pull_request`,
        [
          payload.revisionId,
          payload.generationContextId,
          payload.expectedHeadSha,
        ],
      );
      if (current.rows[0]?.current !== true) {
        await client.query("ROLLBACK");
        return "stale";
      }
      await this.proofReady.fail(client, {
        revisionId: payload.revisionId,
        generationContextId: payload.generationContextId,
        headSha: payload.expectedHeadSha,
        errorClass,
        idempotencyKey: `semantic-preparation-failed:${payload.generationContextId}`,
      });
      await client.query("COMMIT");
      return "failed";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveRun(
    name:
      | "semantic.generate-learning"
      | "semantic.generate-practice-feedback"
      | "semantic.generate-proof-questions",
    payload:
      | JobPayload<"semantic.generate-learning">
      | JobPayload<"semantic.generate-practice-feedback">
      | JobPayload<"semantic.generate-proof-questions">,
  ): Promise<SemanticRunContext | "stale" | "proof_pending"> {
    const purpose = purposeForJob(name);
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`semantic-run:${payload.idempotencyKey}`],
      );
      const lookup = await loadRunBinding(
        client,
        payload.revisionId,
        payload.generationContextId,
        payload.expectedHeadSha,
      );
      if (
        lookup === undefined ||
        !lookup.is_current ||
        lookup.pull_request_state !== "open"
      ) {
        await client.query("ROLLBACK");
        return "stale";
      }
      const context = GenerationContextV1Schema.parse(lookup.context);
      const practice = practicePayload(payload);
      let now = new Date();
      let maximumDeleteAfter = new Date(now.getTime() + PRIVATE_RETENTION_MS);
      if (practice !== null) {
        const session = await client.query<{ delete_after: Date }>(
          `SELECT session.delete_after
             FROM practice_sessions session
             JOIN semantic_practice_answers answer
               ON answer.id = $2
              AND answer.practice_session_id = session.id
              AND answer.practice_question_id = $3
            WHERE session.id = $1
              AND session.repository_id = $4
              AND session.revision_id = $5
              AND session.generation_context_id = $6
              AND session.invalidated_at IS NULL
              AND session.deleted_at IS NULL
              AND answer.deleted_at IS NULL
              AND session.delete_after > clock_timestamp()
            FOR SHARE OF session, answer`,
          [
            practice.practiceSessionId,
            practice.practiceAnswerId,
            practice.practiceQuestionId,
            lookup.repository_id,
            lookup.revision_id,
            lookup.generation_context_id,
          ],
        );
        const sessionDeadline = session.rows[0]?.delete_after;
        if (!(sessionDeadline instanceof Date)) {
          await client.query("ROLLBACK");
          return "stale";
        }
        maximumDeleteAfter = sessionDeadline;
      }
      const databaseClock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      now = databaseClock.rows[0]?.now ?? now;
      const deleteAfter = new Date(
        Math.min(
          now.getTime() + PRIVATE_RETENTION_MS,
          maximumDeleteAfter.getTime(),
        ),
      );
      const questionCount =
        purpose === "learning_material"
          ? Math.max(3, lookup.question_budget)
          : lookup.question_budget;
      const artifactSeed = sha256(
        [
          "semantic-artifact-seed-v1",
          purpose,
          lookup.repository_id,
          lookup.revision_id,
          lookup.generation_context_id,
          lookup.repository_policy_id,
          String(questionCount),
          payload.idempotencyKey,
        ].join(":"),
      );
      const persisted = await client.query<RunRow>(
        `SELECT id, idempotency_key, purpose, repository_id, revision_id,
                generation_context_id, practice_session_id,
                practice_question_id, practice_answer_id,
                artifact_seed, question_count,
                created_at, deadline_at, delete_after, artifact_id
           FROM semantic_generation_runs
          WHERE idempotency_key = $1
          FOR SHARE`,
        [payload.idempotencyKey],
      );
      let run = persisted.rows[0];
      if (run === undefined) {
        if (purposeRequiresFrozenProof(purpose)) {
          const forbiddenProofContent = await readFrozenProofContent(client, {
            revisionId: lookup.revision_id,
            generationContextId: lookup.generation_context_id,
            authorId: lookup.author_id,
            headSha: lookup.head_sha,
          });
          if (forbiddenProofContent === "pending") {
            await client.query("ROLLBACK");
            return "proof_pending";
          }
        }
        await client.query(
          `INSERT INTO semantic_generation_runs
             (idempotency_key, purpose, repository_id, revision_id,
              generation_context_id, practice_session_id, practice_question_id,
              practice_answer_id, artifact_seed, question_count, created_at,
              deadline_at, delete_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            payload.idempotencyKey,
            purpose,
            lookup.repository_id,
            lookup.revision_id,
            lookup.generation_context_id,
            practice?.practiceSessionId ?? null,
            practice?.practiceQuestionId ?? null,
            practice?.practiceAnswerId ?? null,
            artifactSeed,
            questionCount,
            now,
            new Date(now.getTime() + GENERATION_DEADLINE_MS),
            deleteAfter,
          ],
        );
        const inserted = await client.query<RunRow>(
          `SELECT id, idempotency_key, purpose, repository_id, revision_id,
                  generation_context_id, practice_session_id,
                  practice_question_id, practice_answer_id,
                  artifact_seed, question_count,
                  created_at, deadline_at, delete_after, artifact_id
             FROM semantic_generation_runs
            WHERE idempotency_key = $1
            FOR SHARE`,
          [payload.idempotencyKey],
        );
        run = inserted.rows[0];
      }
      if (
        run === undefined ||
        run.repository_id !== lookup.repository_id ||
        run.revision_id !== lookup.revision_id ||
        run.generation_context_id !== lookup.generation_context_id ||
        run.purpose !== purpose ||
        run.practice_session_id !== (practice?.practiceSessionId ?? null) ||
        run.practice_question_id !== (practice?.practiceQuestionId ?? null) ||
        run.practice_answer_id !== (practice?.practiceAnswerId ?? null) ||
        run.artifact_seed !== artifactSeed ||
        run.question_count !== questionCount
      ) {
        throw new Error(
          "Semantic generation replay conflicts with reserved input.",
        );
      }
      await client.query("COMMIT");
      return {
        runId: run.id,
        idempotencyKey: run.idempotency_key,
        repositoryId: run.repository_id,
        revisionId: run.revision_id,
        generationContextId: run.generation_context_id,
        authorId: lookup.author_id,
        repositoryPolicyId: lookup.repository_policy_id,
        generationContext: context,
        artifactSeed: run.artifact_seed,
        questionCount: run.question_count,
        createdAt: run.created_at,
        deadlineAt: run.deadline_at,
        deleteAfter: run.delete_after,
        completedArtifactId: run.artifact_id,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistLearning(
    run: SemanticRunContext,
    result: SemanticGenerationResultV1<LearningBundleV1>,
  ): Promise<"created" | "replayed"> {
    const artifact = LearningBundleV1Schema.parse(result.artifact);
    assertArtifactBinding(run, artifact);
    return this.persistPrivateArtifact({
      run,
      artifact,
      metadata: result.providerMetadata,
      failure: result.providerFailure,
      table: "semantic_learning_bundles",
      schemaVersion: artifact.learningVersion,
      aad: semanticPrivateAad({
        kind: "learning_bundle",
        repositoryId: run.repositoryId,
        revisionId: run.revisionId,
        artifactId: artifact.id,
      }),
      expiryKind: "learning_bundle_v1",
    });
  }

  async persistPracticeFeedback(
    run: SemanticRunContext,
    payload: JobPayload<"semantic.generate-practice-feedback">,
    result: SemanticGenerationResultV1<PracticeFeedbackV1>,
  ): Promise<"created" | "replayed"> {
    const artifact = PracticeFeedbackV1Schema.parse(result.artifact);
    assertArtifactBinding(run, artifact);
    if (artifact.practiceQuestionId !== payload.practiceQuestionId) {
      throw new Error("Practice feedback question binding is invalid.");
    }
    return this.persistPrivateArtifact({
      run,
      artifact,
      metadata: result.providerMetadata,
      failure: result.providerFailure,
      table: "semantic_practice_feedback",
      schemaVersion: artifact.feedbackVersion,
      practiceSessionId: payload.practiceSessionId,
      practiceQuestionId: payload.practiceQuestionId,
      aad: semanticPrivateAad({
        kind: "practice_feedback",
        repositoryId: run.repositoryId,
        revisionId: run.revisionId,
        sessionId: payload.practiceSessionId,
        questionId: payload.practiceQuestionId,
        artifactId: artifact.id,
      }),
      expiryKind: "practice_feedback_v1",
    });
  }

  async loadPracticeQuestionAndAnswer(
    run: SemanticRunContext,
    payload: JobPayload<"semantic.generate-practice-feedback">,
  ) {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const stored = await client.query<{
        bundle_id: string;
        encrypted_bundle: string;
        answer_id: string;
        encrypted_answer: string;
      }>(
        `SELECT bundle.id AS bundle_id,
                bundle.encrypted_payload AS encrypted_bundle,
                answer.id AS answer_id,
                answer.encrypted_payload AS encrypted_answer
           FROM practice_sessions session
           JOIN pull_request_revisions revision ON revision.id = session.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           JOIN repositories repository ON repository.id = pull_request.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
           JOIN semantic_learning_bundles bundle ON bundle.id = session.learning_bundle_id
           JOIN semantic_practice_answers answer
             ON answer.practice_session_id = session.id
            AND answer.id = $3
            AND answer.practice_question_id = $4
          WHERE session.id = $1
            AND session.generation_context_id = $2
            AND session.repository_id = $5
            AND session.revision_id = $6
            AND session.user_id = $7
            AND session.invalidated_at IS NULL
            AND session.deleted_at IS NULL
            AND bundle.deleted_at IS NULL
            AND answer.deleted_at IS NULL
            AND session.delete_after > clock_timestamp()
            AND revision.is_current = true
            AND pull_request.state = 'open'
            AND pull_request.author_id = $7
            AND repository.status = 'active'
            AND installation.status = 'active'
          FOR SHARE OF session, revision, pull_request, repository,
                       installation, bundle, answer`,
        [
          payload.practiceSessionId,
          run.generationContextId,
          payload.practiceAnswerId,
          payload.practiceQuestionId,
          run.repositoryId,
          run.revisionId,
          run.authorId,
        ],
      );
      const row = stored.rows[0];
      if (row === undefined) {
        throw new Error("Private practice input is unavailable.");
      }
      const bundle = decryptSemanticArtifact(
        this.cipher,
        JSON.parse(row.encrypted_bundle),
        semanticPrivateAad({
          kind: "learning_bundle",
          repositoryId: run.repositoryId,
          revisionId: run.revisionId,
          artifactId: row.bundle_id,
        }),
        LearningBundleV1Schema,
      );
      const question = bundle.practiceQuestions.find(
        (candidate) => candidate.id === payload.practiceQuestionId,
      );
      if (question === undefined) {
        throw new Error(
          "Practice question is outside the stored learning bundle.",
        );
      }
      const answer = this.cipher.decryptJson(
        JSON.parse(row.encrypted_answer),
        semanticPrivateAad({
          kind: "practice_answer",
          repositoryId: run.repositoryId,
          revisionId: run.revisionId,
          sessionId: payload.practiceSessionId,
          questionId: payload.practiceQuestionId,
          artifactId: row.answer_id,
        }),
        ContributorPracticeAnswerV1Schema,
      );
      await client.query("COMMIT");
      return { question, answer };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async persistProofPlanAndCreateAttempt(
    run: SemanticRunContext,
    result: SemanticGenerationResultV1<ProofQuestionPlanV2>,
  ) {
    const plan = ProofQuestionPlanV2Schema.parse(result.artifact);
    assertArtifactBinding(run, plan);
    if (plan.questionBudget !== run.questionCount) {
      throw new Error("Proof plan budget is not analyzer-owned.");
    }
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`semantic-proof:${run.revisionId}`],
      );
      const current = await client.query<{
        is_current: boolean;
        head_sha: string;
      }>(
        `SELECT revision.is_current, revision.head_sha
           FROM pull_request_revisions revision
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           JOIN repositories repository ON repository.id = pull_request.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE revision.id = $1
            AND pull_request.state = 'open'
            AND repository.status = 'active'
            AND installation.status = 'active'
          FOR SHARE OF revision, pull_request, repository, installation`,
        [run.revisionId],
      );
      if (
        current.rows[0]?.is_current !== true ||
        current.rows[0]?.head_sha !== run.generationContext.headSha
      ) {
        await client.query("ROLLBACK");
        return { outcome: "stale" as const };
      }
      const existingAttempt = await client.query<{
        id: string;
        proof_plan_id: string;
        head_sha: string;
        status: string;
      }>(
        `SELECT id, proof_plan_id, head_sha, status
           FROM attempts
          WHERE revision_id = $1 AND author_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [run.revisionId, run.authorId],
      );
      const attemptHistory = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM attempts
          WHERE revision_id = $1 AND author_id = $2`,
        [run.revisionId, run.authorId],
      );
      const prior = existingAttempt.rows[0];
      if (prior !== undefined) {
        if (
          prior.proof_plan_id === plan.id &&
          prior.head_sha === plan.headSha &&
          usableAttemptStatus(prior.status)
        ) {
          await this.scheduler.recoverOrExpedite(
            client,
            "semantic.generate-learning",
            learningJob({
              revisionId: run.revisionId,
              generationContextId: run.generationContextId,
              headSha: plan.headSha,
            }),
          );
          await client.query("COMMIT");
          return { outcome: "replayed" as const, attemptId: prior.id };
        }
        if (
          prior.proof_plan_id !== plan.id ||
          prior.head_sha !== plan.headSha ||
          prior.status !== "invalidated"
        ) {
          await client.query("ROLLBACK");
          return { outcome: "existing_attempt_conflict" as const };
        }
      }
      await client.query(
        `INSERT INTO semantic_proof_plans_v2
           (id, run_id, repository_id, revision_id, generation_context_id,
            head_sha, context_hash, schema_version, planner_version,
            content_hash, plan_hash, question_budget, generation_outcome,
            plan, created_at, delete_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14::jsonb, $15, $16)
         ON CONFLICT (run_id) DO NOTHING`,
        [
          plan.id,
          run.runId,
          run.repositoryId,
          run.revisionId,
          run.generationContextId,
          plan.headSha,
          plan.contextHash,
          plan.planVersion,
          plan.plannerVersion,
          plan.contentHash,
          plan.planHash,
          plan.questionBudget,
          plan.generationOutcome,
          JSON.stringify(plan),
          plan.createdAt,
          plan.deleteAfter,
        ],
      );
      await client.query(
        `INSERT INTO proof_plans
           (id, revision_id, generation_context_id, repository_policy_id,
            plan_version, deterministic_seed, risk_explanation,
            question_budget, plan_hash, status, created_at)
         VALUES ($1, $2, $3, $4, 'proof-planner-v2', $5, $6::jsonb,
                 $7, $8, 'ready', $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          plan.id,
          run.revisionId,
          run.generationContextId,
          run.repositoryPolicyId,
          run.artifactSeed,
          JSON.stringify({
            schemaVersion: "1",
            source: "semantic-proof-plan-v2",
            contextHash: plan.contextHash,
            generationOutcome: plan.generationOutcome,
          }),
          plan.questionBudget,
          plan.planHash,
          plan.createdAt,
        ],
      );
      for (const question of plan.questions) {
        const primaryAnchorId = question.anchorIds[0];
        const anchor = run.generationContext.anchors.find(
          (candidate) => candidate.id === primaryAnchorId,
        );
        if (anchor === undefined)
          throw new Error("Proof anchor is unavailable.");
        const exactAnchor = {
          id: anchor.id,
          file: anchor.filename.content,
          hunkHeader: anchor.hunkHeader.content,
          oldStart: anchor.oldStart,
          newStart: anchor.newStart,
          changedLines: anchor.changedLines,
          evidence: anchor.evidence.content,
        };
        await client.query(
          `INSERT INTO proof_questions
             (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, true)
           ON CONFLICT (proof_plan_id, ordinal) DO NOTHING`,
          [
            question.id,
            plan.id,
            question.order - 1,
            question.intent,
            question.prompt,
            JSON.stringify(exactAnchor),
            JSON.stringify({
              requiredPoints: question.rubric.requiredPoints.map(
                (point) => point.description,
              ),
              rejectsGenericAnswer: true,
            }),
          ],
        );
      }
      await assertProofReplay(client, plan, run.generationContext);
      const attemptId = deterministicUuid(
        `semantic-attempt-v1:${run.revisionId}:${run.authorId}:${plan.id}:${String(
          (attemptHistory.rows[0]?.count ?? 0) + 1,
        )}`,
      );
      const databaseClock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      const attemptCreatedAt = databaseClock.rows[0]?.now ?? new Date();
      const expiresAt = new Date(
        attemptCreatedAt.getTime() + ATTEMPT_LIFETIME_MS,
      );
      if (expiresAt.getTime() <= attemptCreatedAt.getTime()) {
        throw new Error(
          "Proof V2 plan retention expired before Attempt recovery.",
        );
      }
      await client.query(
        `INSERT INTO attempts
           (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
            status, nonce_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8)`,
        [
          attemptId,
          run.repositoryId,
          run.revisionId,
          run.authorId,
          plan.id,
          plan.headSha,
          sha256(`semantic-attempt-nonce-v1:${attemptId}`),
          expiresAt,
        ],
      );
      if (run.completedArtifactId === null) {
        await persistInvocation(
          client,
          run,
          result.providerMetadata,
          result.providerFailure,
        );
        await completeRun(client, run, plan.id, result.degraded);
      } else if (run.completedArtifactId !== plan.id) {
        throw new Error("Completed semantic Proof run points to another plan.");
      }
      await this.scheduler.recoverOrExpedite(
        client,
        "semantic.generate-learning",
        learningJob({
          revisionId: run.revisionId,
          generationContextId: run.generationContextId,
          headSha: plan.headSha,
        }),
      );
      await this.scheduler.scheduleAttemptExpiry(
        client,
        {
          schemaVersion: "1",
          idempotencyKey: `semantic.expire.attempt:${attemptId}`,
          attemptId,
          expectedHeadSha: plan.headSha,
        },
        expiresAt,
      );
      await this.proofReady.write(client, {
        revisionId: run.revisionId,
        headSha: plan.headSha,
        attemptId,
        proofPlanId: plan.id,
        expiresAt,
        idempotencyKey: run.idempotencyKey,
      });
      await client.query("COMMIT");
      return {
        outcome:
          prior === undefined ? ("created" as const) : ("recovered" as const),
        attemptId,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replayCompletedProof(run: SemanticRunContext) {
    const result = await this.database.pool.query<{
      attempt_id: string;
      head_sha: string;
      is_current: boolean;
      status: string;
      plan: unknown;
    }>(
      `SELECT attempt.id AS attempt_id, attempt.head_sha, revision.is_current,
              attempt.status,
              semantic_plan.plan
         FROM semantic_generation_runs generation_run
         JOIN semantic_proof_plans_v2 semantic_plan
           ON semantic_plan.id = generation_run.artifact_id
          AND semantic_plan.run_id = generation_run.id
         JOIN LATERAL (
           SELECT candidate.id, candidate.head_sha, candidate.status,
                  candidate.revision_id
             FROM attempts candidate
            WHERE candidate.proof_plan_id = semantic_plan.id
            ORDER BY candidate.created_at DESC, candidate.id DESC
            LIMIT 1
         ) attempt ON true
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
        WHERE generation_run.id = $1
          AND generation_run.revision_id = $2
          AND generation_run.generation_context_id = $3
        LIMIT 2`,
      [run.runId, run.revisionId, run.generationContextId],
    );
    const row = result.rows.length === 1 ? result.rows[0] : undefined;
    const parsed = hydrateSemanticArtifact(
      row?.plan,
      ProofQuestionPlanV2Schema,
    );
    if (
      row === undefined ||
      parsed === null ||
      parsed.id !== run.completedArtifactId ||
      row.head_sha !== run.generationContext.headSha
    ) {
      throw new Error("Completed Proof V2 replay is inconsistent.");
    }
    if (!row.is_current) return { outcome: "stale" as const };
    if (usableAttemptStatus(row.status)) {
      return { outcome: "replayed" as const, attemptId: row.attempt_id };
    }
    if (row.status !== "invalidated") {
      return { outcome: "existing_attempt_conflict" as const };
    }
    const recovered = await this.persistProofPlanAndCreateAttempt(run, {
      artifact: parsed,
      providerMetadata: await this.loadInvocationMetadata(run.runId),
      providerFailure: null,
      degraded: parsed.generationOutcome === "fallback",
    });
    switch (recovered.outcome) {
      case "created":
      case "recovered":
        return {
          outcome: "recovered" as const,
          attemptId: recovered.attemptId,
        };
      case "replayed":
        return { outcome: "replayed" as const, attemptId: recovered.attemptId };
      case "stale":
      case "existing_attempt_conflict":
        return { outcome: recovered.outcome };
    }
  }

  private async loadInvocationMetadata(runId: string) {
    const result = await this.database.pool.query<{
      call_id: string;
      metadata_version: string;
      purpose: string;
      provider: string;
      model: string;
      prompt_version: string;
      output_schema_version: string;
      planner_version: string;
      input_hash: string;
      output_hash: string;
      input_tokens: number | null;
      output_tokens: number | null;
      latency_ms: number;
      invocation_count: number;
      outcome: string;
      degraded: boolean;
      completed_at: Date;
    }>(
      `SELECT * FROM semantic_provider_invocations WHERE run_id = $1 LIMIT 1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("Semantic invocation metadata is unavailable.");
    return SemanticProviderInvocationMetadataV1Schema.parse({
      schemaVersion: "1",
      metadataVersion: row.metadata_version,
      callId: row.call_id,
      purpose: row.purpose,
      provider: row.provider,
      model: row.model,
      promptVersion: row.prompt_version,
      outputSchemaVersion: row.output_schema_version,
      plannerVersion: row.planner_version,
      inputHash: row.input_hash,
      outputHash: row.output_hash,
      tokenUsage:
        row.input_tokens === null || row.output_tokens === null
          ? null
          : { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
      latencyMs: row.latency_ms,
      invocationCount: row.invocation_count,
      outcome: row.outcome,
      degraded: row.degraded,
      completedAt: row.completed_at,
    });
  }

  async startPracticeSession(input: StartPracticeSessionInput) {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await reserveSemanticPracticeRateLimit(client, {
        repositoryId: input.repositoryId,
        revisionId: input.revisionId,
        actorKeyHash: input.actorKeyHash,
        action: "start_session",
        maximumEvents: 5,
        windowSeconds: 60,
      });
      const bundle = await client.query<{
        head_sha: string;
        context_hash: string;
        delete_after: Date;
      }>(
        `SELECT bundle.head_sha, bundle.context_hash, bundle.delete_after
           FROM semantic_learning_bundles bundle
           JOIN pull_request_revisions revision ON revision.id = bundle.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           JOIN repositories repository ON repository.id = pull_request.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
          WHERE bundle.id = $1
            AND bundle.repository_id = $2
            AND bundle.revision_id = $3
            AND bundle.generation_context_id = $4
            AND bundle.deleted_at IS NULL
            AND bundle.delete_after > clock_timestamp()
            AND revision.is_current = true
            AND revision.head_sha = bundle.head_sha
            AND pull_request.state = 'open'
            AND pull_request.author_id = $5
            AND repository.status = 'active'
            AND installation.status = 'active'
          FOR SHARE OF bundle, revision, pull_request, repository, installation`,
        [
          input.learningBundleId,
          input.repositoryId,
          input.revisionId,
          input.generationContextId,
          input.userId,
        ],
      );
      const material = bundle.rows[0];
      if (material === undefined)
        throw new Error("Learning bundle is unavailable.");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`semantic-practice-session:${input.revisionId}:${input.userId}`],
      );
      const existing = await client.query<{
        id: string;
        learning_bundle_id: string;
        delete_after: Date;
      }>(
        `SELECT id, learning_bundle_id, delete_after FROM practice_sessions
          WHERE revision_id = $1 AND user_id = $2
            AND generation_context_id = $3
            AND invalidated_at IS NULL AND deleted_at IS NULL
          FOR UPDATE`,
        [input.revisionId, input.userId, input.generationContextId],
      );
      const activeSession = existing.rows[0];
      if (
        activeSession !== undefined &&
        activeSession.learning_bundle_id === input.learningBundleId
      ) {
        await client.query("COMMIT");
        return {
          sessionId: activeSession.id,
          deleteAfter: activeSession.delete_after,
        };
      }
      if (activeSession !== undefined) {
        await client.query(
          `UPDATE practice_sessions
              SET invalidated_at = clock_timestamp()
            WHERE id = $1 AND invalidated_at IS NULL AND deleted_at IS NULL`,
          [activeSession.id],
        );
      }
      const sessionId = randomUUID();
      await client.query(
        `INSERT INTO practice_sessions
           (id, revision_id, repository_id, generation_context_id,
            learning_bundle_id, head_sha, context_hash, user_id, version,
            started_at, delete_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 'practice-session-v1', clock_timestamp(), $9)`,
        [
          sessionId,
          input.revisionId,
          input.repositoryId,
          input.generationContextId,
          input.learningBundleId,
          material.head_sha,
          material.context_hash,
          input.userId,
          material.delete_after,
        ],
      );
      await client.query("COMMIT");
      return { sessionId, deleteAfter: material.delete_after };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async submitPracticeAnswer(input: SubmitPracticeAnswerInput) {
    const answer = ContributorPracticeAnswerV1Schema.parse(input.answer);
    if (Buffer.byteLength(answer.content, "utf8") > MAX_PRACTICE_ANSWER_BYTES) {
      throw new Error("Practice answer exceeds the UTF-8 byte limit.");
    }
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await reserveSemanticPracticeRateLimit(client, {
        repositoryId: input.repositoryId,
        revisionId: input.revisionId,
        actorKeyHash: input.actorKeyHash,
        action: "submit_answer",
        maximumEvents: 10,
        windowSeconds: 60,
      });
      const session = await client.query<{
        learning_bundle_id: string;
        encrypted_payload: string;
        delete_after: Date;
      }>(
        `SELECT session.learning_bundle_id, bundle.encrypted_payload,
                session.delete_after
           FROM practice_sessions session
           JOIN pull_request_revisions revision ON revision.id = session.revision_id
           JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
           JOIN repositories repository ON repository.id = pull_request.repository_id
           JOIN installations installation ON installation.id = repository.installation_id
           JOIN semantic_learning_bundles bundle ON bundle.id = session.learning_bundle_id
          WHERE session.id = $1
            AND session.repository_id = $2
            AND session.revision_id = $3
            AND session.generation_context_id = $4
            AND session.user_id = $5
            AND session.invalidated_at IS NULL
            AND session.deleted_at IS NULL
            AND session.delete_after > clock_timestamp()
            AND revision.is_current = true
            AND pull_request.state = 'open'
            AND pull_request.author_id = $5
            AND repository.status = 'active'
            AND installation.status = 'active'
            AND bundle.deleted_at IS NULL
          FOR SHARE OF session, revision, pull_request, repository,
                       installation, bundle`,
        [
          input.practiceSessionId,
          input.repositoryId,
          input.revisionId,
          input.generationContextId,
          input.userId,
        ],
      );
      const bound = session.rows[0];
      if (bound === undefined)
        throw new Error("Practice session is unavailable.");
      const learning = decryptSemanticArtifact(
        this.cipher,
        JSON.parse(bound.encrypted_payload),
        semanticPrivateAad({
          kind: "learning_bundle",
          repositoryId: input.repositoryId,
          revisionId: input.revisionId,
          artifactId: bound.learning_bundle_id,
        }),
        LearningBundleV1Schema,
      );
      if (
        !learning.practiceQuestions.some(
          (question) => question.id === input.practiceQuestionId,
        )
      ) {
        throw new Error("Practice question is outside the session bundle.");
      }
      const answerId = deterministicUuid(
        `semantic-practice-answer-v1:${input.practiceSessionId}:${input.practiceQuestionId}`,
      );
      const encrypted = JSON.stringify(
        this.cipher.encryptJson(
          answer,
          semanticPrivateAad({
            kind: "practice_answer",
            repositoryId: input.repositoryId,
            revisionId: input.revisionId,
            sessionId: input.practiceSessionId,
            questionId: input.practiceQuestionId,
            artifactId: answerId,
          }),
        ),
      );
      const inserted = await client.query(
        `INSERT INTO semantic_practice_answers
           (id, practice_session_id, repository_id, revision_id,
            generation_context_id, practice_question_id, encrypted_payload,
            delete_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (practice_session_id, practice_question_id) DO NOTHING
         RETURNING id`,
        [
          answerId,
          input.practiceSessionId,
          input.repositoryId,
          input.revisionId,
          input.generationContextId,
          input.practiceQuestionId,
          encrypted,
          bound.delete_after,
        ],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        const existing = await client.query<{ encrypted_payload: string }>(
          `SELECT encrypted_payload FROM semantic_practice_answers
            WHERE id = $1 AND deleted_at IS NULL FOR SHARE`,
          [answerId],
        );
        const prior = existing.rows[0];
        if (prior === undefined)
          throw new Error("Practice answer replay is unavailable.");
        const decoded = this.cipher.decryptJson(
          JSON.parse(prior.encrypted_payload),
          semanticPrivateAad({
            kind: "practice_answer",
            repositoryId: input.repositoryId,
            revisionId: input.revisionId,
            sessionId: input.practiceSessionId,
            questionId: input.practiceQuestionId,
            artifactId: answerId,
          }),
          ContributorPracticeAnswerV1Schema,
        );
        if (stableJson(decoded) !== stableJson(answer)) {
          throw new Error(
            "Practice answer replay conflicts with stored content.",
          );
        }
        await client.query("COMMIT");
        return { answerId, replayed: true };
      }
      const job: JobPayload<"semantic.generate-practice-feedback"> = {
        schemaVersion: "1",
        idempotencyKey: `semantic.practice.feedback:${answerId}`,
        artifactKind: "practice_feedback_v1",
        revisionId: input.revisionId,
        generationContextId: input.generationContextId,
        expectedHeadSha: learning.headSha,
        practiceSessionId: input.practiceSessionId,
        practiceQuestionId: input.practiceQuestionId,
        practiceAnswerId: answerId,
      };
      await this.scheduler.schedule(
        client,
        "semantic.generate-practice-feedback",
        job,
      );
      await this.scheduler.schedule(
        client,
        "semantic.expire-private",
        {
          schemaVersion: "1",
          idempotencyKey: `semantic.expire.answer:${answerId}`,
          revisionId: input.revisionId,
          artifactId: answerId,
          artifactKind: "practice_answer_v1",
        },
        bound.delete_after,
      );
      await client.query("COMMIT");
      return { answerId, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readPracticeView(input: ReadPracticeViewInput): Promise<PracticeView> {
    if (
      !uuid(input.repositoryId) ||
      !uuid(input.revisionId) ||
      !uuid(input.generationContextId) ||
      (input.practiceSessionId !== undefined &&
        !uuid(input.practiceSessionId)) ||
      input.userId.length < 1 ||
      input.userId.length > 200
    ) {
      return { state: "unavailable" };
    }
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query<{
        head_sha: string;
        context: unknown;
      }>(
        `SELECT revision.head_sha, generation_context.context
         FROM semantic_generation_budgets budget
         JOIN pull_request_revisions revision ON revision.id = budget.revision_id
         JOIN generation_contexts generation_context
           ON generation_context.id = budget.generation_context_id
         JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
         JOIN repositories repository ON repository.id = pull_request.repository_id
         JOIN installations installation ON installation.id = repository.installation_id
        WHERE budget.repository_id = $1
          AND budget.revision_id = $2
          AND budget.generation_context_id = $3
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND pull_request.author_id = $4
          AND repository.status = 'active'
          AND installation.status = 'active'
        LIMIT 1
        FOR SHARE OF budget, revision, generation_context, pull_request,
                     repository, installation`,
        [
          input.repositoryId,
          input.revisionId,
          input.generationContextId,
          input.userId,
        ],
      );
      const row = state.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return { state: "unavailable" };
      }
      const generationContext = GenerationContextV1Schema.parse(row.context);
      const storedBundle = await client.query<{
        id: string;
        encrypted_payload: string;
        generation_outcome: "generated" | "repaired" | "fallback";
      }>(
        `SELECT id, encrypted_payload, generation_outcome
           FROM semantic_learning_bundles
          WHERE repository_id = $1
            AND revision_id = $2
            AND generation_context_id = $3
            AND deleted_at IS NULL
            AND delete_after > clock_timestamp()
          ORDER BY (generation_outcome = 'fallback') ASC, created_at DESC, id DESC
          LIMIT 1
          FOR SHARE`,
        [input.repositoryId, input.revisionId, input.generationContextId],
      );
      const bundle = storedBundle.rows[0];
      if (bundle === undefined) {
        await client.query("COMMIT");
        return {
          state: "generating",
          revisionId: input.revisionId,
          headSha: row.head_sha,
        };
      }
      if (bundle.generation_outcome === "fallback") {
        const retry = learningJob({
          revisionId: input.revisionId,
          generationContextId: input.generationContextId,
          headSha: row.head_sha,
        });
        const retryRun = await client.query<{
          completed_at: Date | null;
          degraded: boolean | null;
        }>(
          `SELECT completed_at, degraded
             FROM semantic_generation_runs
            WHERE idempotency_key = $1
            LIMIT 1
            FOR SHARE`,
          [retry.idempotencyKey],
        );
        const retryState = retryRun.rows[0];
        if (retryState === undefined || retryState.completed_at === null) {
          await this.scheduler.recoverOrExpedite(
            client,
            "semantic.generate-learning",
            retry,
          );
          await client.query("COMMIT");
          return {
            state: "generating",
            revisionId: input.revisionId,
            headSha: row.head_sha,
          };
        }
        if (retryState.degraded === true) {
          await client.query("COMMIT");
          return {
            state: "generation_failed",
            revisionId: input.revisionId,
            headSha: row.head_sha,
          };
        }
        throw new Error("Generated Learning retry has no readable artifact.");
      }
      const learning = decryptSemanticArtifact(
        this.cipher,
        JSON.parse(bundle.encrypted_payload),
        semanticPrivateAad({
          kind: "learning_bundle",
          repositoryId: input.repositoryId,
          revisionId: input.revisionId,
          artifactId: bundle.id,
        }),
        LearningBundleV1Schema,
      );
      if (input.practiceSessionId === undefined) {
        await client.query("COMMIT");
        return {
          state: "ready",
          revisionId: input.revisionId,
          headSha: row.head_sha,
          patchPreview: practicePatchPreview(generationContext),
          learning,
          practiceSession: null,
        };
      }
      const session = await client.query<{
        id: string;
        delete_after: Date;
      }>(
        `SELECT id, delete_after
         FROM practice_sessions
        WHERE id = $1 AND repository_id = $2 AND revision_id = $3
          AND generation_context_id = $4 AND learning_bundle_id = $5
          AND user_id = $6 AND invalidated_at IS NULL AND deleted_at IS NULL
          AND delete_after > clock_timestamp()
        LIMIT 1
        FOR SHARE`,
        [
          input.practiceSessionId,
          input.repositoryId,
          input.revisionId,
          input.generationContextId,
          bundle.id,
          input.userId,
        ],
      );
      const boundSession = session.rows[0];
      if (boundSession === undefined) {
        await client.query("COMMIT");
        return { state: "unavailable" };
      }
      const storedFeedback = await client.query<{
        id: string;
        practice_question_id: string;
        encrypted_payload: string;
      }>(
        `SELECT id, practice_question_id, encrypted_payload
         FROM semantic_practice_feedback
        WHERE practice_session_id = $1 AND deleted_at IS NULL
          AND delete_after > clock_timestamp()
        ORDER BY created_at, id
        FOR SHARE`,
        [boundSession.id],
      );
      const storedAnswers = await client.query<{
        id: string;
        practice_question_id: string;
        encrypted_payload: string;
      }>(
        `SELECT id, practice_question_id, encrypted_payload
         FROM semantic_practice_answers
        WHERE practice_session_id = $1
          AND deleted_at IS NULL
          AND delete_after > clock_timestamp()
        ORDER BY created_at, id
        FOR SHARE`,
        [boundSession.id],
      );
      const feedbackByQuestionId: Record<string, PracticeFeedbackV1> = {};
      for (const feedback of storedFeedback.rows) {
        feedbackByQuestionId[feedback.practice_question_id] =
          decryptSemanticArtifact(
            this.cipher,
            JSON.parse(feedback.encrypted_payload),
            semanticPrivateAad({
              kind: "practice_feedback",
              repositoryId: input.repositoryId,
              revisionId: input.revisionId,
              sessionId: boundSession.id,
              questionId: feedback.practice_question_id,
              artifactId: feedback.id,
            }),
            PracticeFeedbackV1Schema,
          );
      }
      const knownQuestionIds = new Set(
        learning.practiceQuestions.map((question) => question.id),
      );
      const answersByQuestionId: Record<string, string> = {};
      for (const stored of storedAnswers.rows) {
        if (!knownQuestionIds.has(stored.practice_question_id)) continue;
        const answer = this.cipher.decryptJson(
          JSON.parse(stored.encrypted_payload),
          semanticPrivateAad({
            kind: "practice_answer",
            repositoryId: input.repositoryId,
            revisionId: input.revisionId,
            sessionId: boundSession.id,
            questionId: stored.practice_question_id,
            artifactId: stored.id,
          }),
          ContributorPracticeAnswerV1Schema,
        );
        answersByQuestionId[stored.practice_question_id] = answer.content;
      }
      const pendingQuestionIds = Object.keys(answersByQuestionId).filter(
        (questionId) => feedbackByQuestionId[questionId] === undefined,
      );
      await client.query("COMMIT");
      return {
        state: "ready",
        revisionId: input.revisionId,
        headSha: row.head_sha,
        patchPreview: practicePatchPreview(generationContext),
        learning,
        practiceSession: {
          id: boundSession.id,
          deleteAfter: boundSession.delete_after,
          questions: learning.practiceQuestions,
          pendingQuestionIds,
          answersByQuestionId,
          feedbackByQuestionId,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async expirePrivate(payload: JobPayload<"semantic.expire-private">) {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`semantic-expire:${payload.artifactKind}:${payload.artifactId}`],
      );
      const table = privateTable(payload.artifactKind);
      const state = await client.query<{
        revision_id: string;
        delete_after: Date;
        deleted_at: Date | null;
        is_current: boolean;
        invalidated_at: Date | null;
      }>(
        `SELECT artifact.revision_id, artifact.delete_after,
                artifact.deleted_at, revision.is_current,
                revision.invalidated_at
           FROM ${table} artifact
           JOIN pull_request_revisions revision ON revision.id = artifact.revision_id
          WHERE artifact.id = $1 AND artifact.revision_id = $2
          FOR UPDATE OF artifact`,
        [payload.artifactId, payload.revisionId],
      );
      const row = state.rows[0];
      if (row === undefined)
        throw new Error("Private semantic artifact is unavailable.");
      if (row.deleted_at !== null) {
        await client.query("COMMIT");
        return "replayed" as const;
      }
      const clock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      const now = clock.rows[0]?.now ?? new Date();
      if (row.is_current && row.delete_after.getTime() > now.getTime()) {
        throw new Error("Private semantic artifact is not due for deletion.");
      }
      const invalidatedAt = row.is_current ? null : (row.invalidated_at ?? now);
      await client.query(
        `UPDATE ${table}
            SET encrypted_payload = NULL, invalidated_at = $2, deleted_at = $3
          WHERE id = $1 AND encrypted_payload IS NOT NULL`,
        [payload.artifactId, invalidatedAt, now],
      );
      if (payload.artifactKind === "learning_bundle_v1") {
        await client.query(
          `UPDATE semantic_practice_answers answer
              SET encrypted_payload = NULL,
                  invalidated_at = COALESCE(answer.invalidated_at, $2),
                  deleted_at = $2
             FROM practice_sessions session
            WHERE session.learning_bundle_id = $1
              AND answer.practice_session_id = session.id
              AND answer.encrypted_payload IS NOT NULL`,
          [payload.artifactId, now],
        );
        await client.query(
          `UPDATE semantic_practice_feedback feedback
              SET encrypted_payload = NULL,
                  invalidated_at = COALESCE(feedback.invalidated_at, $2),
                  deleted_at = $2
             FROM practice_sessions session
            WHERE session.learning_bundle_id = $1
              AND feedback.practice_session_id = session.id
              AND feedback.encrypted_payload IS NOT NULL`,
          [payload.artifactId, now],
        );
        await client.query(
          `UPDATE practice_sessions
              SET invalidated_at = COALESCE(invalidated_at, $2), deleted_at = $2
            WHERE learning_bundle_id = $1 AND deleted_at IS NULL`,
          [payload.artifactId, now],
        );
      }
      await client.query("COMMIT");
      return "deleted" as const;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async sweepDueSemanticPrivate(now: Date, limit = 100) {
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new Error("Semantic private retention sweep input is invalid.");
    }
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{
        artifact_id: string;
        revision_id: string;
        artifact_kind:
          "learning_bundle_v1" | "practice_answer_v1" | "practice_feedback_v1";
        delete_after: Date;
      }>(
        `SELECT due.artifact_id, due.revision_id, due.artifact_kind,
                due.delete_after
           FROM (
             SELECT bundle.id AS artifact_id, bundle.revision_id,
                    'learning_bundle_v1'::text AS artifact_kind,
                    bundle.delete_after, revision.is_current
               FROM semantic_learning_bundles bundle
               JOIN pull_request_revisions revision ON revision.id = bundle.revision_id
              WHERE bundle.encrypted_payload IS NOT NULL
             UNION ALL
             SELECT answer.id, answer.revision_id,
                    'practice_answer_v1'::text, answer.delete_after,
                    revision.is_current
               FROM semantic_practice_answers answer
               JOIN pull_request_revisions revision ON revision.id = answer.revision_id
              WHERE answer.encrypted_payload IS NOT NULL
             UNION ALL
             SELECT feedback.id, feedback.revision_id,
                    'practice_feedback_v1'::text, feedback.delete_after,
                    revision.is_current
               FROM semantic_practice_feedback feedback
               JOIN pull_request_revisions revision ON revision.id = feedback.revision_id
              WHERE feedback.encrypted_payload IS NOT NULL
           ) due
          WHERE due.delete_after <= $1 OR due.is_current = false
          ORDER BY due.delete_after, due.artifact_id
          LIMIT $2`,
        [now, limit],
      );
      let requeued = 0;
      for (const artifact of due.rows) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`semantic-expire:${artifact.artifact_kind}:${artifact.artifact_id}`],
        );
        await this.scheduler.recoverOrExpedite(
          client,
          "semantic.expire-private",
          {
            schemaVersion: "1",
            idempotencyKey: `semantic.expire.${artifact.artifact_kind}:${artifact.artifact_id}`,
            revisionId: artifact.revision_id,
            artifactId: artifact.artifact_id,
            artifactKind: artifact.artifact_kind,
          },
          artifact.delete_after,
        );
        requeued += 1;
      }
      const incomplete = await client.query<{
        generation_context_id: string;
        revision_id: string;
        head_sha: string;
        needs_learning: boolean;
        needs_proof: boolean;
      }>(
        `SELECT budget.generation_context_id, budget.revision_id,
                budget.head_sha,
                NOT EXISTS (
                  SELECT 1 FROM semantic_generation_runs run
                   WHERE run.generation_context_id = budget.generation_context_id
                     AND run.purpose = 'learning_material'
                     AND run.completed_at IS NOT NULL
                ) AS needs_learning,
                (NOT EXISTS (
                  SELECT 1 FROM check_runs check_run
                   WHERE check_run.revision_id = budget.revision_id
                     AND check_run.intent_reason = 'preparation_failed'
                ) AND NOT EXISTS (
                  SELECT 1 FROM semantic_generation_runs run
                   WHERE run.generation_context_id = budget.generation_context_id
                     AND run.purpose = 'proof_questions'
                     AND run.completed_at IS NOT NULL
                ) AND NOT EXISTS (
                  SELECT 1 FROM attempts attempt
                   WHERE attempt.revision_id = budget.revision_id
                )) AS needs_proof
           FROM semantic_generation_budgets budget
           JOIN pull_request_revisions revision
             ON revision.id = budget.revision_id
            AND revision.head_sha = budget.head_sha
           JOIN pull_requests pull_request
             ON pull_request.id = revision.pull_request_id
           JOIN repositories repository
             ON repository.id = budget.repository_id
            AND repository.id = pull_request.repository_id
           JOIN installations installation
             ON installation.id = repository.installation_id
          WHERE revision.is_current = true
            AND pull_request.state = 'open'
            AND repository.status = 'active'
            AND installation.status = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM check_runs check_run
               WHERE check_run.revision_id = budget.revision_id
                 AND check_run.intent_reason = 'preparation_failed'
            )
            AND (
              NOT EXISTS (
                SELECT 1 FROM semantic_generation_runs run
                 WHERE run.generation_context_id = budget.generation_context_id
                   AND run.purpose = 'learning_material'
                   AND run.completed_at IS NOT NULL
              )
              OR (NOT EXISTS (
                SELECT 1 FROM check_runs check_run
                 WHERE check_run.revision_id = budget.revision_id
                   AND check_run.intent_reason = 'preparation_failed'
              ) AND NOT EXISTS (
                SELECT 1 FROM semantic_generation_runs run
                 WHERE run.generation_context_id = budget.generation_context_id
                   AND run.purpose = 'proof_questions'
                   AND run.completed_at IS NOT NULL
              ) AND NOT EXISTS (
                SELECT 1 FROM attempts attempt
                 WHERE attempt.revision_id = budget.revision_id
              ))
            )
          ORDER BY budget.created_at, budget.generation_context_id
          LIMIT $1
          FOR SHARE OF budget, revision, pull_request, repository, installation`,
        [limit],
      );
      for (const budget of incomplete.rows) {
        if (budget.needs_learning) {
          await this.scheduler.recoverOrExpedite(
            client,
            "semantic.generate-learning",
            learningJob({
              revisionId: budget.revision_id,
              generationContextId: budget.generation_context_id,
              headSha: budget.head_sha,
            }),
          );
          requeued += 1;
        }
        if (budget.needs_proof) {
          await this.scheduler.recoverOrExpedite(
            client,
            "semantic.generate-proof-questions",
            {
              schemaVersion: "1",
              idempotencyKey: `semantic.proof.v2:${budget.generation_context_id}`,
              artifactKind: "proof_question_plan_v2",
              revisionId: budget.revision_id,
              generationContextId: budget.generation_context_id,
              expectedHeadSha: budget.head_sha,
            },
          );
          requeued += 1;
        }
      }
      await client.query(
        `DELETE FROM semantic_practice_capability_uses
          WHERE jti IN (
            SELECT jti FROM semantic_practice_capability_uses
             WHERE expires_at <= $1
             ORDER BY expires_at, jti
             LIMIT 1000
          )`,
        [now],
      );
      await client.query(
        `DELETE FROM semantic_practice_rate_limits
          WHERE id IN (
            SELECT id FROM semantic_practice_rate_limits
             WHERE expires_at <= $1
             ORDER BY expires_at, id
             LIMIT 1000
          )`,
        [now],
      );
      await client.query("COMMIT");
      return { scanned: due.rows.length + incomplete.rows.length, requeued };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async persistPrivateArtifact(input: {
    run: SemanticRunContext;
    artifact: LearningBundleV1 | PracticeFeedbackV1;
    metadata: SemanticProviderInvocationMetadataV1;
    failure: SemanticProviderFailureV1 | null;
    table: "semantic_learning_bundles" | "semantic_practice_feedback";
    schemaVersion: string;
    aad: string;
    expiryKind: "learning_bundle_v1" | "practice_feedback_v1";
    practiceSessionId?: string;
    practiceQuestionId?: string;
  }): Promise<"created" | "replayed"> {
    const encrypted = JSON.stringify(
      this.cipher.encryptJson(input.artifact, input.aad),
    );
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`semantic-run:${input.run.runId}`],
      );
      const completed = await client.query<{ artifact_id: string | null }>(
        "SELECT artifact_id FROM semantic_generation_runs WHERE id = $1 FOR UPDATE",
        [input.run.runId],
      );
      const completedId = completed.rows[0]?.artifact_id;
      if (completedId !== null && completedId !== undefined) {
        if (completedId !== input.artifact.id) {
          throw new Error(
            "Semantic artifact replay conflicts with completed run.",
          );
        }
        await assertPrivateReplay(
          client,
          input.table,
          input.artifact.id,
          input.artifact,
          input.aad,
          this.cipher,
        );
        await client.query("COMMIT");
        return "replayed";
      }
      if (input.table === "semantic_learning_bundles") {
        await client.query(
          `INSERT INTO semantic_learning_bundles
             (id, run_id, repository_id, revision_id, generation_context_id,
              head_sha, context_hash, schema_version, content_hash,
              generation_outcome, encrypted_payload, delete_after, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            input.artifact.id,
            input.run.runId,
            input.run.repositoryId,
            input.run.revisionId,
            input.run.generationContextId,
            input.artifact.headSha,
            input.artifact.contextHash,
            input.schemaVersion,
            input.artifact.contentHash,
            input.artifact.generationOutcome,
            encrypted,
            input.artifact.deleteAfter,
            input.artifact.createdAt,
          ],
        );
      } else {
        if (
          input.practiceSessionId === undefined ||
          input.practiceQuestionId === undefined
        ) {
          throw new Error(
            "Practice feedback persistence binding is incomplete.",
          );
        }
        await client.query(
          `INSERT INTO semantic_practice_feedback
             (id, run_id, practice_session_id, repository_id, revision_id,
              generation_context_id, practice_question_id, head_sha,
              context_hash, schema_version, content_hash, generation_outcome,
              encrypted_payload, delete_after, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15)`,
          [
            input.artifact.id,
            input.run.runId,
            input.practiceSessionId,
            input.run.repositoryId,
            input.run.revisionId,
            input.run.generationContextId,
            input.practiceQuestionId,
            input.artifact.headSha,
            input.artifact.contextHash,
            input.schemaVersion,
            input.artifact.contentHash,
            input.artifact.generationOutcome,
            encrypted,
            input.artifact.deleteAfter,
            input.artifact.createdAt,
          ],
        );
      }
      await persistInvocation(client, input.run, input.metadata, input.failure);
      await completeRun(
        client,
        input.run,
        input.artifact.id,
        input.metadata.degraded,
      );
      await this.scheduler.schedule(
        client,
        "semantic.expire-private",
        {
          schemaVersion: "1",
          idempotencyKey: `semantic.expire.${input.expiryKind}:${input.artifact.id}`,
          revisionId: input.run.revisionId,
          artifactId: input.artifact.id,
          artifactKind: input.expiryKind,
        },
        input.artifact.deleteAfter,
      );
      await client.query("COMMIT");
      return "created";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadRunBinding(
  client: PoolClient,
  revisionId: string,
  generationContextId: string,
  headSha: string,
): Promise<RunLookupRow | undefined> {
  const result = await client.query<RunLookupRow>(
    `SELECT repository.id AS repository_id, revision.id AS revision_id,
            context.id AS generation_context_id, pull_request.author_id,
            budget.repository_policy_id, revision.head_sha,
            context.context_hash, context.context, budget.question_budget,
            revision.is_current, pull_request.state AS pull_request_state
       FROM generation_contexts context
       JOIN pull_request_revisions revision ON revision.id = context.revision_id
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
       JOIN repositories repository ON repository.id = pull_request.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
       JOIN semantic_generation_budgets budget
         ON budget.generation_context_id = context.id
        AND budget.revision_id = revision.id
        AND budget.repository_id = repository.id
        AND budget.head_sha = revision.head_sha
      WHERE revision.id = $1 AND context.id = $2
        AND revision.head_sha = $3 AND context.head_sha = $3
        AND repository.status = 'active'
        AND installation.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM check_runs check_run
           WHERE check_run.revision_id = revision.id
             AND check_run.intent_reason = 'preparation_failed'
        )
      FOR SHARE OF revision, context, pull_request, repository, installation`,
    [revisionId, generationContextId, headSha],
  );
  return result.rows[0];
}

function purposeForJob(
  name:
    | "semantic.generate-learning"
    | "semantic.generate-practice-feedback"
    | "semantic.generate-proof-questions",
) {
  return name === "semantic.generate-learning"
    ? ("learning_material" as const)
    : name === "semantic.generate-practice-feedback"
      ? ("practice_feedback" as const)
      : ("proof_questions" as const);
}

function purposeRequiresFrozenProof(
  purpose: ReturnType<typeof purposeForJob>,
): boolean {
  return purpose !== "proof_questions";
}

async function readFrozenProofContent(
  queryable: Pick<PoolClient, "query">,
  input: {
    revisionId: string;
    generationContextId: string;
    authorId: string;
    headSha: string;
  },
): Promise<ForbiddenProofContentV1 | "pending"> {
  const result = await queryable.query<{
    semantic_plan: unknown | null;
    legacy_questions: unknown;
  }>(
    `SELECT semantic_plan.plan AS semantic_plan,
            jsonb_agg(
              jsonb_build_object(
                'prompt', question.prompt,
                'rubric', question.rubric
              ) ORDER BY question.ordinal
            ) AS legacy_questions
       FROM proof_plans plan
       JOIN semantic_generation_budgets budget
         ON budget.generation_context_id = plan.generation_context_id
        AND budget.revision_id = plan.revision_id
       JOIN proof_questions question ON question.proof_plan_id = plan.id
       LEFT JOIN semantic_proof_plans_v2 semantic_plan
         ON semantic_plan.id = plan.id
      WHERE plan.revision_id = $1
        AND plan.generation_context_id = $2
        AND plan.status = 'ready'
        AND plan.question_budget = budget.question_budget
        AND EXISTS (
          SELECT 1 FROM attempts attempt
           WHERE attempt.proof_plan_id = plan.id
             AND attempt.revision_id = $1
             AND attempt.author_id = $3
             AND attempt.head_sha = $4
        )
      GROUP BY plan.id, plan.created_at, semantic_plan.plan
     HAVING count(question.id)::int = plan.question_budget
      ORDER BY plan.created_at DESC, plan.id DESC
      LIMIT 1`,
    [
      input.revisionId,
      input.generationContextId,
      input.authorId,
      input.headSha,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return "pending";
  if (row.semantic_plan !== null) {
    const plan = hydrateSemanticArtifact(
      row.semantic_plan,
      ProofQuestionPlanV2Schema,
    );
    if (plan === null) {
      throw new Error("Frozen semantic Proof plan is invalid.");
    }
    return ForbiddenProofContentV1Schema.parse(
      proofQuestionsContentV1(plan.questions),
    );
  }
  const questions = z
    .array(
      z
        .object({
          prompt: z.string().trim().min(1).max(2_000),
          rubric: z
            .object({
              requiredPoints: z
                .array(z.string().trim().min(1).max(300))
                .min(1)
                .max(8),
            })
            .passthrough(),
        })
        .strict(),
    )
    .min(1)
    .max(5)
    .parse(row.legacy_questions);
  return ForbiddenProofContentV1Schema.parse(
    questions.flatMap((question) => [
      question.prompt,
      ...question.rubric.requiredPoints,
    ]),
  );
}

function learningJob(input: {
  revisionId: string;
  generationContextId: string;
  headSha: string;
}): JobPayload<"semantic.generate-learning"> {
  return {
    schemaVersion: "1",
    idempotencyKey: `semantic.learning.${LEARNING_GENERATION_IDEMPOTENCY_VERSION}:${input.generationContextId}`,
    artifactKind: "learning_bundle_v1",
    revisionId: input.revisionId,
    generationContextId: input.generationContextId,
    expectedHeadSha: input.headSha,
  };
}

function practicePatchPreview(context: GenerationContextV1) {
  return {
    title: context.title.content,
    anchors: context.anchors.slice(0, 12).map((anchor) => ({
      id: anchor.id,
      file: anchor.filename.content,
      hunkHeader: anchor.hunkHeader.content,
      oldStart: anchor.oldStart,
      newStart: anchor.newStart,
      changedLines: anchor.changedLines,
      evidence: anchor.evidence.content,
    })),
  };
}

function practicePayload(
  payload:
    | JobPayload<"semantic.generate-learning">
    | JobPayload<"semantic.generate-practice-feedback">
    | JobPayload<"semantic.generate-proof-questions">,
) {
  return "practiceSessionId" in payload
    ? {
        practiceSessionId: payload.practiceSessionId,
        practiceQuestionId: payload.practiceQuestionId,
        practiceAnswerId: payload.practiceAnswerId,
      }
    : null;
}

function assertArtifactBinding(
  run: SemanticRunContext,
  artifact: {
    revisionId: string;
    headSha: string;
    contextHash: string;
    createdAt: Date;
    deleteAfter: Date;
  },
): void {
  if (
    artifact.revisionId !== run.revisionId ||
    artifact.headSha !== run.generationContext.headSha ||
    artifact.contextHash !== run.generationContext.contextHash ||
    artifact.createdAt.getTime() !== run.createdAt.getTime() ||
    artifact.deleteAfter.getTime() !== run.deleteAfter.getTime()
  ) {
    throw new Error(
      "Semantic artifact is outside its server-owned run binding.",
    );
  }
}

async function persistInvocation(
  client: PoolClient,
  run: SemanticRunContext,
  rawMetadata: unknown,
  rawFailure: unknown,
): Promise<void> {
  const metadata =
    SemanticProviderInvocationMetadataV1Schema.parse(rawMetadata);
  const failure =
    rawFailure === null
      ? null
      : SemanticProviderFailureV1Schema.parse(rawFailure);
  const tokens = metadata.tokenUsage;
  await client.query(
    `INSERT INTO semantic_provider_invocations
       (call_id, run_id, metadata_version, purpose, provider, model,
        prompt_version, output_schema_version, planner_version, input_hash,
        output_hash, input_tokens, output_tokens, latency_ms,
        invocation_count, outcome, degraded, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18)
     ON CONFLICT (run_id) DO NOTHING`,
    [
      metadata.callId,
      run.runId,
      metadata.metadataVersion,
      metadata.purpose,
      metadata.provider,
      metadata.model,
      metadata.promptVersion,
      metadata.outputSchemaVersion,
      metadata.plannerVersion,
      metadata.inputHash,
      metadata.outputHash,
      tokens?.inputTokens ?? null,
      tokens?.outputTokens ?? null,
      metadata.latencyMs,
      metadata.invocationCount,
      metadata.outcome,
      metadata.degraded,
      metadata.completedAt,
    ],
  );
  if (failure !== null) {
    await client.query(
      `INSERT INTO audit_events
         (actor_id, action, object_type, object_id, metadata)
       SELECT 'semantic-worker', 'semantic.provider_failed',
              'semantic_generation_run', $1, $2::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_events
          WHERE action = 'semantic.provider_failed'
            AND object_type = 'semantic_generation_run'
            AND object_id = $1
       )`,
      [run.runId, JSON.stringify(failure)],
    );
  }
}

async function completeRun(
  client: PoolClient,
  run: SemanticRunContext,
  artifactId: string,
  degraded: boolean,
): Promise<void> {
  const updated = await client.query(
    `UPDATE semantic_generation_runs
        SET completed_at = clock_timestamp(), artifact_id = $2, degraded = $3
      WHERE id = $1 AND completed_at IS NULL`,
    [run.runId, artifactId, degraded],
  );
  if (updated.rowCount !== 1) {
    throw new Error(
      "Semantic generation run could not be completed exactly once.",
    );
  }
}

async function assertPrivateReplay(
  client: PoolClient,
  table: "semantic_learning_bundles" | "semantic_practice_feedback",
  artifactId: string,
  artifact: LearningBundleV1 | PracticeFeedbackV1,
  aad: string,
  cipher: SemanticCipher,
): Promise<void> {
  const row = await client.query<{ encrypted_payload: string }>(
    `SELECT encrypted_payload FROM ${table}
      WHERE id = $1 AND deleted_at IS NULL FOR SHARE`,
    [artifactId],
  );
  const encrypted = row.rows[0]?.encrypted_payload;
  if (encrypted === undefined)
    throw new Error("Semantic replay payload is unavailable.");
  const decoded: LearningBundleV1 | PracticeFeedbackV1 =
    table === "semantic_learning_bundles"
      ? decryptSemanticArtifact(
          cipher,
          JSON.parse(encrypted),
          aad,
          LearningBundleV1Schema,
        )
      : decryptSemanticArtifact(
          cipher,
          JSON.parse(encrypted),
          aad,
          PracticeFeedbackV1Schema,
        );
  if (stableJson(decoded) !== stableJson(artifact)) {
    throw new Error("Semantic replay conflicts with stored artifact.");
  }
}

async function assertProofReplay(
  client: PoolClient,
  plan: ProofQuestionPlanV2,
  context: GenerationContextV1,
): Promise<void> {
  const persisted = await client.query<{
    id: string;
    ordinal: number;
    type: string;
    prompt: string;
    diff_anchor: unknown;
    rubric: unknown;
  }>(
    `SELECT id, ordinal, type, prompt, diff_anchor, rubric
       FROM proof_questions WHERE proof_plan_id = $1 ORDER BY ordinal`,
    [plan.id],
  );
  const expected = plan.questions.map((question) => {
    const anchor = context.anchors.find(
      (candidate) => candidate.id === question.anchorIds[0],
    );
    if (anchor === undefined) throw new Error("Proof anchor is unavailable.");
    return {
      id: question.id,
      ordinal: question.order - 1,
      type: question.intent,
      prompt: question.prompt,
      diff_anchor: {
        id: anchor.id,
        file: anchor.filename.content,
        hunkHeader: anchor.hunkHeader.content,
        oldStart: anchor.oldStart,
        newStart: anchor.newStart,
        changedLines: anchor.changedLines,
        evidence: anchor.evidence.content,
      },
      rubric: {
        requiredPoints: question.rubric.requiredPoints.map(
          (point) => point.description,
        ),
        rejectsGenericAnswer: true,
      },
    };
  });
  if (stableJson(persisted.rows) !== stableJson(expected)) {
    throw new Error("Served Proof V2 questions conflict with frozen plan.");
  }
}

function privateTable(
  kind: "learning_bundle_v1" | "practice_answer_v1" | "practice_feedback_v1",
):
  | "semantic_learning_bundles"
  | "semantic_practice_answers"
  | "semantic_practice_feedback" {
  switch (kind) {
    case "learning_bundle_v1":
      return "semantic_learning_bundles";
    case "practice_answer_v1":
      return "semantic_practice_answers";
    case "practice_feedback_v1":
      return "semantic_practice_feedback";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}

function usableAttemptStatus(status: string): boolean {
  return [
    "preparing",
    "ready",
    "active",
    "uploading",
    "processing",
    "review_required",
  ].includes(status);
}

const StoredSemanticArtifactEnvelopeSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    deleteAfter: z.string().datetime({ offset: true }),
  })
  .passthrough();

function hydrateSemanticArtifact<T>(
  raw: unknown,
  schema: z.ZodType<T>,
): T | null {
  const wire = StoredSemanticArtifactEnvelopeSchema.safeParse(raw);
  if (!wire.success) return null;
  const createdAt = new Date(wire.data.createdAt);
  const deleteAfter = new Date(wire.data.deleteAfter);
  const parsed = schema.safeParse({ ...wire.data, createdAt, deleteAfter });
  return parsed.success ? parsed.data : null;
}

function decryptSemanticArtifact<T>(
  cipher: SemanticCipher,
  envelope: unknown,
  aad: string,
  schema: z.ZodType<T>,
): T {
  const wire = cipher.decryptJson(
    envelope,
    aad,
    StoredSemanticArtifactEnvelopeSchema,
  );
  const hydrated = hydrateSemanticArtifact(wire, schema);
  if (hydrated === null) {
    throw new Error("Private semantic artifact failed date hydration.");
  }
  return hydrated;
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
