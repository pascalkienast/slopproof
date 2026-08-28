import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  TRUSTED_PROXY_AUTHENTICATOR_HEADER,
  TRUSTED_PROXY_CLIENT_IP_HEADER,
  trustedProxyHeaders,
} from "./oauth-start-protection";

export const WebRequestRateLimitActionSchema = z.enum([
  "closed_beta_signup",
  "handoff_create",
  "handoff_exchange",
  "upload_start",
  "upload_part_url",
  "upload_part_complete",
  "upload_finalize",
  "review_queue",
  "review_detail",
  "review_context",
  "evidence_capability",
  "evidence_stream",
  "review_decision",
]);

export type WebRequestRateLimitAction = z.infer<
  typeof WebRequestRateLimitActionSchema
>;

const SubjectKeyHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const SubjectComponentSchema = z
  .array(z.string().min(1).max(256))
  .min(1)
  .max(8);

type RateLimitPolicy = Readonly<{
  maximumEvents: number;
  globalMaximumEvents: number;
  windowSeconds: number;
  retentionSeconds: number;
}>;

export const WEB_REQUEST_RATE_LIMIT_POLICIES = Object.freeze({
  closed_beta_signup: policy(5, 1_000, 10 * 60),
  handoff_create: policy(6, 1_000, 5 * 60),
  handoff_exchange: policy(20, 2_000, 5 * 60),
  upload_start: policy(8, 1_000, 10 * 60),
  upload_part_url: policy(128, 20_000, 10 * 60),
  upload_part_complete: policy(128, 20_000, 10 * 60),
  upload_finalize: policy(12, 2_000, 10 * 60),
  review_queue: policy(60, 10_000, 5 * 60),
  review_detail: policy(60, 10_000, 5 * 60),
  review_context: policy(30, 5_000, 5 * 60),
  evidence_capability: policy(20, 3_000, 5 * 60),
  evidence_stream: policy(30, 3_000, 5 * 60),
  review_decision: policy(10, 1_000, 10 * 60),
}) satisfies Readonly<Record<WebRequestRateLimitAction, RateLimitPolicy>>;

const CLEANUP_BATCH_SIZE = 500;
const RATE_LIMIT_DOMAIN = "slopproof:web-request-rate-limit:v1";
const RATE_LIMIT_LOCK_NAMESPACE = 1_934_731_629;
const RATE_LIMIT_LOCK_IDS = Object.freeze({
  handoff_create: 1,
  handoff_exchange: 2,
  upload_start: 3,
  upload_part_url: 4,
  upload_part_complete: 5,
  upload_finalize: 6,
  review_queue: 7,
  review_detail: 8,
  review_context: 9,
  evidence_capability: 10,
  review_decision: 11,
  evidence_stream: 12,
  closed_beta_signup: 13,
}) satisfies Readonly<Record<WebRequestRateLimitAction, number>>;

export class WebRequestRateLimitExceededError extends Error {
  readonly code = "WEB_REQUEST_RATE_LIMITED" as const;

  constructor(readonly retryAfterSeconds: number) {
    super("Web request rate limit exceeded.");
    this.name = "WebRequestRateLimitExceededError";
  }
}

export class WebRequestRateLimitUnavailableError extends Error {
  readonly code = "WEB_REQUEST_RATE_LIMIT_UNAVAILABLE" as const;

  constructor() {
    super("Web request rate limit is unavailable.");
    this.name = "WebRequestRateLimitUnavailableError";
  }
}

export class TrustedProxyRequestError extends Error {
  readonly code = "TRUSTED_PROXY_REQUEST_REJECTED" as const;

  constructor() {
    super("Trusted proxy request assertion was rejected.");
    this.name = "TrustedProxyRequestError";
  }
}

export function webRequestRateLimitResponse(
  error: WebRequestRateLimitExceededError,
): NextResponse {
  const retryAfterSeconds =
    Number.isSafeInteger(error.retryAfterSeconds) &&
    error.retryAfterSeconds >= 1 &&
    error.retryAfterSeconds <= 3_600
      ? error.retryAfterSeconds
      : 60;
  return NextResponse.json(
    { error: "rate_limited" },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}

/**
 * Produces an irreversible, action-separated key. Raw actor, repository,
 * attempt, token and client-address values never enter the rate-limit table.
 */
export function createWebRequestSubjectHash(
  secret: string,
  action: WebRequestRateLimitAction,
  rawComponents: readonly string[],
): string {
  const parsedAction = WebRequestRateLimitActionSchema.parse(action);
  const components = SubjectComponentSchema.parse(rawComponents);
  if (Buffer.byteLength(secret, "utf8") < 32 || secret.length > 4_096) {
    throw new TypeError("Rate-limit HMAC secret is invalid.");
  }
  const hmac = createHmac("sha256", secret)
    .update(RATE_LIMIT_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(parsedAction, "ascii");
  for (const component of components) {
    const encoded = Buffer.from(component, "utf8");
    hmac
      .update("\0", "utf8")
      .update(String(encoded.byteLength), "ascii")
      .update(":", "ascii")
      .update(encoded);
  }
  return hmac.digest("hex");
}

/**
 * Production public endpoints accept a client address only when the local TLS
 * proxy has overwritten and authenticated both private headers. The returned
 * value is already HMACed; callers never persist the address.
 */
export function createTrustedProxySubjectHash(
  request: Request,
  input: Readonly<{
    proxySecret: string;
    subjectSecret: string;
    action: WebRequestRateLimitAction;
  }>,
): string {
  try {
    const assertedAddress = request.headers.get(TRUSTED_PROXY_CLIENT_IP_HEADER);
    const assertedAuthenticator = request.headers.get(
      TRUSTED_PROXY_AUTHENTICATOR_HEADER,
    );
    if (!assertedAddress || !assertedAuthenticator) {
      throw new TrustedProxyRequestError();
    }
    const expected = trustedProxyHeaders(input.proxySecret, assertedAddress);
    const expectedAuthenticator = expected[TRUSTED_PROXY_AUTHENTICATOR_HEADER];
    if (
      !expectedAuthenticator ||
      !safeTextEqual(assertedAuthenticator, expectedAuthenticator)
    ) {
      throw new TrustedProxyRequestError();
    }
    const canonicalAddress = expected[TRUSTED_PROXY_CLIENT_IP_HEADER];
    if (!canonicalAddress) throw new TrustedProxyRequestError();
    return createWebRequestSubjectHash(input.subjectSecret, input.action, [
      "trusted-proxy-client",
      canonicalAddress,
    ]);
  } catch {
    throw new TrustedProxyRequestError();
  }
}

/** Starts and commits a small exact quota transaction around one reservation. */
export async function consumeWebRequestRateLimit(
  pool: Pick<Pool, "connect">,
  input: Readonly<{
    action: WebRequestRateLimitAction;
    subjectKeyHash: string;
  }>,
): Promise<void> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new WebRequestRateLimitUnavailableError();
  }
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    try {
      await reserveWebRequestRateLimit(client, input);
    } catch (error) {
      if (error instanceof WebRequestRateLimitExceededError) {
        // Preserve the bounded cleanup even though this request was rejected.
        await client.query("COMMIT");
        transactionOpen = false;
      }
      throw error;
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    if (
      error instanceof WebRequestRateLimitExceededError ||
      error instanceof WebRequestRateLimitUnavailableError
    ) {
      throw error;
    }
    throw new WebRequestRateLimitUnavailableError();
  } finally {
    client.release();
  }
}

/**
 * Reserves inside the caller's transaction. One action-scoped advisory lock
 * makes both per-subject and global count-and-insert decisions exact under
 * concurrency, and all time is taken from PostgreSQL.
 */
export async function reserveWebRequestRateLimit(
  client: Pick<PoolClient, "query">,
  rawInput: Readonly<{
    action: WebRequestRateLimitAction;
    subjectKeyHash: string;
  }>,
): Promise<void> {
  const action = WebRequestRateLimitActionSchema.parse(rawInput.action);
  const subjectKeyHash = SubjectKeyHashSchema.parse(rawInput.subjectKeyHash);
  const quota = WEB_REQUEST_RATE_LIMIT_POLICIES[action];

  await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [
    RATE_LIMIT_LOCK_NAMESPACE,
    RATE_LIMIT_LOCK_IDS[action],
  ]);
  await client.query(
    `DELETE FROM web_request_rate_limits
      WHERE id IN (
        SELECT id FROM web_request_rate_limits
         WHERE expires_at <= clock_timestamp()
         ORDER BY expires_at, id
         LIMIT $1
      )`,
    [CLEANUP_BATCH_SIZE],
  );
  const decision = await client.query<{
    retry_after_seconds: number | string;
  }>(
    `WITH request_clock AS (
       SELECT clock_timestamp() AS occurred_at
     ), recent_subject AS (
       SELECT event.occurred_at
         FROM web_request_rate_limits event, request_clock clock
        WHERE event.action = $1
          AND event.subject_key_hash = $2
          AND event.occurred_at >
              clock.occurred_at - ($3::integer * interval '1 second')
        ORDER BY event.occurred_at
        LIMIT $4
     ), recent_global AS (
       SELECT event.occurred_at
         FROM web_request_rate_limits event, request_clock clock
        WHERE event.action = $1
          AND event.occurred_at >
              clock.occurred_at - ($3::integer * interval '1 second')
        ORDER BY event.occurred_at
        LIMIT $5
     ), counts AS (
       SELECT clock.occurred_at,
              (SELECT count(*)::integer FROM recent_subject) AS subject_count,
              (SELECT min(occurred_at) FROM recent_subject) AS subject_oldest,
              (SELECT count(*)::integer FROM recent_global) AS global_count,
              (SELECT min(occurred_at) FROM recent_global) AS global_oldest
         FROM request_clock clock
     ), admitted AS (
       INSERT INTO web_request_rate_limits
         (action, subject_key_hash, occurred_at, expires_at)
       SELECT $1, $2, counts.occurred_at,
              counts.occurred_at + ($6::integer * interval '1 second')
         FROM counts
        WHERE counts.subject_count < $4
          AND counts.global_count < $5
       RETURNING id
     )
     SELECT GREATEST(
              1,
              LEAST(
                $3,
                CEIL(EXTRACT(EPOCH FROM (
                  GREATEST(
                    CASE WHEN counts.subject_count >= $4
                      THEN counts.subject_oldest + ($3::integer * interval '1 second')
                      ELSE counts.occurred_at
                    END,
                    CASE WHEN counts.global_count >= $5
                      THEN counts.global_oldest + ($3::integer * interval '1 second')
                      ELSE counts.occurred_at
                    END
                  ) - counts.occurred_at
                )))::integer
              )
            )::integer AS retry_after_seconds
       FROM counts
      WHERE NOT EXISTS (SELECT 1 FROM admitted)`,
    [
      action,
      subjectKeyHash,
      quota.windowSeconds,
      quota.maximumEvents,
      quota.globalMaximumEvents,
      quota.retentionSeconds,
    ],
  );
  const rejected = decision.rows[0];
  if (rejected) {
    const retryAfterSeconds = Number(rejected.retry_after_seconds);
    if (
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 1 ||
      retryAfterSeconds > quota.windowSeconds
    ) {
      throw new WebRequestRateLimitUnavailableError();
    }
    throw new WebRequestRateLimitExceededError(retryAfterSeconds);
  }
}

function policy(
  maximumEvents: number,
  globalMaximumEvents: number,
  windowSeconds: number,
): RateLimitPolicy {
  return Object.freeze({
    maximumEvents,
    globalMaximumEvents,
    windowSeconds,
    retentionSeconds: windowSeconds + 5 * 60,
  });
}

function safeTextEqual(left: string, right: string): boolean {
  if (left.length < 1 || left.length > 256 || /[\0\r\n]/u.test(left)) {
    return false;
  }
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
