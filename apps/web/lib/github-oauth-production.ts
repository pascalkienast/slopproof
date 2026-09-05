import { timingSafeEqual } from "node:crypto";
import {
  GithubOAuthBindingSchema,
  GithubOAuthRejectedError,
  GithubOAuthService,
  GithubOAuthUserSchema,
  createOpaqueCredential,
  deriveGithubOAuthStateHash,
  githubOAuthActorRole,
  hashOpaqueCredential,
  type GithubOAuthBinding,
  type GithubOAuthPurpose,
  type GithubOAuthSessionPort,
  type GithubOAuthStateRecord,
  type GithubOAuthStateRepository,
  type OAuthStateHash,
} from "@understandproof/auth";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requestCookieValue, SESSION_COOKIE } from "./http-auth";
import {
  GithubOAuthHttpClient,
  type GithubOAuthProviderFailureStage,
  type GithubOAuthProviderFailureReason,
} from "./github-oauth-client";
import {
  GithubOAuthWiringError,
  GithubOAuthStartPolicyError,
  GithubOAuthStartRateLimitError,
  type GithubOAuthWebRuntime,
} from "./github-oauth-runtime";
import {
  enforceProductionOAuthStartProtection,
  OAuthStartProtectionError,
  OAuthStartRateLimitExceededError,
} from "./oauth-start-protection";
import type { WebRuntime } from "./runtime";

const STATE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const FRESH_TOKEN_TTL_MS = 15 * 60_000;
const OAUTH_FLOW_QUOTA_LOCK_KEY = 736_567_102;
const OAUTH_FLOW_CLEANUP_BATCH_SIZE = 500;
const OAUTH_FLOW_QUOTA_WINDOW_MS = 60_000;
const OAUTH_FLOW_REPOSITORY_ACTIVE_LIMIT = 8;
const OAUTH_FLOW_REPOSITORY_WINDOW_LIMIT = 12;
const OAUTH_FLOW_GLOBAL_ACTIVE_LIMIT = 500;
const OAUTH_FLOW_GLOBAL_WINDOW_LIMIT = 240;
const UuidPart =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ContributorRedirectSchema = z
  .string()
  .regex(
    new RegExp(`^/revisions/(${UuidPart})(?:/contribute(?:/practice)?)?$`, "u"),
  );
const ReviewDetailRedirectSchema = z
  .string()
  .regex(new RegExp(`^/review/(${UuidPart})$`, "u"));
const OAuthRedirectSchema = z.union([
  z.literal("/review"),
  ContributorRedirectSchema,
  ReviewDetailRedirectSchema,
]);
const StateHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const ActiveRepositoryRowSchema = z
  .object({
    repository_id: z.uuid(),
    github_repository_id: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/u)
      .refine((value) => Number.isSafeInteger(Number(value))),
  })
  .strict();

const RepositoryOwnerNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u);

const ActiveMaintainerRepositorySchema = z
  .object({
    id: z.uuid(),
    owner: RepositoryOwnerNameSchema,
    name: RepositoryOwnerNameSchema,
  })
  .strict();

export type ActiveMaintainerRepositoryV1 = z.infer<
  typeof ActiveMaintainerRepositorySchema
>;

export const MAX_ACTIVE_MAINTAINER_REPOSITORIES = 32;

const BoundStateRowSchema = z
  .object({
    state_hash: StateHashSchema,
    purpose: z.enum(["contributor_login", "maintainer_reauth"]),
    repository_id: z.uuid(),
    github_repository_id: ActiveRepositoryRowSchema.shape.github_repository_id,
    redirect_path: OAuthRedirectSchema,
    created_at: z.date(),
    expires_at: z.date(),
  })
  .strict();
const IdentifyStateRowSchema = z
  .object({
    state_hash: StateHashSchema,
    purpose: z.literal("maintainer_identify"),
    repository_id: z.null(),
    github_repository_id: z.null(),
    redirect_path: z.literal("/review"),
    created_at: z.date(),
    expires_at: z.date(),
  })
  .strict();
const StateRowSchema = z.union([BoundStateRowSchema, IdentifyStateRowSchema]);

type SqlPool = WebRuntime["database"]["pool"];
type GithubOAuthOperationalFailureStage =
  GithubOAuthProviderFailureStage | "session_persist" | "session_revoke";

function reportGithubOAuthFailure(
  stage: GithubOAuthOperationalFailureStage,
  reason?: GithubOAuthProviderFailureReason,
): void {
  process.stderr.write(
    `${JSON.stringify({
      event: "github.oauth.unavailable",
      stage,
      ...(reason ? { reason } : {}),
    })}\n`,
  );
}

class GithubOAuthPersistenceError extends Error {
  constructor() {
    super("GitHub OAuth persistence is unavailable.");
    this.name = "GithubOAuthPersistenceError";
  }
}

export class PgGithubOAuthStateRepository implements GithubOAuthStateRepository {
  constructor(private readonly pool: SqlPool) {}

  async create(record: GithubOAuthStateRecord): Promise<void> {
    const binding = GithubOAuthBindingSchema.safeParse(
      record.purpose === "maintainer_identify"
        ? { purpose: record.purpose }
        : {
            purpose: record.purpose,
            repositoryId: record.repositoryId,
            githubRepositoryId: record.githubRepositoryId,
          },
    );
    const redirect = OAuthRedirectSchema.safeParse(record.redirectPath);
    const createdAtMs =
      record.createdAt instanceof Date ? record.createdAt.getTime() : NaN;
    const expiresAtMs =
      record.expiresAt instanceof Date ? record.expiresAt.getTime() : NaN;
    if (
      !binding.success ||
      !redirect.success ||
      !StateHashSchema.safeParse(record.stateHash).success ||
      !(record.createdAt instanceof Date) ||
      !(record.expiresAt instanceof Date) ||
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= createdAtMs ||
      expiresAtMs - createdAtMs > STATE_TTL_MS ||
      (binding.data.purpose === "maintainer_identify" &&
        redirect.data !== "/review")
    ) {
      throw new GithubOAuthPersistenceError();
    }
    const quotaWindowStart = new Date(createdAtMs - OAUTH_FLOW_QUOTA_WINDOW_MS);
    const client = await this.pool.connect();
    let transactionOpen = false;
    let insertedRowCount = 0;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      // Serialize the tiny start boundary so concurrent unauthenticated starts
      // cannot race past the global/repository quotas.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        OAUTH_FLOW_QUOTA_LOCK_KEY,
      ]);
      await client.query(
        `DELETE FROM github_oauth_flows
          WHERE id IN (
            SELECT id FROM github_oauth_flows
             WHERE expires_at <= $1
             ORDER BY expires_at, id
             LIMIT $2
          )`,
        [record.createdAt, OAUTH_FLOW_CLEANUP_BATCH_SIZE],
      );
      const inserted =
        binding.data.purpose === "maintainer_identify"
          ? await client.query(
              `INSERT INTO github_oauth_flows
               (state_hash, purpose, repository_id, redirect_path,
                expires_at, created_at)
             SELECT $1, $2, NULL, $3, $4::timestamptz, $5::timestamptz
              WHERE $4::timestamptz > $5::timestamptz
                AND (
                  SELECT count(*) FROM github_oauth_flows active
                   WHERE active.consumed_at IS NULL
                     AND active.expires_at > $5::timestamptz
                ) < $6::bigint
                AND (
                  SELECT count(*) FROM github_oauth_flows recent
                   WHERE recent.created_at >= $7::timestamptz
                ) < $8::bigint
             RETURNING state_hash`,
              [
                record.stateHash,
                binding.data.purpose,
                redirect.data,
                record.expiresAt,
                record.createdAt,
                OAUTH_FLOW_GLOBAL_ACTIVE_LIMIT,
                quotaWindowStart,
                OAUTH_FLOW_GLOBAL_WINDOW_LIMIT,
              ],
            )
          : await client.query(
              `INSERT INTO github_oauth_flows
               (state_hash, purpose, repository_id, redirect_path,
                expires_at, created_at)
             SELECT $1, $2, repository.id, $4, $5::timestamptz, $6::timestamptz
               FROM repositories repository
               JOIN installations installation
                 ON installation.id = repository.installation_id
              WHERE repository.id = $3
                AND repository.github_repository_id = $7
                AND repository.status = 'active'
                AND installation.status = 'active'
                AND $5::timestamptz > $6::timestamptz
                AND (
                  SELECT count(*) FROM github_oauth_flows active
                   WHERE active.repository_id = repository.id
                     AND active.consumed_at IS NULL
                     AND active.expires_at > $6::timestamptz
                ) < $8::bigint
                AND (
                  SELECT count(*) FROM github_oauth_flows recent
                   WHERE recent.repository_id = repository.id
                     AND recent.created_at >= $9::timestamptz
                ) < $10::bigint
                AND (
                  SELECT count(*) FROM github_oauth_flows active
                   WHERE active.consumed_at IS NULL
                     AND active.expires_at > $6::timestamptz
                ) < $11::bigint
                AND (
                  SELECT count(*) FROM github_oauth_flows recent
                   WHERE recent.created_at >= $9::timestamptz
                ) < $12::bigint
             RETURNING state_hash`,
              [
                record.stateHash,
                binding.data.purpose,
                binding.data.repositoryId,
                redirect.data,
                record.expiresAt,
                record.createdAt,
                binding.data.githubRepositoryId,
                OAUTH_FLOW_REPOSITORY_ACTIVE_LIMIT,
                quotaWindowStart,
                OAUTH_FLOW_REPOSITORY_WINDOW_LIMIT,
                OAUTH_FLOW_GLOBAL_ACTIVE_LIMIT,
                OAUTH_FLOW_GLOBAL_WINDOW_LIMIT,
              ],
            );
      insertedRowCount = inserted.rowCount ?? 0;
      // Commit bounded cleanup even when the quota rejects this start. This
      // lets abuse traffic drain stale rows instead of rolling cleanup back.
      await client.query("COMMIT");
      transactionOpen = false;
    } catch {
      if (transactionOpen) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw new GithubOAuthPersistenceError();
    } finally {
      client.release();
    }
    if (insertedRowCount !== 1) throw new GithubOAuthPersistenceError();
  }

  async consume(
    input: Readonly<{
      stateHash: OAuthStateHash;
      now: Date;
    }>,
  ): Promise<GithubOAuthStateRecord | null> {
    if (
      !StateHashSchema.safeParse(input.stateHash).success ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    ) {
      throw new GithubOAuthPersistenceError();
    }
    const consumed = await this.pool.query<{
      state_hash: string;
      purpose: string;
      repository_id: string | null;
      github_repository_id: string | null;
      redirect_path: string;
      created_at: Date;
      expires_at: Date;
    }>(
      `WITH consumed AS (
         UPDATE github_oauth_flows flow
            SET consumed_at = $2
          WHERE flow.state_hash = $1
            AND flow.consumed_at IS NULL
            AND flow.expires_at > $2
            AND (
              (
                flow.purpose = 'maintainer_identify'
                AND flow.repository_id IS NULL
              )
              OR EXISTS (
                SELECT 1
                  FROM repositories repository
                  JOIN installations installation
                    ON installation.id = repository.installation_id
                 WHERE repository.id = flow.repository_id
                   AND repository.status = 'active'
                   AND installation.status = 'active'
              )
            )
          RETURNING flow.state_hash, flow.purpose, flow.repository_id,
                    flow.redirect_path, flow.created_at, flow.expires_at
       )
       SELECT consumed.state_hash, consumed.purpose, consumed.repository_id,
              repository.github_repository_id, consumed.redirect_path,
              consumed.created_at, consumed.expires_at
         FROM consumed
         LEFT JOIN repositories repository
           ON repository.id = consumed.repository_id`,
      [input.stateHash, input.now],
    );
    const row = consumed.rows[0];
    if (!row) return null;
    const parsed = StateRowSchema.safeParse(row);
    if (!parsed.success) throw new GithubOAuthPersistenceError();
    return parsed.data.purpose === "maintainer_identify"
      ? Object.freeze({
          stateHash: parsed.data.state_hash as OAuthStateHash,
          purpose: parsed.data.purpose,
          redirectPath: parsed.data.redirect_path,
          createdAt: parsed.data.created_at,
          expiresAt: parsed.data.expires_at,
        })
      : Object.freeze({
          stateHash: parsed.data.state_hash as OAuthStateHash,
          purpose: parsed.data.purpose,
          repositoryId: parsed.data.repository_id,
          githubRepositoryId: parsed.data.github_repository_id,
          redirectPath: parsed.data.redirect_path,
          createdAt: parsed.data.created_at,
          expiresAt: parsed.data.expires_at,
        });
  }
}

/**
 * PostgreSQL-backed server-session boundary. A current session is revoked and
 * its replacement inserted in one transaction. Contributor identity is
 * checked against the exact current revision encoded by the persisted redirect
 * immediately before the author session is installed.
 */
export class PgGithubOAuthSessionPort implements GithubOAuthSessionPort {
  constructor(
    private readonly pool: SqlPool,
    private readonly sessionSecret: string,
    private readonly onFailure: (
      stage: Extract<
        GithubOAuthOperationalFailureStage,
        "session_persist" | "session_revoke"
      >,
    ) => void = () => undefined,
  ) {
    if (sessionSecret.length < 32 || /[\0\r\n]/u.test(sessionSecret)) {
      throw new GithubOAuthPersistenceError();
    }
  }

  async rotate(input: Parameters<GithubOAuthSessionPort["rotate"]>[0]) {
    const binding = GithubOAuthBindingSchema.safeParse(input.binding);
    const user = GithubOAuthUserSchema.safeParse(input.user);
    const redirect = OAuthRedirectSchema.safeParse(input.redirectPath);
    if (
      !binding.success ||
      binding.data.purpose === "maintainer_identify" ||
      !user.success ||
      !redirect.success ||
      input.actorRole !== githubOAuthActorRole(binding.data.purpose) ||
      !Number.isSafeInteger(input.ttlMs) ||
      input.ttlMs < 60_000 ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    ) {
      throw new GithubOAuthPersistenceError();
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeSessionRotation(client, {
        binding: binding.data,
        githubUserId: user.data.githubUserId,
        redirectPath: redirect.data,
      });
      if (input.currentSessionToken) {
        validateCredential(input.currentSessionToken);
        await client.query(
          `UPDATE auth_sessions
              SET revoked_at = COALESCE(revoked_at, $2)
            WHERE token_hash = $1`,
          [
            hashOpaqueCredential(
              this.sessionSecret,
              "session",
              input.currentSessionToken,
            ),
            input.now,
          ],
        );
      }

      const sessionCredential = createOpaqueCredential(
        this.sessionSecret,
        "session",
      );
      const csrfCredential = createOpaqueCredential(this.sessionSecret, "csrf");
      const expiresAt = new Date(input.now.getTime() + input.ttlMs);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO auth_sessions
           (token_hash, actor_id, actor_role, repository_id,
            csrf_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          sessionCredential.hash,
          user.data.githubUserId,
          input.actorRole,
          binding.data.repositoryId,
          csrfCredential.hash,
          expiresAt,
          input.now,
        ],
      );
      const id = z.uuid().safeParse(inserted.rows[0]?.id);
      if (!id.success) throw new GithubOAuthPersistenceError();
      await client.query("COMMIT");
      return {
        session: {
          id: id.data,
          actorId: user.data.githubUserId,
          actorRole: input.actorRole,
          repositoryId: binding.data.repositoryId,
          csrfHash: csrfCredential.hash,
          expiresAt,
        },
        sessionToken: sessionCredential.value,
        csrfToken: csrfCredential.value,
      };
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      this.reportFailure("session_persist");
      throw new GithubOAuthPersistenceError();
    } finally {
      client.release();
    }
  }

  async revoke(input: Parameters<GithubOAuthSessionPort["revoke"]>[0]) {
    validateCredential(input.sessionToken);
    validateCredential(input.csrfToken);
    if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
      throw new GithubOAuthPersistenceError();
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        id: string;
        csrf_hash: string;
      }>(
        `SELECT id, csrf_hash
           FROM auth_sessions
          WHERE token_hash = $1
            AND revoked_at IS NULL
            AND expires_at > $2
          FOR UPDATE`,
        [
          hashOpaqueCredential(
            this.sessionSecret,
            "session",
            input.sessionToken,
          ),
          input.now,
        ],
      );
      const row = selected.rows[0];
      const suppliedCsrf = hashOpaqueCredential(
        this.sessionSecret,
        "csrf",
        input.csrfToken,
      );
      if (!row || !safeHexEqual(row.csrf_hash, suppliedCsrf)) {
        throw new GithubOAuthPersistenceError();
      }
      const revoked = await client.query(
        `UPDATE auth_sessions
            SET revoked_at = $2
          WHERE id = $1 AND revoked_at IS NULL`,
        [row.id, input.now],
      );
      if (revoked.rowCount !== 1) throw new GithubOAuthPersistenceError();
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      this.reportFailure("session_revoke");
      throw new GithubOAuthPersistenceError();
    } finally {
      client.release();
    }
  }

  private reportFailure(stage: "session_persist" | "session_revoke"): void {
    try {
      this.onFailure(stage);
    } catch {
      // Telemetry must never replace the fixed persistence error.
    }
  }
}

export async function createGithubOAuthProductionRuntime(
  app: WebRuntime,
  request: Request,
): Promise<GithubOAuthWebRuntime> {
  if (
    app.config.DEPLOYMENT_PROFILE !== "production" ||
    app.config.GITHUB_ADAPTER !== "octokit" ||
    app.config.DEMO_MODE
  ) {
    throw new GithubOAuthWiringError();
  }
  const context = await resolveRequestOAuthContext(app, request);
  const oauth = new GithubOAuthService({
    clientId: app.config.GITHUB_CLIENT_ID,
    callbackUrl: new URL(
      "/api/auth/github/callback",
      app.config.APP_BASE_URL,
    ).toString(),
    sessionSecret: app.config.SESSION_SECRET,
    allowedRedirectPaths: [context.redirectPath],
    defaultRedirectPath: context.redirectPath,
    stateRepository: new PgGithubOAuthStateRepository(app.database.pool),
    client: new GithubOAuthHttpClient({
      clientId: app.config.GITHUB_CLIENT_ID,
      clientSecret: app.config.GITHUB_CLIENT_SECRET,
      onFailure: reportGithubOAuthFailure,
    }),
    sessions: new PgGithubOAuthSessionPort(
      app.database.pool,
      app.config.SESSION_SECRET,
      reportGithubOAuthFailure,
    ),
    identifyDirectory: {
      async resolve(input) {
        const { resolveProductionIdentifyDirectory } =
          await import("./maintainer-directory");
        return resolveProductionIdentifyDirectory(app, input);
      },
    },
    stateTtlMs: STATE_TTL_MS,
    sessionTtlMs: SESSION_TTL_MS,
    freshTokenTtlMs: FRESH_TOKEN_TTL_MS,
  });
  return Object.freeze({
    appBaseUrl: new URL(app.config.APP_BASE_URL).toString(),
    oauth,
    async resolveStartBinding(input) {
      const target = input.requestedRedirectPath ?? "/review";
      if (!context.startBinding || target !== context.redirectPath) {
        throw new GithubOAuthRejectedError();
      }
      return context.startBinding;
    },
  });
}

async function resolveRequestOAuthContext(
  app: WebRuntime,
  request: Request,
): Promise<{
  redirectPath: string;
  startBinding?: GithubOAuthBinding;
}> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/github/start" && request.method === "GET") {
    try {
      await enforceProductionOAuthStartProtection(app, request);
    } catch (error) {
      if (error instanceof OAuthStartRateLimitExceededError) {
        throw new GithubOAuthStartRateLimitError(error.retryAfterSeconds);
      }
      if (error instanceof OAuthStartProtectionError) {
        throw new GithubOAuthStartPolicyError();
      }
      throw error;
    }
    const values = url.searchParams.getAll("returnTo");
    if (values.length > 1) throw new GithubOAuthWiringError();
    const redirectPath = values[0] || "/review";
    return {
      redirectPath,
      startBinding: await resolveProductionStartBinding(
        app,
        request,
        redirectPath,
      ),
    };
  }
  if (
    url.pathname === "/api/auth/github/callback" &&
    request.method === "GET"
  ) {
    const states = url.searchParams.getAll("state");
    if (states.length !== 1) throw new GithubOAuthWiringError();
    const stateHash = deriveGithubOAuthStateHash(
      states[0]!,
      app.config.SESSION_SECRET,
    );
    return {
      redirectPath: await peekActiveStateRedirect(
        app.database.pool,
        stateHash,
        new Date(),
      ),
    };
  }
  if (url.pathname === "/api/auth/github/logout" && request.method === "POST") {
    return { redirectPath: "/review" };
  }
  throw new GithubOAuthWiringError();
}

export async function resolveProductionStartBinding(
  app: WebRuntime,
  request: Request,
  redirectPath: string,
): Promise<GithubOAuthBinding> {
  const contributor = ContributorRedirectSchema.safeParse(redirectPath);
  if (contributor.success) {
    const revisionId = contributor.data.split("/")[2]!;
    return loadSingleActiveBinding(
      app.database.pool,
      `SELECT repository.id AS repository_id,
              repository.github_repository_id
         FROM pull_request_revisions revision
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE revision.id = $1
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
        LIMIT 1`,
      [revisionId],
      "contributor_login",
    );
  }

  const reviewDetail = ReviewDetailRedirectSchema.safeParse(redirectPath);
  if (reviewDetail.success) {
    const attemptId = reviewDetail.data.split("/")[2]!;
    return loadSingleActiveBinding(
      app.database.pool,
      `SELECT repository.id AS repository_id,
              repository.github_repository_id
         FROM attempts attempt
         JOIN pull_request_revisions revision
           ON revision.id = attempt.revision_id
         JOIN repositories repository
           ON repository.id = attempt.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE attempt.id = $1
          AND revision.is_current = true
          AND repository.status = 'active'
          AND installation.status = 'active'
        LIMIT 1`,
      [attemptId],
      "maintainer_reauth",
    );
  }

  if (redirectPath !== "/review") throw new GithubOAuthWiringError();
  const selectedRepositoryId = requestedReviewRepositoryId(request);
  if (selectedRepositoryId) {
    return loadSingleActiveBinding(
      app.database.pool,
      `SELECT repository.id AS repository_id,
              repository.github_repository_id
         FROM repositories repository
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE repository.id = $1
          AND repository.status = 'active'
          AND installation.status = 'active'
        LIMIT 1`,
      [selectedRepositoryId],
      "maintainer_reauth",
    );
  }
  const sessionToken = requestCookieValue(request, SESSION_COOKIE);
  if (sessionToken) {
    validateCredential(sessionToken);
    const bound = await app.database.pool.query<{
      repository_id: string;
      github_repository_id: string;
    }>(
      `SELECT repository.id AS repository_id,
              repository.github_repository_id
         FROM auth_sessions session
         JOIN repositories repository
           ON repository.id = session.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE session.token_hash = $1
          AND session.revoked_at IS NULL
          AND session.expires_at > now()
          AND repository.status = 'active'
          AND installation.status = 'active'
        LIMIT 1`,
      [
        hashOpaqueCredential(
          app.config.SESSION_SECRET,
          "session",
          sessionToken,
        ),
      ],
    );
    if (bound.rows[0]) {
      return bindingFromRow(bound.rows[0], "maintainer_reauth");
    }
  }

  return { purpose: "maintainer_identify" };
}

async function loadSingleActiveBinding(
  pool: SqlPool,
  sql: string,
  parameters: readonly unknown[],
  purpose: GithubOAuthPurpose,
): Promise<GithubOAuthBinding> {
  const result = await pool.query<{
    repository_id: string;
    github_repository_id: string;
  }>(sql, [...parameters]);
  if (!result.rows[0]) throw new GithubOAuthWiringError();
  return bindingFromRow(result.rows[0], purpose);
}

function bindingFromRow(
  row: unknown,
  purpose: GithubOAuthPurpose,
): GithubOAuthBinding {
  const parsed = ActiveRepositoryRowSchema.safeParse(row);
  if (!parsed.success) throw new GithubOAuthWiringError();
  const binding = GithubOAuthBindingSchema.safeParse({
    purpose,
    repositoryId: parsed.data.repository_id,
    githubRepositoryId: parsed.data.github_repository_id,
  });
  if (!binding.success) throw new GithubOAuthWiringError();
  return binding.data;
}

function requestedReviewRepositoryId(request: Request): string | undefined {
  const url = new URL(request.url);
  const values = url.searchParams.getAll("repositoryId");
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new GithubOAuthWiringError();
  const repositoryId = z.uuid().safeParse(values[0]);
  if (!repositoryId.success) throw new GithubOAuthWiringError();
  return repositoryId.data;
}

const GithubInstallationIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/u)
  .refine((value) => Number.isSafeInteger(Number(value)));

export async function listActiveMaintainerRepositories(
  pool: SqlPool,
  githubInstallationIds: readonly string[],
  githubRepositoryIds: readonly string[],
): Promise<readonly ActiveMaintainerRepositoryV1[]> {
  const parsedIds = githubInstallationIds.map((id) =>
    GithubInstallationIdSchema.safeParse(id),
  );
  if (parsedIds.some((id) => !id.success)) {
    throw new GithubOAuthWiringError();
  }
  const uniqueIds = [...new Set(parsedIds.map((id) => id.data))];
  const parsedRepositoryIds = githubRepositoryIds.map((id) =>
    GithubInstallationIdSchema.safeParse(id),
  );
  if (
    parsedRepositoryIds.some((id) => !id.success) ||
    parsedRepositoryIds.length > 3_200
  ) {
    throw new GithubOAuthWiringError();
  }
  const uniqueRepositoryIds = [
    ...new Set(parsedRepositoryIds.map((id) => id.data)),
  ];
  if (uniqueIds.length === 0 || uniqueRepositoryIds.length === 0) return [];
  const result = await pool.query<{
    id: string;
    owner: string;
    name: string;
  }>(
    `SELECT repository.id, repository.owner, repository.name
       FROM repositories repository
       JOIN installations installation
         ON installation.id = repository.installation_id
      WHERE installation.github_installation_id = ANY($1::text[])
        AND repository.github_repository_id = ANY($2::text[])
        AND repository.status = 'active'
        AND installation.status = 'active'
      ORDER BY repository.owner, repository.name, repository.id
      LIMIT $3`,
    [uniqueIds, uniqueRepositoryIds, MAX_ACTIVE_MAINTAINER_REPOSITORIES],
  );
  return result.rows.map(parseActiveMaintainerRepository);
}

export async function listActiveMaintainerInstallationIds(
  pool: SqlPool,
  githubInstallationIds: readonly string[],
): Promise<readonly string[]> {
  const parsedIds = githubInstallationIds.map((id) =>
    GithubInstallationIdSchema.safeParse(id),
  );
  if (parsedIds.some((id) => !id.success)) {
    throw new GithubOAuthWiringError();
  }
  const uniqueIds = [...new Set(parsedIds.map((id) => id.data))];
  if (uniqueIds.length === 0) return [];
  const result = await pool.query<{ github_installation_id: string }>(
    `SELECT github_installation_id
       FROM installations
      WHERE github_installation_id = ANY($1::text[])
        AND status = 'active'
      ORDER BY github_installation_id`,
    [uniqueIds],
  );
  return result.rows.map((row) => row.github_installation_id);
}

export async function loadActiveMaintainerRepository(
  pool: SqlPool,
  repositoryId: string,
): Promise<ActiveMaintainerRepositoryV1> {
  const parsedId = z.uuid().safeParse(repositoryId);
  if (!parsedId.success) throw new GithubOAuthWiringError();
  const result = await pool.query<{
    id: string;
    owner: string;
    name: string;
  }>(
    `SELECT repository.id, repository.owner, repository.name
       FROM repositories repository
       JOIN installations installation
         ON installation.id = repository.installation_id
      WHERE repository.id = $1
        AND repository.status = 'active'
        AND installation.status = 'active'
      LIMIT 1`,
    [parsedId.data],
  );
  const row = result.rows[0];
  if (row === undefined) throw new GithubOAuthWiringError();
  return parseActiveMaintainerRepository(row);
}

export async function loadMaintainerRepositoriesByIds(
  pool: SqlPool,
  repositoryIds: readonly string[],
): Promise<readonly ActiveMaintainerRepositoryV1[]> {
  if (repositoryIds.length === 0) return [];
  if (repositoryIds.length > MAX_ACTIVE_MAINTAINER_REPOSITORIES) {
    throw new GithubOAuthWiringError();
  }
  const parsedIds = repositoryIds.map((id) => z.uuid().safeParse(id));
  if (parsedIds.some((id) => !id.success)) throw new GithubOAuthWiringError();
  const uniqueIds = [...new Set(parsedIds.map((id) => id.data))];
  if (uniqueIds.length !== repositoryIds.length) {
    throw new GithubOAuthWiringError();
  }
  const result = await pool.query<{
    id: string;
    owner: string;
    name: string;
  }>(
    `SELECT repository.id, repository.owner, repository.name
       FROM repositories repository
       JOIN installations installation
         ON installation.id = repository.installation_id
      WHERE repository.id = ANY($1::uuid[])
        AND repository.status = 'active'
        AND installation.status = 'active'
      ORDER BY repository.owner, repository.name, repository.id`,
    [uniqueIds],
  );
  return result.rows.map(parseActiveMaintainerRepository);
}

function parseActiveMaintainerRepository(
  row: unknown,
): ActiveMaintainerRepositoryV1 {
  const parsed = ActiveMaintainerRepositorySchema.safeParse(row);
  if (!parsed.success) throw new GithubOAuthWiringError();
  return parsed.data;
}

async function peekActiveStateRedirect(
  pool: SqlPool,
  stateHash: OAuthStateHash,
  now: Date,
): Promise<string> {
  const result = await pool.query<{ redirect_path: string }>(
    `SELECT flow.redirect_path
       FROM github_oauth_flows flow
       LEFT JOIN repositories repository ON repository.id = flow.repository_id
       LEFT JOIN installations installation
         ON installation.id = repository.installation_id
      WHERE flow.state_hash = $1
        AND flow.consumed_at IS NULL
        AND flow.expires_at > $2
        AND (
          (
            flow.purpose = 'maintainer_identify'
            AND flow.repository_id IS NULL
          )
          OR (
            repository.status = 'active'
            AND installation.status = 'active'
          )
        )
      LIMIT 1`,
    [stateHash, now],
  );
  const redirect = OAuthRedirectSchema.safeParse(result.rows[0]?.redirect_path);
  if (!redirect.success) throw new GithubOAuthWiringError();
  return redirect.data;
}

async function authorizeSessionRotation(
  client: PoolClient,
  input: Readonly<{
    binding: GithubOAuthBinding;
    githubUserId: string;
    redirectPath: string;
  }>,
): Promise<void> {
  if (input.binding.purpose === "contributor_login") {
    const redirect = ContributorRedirectSchema.safeParse(input.redirectPath);
    if (!redirect.success) throw new GithubOAuthPersistenceError();
    const revisionId = redirect.data.split("/")[2]!;
    const authorized = await client.query(
      `SELECT 1
         FROM pull_request_revisions revision
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
        WHERE revision.id = $1
          AND pull_request.author_id = $2
          AND repository.id = $3
          AND repository.github_repository_id = $4
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
        FOR SHARE OF revision, pull_request, repository, installation`,
      [
        revisionId,
        input.githubUserId,
        input.binding.repositoryId,
        input.binding.githubRepositoryId,
      ],
    );
    if (authorized.rowCount !== 1) throw new GithubOAuthPersistenceError();
    return;
  }

  if (input.binding.purpose !== "maintainer_reauth") {
    throw new GithubOAuthPersistenceError();
  }
  const detail = ReviewDetailRedirectSchema.safeParse(input.redirectPath);
  const authorized = detail.success
    ? await client.query(
        `SELECT 1
           FROM attempts attempt
           JOIN repositories repository
             ON repository.id = attempt.repository_id
           JOIN installations installation
             ON installation.id = repository.installation_id
          WHERE attempt.id = $1
            AND repository.id = $2
            AND repository.github_repository_id = $3
            AND repository.status = 'active'
            AND installation.status = 'active'
          FOR SHARE OF attempt, repository, installation`,
        [
          detail.data.split("/")[2]!,
          input.binding.repositoryId,
          input.binding.githubRepositoryId,
        ],
      )
    : input.redirectPath === "/review"
      ? await client.query(
          `SELECT 1
             FROM repositories repository
             JOIN installations installation
               ON installation.id = repository.installation_id
            WHERE repository.id = $1
              AND repository.github_repository_id = $2
              AND repository.status = 'active'
              AND installation.status = 'active'
            FOR SHARE OF repository, installation`,
          [input.binding.repositoryId, input.binding.githubRepositoryId],
        )
      : null;
  if (!authorized || authorized.rowCount !== 1) {
    throw new GithubOAuthPersistenceError();
  }
}

function validateCredential(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 1_024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new GithubOAuthPersistenceError();
  }
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return timingSafeEqual(leftBytes, rightBytes);
}
