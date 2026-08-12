import { issueSession } from "@slopproof/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { attachSessionCookies } from "../../../../lib/http-auth";
import { getWebRuntime } from "../../../../lib/runtime";

const InputSchema = z
  .object({
    role: z.enum(["author", "maintainer"]),
    attemptId: z.string().uuid().optional(),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  const app = await getWebRuntime();
  if (!app.config.DEMO_MODE) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const input = InputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const repository = await app.database.pool.query<{
    repository_id: string;
    author_id: string;
  }>(
    input.data.role === "author" && input.data.attemptId
      ? `SELECT attempt.repository_id, attempt.author_id
         FROM attempts attempt
         JOIN pull_request_revisions revision ON revision.id = attempt.revision_id
         WHERE attempt.id = $1 AND revision.is_current = true
         LIMIT 1`
      : `SELECT repository.id AS repository_id, pull_request.author_id
         FROM repositories repository
         JOIN pull_requests pull_request ON pull_request.repository_id = repository.id
         WHERE repository.owner = 'acme' AND repository.name = 'cachekit'
         ORDER BY pull_request.number
         LIMIT 1`,
    input.data.role === "author" && input.data.attemptId
      ? [input.data.attemptId]
      : [],
  );
  const row = repository.rows[0];
  if (!row) {
    return NextResponse.json({ error: "demo_seed_missing" }, { status: 409 });
  }
  const actorId =
    input.data.role === "author" ? row.author_id : "demo-maintainer";
  const issued = await issueSession(
    app.database.pool,
    {
      actorId,
      actorRole: input.data.role,
      repositoryId: row.repository_id,
      ttlMs: 8 * 60 * 60_000,
    },
    app.config.SESSION_SECRET,
  );
  const response = NextResponse.json({
    actorId,
    role: input.data.role,
    expiresAt: issued.session.expiresAt.toISOString(),
  });
  attachSessionCookies(response, issued, app.config.APP_BASE_URL);
  return response;
}
