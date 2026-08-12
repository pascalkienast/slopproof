import {
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
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
    const attempt = await app.database.pool.query<{
      author_id: string;
      repository_id: string;
      revision_id: string;
      status: string;
      head_sha: string;
      is_current: boolean;
      expires_at: Date;
      question_budget: number;
      policy: unknown;
    }>(
      `SELECT attempt.author_id, attempt.repository_id, attempt.revision_id,
              attempt.status,
              attempt.head_sha, attempt.expires_at, revision.is_current,
              proof_plan.question_budget, repository_policy.policy
       FROM attempts attempt
       JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
       JOIN proof_plans proof_plan ON proof_plan.id = attempt.proof_plan_id
       JOIN repository_policies repository_policy
         ON repository_policy.id = proof_plan.repository_policy_id
       WHERE attempt.id = $1`,
      [attemptId],
    );
    const row = attempt.rows[0];
    if (
      !row ||
      session.actorRole !== "author" ||
      session.actorId !== row.author_id ||
      session.repositoryId !== row.repository_id ||
      !row.is_current ||
      row.expires_at <= new Date() ||
      !["ready", "active", "uploading"].includes(row.status)
    ) {
      return NextResponse.json(
        { error: "questions_rejected" },
        { status: 403 },
      );
    }
    const questions = await app.database.pool.query<{
      id: string;
      ordinal: number;
      prompt: string;
    }>(
      `SELECT question.id, question.ordinal, question.prompt
       FROM proof_questions question
       JOIN attempts attempt ON attempt.proof_plan_id = question.proof_plan_id
       WHERE attempt.id = $1 ORDER BY question.ordinal`,
      [attemptId],
    );
    if (questions.rows.length !== row.question_budget) {
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
        id: question.id,
        order: index + 1,
        prompt: question.prompt,
        maximumAnswerSeconds: 120,
      })),
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 })
    );
  }
}
