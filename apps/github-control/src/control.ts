import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PgBossGithubCheckOutbox,
  claimGithubCheckSync,
  completeInactiveGithubCheckSync,
  completeSkippedGithubInvalidationSync,
  completeGithubCheckSync,
  expediteJob,
  expediteJobInPgTransaction,
  failGithubCheckSync,
  type DatabaseConnection,
  type JobPayload,
} from "@slopproof/db";
import {
  GithubControlError,
  OctokitCheckRunAdapter,
  OctokitPullRequestCommentAdapter,
  OctokitPullRequestPort,
  PostgresGithubCheckIntentWriter,
  PullRequestJobPayloadSchema,
  type GithubCheckRunPort,
  type GithubCheckPort,
  type GithubLifecycleAuthorizationFence,
  type GithubPullRequestHeadPort,
  type GithubPullRequestCommentPort,
  type GithubPullRequestPort,
  type PullRequestJobPayload,
  type RevisionPreparationPublisher,
  InactiveGithubInstallationError,
  processPullRequestJob,
  processVerifiedPullRequestSnapshot,
} from "@slopproof/github";
import type { PgBoss } from "pg-boss";
import type { PoolClient } from "pg";

export type GithubControlAdapter = "fake" | "octokit";

export type GithubControlDependencies = {
  database: DatabaseConnection;
  queue: PgBoss;
  appBaseUrl: string;
  adapter: GithubControlAdapter;
  pullRequests?: GithubPullRequestPort & GithubPullRequestHeadPort;
  checkRuns?: GithubCheckRunPort;
  pullRequestComments?: GithubPullRequestCommentPort;
  clock?: { now(): Date };
};

const PR_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function shouldExecuteGithubPullRequestDelivery(
  payload: PullRequestJobPayload,
  dependencies: GithubControlDependencies,
): Promise<boolean> {
  const canonicalPayload = PullRequestJobPayloadSchema.parse(payload);
  const client = await dependencies.database.pool.connect();
  try {
    await client.query("BEGIN");
    const delivery = await client.query<{
      processing_status: string;
      job_payload: unknown;
      retry_deferred: boolean;
    }>(
      `SELECT processing_status, job_payload,
              COALESCE(next_retry_at > now(), false) AS retry_deferred
         FROM webhook_deliveries
        WHERE delivery_id = $1
        FOR UPDATE`,
      [canonicalPayload.deliveryId],
    );
    const row = delivery.rows[0];
    if (!row) throw new GithubControlError("INVALID_RESPONSE");
    const persisted = PullRequestJobPayloadSchema.safeParse(row.job_payload);
    if (
      !persisted.success ||
      canonicalJson(persisted.data) !== canonicalJson(canonicalPayload)
    ) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    const shouldExecute =
      row.processing_status === "queued" && !row.retry_deferred;
    await client.query("COMMIT");
    return shouldExecute;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function sweepDueGithubPullRequestDeliveries(
  dependencies: GithubControlDependencies,
  rawInput: { limit?: number } = {},
): Promise<{ examined: number; published: number }> {
  const limit = Math.max(1, Math.min(rawInput.limit ?? 25, 100));
  const client = await dependencies.database.pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{
      delivery_id: string;
      job_payload: unknown;
    }>(
      `SELECT delivery_id, job_payload
         FROM webhook_deliveries
        WHERE event_name = 'pull_request'
          AND processing_status = 'queued'
          AND job_payload IS NOT NULL
          AND (
            (next_retry_at IS NOT NULL AND next_retry_at <= now())
            OR (next_retry_at IS NULL
                AND queued_at < now() - interval '2 minutes')
          )
        ORDER BY COALESCE(next_retry_at, queued_at), delivery_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let published = 0;
    for (const row of due.rows) {
      const payload = PullRequestJobPayloadSchema.parse(row.job_payload);
      if (payload.deliveryId !== row.delivery_id) {
        throw new GithubControlError("INVALID_RESPONSE");
      }
      const jobId = await expediteJobInPgTransaction(
        dependencies.queue,
        client,
        "github.ingest-pr",
        payload,
      );
      await client.query(
        `UPDATE webhook_deliveries
            SET queued_at = now(), next_retry_at = NULL
          WHERE delivery_id = $1 AND processing_status = 'queued'`,
        [row.delivery_id],
      );
      if (jobId !== null) published += 1;
    }
    await client.query("COMMIT");
    return { examined: due.rowCount ?? due.rows.length, published };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function scheduleGithubPullRequestRetry(
  payload: PullRequestJobPayload,
  error: unknown,
  dependencies: GithubControlDependencies,
): Promise<boolean> {
  const classified = classifyControlFailure(error);
  if (!classified.retryable) return false;
  const client = await dependencies.database.pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      retry_attempts: number;
      processing_status: string;
      job_payload: unknown;
    }>(
      `SELECT retry_attempts, processing_status, job_payload
         FROM webhook_deliveries
        WHERE delivery_id = $1
        FOR UPDATE`,
      [payload.deliveryId],
    );
    const row = locked.rows[0];
    if (!row || row.processing_status !== "queued") {
      await client.query("ROLLBACK");
      return row?.processing_status === "processed";
    }
    const persistedPayload = PullRequestJobPayloadSchema.safeParse(
      row.job_payload,
    );
    if (
      !persistedPayload.success ||
      canonicalJson(persistedPayload.data) !== canonicalJson(payload)
    ) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    const nextAttempt = row.retry_attempts + 1;
    const exponentialDelay = Math.min(
      2_000 * 2 ** Math.min(Math.max(nextAttempt - 1, 0), 16),
      PR_RETRY_MAX_DELAY_MS,
    );
    const delayMs = Math.max(
      1_000,
      Math.min(
        classified.retryAfterMs ?? exponentialDelay,
        classified.retryAfterMs === undefined
          ? PR_RETRY_MAX_DELAY_MS
          : 7 * 24 * 60 * 60 * 1_000,
      ),
    );
    const updated = await client.query(
      `UPDATE webhook_deliveries
          SET retry_attempts = $2,
              next_retry_at = now() + ($3::bigint * interval '1 millisecond'),
              queued_at = now()
        WHERE delivery_id = $1 AND processing_status = 'queued'`,
      [payload.deliveryId, nextAttempt, delayMs],
    );
    if (updated.rowCount !== 1) {
      throw new GithubControlError("UNAVAILABLE");
    }
    await client.query("COMMIT");
    return true;
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

async function completeGithubPullRequestPermanentFailure(
  payload: PullRequestJobPayload,
  error: unknown,
  dependencies: GithubControlDependencies,
): Promise<void> {
  const classified = classifyControlFailure(error);
  const client = await dependencies.database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE webhook_deliveries
          SET processing_status = 'permanent_failure',
              queued_at = NULL, next_retry_at = NULL, processed_at = now()
        WHERE delivery_id = $1 AND processing_status = 'queued'`,
      [payload.deliveryId],
    );
    await client.query(
      `INSERT INTO audit_events
         (actor_id, action, object_type, object_id, metadata)
       SELECT 'github-control', 'github.webhook.permanent_failure',
              'webhook_delivery', $1,
              jsonb_build_object('errorClass', $2::text)
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_events
           WHERE action = 'github.webhook.permanent_failure'
             AND object_type = 'webhook_delivery' AND object_id = $1
        )`,
      [payload.deliveryId, classified.errorClass],
    );
    await client.query("COMMIT");
  } catch (caught) {
    await client.query("ROLLBACK");
    throw caught;
  } finally {
    client.release();
  }
}

async function handleGithubPullRequestFailure(
  payload: PullRequestJobPayload,
  error: unknown,
  dependencies: GithubControlDependencies,
): Promise<void> {
  if (await scheduleGithubPullRequestRetry(payload, error, dependencies)) {
    return;
  }
  await completeGithubPullRequestPermanentFailure(payload, error, dependencies);
}

export async function handleGithubPullRequestJob(
  payload: PullRequestJobPayload,
  dependencies: GithubControlDependencies,
): Promise<void> {
  try {
    if (
      !(await shouldExecuteGithubPullRequestDelivery(payload, dependencies))
    ) {
      return;
    }
  } catch (error) {
    await handleGithubPullRequestFailure(payload, error, dependencies);
    return;
  }
  const checkIntents = new PostgresGithubCheckIntentWriter(
    new PgBossGithubCheckOutbox(dependencies.queue),
    dependencies.appBaseUrl,
    dependencies.adapter === "octokit",
  );
  let canonicalPayload = payload;
  let revisionSource:
    | {
        source: Awaited<ReturnType<GithubPullRequestPort["load"]>>;
        fetchedAt: Date;
        authorizationFence: GithubLifecycleAuthorizationFence;
      }
    | undefined;

  if (dependencies.adapter === "octokit") {
    if (!dependencies.pullRequests) {
      throw new GithubControlError("INVALID_INPUT");
    }
    let authorizationFence: GithubLifecycleAuthorizationFence | undefined;
    try {
      const readInput = {
        installationId: payload.installation.githubInstallationId,
        repositoryId: payload.repository.githubRepositoryId,
        owner: payload.repository.owner,
        repositoryName: payload.repository.name,
        pullNumber: payload.pullRequest.number,
        expectedHeadSha: payload.pullRequest.headSha,
        expectedBaseSha: payload.pullRequest.baseSha,
      };
      authorizationFence = await loadLifecycleAuthorizationFence(
        dependencies.database,
        payload,
      );
      if (!canAuthorizeGithubInstallationWork(authorizationFence)) {
        await acknowledgeInactiveGithubInstallationDelivery(
          payload,
          dependencies,
        );
        return;
      }
      const source = authorizationFence.freshAuthorization
        ? await dependencies.pullRequests.loadFresh?.(readInput)
        : await dependencies.pullRequests.load(readInput);
      if (!source) throw new GithubControlError("INVALID_INPUT");
      if (
        source.githubPullRequestId !==
          payload.pullRequest.githubPullRequestId ||
        source.number !== payload.pullRequest.number ||
        source.authorId !== payload.pullRequest.authorId
      ) {
        throw new GithubControlError("STALE_HEAD");
      }
      canonicalPayload = {
        ...payload,
        action:
          source.state === "closed"
            ? "closed"
            : payload.action === "closed"
              ? "synchronize"
              : payload.action,
        pullRequest: {
          githubPullRequestId: source.githubPullRequestId,
          number: source.number,
          state: source.state,
          authorId: source.authorId,
          headSha: source.headSha,
          baseSha: source.baseSha,
        },
      };
      revisionSource = {
        source,
        fetchedAt: dependencies.clock?.now() ?? new Date(),
        authorizationFence,
      };
    } catch (error) {
      if (error instanceof GithubControlError && error.code === "STALE_HEAD") {
        try {
          authorizationFence = await loadLifecycleAuthorizationFence(
            dependencies.database,
            payload,
          );
          if (!canAuthorizeGithubInstallationWork(authorizationFence)) {
            await acknowledgeInactiveGithubInstallationDelivery(
              payload,
              dependencies,
            );
            return;
          }
          const currentInput = {
            installationId: payload.installation.githubInstallationId,
            repositoryId: payload.repository.githubRepositoryId,
            owner: payload.repository.owner,
            repositoryName: payload.repository.name,
            pullNumber: payload.pullRequest.number,
          };
          const current = authorizationFence.freshAuthorization
            ? await dependencies.pullRequests.getCurrentHeadFresh?.(
                currentInput,
              )
            : await dependencies.pullRequests.getCurrentHead(currentInput);
          if (!current) throw new GithubControlError("INVALID_INPUT");
          const refreshInput = {
            installationId: payload.installation.githubInstallationId,
            repositoryId: payload.repository.githubRepositoryId,
            owner: payload.repository.owner,
            repositoryName: payload.repository.name,
            pullNumber: payload.pullRequest.number,
            expectedHeadSha: current.headSha,
            expectedBaseSha: current.baseSha,
          };
          const source = authorizationFence.freshAuthorization
            ? await dependencies.pullRequests.loadFresh?.(refreshInput)
            : await dependencies.pullRequests.load(refreshInput);
          if (!source) throw new GithubControlError("INVALID_INPUT");
          if (
            source.githubPullRequestId !==
              payload.pullRequest.githubPullRequestId ||
            source.number !== payload.pullRequest.number ||
            source.authorId !== payload.pullRequest.authorId
          ) {
            throw new GithubControlError("INVALID_RESPONSE");
          }
          canonicalPayload = {
            ...payload,
            action: source.state === "closed" ? "closed" : "synchronize",
            pullRequest: {
              githubPullRequestId: source.githubPullRequestId,
              number: source.number,
              state: source.state,
              authorId: source.authorId,
              headSha: source.headSha,
              baseSha: source.baseSha,
            },
          };
          revisionSource = {
            source,
            fetchedAt: dependencies.clock?.now() ?? new Date(),
            authorizationFence,
          };
        } catch (refreshError) {
          await handleGithubPullRequestFailure(
            payload,
            refreshError,
            dependencies,
          );
          return;
        }
      } else {
        await handleGithubPullRequestFailure(payload, error, dependencies);
        return;
      }
    }
  }

  try {
    await processPullRequestJob(
      dependencies.database.pool,
      checkIntents,
      canonicalPayload,
      createControlWriters(dependencies, dependencies.adapter === "octokit")
        .publisher,
      revisionSource,
    );
  } catch (error) {
    if (error instanceof InactiveGithubInstallationError) {
      await acknowledgeInactiveGithubInstallationDelivery(payload, dependencies);
      return;
    }
    await handleGithubPullRequestFailure(payload, error, dependencies);
  }
}

function canAuthorizeGithubInstallationWork(
  fence: GithubLifecycleAuthorizationFence,
): boolean {
  const status = fence.installation?.status;
  return status === "active" || status === "suspended";
}

async function acknowledgeInactiveGithubInstallationDelivery(
  payload: PullRequestJobPayload,
  dependencies: GithubControlDependencies,
): Promise<void> {
  const client = await dependencies.database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE webhook_deliveries
          SET processing_status = 'processed', processed_at = now(),
              queued_at = NULL, next_retry_at = NULL
        WHERE delivery_id = $1
          AND processing_status IN ('reserved', 'queued')`,
      [payload.deliveryId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadLifecycleAuthorizationFence(
  database: DatabaseConnection,
  payload: PullRequestJobPayload,
): Promise<GithubLifecycleAuthorizationFence> {
  const installation = await database.pool.query<{
    github_installation_id: string;
    status: "active" | "pending" | "suspended" | "removed";
    version: string;
  }>(
    `SELECT github_installation_id, status, updated_at::text AS version
       FROM installations
      WHERE github_installation_id = $1`,
    [payload.installation.githubInstallationId],
  );
  const repository = await database.pool.query<{
    github_repository_id: string;
    github_installation_id: string;
    status: "active" | "suspended" | "removed";
    owner: string;
    name: string;
    version: string;
  }>(
    `SELECT repository.github_repository_id,
            installation.github_installation_id,
            repository.status, repository.owner, repository.name,
            repository.updated_at::text AS version
       FROM repositories repository
       JOIN installations installation
         ON installation.id = repository.installation_id
      WHERE repository.github_repository_id = $1`,
    [payload.repository.githubRepositoryId],
  );
  const installationRow = installation.rows[0];
  const repositoryRow = repository.rows[0];
  return {
    freshAuthorization:
      !installationRow ||
      installationRow.status !== "active" ||
      !repositoryRow ||
      repositoryRow.status !== "active" ||
      repositoryRow.github_installation_id !==
        payload.installation.githubInstallationId ||
      repositoryRow.owner.toLowerCase() !==
        payload.repository.owner.toLowerCase() ||
      repositoryRow.name.toLowerCase() !==
        payload.repository.name.toLowerCase(),
    installation: installationRow
      ? {
          githubInstallationId: installationRow.github_installation_id,
          status: installationRow.status,
          version: installationRow.version,
        }
      : null,
    repository: repositoryRow
      ? {
          githubRepositoryId: repositoryRow.github_repository_id,
          githubInstallationId: repositoryRow.github_installation_id,
          status: repositoryRow.status,
          owner: repositoryRow.owner,
          name: repositoryRow.name,
          version: repositoryRow.version,
        }
      : null,
  };
}

type GithubRefreshPullRequestJob = Extract<
  JobPayload<"github.ingest-pr">,
  { eventName: "pull_request_refresh" }
>;

export async function handleGithubRefreshPullRequestJob(
  payload: GithubRefreshPullRequestJob,
  dependencies: GithubControlDependencies,
): Promise<void> {
  let binding: RefreshBinding | null = null;
  try {
    if (dependencies.adapter !== "octokit" || !dependencies.pullRequests) {
      return;
    }
    binding = await loadRefreshBinding(dependencies.database, payload);
    if (!binding) return;
    const headInput = {
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      owner: binding.owner,
      repositoryName: binding.repositoryName,
      pullNumber: binding.pullNumber,
    };
    const current = binding.authorizationFence.freshAuthorization
      ? await dependencies.pullRequests.getCurrentHeadFresh?.(headInput)
      : await dependencies.pullRequests.getCurrentHead(headInput);
    if (!current) throw new GithubControlError("INVALID_INPUT");
    const sourceInput = {
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      owner: binding.owner,
      repositoryName: binding.repositoryName,
      pullNumber: binding.pullNumber,
      expectedHeadSha: current.headSha,
      expectedBaseSha: current.baseSha,
    };
    const source = binding.authorizationFence.freshAuthorization
      ? await dependencies.pullRequests.loadFresh?.(sourceInput)
      : await dependencies.pullRequests.load(sourceInput);
    if (!source) throw new GithubControlError("INVALID_INPUT");
    if (
      source.githubPullRequestId !== binding.githubPullRequestId ||
      source.number !== binding.pullNumber ||
      source.authorId !== binding.authorId ||
      source.state !== current.state
    ) {
      throw new GithubControlError("STALE_HEAD");
    }
    if (!binding.defaultBranch) {
      throw new GithubControlError("INVALID_RESPONSE");
    }
    const writers = createControlWriters(dependencies, true);
    await processVerifiedPullRequestSnapshot(
      dependencies.database.pool,
      writers.checkIntents,
      {
        schemaVersion: "1",
        idempotencyKey: payload.idempotencyKey,
        action: source.state === "closed" ? "closed" : "synchronize",
        installation: {
          githubInstallationId: binding.installationId,
          accountId: binding.installationAccountId,
          accountLogin: binding.installationAccountLogin,
        },
        repository: {
          githubRepositoryId: binding.repositoryId,
          owner: binding.owner,
          name: binding.repositoryName,
          defaultBranch: binding.defaultBranch,
        },
        pullRequest: {
          githubPullRequestId: source.githubPullRequestId,
          number: source.number,
          state: source.state,
          authorId: source.authorId,
          headSha: source.headSha,
          baseSha: source.baseSha,
        },
      },
      writers.publisher,
      {
        source,
        fetchedAt: dependencies.clock?.now() ?? new Date(),
        authorizationFence: binding.authorizationFence,
      },
    );
  } catch (error) {
    if (!binding) return;
    const classified = classifyControlFailure(error);
    const recoveryForbidden =
      error instanceof GithubControlError &&
      error.code === "REJECTED" &&
      error.status === 403;
    if (binding.authorizationFence.freshAuthorization && recoveryForbidden) {
      await resolveForbiddenGithubRecoveryCandidate(
        dependencies.database,
        binding.githubPullRequestId,
        binding.installationId,
      );
      return;
    }
    if (
      binding.authorizationFence.freshAuthorization &&
      !classified.retryable
    ) {
      await discardGithubRecoveryCandidate(
        dependencies.database,
        binding.githubPullRequestId,
        binding.installationId,
      );
      return;
    }
    const delayMs = classified.retryable
      ? Math.max(
          1_000,
          Math.min(
            classified.retryAfterMs ?? 2_000,
            classified.retryAfterMs === undefined
              ? PR_RETRY_MAX_DELAY_MS
              : 7 * 24 * 60 * 60 * 1_000,
          ),
        )
      : 2 * 60 * 1_000;
    await dependencies.database.pool.query(
      `UPDATE pull_requests
          SET next_github_refresh_at =
                now() + ($2::bigint * interval '1 millisecond'),
              updated_at = now()
        WHERE github_pull_request_id = $1 AND state = 'open'`,
      [binding.githubPullRequestId, delayMs],
    );
  }
}

async function resolveForbiddenGithubRecoveryCandidate(
  database: DatabaseConnection,
  githubPullRequestId: string,
  githubInstallationId: string,
): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{
      pull_request_id: string;
      repository_status: "active" | "suspended" | "removed";
      installation_status: "active" | "suspended" | "removed" | null;
      refresh_due: boolean;
    }>(
      `SELECT pull_request.id AS pull_request_id,
              repository.status AS repository_status,
              target_installation.status AS installation_status,
              pull_request.next_github_refresh_at IS NOT NULL AS refresh_due
         FROM pull_requests pull_request
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
         JOIN github_recovery_candidates candidate
           ON candidate.pull_request_id = pull_request.id
          AND candidate.github_installation_id = $2
         LEFT JOIN installations target_installation
           ON target_installation.github_installation_id = $2
        WHERE pull_request.github_pull_request_id = $1
          AND pull_request.github_recovery_binding->>'installationId' = $2
        FOR UPDATE OF pull_request`,
      [githubPullRequestId, githubInstallationId],
    );
    const state = current.rows[0];
    if (!state) {
      await client.query("ROLLBACK");
      return;
    }
    if (
      state.repository_status === "removed" ||
      state.installation_status === "removed" ||
      state.installation_status === null
    ) {
      await discardGithubRecoveryCandidateInTransaction(
        client,
        state.pull_request_id,
        githubInstallationId,
      );
    } else if (
      state.repository_status === "suspended" ||
      state.installation_status === "suspended"
    ) {
      if (!state.refresh_due) {
        // The lifecycle event already parked this exact candidate. Keep it
        // for a later unsuspend wake-up; an older job cannot delete it.
        await client.query(
          `UPDATE pull_requests
              SET updated_at = now()
            WHERE id = $1
              AND github_recovery_binding->>'installationId' = $2
              AND next_github_refresh_at IS NULL`,
          [state.pull_request_id, githubInstallationId],
        );
      }
      // A non-NULL deadline is a later unsuspend/re-add wake-up. Do not let
      // the older 403 overwrite it; the durable sweeper stays authoritative.
    } else {
      // The candidate and its binding are currently active. A definitive 403
      // is therefore terminal for this candidate and promotes the fallback.
      await discardGithubRecoveryCandidateInTransaction(
        client,
        state.pull_request_id,
        githubInstallationId,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function discardGithubRecoveryCandidate(
  database: DatabaseConnection,
  githubPullRequestId: string,
  githubInstallationId: string,
): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const pullRequest = await client.query<{ id: string }>(
      `SELECT id FROM pull_requests
        WHERE github_pull_request_id = $1
        FOR UPDATE`,
      [githubPullRequestId],
    );
    const pullRequestId = pullRequest.rows[0]?.id;
    if (!pullRequestId) {
      await client.query("ROLLBACK");
      return;
    }
    await discardGithubRecoveryCandidateInTransaction(
      client,
      pullRequestId,
      githubInstallationId,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function discardGithubRecoveryCandidateInTransaction(
  client: PoolClient,
  pullRequestId: string,
  githubInstallationId: string,
): Promise<void> {
  await client.query(
    `DELETE FROM github_recovery_candidates
      WHERE pull_request_id = $1 AND github_installation_id = $2`,
    [pullRequestId, githubInstallationId],
  );
  await client.query(
    `UPDATE pull_requests pull_request
        SET github_recovery_binding = (
              SELECT jsonb_build_object(
                       'installationId', candidate.github_installation_id,
                       'accountId', candidate.account_id,
                       'accountLogin', candidate.account_login,
                       'owner', candidate.owner,
                       'repositoryName', candidate.repository_name
                     )
                FROM github_recovery_candidates candidate
               WHERE candidate.pull_request_id = pull_request.id
               ORDER BY candidate.created_at,
                        candidate.github_installation_id
               LIMIT 1
            ),
            next_github_refresh_at = CASE WHEN EXISTS (
              SELECT 1 FROM github_recovery_candidates candidate
               WHERE candidate.pull_request_id = pull_request.id
            ) THEN now() ELSE NULL END,
            updated_at = now()
      WHERE pull_request.id = $1
        AND pull_request.github_recovery_binding->>'installationId' = $2`,
    [pullRequestId, githubInstallationId],
  );
}

export async function sweepDueGithubPullRequestRefreshes(
  dependencies: GithubControlDependencies,
  rawInput: { limit?: number } = {},
): Promise<{ examined: number; published: number }> {
  if (dependencies.adapter !== "octokit") {
    return { examined: 0, published: 0 };
  }
  const limit = Math.max(1, Math.min(rawInput.limit ?? 25, 100));
  const client = await dependencies.database.pool.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{
      id: string;
      installation_id: string;
      repository_id: string;
      owner: string;
      name: string;
      number: number;
      head_sha: string;
      base_sha: string;
      github_recovery_binding: unknown;
    }>(
      `SELECT pull_request.id,
              installation.github_installation_id AS installation_id,
              repository.github_repository_id AS repository_id,
              repository.owner, repository.name, pull_request.number,
              revision.head_sha, revision.base_sha,
              pull_request.github_recovery_binding
         FROM pull_requests pull_request
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
         JOIN pull_request_revisions revision
           ON revision.pull_request_id = pull_request.id
          AND revision.is_current = true
        WHERE pull_request.state = 'open'
          AND pull_request.next_github_refresh_at IS NOT NULL
          AND pull_request.next_github_refresh_at <= now()
        ORDER BY pull_request.next_github_refresh_at, pull_request.id
        LIMIT $1
        FOR UPDATE OF pull_request SKIP LOCKED`,
      [limit],
    );
    let published = 0;
    for (const row of due.rows) {
      const recovery = parseGithubRecoveryBinding(row.github_recovery_binding);
      const jobId = await expediteJobInPgTransaction(
        dependencies.queue,
        client,
        "github.ingest-pr",
        {
          schemaVersion: "1",
          idempotencyKey: `github:scheduled-refresh:${row.id}:${row.head_sha}:${row.base_sha}`,
          eventName: "pull_request_refresh",
          installationId: recovery?.installationId ?? row.installation_id,
          repositoryId: row.repository_id,
          owner: recovery?.owner ?? row.owner,
          repositoryName: recovery?.repositoryName ?? row.name,
          pullNumber: row.number,
          expectedHeadSha: row.head_sha,
        },
      );
      await client.query(
        `UPDATE pull_requests
            SET next_github_refresh_at = now() + interval '2 minutes',
                updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      if (jobId !== null) published += 1;
    }
    await client.query("COMMIT");
    return { examined: due.rowCount ?? due.rows.length, published };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function handleGithubCheckReconcileJob(
  payload: JobPayload<"github.reconcile-check">,
  dependencies: GithubControlDependencies,
): Promise<void> {
  const claimed = await claimGithubCheckSync(dependencies.database.pool, {
    revisionId: payload.revisionId,
    expectedHeadSha: payload.expectedHeadSha,
    reason: payload.reason,
  });
  if (!claimed) return;

  if (payload.reason === "revision_invalidated") {
    try {
      let synchronizedRemoteId: string | null = null;
      if (dependencies.adapter === "octokit" && dependencies.checkRuns) {
        const loadedTarget = await loadCheckTarget(
          dependencies.database,
          payload.revisionId,
          payload.expectedHeadSha,
          true,
        );
        if (loadedTarget.kind === "inactive") {
          const completed = await completeSkippedGithubInvalidationSync(
            dependencies.database.pool,
            { checkRunId: claimed.checkRunId, attempt: claimed.attempt },
          );
          if (!completed) throw new GithubControlError("UNAVAILABLE");
          return;
        }
        if (loadedTarget.kind === "stale") {
          throw new GithubControlError("STALE_HEAD");
        }
        const target = loadedTarget.target;
        const staleInput = {
          installationId: target.installationId,
          repositoryId: target.repositoryId,
          owner: target.owner,
          repositoryName: target.repositoryName,
          pullNumber: target.pullNumber,
          revisionId: target.revisionId,
          headSha: target.headSha,
          baseSha: target.baseSha,
          expectedPullRequestState: "open",
          status: "completed",
          conclusion: "cancelled",
          summary: claimed.publicSummary,
          detailsUrl: claimed.detailsUrl,
        } as const;
        const remoteReference = claimed.githubCheckRunId
          ? { checkRunId: claimed.githubCheckRunId }
          : await dependencies.checkRuns.findExisting(staleInput);
        if (remoteReference) {
          synchronizedRemoteId = (
            await dependencies.checkRuns.invalidateStale({
              ...staleInput,
              checkRunId: remoteReference.checkRunId,
            })
          ).checkRunId;
        }
      }
      const completed = synchronizedRemoteId
        ? await completeGithubCheckSync(dependencies.database.pool, {
            checkRunId: claimed.checkRunId,
            attempt: claimed.attempt,
            githubCheckRunId: synchronizedRemoteId,
          })
        : await completeSkippedGithubInvalidationSync(
            dependencies.database.pool,
            {
              checkRunId: claimed.checkRunId,
              attempt: claimed.attempt,
            },
          );
      if (!completed) throw new GithubControlError("UNAVAILABLE");
      return;
    } catch (error) {
      const classified = classifyControlFailure(error);
      const nextSyncAfter = getDurableRetryTime(
        classified,
        claimed.attempt,
        dependencies,
      );
      await failGithubCheckSync(dependencies.database.pool, {
        checkRunId: claimed.checkRunId,
        attempt: claimed.attempt,
        errorClass: classified.errorClass,
        retryable: classified.retryable,
        ...(nextSyncAfter ? { nextSyncAfter } : {}),
      });
      return;
    }
  }

  try {
    const loadedTarget = await loadCheckTarget(
      dependencies.database,
      payload.revisionId,
      payload.expectedHeadSha,
    );
    if (loadedTarget.kind === "inactive") {
      const completed = await completeInactiveGithubCheckSync(
        dependencies.database.pool,
        { checkRunId: claimed.checkRunId, attempt: claimed.attempt },
      );
      if (!completed) {
        await failGithubCheckSync(dependencies.database.pool, {
          checkRunId: claimed.checkRunId,
          attempt: claimed.attempt,
          errorClass: "LifecycleChanged",
          retryable: true,
          nextSyncAfter: new Date(
            (dependencies.clock?.now() ?? new Date()).getTime() + 1_000,
          ),
        });
      }
      return;
    }
    if (loadedTarget.kind === "stale") {
      throw new GithubControlError("STALE_HEAD");
    }
    const target = loadedTarget.target;

    const closedWebhookIntent =
      claimed.intentReason === "webhook_ingested" &&
      claimed.status === "completed" &&
      claimed.conclusion === "cancelled";
    const reconciledTarget = await reconcileCheckTarget(
      target,
      dependencies,
      closedWebhookIntent ? "closed" : "open",
    );
    if (!reconciledTarget) return;

    const githubCheckRunId =
      dependencies.adapter === "fake"
        ? deterministicFakeCheckRunId(claimed.checkRunId)
        : await synchronizeRemoteCheck(claimed, reconciledTarget, dependencies);
    if (dependencies.adapter === "octokit" && !closedWebhookIntent) {
      await synchronizePullRequestComment(
        claimed,
        reconciledTarget,
        dependencies,
      );
    }

    const completed = await completeGithubCheckSync(
      dependencies.database.pool,
      {
        checkRunId: claimed.checkRunId,
        attempt: claimed.attempt,
        githubCheckRunId,
      },
    );
    if (!completed) throw new GithubControlError("UNAVAILABLE");
  } catch (error) {
    const classified = classifyControlFailure(error);
    const nextSyncAfter = getDurableRetryTime(
      classified,
      claimed.attempt,
      dependencies,
    );
    await failGithubCheckSync(dependencies.database.pool, {
      checkRunId: claimed.checkRunId,
      attempt: claimed.attempt,
      errorClass: classified.errorClass,
      retryable: classified.retryable,
      ...(nextSyncAfter ? { nextSyncAfter } : {}),
    });
  }
}

type CheckTarget = {
  revisionId: string;
  installationId: string;
  repositoryId: string;
  owner: string;
  repositoryName: string;
  pullNumber: number;
  githubPullRequestId: string;
  authorId: string;
  headSha: string;
  baseSha: string;
  installationAccountId: string;
  installationAccountLogin: string;
  defaultBranch: string | null;
};

type RefreshBinding = CheckTarget & {
  authorizationFence: GithubLifecycleAuthorizationFence;
};

const GithubRecoveryBindingSchema = z
  .object({
    installationId: z.string().regex(/^[1-9][0-9]{0,15}$/),
    accountId: z.string().regex(/^[1-9][0-9]{0,15}$/),
    accountLogin: z.string().min(1).max(100),
    owner: z.string().min(1).max(100),
    repositoryName: z.string().min(1).max(100),
  })
  .strict();

function parseGithubRecoveryBinding(
  value: unknown,
): z.output<typeof GithubRecoveryBindingSchema> | undefined {
  const parsed = GithubRecoveryBindingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

type ClaimedCheck = NonNullable<
  Awaited<ReturnType<typeof claimGithubCheckSync>>
>;

async function synchronizeRemoteCheck(
  claimed: ClaimedCheck,
  target: CheckTarget,
  dependencies: GithubControlDependencies,
): Promise<string> {
  if (!dependencies.checkRuns) throw new GithubControlError("INVALID_INPUT");
  const input = {
    installationId: target.installationId,
    repositoryId: target.repositoryId,
    owner: target.owner,
    repositoryName: target.repositoryName,
    pullNumber: target.pullNumber,
    revisionId: target.revisionId,
    headSha: target.headSha,
    baseSha: target.baseSha,
    expectedPullRequestState:
      claimed.status === "completed" && claimed.conclusion === "cancelled"
        ? "closed"
        : "open",
    status: claimed.status,
    conclusion: claimed.conclusion,
    summary: claimed.publicSummary,
    detailsUrl: claimed.detailsUrl,
  } as const;
  try {
    const result = claimed.githubCheckRunId
      ? await dependencies.checkRuns.update({
          ...input,
          checkRunId: claimed.githubCheckRunId,
        })
      : await dependencies.checkRuns.create(input);
    return result.checkRunId;
  } catch (error) {
    if (error instanceof GithubControlError && error.code === "STALE_HEAD") {
      await schedulePullRequestRefresh(target, dependencies);
      throw new GithubControlError("STALE_HEAD", { retryAfterMs: 15_000 });
    }
    throw error;
  }
}

async function synchronizePullRequestComment(
  claimed: ClaimedCheck,
  target: CheckTarget,
  dependencies: GithubControlDependencies,
): Promise<void> {
  if (!dependencies.pullRequestComments) {
    throw new GithubControlError("INVALID_INPUT");
  }
  try {
    await dependencies.pullRequestComments.upsert({
      installationId: target.installationId,
      repositoryId: target.repositoryId,
      owner: target.owner,
      repositoryName: target.repositoryName,
      pullNumber: target.pullNumber,
      revisionId: target.revisionId,
      headSha: target.headSha,
      baseSha: target.baseSha,
      expectedPullRequestState: "open",
      detailsUrl: claimed.detailsUrl,
    });
  } catch (error) {
    if (error instanceof GithubControlError && error.code === "STALE_HEAD") {
      await schedulePullRequestRefresh(target, dependencies);
      throw new GithubControlError("STALE_HEAD", { retryAfterMs: 15_000 });
    }
    throw error;
  }
}

/**
 * Re-reads the authoritative GitHub PR immediately before a Check write. A
 * target-branch move keeps the head SHA but creates a different immutable
 * revision tuple, so route it through the same transactional ingest path.
 */
async function reconcileCheckTarget(
  target: CheckTarget,
  dependencies: GithubControlDependencies,
  expectedState: "open" | "closed" = "open",
): Promise<CheckTarget | null> {
  if (dependencies.adapter !== "octokit") return target;
  if (!dependencies.pullRequests) {
    throw new GithubControlError("INVALID_INPUT");
  }
  let source: Awaited<ReturnType<GithubPullRequestPort["load"]>>;
  try {
    source = await dependencies.pullRequests.load({
      installationId: target.installationId,
      repositoryId: target.repositoryId,
      owner: target.owner,
      repositoryName: target.repositoryName,
      pullNumber: target.pullNumber,
      expectedHeadSha: target.headSha,
      expectedBaseSha: target.baseSha,
    });
  } catch (error) {
    if (!(error instanceof GithubControlError) || error.code !== "STALE_HEAD") {
      throw error;
    }
    await schedulePullRequestRefresh(target, dependencies);
    throw new GithubControlError("STALE_HEAD", { retryAfterMs: 15_000 });
  }
  if (
    source.githubPullRequestId !== target.githubPullRequestId ||
    source.number !== target.pullNumber ||
    source.authorId !== target.authorId ||
    source.headSha !== target.headSha
  ) {
    throw new GithubControlError("STALE_HEAD");
  }
  if (source.baseSha === target.baseSha && source.state === expectedState) {
    return target;
  }
  await schedulePullRequestRefresh(target, dependencies);
  throw new GithubControlError("STALE_HEAD", { retryAfterMs: 15_000 });
}

async function schedulePullRequestRefresh(
  target: CheckTarget,
  dependencies: GithubControlDependencies,
): Promise<void> {
  await expediteJob(dependencies.queue, "github.ingest-pr", {
    schemaVersion: "1",
    idempotencyKey: `github:refresh:${target.repositoryId}:${target.pullNumber}:${target.headSha}:${target.baseSha}`,
    eventName: "pull_request_refresh",
    installationId: target.installationId,
    repositoryId: target.repositoryId,
    owner: target.owner,
    repositoryName: target.repositoryName,
    pullNumber: target.pullNumber,
    expectedHeadSha: target.headSha,
  });
}

function createControlWriters(
  dependencies: GithubControlDependencies,
  requiresVerifiedRevisionSource: boolean,
): {
  checkIntents: GithubCheckPort;
  publisher: RevisionPreparationPublisher;
} {
  return {
    checkIntents: new PostgresGithubCheckIntentWriter(
      new PgBossGithubCheckOutbox(dependencies.queue),
      dependencies.appBaseUrl,
      requiresVerifiedRevisionSource,
    ),
    publisher: {
      publish: (client, job) =>
        expediteJobInPgTransaction(
          dependencies.queue,
          client,
          "analysis.prepare-revision",
          job,
        ),
      publishAttemptExpiry: (client, job) =>
        expediteJobInPgTransaction(
          dependencies.queue,
          client,
          "proof.expire-attempt",
          job,
        ),
    },
  };
}

async function loadRefreshBinding(
  database: DatabaseConnection,
  payload: GithubRefreshPullRequestJob,
): Promise<RefreshBinding | null> {
  const result = await database.pool.query<{
    revision_id: string;
    head_sha: string;
    base_sha: string;
    number: number;
    github_pull_request_id: string;
    author_id: string;
    github_repository_id: string;
    owner: string;
    name: string;
    default_branch: string | null;
    bound_installation_id: string;
    bound_account_id: string;
    bound_account_login: string;
    target_installation_id: string | null;
    target_account_id: string | null;
    target_account_login: string | null;
    repository_status: "active" | "suspended" | "removed";
    bound_installation_status: "active" | "suspended" | "removed";
    target_installation_status: "active" | "suspended" | "removed" | null;
    repository_version: string;
    target_installation_version: string | null;
    github_recovery_binding: unknown;
  }>(
    `SELECT revision.id AS revision_id, revision.head_sha, revision.base_sha,
            pull_request.number, pull_request.github_pull_request_id,
            pull_request.author_id, repository.github_repository_id,
            repository.owner, repository.name, repository.default_branch,
            bound_installation.github_installation_id AS bound_installation_id,
            bound_installation.account_id AS bound_account_id,
            bound_installation.account_login AS bound_account_login,
            target_installation.github_installation_id AS target_installation_id,
            target_installation.account_id AS target_account_id,
            target_installation.account_login AS target_account_login,
            repository.status AS repository_status,
            bound_installation.status AS bound_installation_status,
            target_installation.status AS target_installation_status,
            repository.updated_at::text AS repository_version,
            target_installation.updated_at::text AS target_installation_version,
            pull_request.github_recovery_binding
       FROM repositories repository
       JOIN installations bound_installation
         ON bound_installation.id = repository.installation_id
       LEFT JOIN installations target_installation
         ON target_installation.github_installation_id = $1
       JOIN pull_requests pull_request
         ON pull_request.repository_id = repository.id
       JOIN pull_request_revisions revision
         ON revision.pull_request_id = pull_request.id
        AND revision.is_current = true
      WHERE repository.github_repository_id = $2
        AND pull_request.number = $3`,
    [payload.installationId, payload.repositoryId, payload.pullNumber],
  );
  const row = result.rows[0];
  if (!row) return null;
  const recovery = parseGithubRecoveryBinding(row.github_recovery_binding);
  if (
    recovery &&
    (recovery.installationId !== payload.installationId ||
      recovery.owner !== payload.owner ||
      recovery.repositoryName !== payload.repositoryName)
  ) {
    return null;
  }
  if (
    !recovery &&
    (row.bound_installation_id !== payload.installationId ||
      row.owner !== payload.owner ||
      row.name !== payload.repositoryName)
  ) {
    return null;
  }
  if (
    recovery &&
    row.target_installation_id !== null &&
    (row.target_account_id !== recovery.accountId ||
      row.target_account_login !== recovery.accountLogin)
  ) {
    throw new GithubControlError("INVALID_RESPONSE");
  }
  const targetInstallationId =
    recovery?.installationId ?? row.bound_installation_id;
  const targetAccountId = recovery?.accountId ?? row.bound_account_id;
  const targetAccountLogin = recovery?.accountLogin ?? row.bound_account_login;
  const targetOwner = recovery?.owner ?? row.owner;
  const targetRepositoryName = recovery?.repositoryName ?? row.name;
  return {
    revisionId: row.revision_id,
    installationId: targetInstallationId,
    repositoryId: row.github_repository_id,
    owner: targetOwner,
    repositoryName: targetRepositoryName,
    pullNumber: row.number,
    githubPullRequestId: row.github_pull_request_id,
    authorId: row.author_id,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    installationAccountId: targetAccountId,
    installationAccountLogin: targetAccountLogin,
    defaultBranch: row.default_branch,
    authorizationFence: {
      freshAuthorization:
        recovery !== undefined ||
        row.repository_status !== "active" ||
        row.bound_installation_status !== "active",
      installation:
        row.target_installation_id === null ||
        row.target_installation_status === null ||
        row.target_installation_version === null
          ? null
          : {
              githubInstallationId: row.target_installation_id,
              status: row.target_installation_status,
              version: row.target_installation_version,
            },
      repository: {
        githubRepositoryId: row.github_repository_id,
        githubInstallationId: row.bound_installation_id,
        status: row.repository_status,
        owner: row.owner,
        name: row.name,
        version: row.repository_version,
      },
    },
  };
}

async function loadCheckTarget(
  database: DatabaseConnection,
  revisionId: string,
  expectedHeadSha: string,
  allowNoncurrent = false,
): Promise<
  | { kind: "active"; target: CheckTarget }
  | { kind: "inactive" }
  | { kind: "stale" }
> {
  const result = await database.pool.query<{
    revision_id: string;
    head_sha: string;
    base_sha: string;
    number: number;
    github_pull_request_id: string;
    author_id: string;
    github_repository_id: string;
    owner: string;
    name: string;
    default_branch: string | null;
    github_installation_id: string;
    account_id: string;
    account_login: string;
    repository_status: string;
    installation_status: string;
  }>(
    `SELECT revision.id AS revision_id, revision.head_sha, revision.base_sha,
            pull_request.number, pull_request.github_pull_request_id,
            pull_request.author_id, repository.github_repository_id,
            repository.owner, repository.name, repository.default_branch,
            installation.github_installation_id, installation.account_id,
            installation.account_login,
            repository.status AS repository_status,
            installation.status AS installation_status
       FROM pull_request_revisions revision
       JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
       JOIN repositories repository ON repository.id = pull_request.repository_id
       JOIN installations installation ON installation.id = repository.installation_id
      WHERE revision.id = $1 AND revision.head_sha = $2
        AND ($3::boolean = true OR revision.is_current = true)`,
    [revisionId, expectedHeadSha, allowNoncurrent],
  );
  const row = result.rows[0];
  if (!row) return { kind: "stale" };
  if (
    row.repository_status !== "active" ||
    row.installation_status !== "active"
  ) {
    return { kind: "inactive" };
  }
  return {
    kind: "active",
    target: {
      revisionId: row.revision_id,
      installationId: row.github_installation_id,
      repositoryId: row.github_repository_id,
      owner: row.owner,
      repositoryName: row.name,
      pullNumber: row.number,
      githubPullRequestId: row.github_pull_request_id,
      authorId: row.author_id,
      headSha: row.head_sha,
      baseSha: row.base_sha,
      installationAccountId: row.account_id,
      installationAccountLogin: row.account_login,
      defaultBranch: row.default_branch,
    },
  };
}

function deterministicFakeCheckRunId(checkRunId: string): string {
  const value = BigInt(
    `0x${createHash("sha256").update(checkRunId).digest("hex").slice(0, 13)}`,
  );
  return String((value % 9_000_000_000_000_000n) + 1n);
}

function classifyControlFailure(error: unknown): {
  code: GithubControlError["code"];
  errorClass: string;
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (!(error instanceof GithubControlError)) {
    return { code: "UNAVAILABLE", errorClass: "Unavailable", retryable: true };
  }
  const retryable =
    [
      "RATE_LIMITED",
      "TIMEOUT",
      "UNAVAILABLE",
      "AMBIGUOUS_WRITE",
      "STALE_HEAD",
    ].includes(error.code) ||
    (error.code === "REJECTED" && error.status === 401);
  return {
    code: error.code,
    errorClass: error.code
      .toLowerCase()
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(""),
    retryable,
    ...(error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

function getDurableRetryTime(
  classified: ReturnType<typeof classifyControlFailure>,
  attempt: number,
  dependencies: GithubControlDependencies,
): Date | undefined {
  if (!classified.retryable) return undefined;
  const exponentialDelayMs = Math.min(
    2_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 16),
    5 * 60 * 1_000,
  );
  const delayMs = classified.retryAfterMs ?? exponentialDelayMs;
  const maximumDelayMs =
    classified.retryAfterMs === undefined
      ? 5 * 60 * 1_000
      : 7 * 24 * 60 * 60 * 1_000;
  return new Date(
    (dependencies.clock?.now() ?? new Date()).getTime() +
      Math.max(1_000, Math.min(delayMs, maximumDelayMs)),
  );
}

export function createOctokitControlPorts(input: {
  tokenProvider: ConstructorParameters<typeof OctokitPullRequestPort>[0];
  appId: string;
}): {
  pullRequests: OctokitPullRequestPort;
  checkRuns: OctokitCheckRunAdapter;
  pullRequestComments: OctokitPullRequestCommentAdapter;
} {
  const pullRequests = new OctokitPullRequestPort(input.tokenProvider);
  return {
    pullRequests,
    checkRuns: new OctokitCheckRunAdapter(input.tokenProvider, pullRequests),
    pullRequestComments: new OctokitPullRequestCommentAdapter(
      input.tokenProvider,
      pullRequests,
      { appId: input.appId },
    ),
  };
}
