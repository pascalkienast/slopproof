import {
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
  MAX_PROOF_QUESTION_ANSWER_MS,
} from "@slopproof/media";
import {
  RepositoryPolicyV1Schema,
  resolveEffectiveRecordingLimits,
} from "@slopproof/policy";
import { NextResponse } from "next/server";
import {
  authErrorResponse,
  requireSession,
} from "../../../../../lib/http-auth";
import { getWebRuntime } from "../../../../../lib/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireSession(request, app);
    const { attemptId } = await context.params;
    const questions = await app.database.pool.query<{
      author_id: string;
      repository_id: string;
      revision_id: string;
      status: string;
      head_sha: string;
      is_current: boolean;
      expires_at: Date;
      question_budget: number;
      policy: unknown;
      question_id: string;
      question_ordinal: number;
      question_prompt: string;
      required_question_count: number;
    }>(
      `SELECT attempt.author_id, attempt.repository_id, attempt.revision_id,
              attempt.status,
              attempt.head_sha, attempt.expires_at, revision.is_current,
              proof_plan.question_budget, repository_policy.policy,
              question.id AS question_id,
              question.ordinal AS question_ordinal,
              question.prompt AS question_prompt,
              count(*) OVER ()::int AS required_question_count
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
         AND pull_request.repository_id = attempt.repository_id
       JOIN repositories repository ON repository.id = attempt.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
       JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
       JOIN repository_policies repository_policy
         ON repository_policy.id = proof_plan.repository_policy_id
       JOIN proof_questions question ON question.proof_plan_id = proof_plan.id
         AND question.required = true
       WHERE attempt.id = $1 AND attempt.author_id = $2
         AND attempt.repository_id = $3
         AND attempt.status IN ('ready', 'active', 'uploading')
         AND attempt.expires_at > clock_timestamp()
         AND revision.is_current = true AND pull_request.state = 'open'
         AND repository.status = 'active' AND installation.status = 'active'
       ORDER BY question.ordinal`,
      [attemptId, session.actorId, session.repositoryId],
    );
    const row = questions.rows[0];
    if (
      !row ||
      session.actorRole !== "author" ||
      session.actorId !== row.author_id ||
      session.repositoryId !== row.repository_id
    ) {
      return NextResponse.json(
        { error: "questions_rejected" },
        { status: 403 },
      );
    }
    if (
      row.required_question_count !== row.question_budget ||
      questions.rows.length !== row.question_budget ||
      questions.rows.some(
        (question, index) => question.question_ordinal !== index,
      )
    ) {
      return NextResponse.json({ error: "plan_incomplete" }, { status: 409 });
    }
    const limits = resolveEffectiveRecordingLimits(
      RepositoryPolicyV1Schema.parse(row.policy),
      {
        maximumDurationMs: MAX_RECORDING_DURATION_MS,
        maximumUploadBytes: MAX_RECORDING_OBJECT_BYTES,
      },
    );
    return NextResponse.json({
      attemptId,
      revisionId: row.revision_id,
      headSha: row.head_sha,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
      maximumDurationMs: limits.maximumDurationMs,
      maximumUploadBytes: limits.maximumUploadBytes,
      retentionHours: limits.retentionHours,
      questions: questions.rows.map((question, index) => ({
        id: question.question_id,
        order: index + 1,
        prompt: question.question_prompt,
        maximumAnswerSeconds: MAX_PROOF_QUESTION_ANSWER_MS / 1_000,
      })),
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 })
    );
  }
}
