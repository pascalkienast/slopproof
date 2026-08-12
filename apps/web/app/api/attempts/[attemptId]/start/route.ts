import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  authErrorResponse,
  requireMutationSession,
} from "../../../../../lib/http-auth";
import { getWebRuntime } from "../../../../../lib/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const { attemptId } = await context.params;
    const idempotencyKey =
      request.headers.get("idempotency-key") ?? `start:${randomUUID()}`;
    const client = await app.database.pool.connect();
    try {
      await client.query("BEGIN");
      const attempt = await client.query<{
        status: string;
        author_id: string;
        repository_id: string;
        head_sha: string;
        is_current: boolean;
        expires_at: Date;
      }>(
        `SELECT attempt.status, attempt.author_id, attempt.repository_id,
                attempt.head_sha, attempt.expires_at, revision.is_current
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         WHERE attempt.id = $1 FOR UPDATE OF attempt`,
        [attemptId],
      );
      const row = attempt.rows[0];
      if (
        !row ||
        session.actorRole !== "author" ||
        row.author_id !== session.actorId ||
        row.repository_id !== session.repositoryId ||
        !row.is_current ||
        row.expires_at <= new Date()
      ) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "start_rejected" }, { status: 409 });
      }
      if (row.status === "active") {
        await client.query("COMMIT");
        return NextResponse.json({ attemptId, status: "active" });
      }
      if (row.status !== "ready") {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "start_rejected" }, { status: 409 });
      }
      await client.query(
        `INSERT INTO attempt_transitions
          (attempt_id, idempotency_key, from_status, to_status,
           expected_head_sha, current_head_sha, actor_id, actor_role, occurred_at)
         VALUES ($1, $2, 'ready', 'active', $3, $3, $4, 'author', now())
         ON CONFLICT (attempt_id, idempotency_key) DO NOTHING`,
        [attemptId, idempotencyKey, row.head_sha, session.actorId],
      );
      await client.query(
        "UPDATE attempts SET status = 'active', started_at = now(), updated_at = now() WHERE id = $1",
        [attemptId],
      );
      await client.query("COMMIT");
      return NextResponse.json({ attemptId, status: "active" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return (
      authErrorResponse(error) ??
      NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 })
    );
  }
}
