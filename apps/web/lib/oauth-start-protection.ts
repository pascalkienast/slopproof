import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { WebRuntime } from "./runtime";

export const TRUSTED_PROXY_CLIENT_IP_HEADER = "x-slopproof-client-ip";
export const TRUSTED_PROXY_AUTHENTICATOR_HEADER =
  "x-slopproof-proxy-authenticator";

const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_CLIENT_MAX_STARTS = 4;
const RATE_LIMIT_GLOBAL_MAX_STARTS = 600;
const RATE_LIMIT_RETENTION_MS = 10 * 60_000;
const RATE_LIMIT_CLEANUP_BATCH_SIZE = 500;
const RATE_LIMIT_LOCK_KEY = 736_567_103;

const ClientKeyHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ProxyAuthenticatorSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

export class OAuthStartProtectionError extends Error {
  readonly code = "OAUTH_START_PROTECTION_REJECTED" as const;

  constructor() {
    super("OAuth start protection rejected the request.");
    this.name = "OAuthStartProtectionError";
  }
}

export class OAuthStartProtectionUnavailableError extends Error {
  readonly code = "OAUTH_START_PROTECTION_UNAVAILABLE" as const;

  constructor() {
    super("OAuth start protection is unavailable.");
    this.name = "OAuthStartProtectionUnavailableError";
  }
}

export class OAuthStartRateLimitExceededError extends Error {
  readonly code = "OAUTH_START_RATE_LIMIT_EXCEEDED" as const;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("OAuth start rate limit was exceeded.");
    this.name = "OAuthStartRateLimitExceededError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Production trusts a client address only when the TLS proxy overwrote both
 * `X-SlopProof-*` headers and proves that boundary with the compiler-derived static
 * authenticator. Forwarded and X-Forwarded-For are intentionally ignored.
 */
export async function enforceProductionOAuthStartProtection(
  app: WebRuntime,
  request: Request,
  now = new Date(),
): Promise<void> {
  if (app.config.DEPLOYMENT_PROFILE !== "production") return;
  if (!Number.isFinite(now.getTime())) throw new OAuthStartProtectionError();

  const applicationOrigin = new URL(app.config.APP_BASE_URL).origin;
  requireSameOriginNavigation(request, applicationOrigin);
  const secret = app.config.OAUTH_TRUSTED_PROXY_SECRET;
  if (!secret) throw new OAuthStartProtectionError();
  const clientAddress = verifyTrustedProxyAssertion(request, secret);
  const clientKeyHash = hashClientKey(secret, clientAddress);
  await consumeOAuthStartRateLimit(app.database.pool, clientKeyHash, now);
}

export async function consumeOAuthStartRateLimit(
  pool: Pick<Pool, "connect">,
  clientKeyHash: string,
  now: Date,
): Promise<void> {
  if (
    !ClientKeyHashSchema.safeParse(clientKeyHash).success ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    throw new OAuthStartProtectionError();
  }
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  const expiresAt = new Date(now.getTime() + RATE_LIMIT_RETENTION_MS);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new OAuthStartProtectionUnavailableError();
  }
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    // A single small global lock makes both client and global quotas exact
    // under concurrency. No rejected request can race an INSERT.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      RATE_LIMIT_LOCK_KEY,
    ]);
    await client.query(
      `DELETE FROM oauth_start_rate_limits
        WHERE id IN (
          SELECT id FROM oauth_start_rate_limits
           WHERE expires_at <= $1
           ORDER BY expires_at, id
           LIMIT $2
        )`,
      [now, RATE_LIMIT_CLEANUP_BATCH_SIZE],
    );
    const consumed = await client.query<{
      client_count: number;
      client_oldest: Date | null;
      global_count: number;
      global_oldest: Date | null;
    }>(
      `WITH recent_client AS (
         SELECT occurred_at
           FROM oauth_start_rate_limits
          WHERE client_key_hash = $1
            AND occurred_at >= $2
          ORDER BY occurred_at
          LIMIT $3
       ), recent_global AS (
         SELECT occurred_at
           FROM oauth_start_rate_limits
          WHERE occurred_at >= $2
          ORDER BY occurred_at
          LIMIT $4
       ), counts AS (
         SELECT
           (SELECT count(*)::integer FROM recent_client) AS client_count,
           (SELECT min(occurred_at) FROM recent_client) AS client_oldest,
           (SELECT count(*)::integer FROM recent_global) AS global_count,
           (SELECT min(occurred_at) FROM recent_global) AS global_oldest
       ), admitted AS (
         INSERT INTO oauth_start_rate_limits
           (client_key_hash, occurred_at, expires_at)
         SELECT $1, $5, $6
           FROM counts
          WHERE client_count < $3
            AND global_count < $4
         RETURNING id
       )
       SELECT client_count, client_oldest, global_count, global_oldest
         FROM counts
        WHERE NOT EXISTS (SELECT 1 FROM admitted)`,
      [
        clientKeyHash,
        windowStart,
        RATE_LIMIT_CLIENT_MAX_STARTS,
        RATE_LIMIT_GLOBAL_MAX_STARTS,
        now,
        expiresAt,
      ],
    );
    // Commit bounded cleanup even on quota rejection.
    await client.query("COMMIT");
    transactionOpen = false;

    const rejected = consumed.rows[0];
    if (rejected) {
      const oldest =
        rejected.client_count >= RATE_LIMIT_CLIENT_MAX_STARTS
          ? rejected.client_oldest
          : rejected.global_oldest;
      if (!(oldest instanceof Date) || !Number.isFinite(oldest.getTime())) {
        throw new OAuthStartProtectionUnavailableError();
      }
      const retryAfterSeconds = Math.max(
        1,
        Math.min(
          Math.ceil(RATE_LIMIT_WINDOW_MS / 1_000),
          Math.ceil(
            (oldest.getTime() + RATE_LIMIT_WINDOW_MS - now.getTime()) / 1_000,
          ),
        ),
      );
      throw new OAuthStartRateLimitExceededError(retryAfterSeconds);
    }
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    if (
      error instanceof OAuthStartRateLimitExceededError ||
      error instanceof OAuthStartProtectionUnavailableError
    ) {
      throw error;
    }
    throw new OAuthStartProtectionUnavailableError();
  } finally {
    client.release();
  }
}

/** Test/deployment helper: values match the headers stock Caddy must overwrite. */
export function trustedProxyHeaders(
  secret: string,
  clientAddress: string,
): Readonly<Record<string, string>> {
  const authenticator = parseProxyAuthenticator(secret);
  const address = canonicalClientAddress(clientAddress);
  return Object.freeze({
    [TRUSTED_PROXY_CLIENT_IP_HEADER]: address,
    [TRUSTED_PROXY_AUTHENTICATOR_HEADER]: authenticator,
  });
}

function requireSameOriginNavigation(
  request: Request,
  applicationOrigin: string,
): void {
  if (
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    request.headers.get("sec-fetch-mode") !== "navigate" ||
    request.headers.get("sec-fetch-dest") !== "document"
  ) {
    throw new OAuthStartProtectionError();
  }
  for (const value of [
    request.headers.get("origin"),
    request.headers.get("referer"),
  ]) {
    if (value && exactOrigin(value) !== applicationOrigin) {
      throw new OAuthStartProtectionError();
    }
  }
}

function verifyTrustedProxyAssertion(request: Request, secret: string): string {
  const rawAddress = request.headers.get(TRUSTED_PROXY_CLIENT_IP_HEADER);
  const authenticator = request.headers.get(TRUSTED_PROXY_AUTHENTICATOR_HEADER);
  if (!rawAddress || !authenticator) throw new OAuthStartProtectionError();
  const expected = parseProxyAuthenticator(secret);
  if (!safeTextEqual(authenticator, expected)) {
    throw new OAuthStartProtectionError();
  }
  return canonicalClientAddress(rawAddress);
}

function parseProxyAuthenticator(value: string): string {
  const parsed = ProxyAuthenticatorSchema.safeParse(value);
  if (!parsed.success || /[\0\r\n]/u.test(parsed.data)) {
    throw new OAuthStartProtectionError();
  }
  return parsed.data;
}

function hashClientKey(secret: string, clientAddress: string): string {
  return createHmac("sha256", secret)
    .update("slopproof-oauth-client-key-v1", "utf8")
    .update("\0", "utf8")
    .update(clientAddress, "ascii")
    .digest("hex");
}

function canonicalClientAddress(value: string): string {
  if (
    value.length === 0 ||
    value.length > 64 ||
    value.trim() !== value ||
    /[\0\r\n,\s]/u.test(value)
  ) {
    throw new OAuthStartProtectionError();
  }
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind !== 6) throw new OAuthStartProtectionError();
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    throw new OAuthStartProtectionError();
  }
}

function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeTextEqual(left: string, right: string): boolean {
  if (!ProxyAuthenticatorSchema.safeParse(left).success) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
