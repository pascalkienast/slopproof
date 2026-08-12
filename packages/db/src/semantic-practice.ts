import type { PoolClient } from "pg";
import { z } from "zod";

const SemanticPracticeRateLimitInputSchema = z
  .object({
    repositoryId: z.string().uuid(),
    revisionId: z.string().uuid(),
    actorKeyHash: z.string().regex(/^[0-9a-f]{64}$/u),
    action: z.enum(["start_session", "submit_answer"]),
    maximumEvents: z.number().int().min(1).max(100),
    windowSeconds: z
      .number()
      .int()
      .min(1)
      .max(60 * 60),
  })
  .strict();

export type SemanticPracticeRateLimitInput = z.infer<
  typeof SemanticPracticeRateLimitInputSchema
>;

export class SemanticPracticeRateLimitExceededError extends Error {
  readonly code = "SEMANTIC_PRACTICE_RATE_LIMITED" as const;

  constructor(readonly retryAfter: Date) {
    super("Practice request rate limit exceeded.");
    this.name = "SemanticPracticeRateLimitExceededError";
  }
}

/**
 * Reserves one actor+revision slot on the caller's transaction. The advisory
 * transaction lock makes a concurrent count-and-insert exact. Call this before
 * inserting a session or answer with the same PoolClient.
 */
export async function reserveSemanticPracticeRateLimit(
  client: PoolClient,
  rawInput: SemanticPracticeRateLimitInput,
): Promise<{ occurredAt: Date; expiresAt: Date }> {
  const input = SemanticPracticeRateLimitInputSchema.parse(rawInput);
  const lockKey = [
    "semantic-practice-rate-v1",
    input.repositoryId,
    input.revisionId,
    input.actorKeyHash,
    input.action,
  ].join(":");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    lockKey,
  ]);
  const revision = await client.query<{ now: Date }>(
    `SELECT clock_timestamp() AS now
       FROM pull_request_revisions revision
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
       JOIN repositories repository ON repository.id = pull_request.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
      WHERE revision.id = $1
        AND pull_request.repository_id = $2
        AND revision.is_current = true
        AND pull_request.state = 'open'
        AND repository.status = 'active'
        AND installation.status = 'active'
      FOR SHARE OF revision, pull_request, repository, installation`,
    [input.revisionId, input.repositoryId],
  );
  const occurredAt = revision.rows[0]?.now;
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
    throw new Error("Practice revision is not current.");
  }
  const windowStart = new Date(
    occurredAt.getTime() - input.windowSeconds * 1_000,
  );
  const existing = await client.query<{
    event_count: number;
    retry_after: Date | null;
  }>(
    `SELECT count(*)::int AS event_count,
            min(occurred_at) + ($6::integer * interval '1 second') AS retry_after
       FROM semantic_practice_rate_limits
      WHERE repository_id = $1
        AND revision_id = $2
        AND actor_key_hash = $3
        AND action = $4
        AND occurred_at > $5`,
    [
      input.repositoryId,
      input.revisionId,
      input.actorKeyHash,
      input.action,
      windowStart,
      input.windowSeconds,
    ],
  );
  if ((existing.rows[0]?.event_count ?? 0) >= input.maximumEvents) {
    throw new SemanticPracticeRateLimitExceededError(
      existing.rows[0]?.retry_after ??
        new Date(occurredAt.getTime() + input.windowSeconds * 1_000),
    );
  }
  const expiresAt = new Date(
    occurredAt.getTime() + input.windowSeconds * 1_000,
  );
  await client.query(
    `INSERT INTO semantic_practice_rate_limits
       (repository_id, revision_id, actor_key_hash, action, occurred_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.repositoryId,
      input.revisionId,
      input.actorKeyHash,
      input.action,
      occurredAt,
      expiresAt,
    ],
  );
  return { occurredAt, expiresAt };
}
