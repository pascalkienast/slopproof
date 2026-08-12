import type { AuthenticatedSession } from "@slopproof/auth";
import { enqueueJobInPgTransaction } from "@slopproof/db";
import {
  RepositoryPolicyV1Schema,
  type RepositoryPolicyV1,
} from "@slopproof/policy";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { CheckIntentWriter } from "./attempt-lifecycle";
import {
  requireRequestMaintainerAuthorization,
  type MaintainerAuthorizationDependencies,
  type MaintainerAuthorization,
  type SqlExecutor,
} from "./maintainer-authorization";
import type { WebRuntime } from "./runtime";

export const ReviewActionSchema = z.enum(["approve", "reject", "manual_retry"]);

export const ReviewDecisionInputSchema = z
  .object({
    action: ReviewActionSchema,
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    explanation: z.string().trim().min(1).max(2_000).optional(),
    idempotencyKey: z
      .string()
      .min(8)
      .max(200)
      .regex(/^[A-Za-z0-9:._-]+$/),
  })
  .strict();

export type ReviewAction = z.infer<typeof ReviewActionSchema>;
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionInputSchema>;

export function shouldAccelerateEvidenceDeletion(
  action: ReviewAction,
  rawPolicy: RepositoryPolicyV1,
): boolean {
  const policy = RepositoryPolicyV1Schema.parse(rawPolicy);
  return action === "approve" && policy.evidence.deleteAfterMaintainerPass;
}

export async function accelerateEvidenceDeletionAfterPass(
  queue: PgBoss,
  client: PoolClient,
  attemptId: string,
): Promise<{ deletionJobId: string; completed: boolean }> {
  const deletion = await client.query<{
    id: string;
    state: string;
  }>(
    `INSERT INTO deletion_jobs
      (object_class, object_id, deadline, state)
     VALUES ('attempt_evidence', $1, now(), 'pending')
     ON CONFLICT (object_class, object_id) DO UPDATE
       SET deadline = LEAST(deletion_jobs.deadline, EXCLUDED.deadline),
           state = CASE
             WHEN deletion_jobs.state = 'completed' THEN 'completed'::deletion_job_state
             ELSE 'pending'::deletion_job_state
           END,
           updated_at = now()
     RETURNING id, state`,
    [attemptId],
  );
  const deletionJob = deletion.rows[0];
  if (!deletionJob) throw new ReviewConflictError();
  if (deletionJob.state !== "completed") {
    await enqueueJobInPgTransaction(queue, client, "evidence.delete", {
      schemaVersion: "1",
      idempotencyKey: `evidence-delete:${deletionJob.id}:maintainer-pass`,
      deletionJobId: deletionJob.id,
    });
  }
  return {
    deletionJobId: deletionJob.id,
    completed: deletionJob.state === "completed",
  };
}

export type ReviewQueueItem = {
  attemptId: string;
  revisionId: string;
  pullRequestNumber: number;
  headSha: string;
  authorId: string;
  status: "review_required";
  submittedAt: Date;
  questionCount: number;
  recommendation: string | null;
  deleteAfter: Date | null;
  hasRecording: boolean;
  hasTranscript: boolean;
};

export type ReviewQuestion = {
  id: string;
  ordinal: number;
  prompt: string;
  rubric: Record<string, unknown>;
};

export type ReviewDetail = {
  attemptId: string;
  revisionId: string;
  pullRequestNumber: number;
  repository: string;
  headSha: string;
  authorId: string;
  status:
    | "review_required"
    | "passed"
    | "retry_required"
    | "technical_retry"
    | "invalidated";
  isCurrent: boolean;
  submittedAt: Date;
  recommendation: string | null;
  evaluationProvider: string | null;
  evaluationModel: string | null;
  transcriptProvider: string | null;
  recordingObjectId: string | null;
  recordingDurationMs: number | null;
  recordingBytes: number | null;
  recordingCodec: string | null;
  deleteAfter: Date | null;
  deletedAt: Date | null;
  frameCount: number;
  questions: ReviewQuestion[];
};

export type EvidenceAccess = {
  attemptId: string;
  repositoryId: string;
  revisionId: string;
  headSha: string;
  recordingObjectId: string;
};

export class ReviewNotFoundError extends Error {
  readonly code = "REVIEW_NOT_FOUND" as const;
}

export class ReviewConflictError extends Error {
  readonly code = "REVIEW_CONFLICT" as const;
}

export type ReviewDecisionPlan = {
  databaseDecision: "pass" | "retry";
  targetStatus: "passed" | "retry_required" | "technical_retry";
  reasonCode: "maintainer_approved" | "maintainer_rejected" | "manual_retry";
  checkConclusion: "success" | "action_required" | "neutral";
  publicSummary: string;
};

export function planReviewDecision(
  action: ReviewAction,
  headSha: string,
): ReviewDecisionPlan {
  switch (action) {
    case "approve":
      return {
        databaseDecision: "pass",
        targetStatus: "passed",
        reasonCode: "maintainer_approved",
        checkConclusion: "success",
        publicSummary: `passed ${headSha}`,
      };
    case "reject":
      return {
        databaseDecision: "retry",
        targetStatus: "retry_required",
        reasonCode: "maintainer_rejected",
        checkConclusion: "action_required",
        publicSummary: `action required ${headSha}`,
      };
    case "manual_retry":
      return {
        databaseDecision: "retry",
        targetStatus: "technical_retry",
        reasonCode: "manual_retry",
        checkConclusion: "neutral",
        publicSummary: `technical retry ${headSha}`,
      };
  }
}

export async function writeReviewAudit(
  executor: SqlExecutor,
  input: {
    actorId: string;
    action: string;
    objectType: "attempt" | "repository" | "recording_object";
    objectId: string;
    metadata: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO audit_events
      (actor_id, action, object_type, object_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.actorId,
      input.action,
      input.objectType,
      input.objectId,
      JSON.stringify(input.metadata),
    ],
  );
}

export async function loadReviewQueue(
  app: WebRuntime,
  request: Request,
  session: AuthenticatedSession,
  authorizationDependencies: MaintainerAuthorizationDependencies = {},
): Promise<{
  authorization: MaintainerAuthorization;
  items: ReviewQueueItem[];
}> {
  const client = await app.database.pool.connect();
  try {
    await client.query("BEGIN");
    const authorization = await requireRequestMaintainerAuthorization(
      app,
      {
        request,
        session,
        binding: {
          kind: "repository",
          repositoryId: session.repositoryId!,
        },
        executor: client,
      },
      authorizationDependencies,
    );
    const result = await client.query<{
      attempt_id: string;
      revision_id: string;
      pull_request_number: number;
      head_sha: string;
      author_id: string;
      status: "review_required";
      submitted_at: Date;
      question_count: number;
      recommendation: string | null;
      delete_after: Date | null;
      has_recording: boolean;
      has_transcript: boolean;
    }>(
      `SELECT attempt.id AS attempt_id, revision.id AS revision_id,
              pull_request.number AS pull_request_number, revision.head_sha,
              attempt.author_id, attempt.status, attempt.updated_at AS submitted_at,
              (SELECT count(*)::int FROM proof_questions question
               WHERE question.proof_plan_id = attempt.proof_plan_id) AS question_count,
              evaluation.recommendation,
              recording.delete_after,
              recording.id IS NOT NULL AS has_recording,
              EXISTS (SELECT 1 FROM transcripts transcript
                      WHERE transcript.attempt_id = attempt.id
                        AND transcript.deleted_at IS NULL) AS has_transcript
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
       LEFT JOIN LATERAL (
         SELECT candidate.recommendation
         FROM evaluations candidate
         WHERE candidate.attempt_id = attempt.id AND candidate.deleted_at IS NULL
         ORDER BY candidate.created_at DESC LIMIT 1
       ) evaluation ON true
       LEFT JOIN recording_objects recording
         ON recording.attempt_id = attempt.id AND recording.deleted_at IS NULL
       WHERE attempt.repository_id = $1
         AND attempt.status = 'review_required'
         AND revision.is_current = true
       ORDER BY attempt.updated_at ASC`,
      [authorization.repositoryId],
    );
    await writeReviewAudit(client, {
      actorId: authorization.actorId,
      action: "maintainer.review_queue.viewed",
      objectType: "repository",
      objectId: authorization.repositoryId,
      metadata: {
        repositoryId: authorization.repositoryId,
        itemCount: result.rows.length,
        authorizationSource: authorization.source,
      },
    });
    await client.query("COMMIT");
    return {
      authorization,
      items: result.rows.map((row) => ({
        attemptId: row.attempt_id,
        revisionId: row.revision_id,
        pullRequestNumber: row.pull_request_number,
        headSha: row.head_sha,
        authorId: row.author_id,
        status: row.status,
        submittedAt: row.submitted_at,
        questionCount: row.question_count,
        recommendation: row.recommendation,
        deleteAfter: row.delete_after,
        hasRecording: row.has_recording,
        hasTranscript: row.has_transcript,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadReviewDetail(
  app: WebRuntime,
  request: Request,
  session: AuthenticatedSession,
  attemptId: string,
  authorizationDependencies: MaintainerAuthorizationDependencies = {},
): Promise<ReviewDetail> {
  const client = await app.database.pool.connect();
  try {
    await client.query("BEGIN");
    const authorization = await requireRequestMaintainerAuthorization(
      app,
      {
        request,
        session,
        binding: { kind: "attempt", attemptId },
        executor: client,
      },
      authorizationDependencies,
    );
    const result = await client.query<{
      attempt_id: string;
      revision_id: string;
      pull_request_number: number;
      owner: string;
      name: string;
      head_sha: string;
      author_id: string;
      status: ReviewDetail["status"];
      is_current: boolean;
      submitted_at: Date;
      recommendation: string | null;
      evaluation_provider: string | null;
      evaluation_model: string | null;
      transcript_provider: string | null;
      recording_object_id: string | null;
      recording_duration_ms: number | null;
      recording_bytes: number | null;
      recording_codec: string | null;
      delete_after: Date | null;
      deleted_at: Date | null;
      frame_count: number;
    }>(
      `SELECT attempt.id AS attempt_id, revision.id AS revision_id,
              pull_request.number AS pull_request_number,
              repository.owner, repository.name, revision.head_sha,
              attempt.author_id, attempt.status, revision.is_current,
              attempt.updated_at AS submitted_at,
              evaluation.recommendation,
              evaluation.provider AS evaluation_provider,
              evaluation.model AS evaluation_model,
              transcript.provider AS transcript_provider,
              recording.id AS recording_object_id,
              recording.duration_ms AS recording_duration_ms,
              recording.byte_length::double precision AS recording_bytes,
              recording.codec AS recording_codec,
              recording.delete_after, recording.deleted_at,
              (SELECT count(*)::int FROM frame_selections frame
               WHERE frame.attempt_id = attempt.id AND frame.deleted_at IS NULL) AS frame_count
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
       JOIN repositories repository ON repository.id = attempt.repository_id
       LEFT JOIN LATERAL (
         SELECT candidate.recommendation, candidate.provider, candidate.model
         FROM evaluations candidate
         WHERE candidate.attempt_id = attempt.id AND candidate.deleted_at IS NULL
         ORDER BY candidate.created_at DESC LIMIT 1
       ) evaluation ON true
       LEFT JOIN LATERAL (
         SELECT candidate.provider
         FROM transcripts candidate
         WHERE candidate.attempt_id = attempt.id AND candidate.deleted_at IS NULL
         ORDER BY candidate.created_at DESC LIMIT 1
       ) transcript ON true
       LEFT JOIN recording_objects recording ON recording.attempt_id = attempt.id
       WHERE attempt.id = $1 AND attempt.repository_id = $2
         AND attempt.status IN
           ('review_required','passed','retry_required','technical_retry','invalidated')
       LIMIT 1`,
      [attemptId, authorization.repositoryId],
    );
    const row = result.rows[0];
    if (!row) throw new ReviewNotFoundError();
    const questions = await client.query<ReviewQuestion>(
      `SELECT id, ordinal, prompt, rubric
       FROM proof_questions
       WHERE proof_plan_id = (SELECT proof_plan_id FROM attempts WHERE id = $1)
       ORDER BY ordinal`,
      [attemptId],
    );
    await writeReviewAudit(client, {
      actorId: authorization.actorId,
      action: "maintainer.review_detail.viewed",
      objectType: "attempt",
      objectId: attemptId,
      metadata: {
        repositoryId: authorization.repositoryId,
        revisionId: row.revision_id,
        headSha: row.head_sha,
        current: row.is_current,
        authorizationSource: authorization.source,
      },
    });
    await client.query("COMMIT");
    return {
      attemptId: row.attempt_id,
      revisionId: row.revision_id,
      pullRequestNumber: row.pull_request_number,
      repository: `${row.owner}/${row.name}`,
      headSha: row.head_sha,
      authorId: row.author_id,
      status: row.status,
      isCurrent: row.is_current,
      submittedAt: row.submitted_at,
      recommendation: row.recommendation,
      evaluationProvider: row.evaluation_provider,
      evaluationModel: row.evaluation_model,
      transcriptProvider: row.transcript_provider,
      recordingObjectId: row.recording_object_id,
      recordingDurationMs: row.recording_duration_ms,
      recordingBytes: row.recording_bytes,
      recordingCodec: row.recording_codec,
      deleteAfter: row.delete_after,
      deletedAt: row.deleted_at,
      frameCount: row.frame_count,
      questions: questions.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function requireEvidenceAccess(
  app: WebRuntime,
  request: Request,
  session: AuthenticatedSession,
  attemptId: string,
  executor: SqlExecutor = app.database.pool,
  authorizationDependencies: MaintainerAuthorizationDependencies = {},
): Promise<{
  authorization: MaintainerAuthorization;
  evidence: EvidenceAccess;
}> {
  const authorization = await requireRequestMaintainerAuthorization(
    app,
    {
      request,
      session,
      binding: { kind: "attempt", attemptId },
      executor,
    },
    authorizationDependencies,
  );
  const result = await executor.query<{
    attempt_id: string;
    repository_id: string;
    revision_id: string;
    head_sha: string;
    is_current: boolean;
    recording_object_id: string;
    delete_after: Date;
    deleted_at: Date | null;
  }>(
    `SELECT attempt.id AS attempt_id, attempt.repository_id,
            revision.id AS revision_id, revision.head_sha, revision.is_current,
            recording.id AS recording_object_id,
            recording.delete_after, recording.deleted_at
     FROM attempts attempt
     JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
     JOIN recording_objects recording ON recording.attempt_id = attempt.id
     WHERE attempt.id = $1 AND attempt.repository_id = $2
       AND attempt.status = 'review_required'`,
    [attemptId, authorization.repositoryId],
  );
  const row = result.rows[0];
  if (
    !row ||
    !row.is_current ||
    row.deleted_at !== null ||
    row.delete_after <= new Date()
  ) {
    throw new ReviewNotFoundError();
  }
  return {
    authorization,
    evidence: {
      attemptId: row.attempt_id,
      repositoryId: row.repository_id,
      revisionId: row.revision_id,
      headSha: row.head_sha,
      recordingObjectId: row.recording_object_id,
    },
  };
}

export async function decideReview(
  app: WebRuntime,
  request: Request,
  session: AuthenticatedSession,
  attemptId: string,
  rawInput: unknown,
  checkIntents: CheckIntentWriter,
  authorizationDependencies: MaintainerAuthorizationDependencies = {},
): Promise<{
  replay: boolean;
  action: ReviewAction;
  status: "passed" | "retry_required" | "technical_retry";
  headSha: string;
}> {
  const input = ReviewDecisionInputSchema.parse(rawInput);
  const plan = planReviewDecision(input.action, input.expectedHeadSha);
  const client = await app.database.pool.connect();
  try {
    await client.query("BEGIN");
    const authorization = await requireRequestMaintainerAuthorization(
      app,
      {
        request,
        session,
        binding: { kind: "attempt", attemptId },
        executor: client,
      },
      authorizationDependencies,
    );
    const attempt = await client.query<{
      status: string;
      repository_id: string;
      revision_id: string;
      head_sha: string;
      is_current: boolean;
      policy: RepositoryPolicyV1;
    }>(
      `SELECT attempt.status, attempt.repository_id, revision.id AS revision_id,
              revision.head_sha, revision.is_current, repository_policy.policy
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
       JOIN repository_policies repository_policy
         ON repository_policy.id = proof_plan.repository_policy_id
       WHERE attempt.id = $1 AND attempt.repository_id = $2
       FOR UPDATE OF attempt, revision`,
      [attemptId, authorization.repositoryId],
    );
    const row = attempt.rows[0];
    if (!row || !row.is_current || row.head_sha !== input.expectedHeadSha) {
      throw new ReviewConflictError();
    }
    const frozenPolicy = RepositoryPolicyV1Schema.parse(row.policy);

    const replay = await client.query<{
      to_status: string;
      actor_id: string;
      decision: string | null;
      reason_code: string | null;
      explanation: string | null;
      decision_head_sha: string | null;
    }>(
      `SELECT transition.to_status, transition.actor_id,
              decision.decision, decision.reason_code, decision.explanation,
              decision.head_sha AS decision_head_sha
       FROM attempt_transitions transition
       LEFT JOIN LATERAL (
         SELECT candidate.decision, candidate.reason_code,
                candidate.explanation, candidate.head_sha
         FROM review_decisions candidate
         WHERE candidate.attempt_id = transition.attempt_id
         ORDER BY candidate.decided_at ASC
         LIMIT 1
       ) decision ON true
       WHERE transition.attempt_id = $1
         AND transition.idempotency_key = $2`,
      [attemptId, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (
        replay.rows[0].to_status !== plan.targetStatus ||
        replay.rows[0].actor_id !== authorization.actorId ||
        replay.rows[0].decision !== plan.databaseDecision ||
        replay.rows[0].reason_code !== plan.reasonCode ||
        replay.rows[0].explanation !== (input.explanation ?? null) ||
        replay.rows[0].decision_head_sha !== row.head_sha ||
        row.status !== plan.targetStatus
      ) {
        throw new ReviewConflictError();
      }
      await client.query("COMMIT");
      return {
        replay: true,
        action: input.action,
        status: plan.targetStatus,
        headSha: row.head_sha,
      };
    }
    if (row.status !== "review_required") {
      throw new ReviewConflictError();
    }
    const priorDecision = await client.query(
      "SELECT id FROM review_decisions WHERE attempt_id = $1 LIMIT 1",
      [attemptId],
    );
    if (priorDecision.rowCount !== 0) throw new ReviewConflictError();

    await client.query(
      `INSERT INTO review_decisions
        (attempt_id, maintainer_id, decision, reason_code, explanation, head_sha)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        attemptId,
        authorization.actorId,
        plan.databaseDecision,
        plan.reasonCode,
        input.explanation ?? null,
        row.head_sha,
      ],
    );
    await client.query(
      `INSERT INTO attempt_transitions
        (attempt_id, idempotency_key, from_status, to_status,
         expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
       VALUES ($1, $2, 'review_required', $3, $4, $4, $5, 'maintainer', now())`,
      [
        attemptId,
        input.idempotencyKey,
        plan.targetStatus,
        row.head_sha,
        authorization.actorId,
      ],
    );
    const updated = await client.query(
      `UPDATE attempts SET status = $2, completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'review_required'`,
      [attemptId, plan.targetStatus],
    );
    if (updated.rowCount !== 1) throw new ReviewConflictError();

    await checkIntents.write(client, {
      revisionId: row.revision_id,
      headSha: row.head_sha,
      status: "completed",
      conclusion: plan.checkConclusion,
      summary: plan.publicSummary,
      reason: "maintainer_decision",
      idempotencyKey: input.idempotencyKey,
    });
    if (shouldAccelerateEvidenceDeletion(input.action, frozenPolicy)) {
      await accelerateEvidenceDeletionAfterPass(
        app.jobQueue,
        client,
        attemptId,
      );
      await writeReviewAudit(client, {
        actorId: authorization.actorId,
        action: "evidence.deletion_accelerated",
        objectType: "attempt",
        objectId: attemptId,
        metadata: {
          repositoryId: authorization.repositoryId,
          reason: "maintainer_pass",
          originalDeadlinePreserved: true,
        },
      });
    }
    await writeReviewAudit(client, {
      actorId: authorization.actorId,
      action: "maintainer.review_decided",
      objectType: "attempt",
      objectId: attemptId,
      metadata: {
        repositoryId: authorization.repositoryId,
        revisionId: row.revision_id,
        headSha: row.head_sha,
        decision: plan.databaseDecision,
        reasonCode: plan.reasonCode,
      },
    });
    await client.query("COMMIT");
    return {
      replay: false,
      action: input.action,
      status: plan.targetStatus,
      headSha: row.head_sha,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
