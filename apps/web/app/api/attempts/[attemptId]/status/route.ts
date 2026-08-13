import { AttemptStatusSchema, UuidSchema } from "@slopproof/domain";
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
    const attemptId = UuidSchema.parse((await context.params).attemptId);
    const result = await app.database.pool.query<{
      status: string;
      revision_id: string;
      head_sha: string;
      is_current: boolean;
      author_id: string;
      repository_id: string;
    }>(
      `SELECT attempt.status, attempt.revision_id, attempt.head_sha,
              revision.is_current, attempt.author_id, attempt.repository_id
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
        WHERE attempt.id = $1 AND attempt.author_id = $2
          AND attempt.repository_id = $3
        LIMIT 1`,
      [attemptId, session.actorId, session.repositoryId],
    );
    const row = result.rows[0];
    const status = AttemptStatusSchema.safeParse(row?.status);
    if (
      !row ||
      !status.success ||
      session.actorRole !== "author" ||
      row.author_id !== session.actorId ||
      row.repository_id !== session.repositoryId
    ) {
      return NextResponse.json(
        { error: "status_rejected" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        attemptId,
        revisionId: row.revision_id,
        headSha: row.head_sha,
        status: status.data,
        isCurrent: row.is_current,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return (
      authErrorResponse(error) ??
      NextResponse.json(
        { error: "temporarily_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      )
    );
  }
}
