import type { Pool, PoolClient } from "pg";
import type { PullRequestJobPublisher } from "./queue";
import { PullRequestJobPayloadSchema } from "./schemas";
import {
  WebhookDeliveryConflictError,
  reserveWebhookDelivery,
} from "./service";
import { parseSupportedGithubWebhook } from "./webhook";

export type IngestWebhookResult = {
  accepted: true;
  duplicate: boolean;
  ignored: boolean;
  deliveryId: string;
};

/**
 * Verifies, reserves and publishes a webhook in one PostgreSQL transaction.
 * Installation lifecycle events are deliberately small DB-only operations;
 * pull requests are queued for the isolated GitHub control process.
 */
export async function ingestGithubWebhook(input: {
  pool: Pool;
  queue: PullRequestJobPublisher;
  secret: string;
  rawBody: Uint8Array;
  headers: unknown;
}): Promise<IngestWebhookResult> {
  const parsed = parseSupportedGithubWebhook(
    input.rawBody,
    input.headers,
    input.secret,
  );
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const reservation = await reserveWebhookDelivery(client, {
      deliveryId: parsed.deliveryId,
      eventName: parsed.eventName,
      payloadHash: parsed.payloadHash,
    });

    let ignored = parsed.kind === "ignored";
    if (reservation.shouldEnqueue) {
      switch (parsed.kind) {
        case "pull_request": {
          const payload = PullRequestJobPayloadSchema.parse({
            schemaVersion: "1",
            idempotencyKey: `github-delivery:${parsed.deliveryId}`,
            deliveryId: parsed.deliveryId,
            eventName: "pull_request",
            ...parsed.event,
          });
          if (
            !(await canEnqueueGithubPullRequest(
              client,
              payload.installation.githubInstallationId,
            ))
          ) {
            ignored = true;
            await setDeliveryStatus(client, parsed.deliveryId, "ignored");
            break;
          }
          await persistPullRequestDeliveryPayload(
            client,
            parsed.deliveryId,
            payload,
          );
          if (!reservation.duplicate || reservation.shouldEnqueue) {
            await input.queue.publishInTransaction(client, payload);
          }
          await setDeliveryStatus(client, parsed.deliveryId, "queued");
          break;
        }
        case "installation":
          await applyInstallationEvent(client, parsed.event);
          await setDeliveryStatus(client, parsed.deliveryId, "processed");
          break;
        case "installation_repositories":
          await applyInstallationRepositoriesEvent(client, parsed.event);
          await setDeliveryStatus(client, parsed.deliveryId, "processed");
          break;
        case "ignored":
          await setDeliveryStatus(client, parsed.deliveryId, "ignored");
          break;
      }
    }

    await client.query("COMMIT");
    return {
      accepted: true,
      duplicate: reservation.duplicate,
      ignored,
      deliveryId: parsed.deliveryId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistPullRequestDeliveryPayload(
  client: PoolClient,
  deliveryId: string,
  payload: unknown,
): Promise<void> {
  const canonical = PullRequestJobPayloadSchema.parse(payload);
  const encoded = JSON.stringify(canonical);
  if (Buffer.byteLength(encoded, "utf8") > 8_192) {
    throw new WebhookDeliveryConflictError(
      "Sanitized PR delivery is too large",
    );
  }
  const result = await client.query(
    `UPDATE webhook_deliveries
        SET job_payload = COALESCE(job_payload, $2::jsonb)
      WHERE delivery_id = $1
        AND (job_payload IS NULL OR job_payload = $2::jsonb)`,
    [deliveryId, encoded],
  );
  if (result.rowCount !== 1) {
    throw new WebhookDeliveryConflictError(
      "Delivery job payload does not match its reservation",
    );
  }
}

/** Backward-compatible name retained for the local fake golden path. */
export const ingestPullRequestWebhook = ingestGithubWebhook;

type InstallationBinding = {
  githubInstallationId: string;
  accountId: string;
  accountLogin: string;
  senderId?: string | undefined;
};

type InstallationTenantStatus = "active" | "pending";

type LifecycleRepository = {
  githubRepositoryId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
};

async function applyInstallationEvent(
  client: PoolClient,
  event: {
    action:
      | "created"
      | "deleted"
      | "new_permissions_accepted"
      | "suspend"
      | "unsuspend";
    installation: InstallationBinding;
    repositorySelection: "all" | "selected";
    repositories: LifecycleRepository[];
  },
): Promise<void> {
  if (
    ["deleted", "suspend", "unsuspend", "new_permissions_accepted"].includes(
      event.action,
    )
  ) {
    await lockGithubRecoveryCandidatePullRequests(
      client,
      event.installation.githubInstallationId,
    );
  }
  const tenantStatus =
    event.action === "suspend" || event.action === "deleted"
      ? "pending"
      : await resolveGithubAppTenantStatus(client, event.installation);
  const desiredStatus =
    event.action === "suspend"
      ? "suspended"
      : event.action === "deleted"
        ? "removed"
        : tenantStatus;
  const upserted = await upsertInstallation(
    client,
    event.installation,
    desiredStatus,
    {
      allowReactivation: false,
      allowPendingPromotion:
        desiredStatus === "active" && event.action !== "unsuspend",
    },
  );
  const existingInstallationId =
    upserted?.id ??
    (event.action === "unsuspend" || event.action === "new_permissions_accepted"
      ? await findInstallationId(client, event.installation)
      : null);
  if (!existingInstallationId) return;
  const installationStatus =
    upserted?.status ??
    (await loadInstallationStatus(client, existingInstallationId));

  if (event.action === "deleted") {
    await client.query(
      `UPDATE repositories
          SET status = 'removed', suspended_at = NULL,
              removed_at = COALESCE(removed_at, now()), updated_at = now()
        WHERE installation_id = $1 AND status <> 'removed'`,
      [existingInstallationId],
    );
    await revokeSessionsForInstallation(client, existingInstallationId);
    await setInstallationPullRequestRefresh(
      client,
      existingInstallationId,
      event.installation.githubInstallationId,
      false,
    );
    await removeGithubRecoveryCandidate(
      client,
      event.installation.githubInstallationId,
    );
    return;
  }

  if (event.action === "suspend") {
    await client.query(
      `UPDATE repositories
          SET status = 'suspended', suspended_at = COALESCE(suspended_at, now()),
              removed_at = NULL, updated_at = now()
        WHERE installation_id = $1 AND status = 'active'`,
      [existingInstallationId],
    );
    await revokeSessionsForInstallation(client, existingInstallationId);
    await setInstallationPullRequestRefresh(
      client,
      existingInstallationId,
      event.installation.githubInstallationId,
      false,
    );
    await setGithubRecoveryCandidateDue(
      client,
      event.installation.githubInstallationId,
      false,
    );
    return;
  }

  // GitHub may include publicly readable account repositories in the
  // installation payload even when the installation itself is restricted to
  // selected repositories. In that mode only installation_repositories
  // deliveries (and later repository-scoped fresh reads) may activate a row.
  // Pending installs must not activate repository rows.
  if (installationStatus === "active" && event.repositorySelection === "all") {
    for (const repository of event.repositories) {
      await upsertRepository(client, existingInstallationId, repository);
    }
  }
  if (
    event.action === "unsuspend" ||
    event.action === "new_permissions_accepted"
  ) {
    await setInstallationPullRequestRefresh(
      client,
      existingInstallationId,
      event.installation.githubInstallationId,
      true,
    );
    await setGithubRecoveryCandidateDue(
      client,
      event.installation.githubInstallationId,
      true,
    );
  }
}

async function applyInstallationRepositoriesEvent(
  client: PoolClient,
  event: {
    action: "added" | "removed";
    installation: InstallationBinding;
    repositoriesAdded: LifecycleRepository[];
    repositoriesRemoved: LifecycleRepository[];
  },
): Promise<void> {
  if (event.repositoriesRemoved.length > 0) {
    await removeGithubRecoveryCandidate(
      client,
      event.installation.githubInstallationId,
      event.repositoriesRemoved.map(
        (repository) => repository.githubRepositoryId,
      ),
    );
  }
  const addedTenantStatus =
    event.action === "added"
      ? await resolveGithubAppTenantStatus(client, event.installation)
      : "pending";
  const upserted =
    event.action === "removed"
      ? await ensureInstallationForRepositoryRemoval(client, event.installation)
      : await upsertInstallation(
          client,
          event.installation,
          addedTenantStatus,
          {
            allowReactivation: false,
            allowPendingPromotion: addedTenantStatus === "active",
          },
        );
  let installationId = upserted?.id ?? null;
  if (!installationId && event.action === "added") {
    installationId = await findInstallationId(client, event.installation);
  }
  if (!installationId) return;
  const installationStatus =
    upserted?.status ?? (await loadInstallationStatus(client, installationId));
  if (installationStatus === "active") {
    for (const repository of event.repositoriesAdded) {
      await upsertRepository(client, installationId, repository);
    }
    if (event.repositoriesAdded.length > 0) {
      await persistRepositoryRecoveryBindings(
        client,
        event.installation,
        event.repositoriesAdded,
      );
      await setRepositoryPullRequestRefresh(
        client,
        event.repositoriesAdded.map(
          (repository) => repository.githubRepositoryId,
        ),
        true,
      );
    }
  }
  const removedRepositoryIds: string[] = [];
  for (const repository of event.repositoriesRemoved) {
    const removed = await client.query<{ id: string }>(
      `INSERT INTO repositories
         (installation_id, github_repository_id, owner, name, default_branch,
          status, suspended_at, removed_at)
       VALUES ($1, $2, $3, $4, $5, 'removed', NULL, now())
       ON CONFLICT (github_repository_id) DO UPDATE SET
         owner = EXCLUDED.owner,
         name = EXCLUDED.name,
         default_branch = COALESCE(EXCLUDED.default_branch, repositories.default_branch),
         status = 'removed',
         suspended_at = NULL,
         removed_at = COALESCE(repositories.removed_at, EXCLUDED.removed_at),
         updated_at = now()
       WHERE repositories.installation_id = EXCLUDED.installation_id
       RETURNING id`,
      [
        installationId,
        repository.githubRepositoryId,
        repository.owner,
        repository.name,
        repository.defaultBranch,
      ],
    );
    // A repository already bound to another installation is deliberately not
    // rebound or tombstoned by an out-of-order lifecycle delivery.
    if (removed.rows[0]) removedRepositoryIds.push(removed.rows[0].id);
  }
  if (removedRepositoryIds.length > 0) {
    await revokeSessionsForRepositories(client, removedRepositoryIds);
    await client.query(
      `UPDATE pull_requests
          SET next_github_refresh_at = NULL, updated_at = now()
        WHERE repository_id = ANY($1::uuid[])
          AND (
            github_recovery_binding IS NULL
            OR github_recovery_binding->>'installationId' = $2
          )`,
      [removedRepositoryIds, event.installation.githubInstallationId],
    );
  }
}

async function persistRepositoryRecoveryBindings(
  client: PoolClient,
  installation: InstallationBinding,
  repositories: LifecycleRepository[],
): Promise<void> {
  for (const repository of repositories) {
    await client.query(
      `WITH eligible AS (
         SELECT pull_request.id
           FROM pull_requests pull_request
           JOIN repositories existing_repository
             ON existing_repository.id = pull_request.repository_id
           JOIN installations target_installation
             ON target_installation.github_installation_id = $2
            AND target_installation.status = 'active'
          WHERE existing_repository.github_repository_id = $1
            AND pull_request.state = 'open'
            AND existing_repository.installation_id <> target_installation.id
       ), candidate AS (
         INSERT INTO github_recovery_candidates
           (pull_request_id, github_installation_id, account_id, account_login,
            owner, repository_name)
         SELECT id, $2, $3, $4, $5, $6 FROM eligible
         ON CONFLICT (pull_request_id, github_installation_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           account_login = EXCLUDED.account_login,
           owner = EXCLUDED.owner,
           repository_name = EXCLUDED.repository_name
         RETURNING pull_request_id
       )
       UPDATE pull_requests pull_request
          SET github_recovery_binding = COALESCE(
                pull_request.github_recovery_binding,
                jsonb_build_object(
                  'installationId', $2::text,
                  'accountId', $3::text,
                  'accountLogin', $4::text,
                  'owner', $5::text,
                  'repositoryName', $6::text
                )
              ),
              next_github_refresh_at = now(),
              updated_at = now()
         FROM candidate
        WHERE pull_request.id = candidate.pull_request_id`,
      [
        repository.githubRepositoryId,
        installation.githubInstallationId,
        installation.accountId,
        installation.accountLogin,
        repository.owner,
        repository.name,
      ],
    );
    await client.query(
      `DELETE FROM github_recovery_candidates candidate
        USING (
          SELECT candidate.pull_request_id,
                 candidate.github_installation_id,
                 row_number() OVER (
                   PARTITION BY candidate.pull_request_id
                   ORDER BY
                     CASE WHEN pull_request.github_recovery_binding->>'installationId'
                                    = candidate.github_installation_id
                          THEN 0 ELSE 1 END,
                     candidate.created_at DESC,
                     candidate.github_installation_id
                 ) AS ordinal
            FROM github_recovery_candidates candidate
            JOIN pull_requests pull_request
              ON pull_request.id = candidate.pull_request_id
        ) ranked
       WHERE candidate.pull_request_id = ranked.pull_request_id
         AND candidate.github_installation_id = ranked.github_installation_id
         AND ranked.ordinal > 8`,
    );
  }
}

async function setGithubRecoveryCandidateDue(
  client: PoolClient,
  githubInstallationId: string,
  due: boolean,
): Promise<void> {
  await client.query(
    `UPDATE pull_requests
        SET next_github_refresh_at = CASE WHEN $2 THEN now() ELSE NULL END,
            updated_at = now()
      WHERE github_recovery_binding->>'installationId' = $1
        AND state = 'open'`,
    [githubInstallationId, due],
  );
}

async function removeGithubRecoveryCandidate(
  client: PoolClient,
  githubInstallationId: string,
  githubRepositoryIds?: string[],
): Promise<void> {
  const repositoryFilter = githubRepositoryIds?.length
    ? githubRepositoryIds
    : null;
  await lockGithubRecoveryCandidatePullRequests(
    client,
    githubInstallationId,
    repositoryFilter,
  );
  await client.query(
    `DELETE FROM github_recovery_candidates candidate
      USING pull_requests pull_request, repositories repository
     WHERE candidate.pull_request_id = pull_request.id
       AND pull_request.repository_id = repository.id
       AND candidate.github_installation_id = $1
       AND ($2::text[] IS NULL
            OR repository.github_repository_id = ANY($2::text[]))`,
    [githubInstallationId, repositoryFilter],
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
               ORDER BY candidate.created_at, candidate.github_installation_id
               LIMIT 1
            ),
            next_github_refresh_at = CASE WHEN EXISTS (
              SELECT 1 FROM github_recovery_candidates candidate
               WHERE candidate.pull_request_id = pull_request.id
            ) THEN now() ELSE NULL END,
            updated_at = now()
       FROM repositories repository
      WHERE pull_request.repository_id = repository.id
        AND pull_request.github_recovery_binding->>'installationId' = $1
        AND ($2::text[] IS NULL
             OR repository.github_repository_id = ANY($2::text[]))`,
    [githubInstallationId, repositoryFilter],
  );
}

async function lockGithubRecoveryCandidatePullRequests(
  client: PoolClient,
  githubInstallationId: string,
  githubRepositoryIds: string[] | null = null,
): Promise<void> {
  await client.query(
    `SELECT pull_request.id
       FROM pull_requests pull_request
       JOIN repositories repository
         ON repository.id = pull_request.repository_id
       JOIN github_recovery_candidates candidate
         ON candidate.pull_request_id = pull_request.id
        AND candidate.github_installation_id = $1
      WHERE ($2::text[] IS NULL
             OR repository.github_repository_id = ANY($2::text[]))
      FOR UPDATE OF pull_request`,
    [githubInstallationId, githubRepositoryIds],
  );
}

async function setInstallationPullRequestRefresh(
  client: PoolClient,
  installationId: string,
  githubInstallationId: string,
  due: boolean,
): Promise<void> {
  await client.query(
    `UPDATE pull_requests pull_request
        SET next_github_refresh_at = CASE WHEN $2 THEN now() ELSE NULL END,
            updated_at = now()
       FROM repositories repository
      WHERE pull_request.repository_id = repository.id
        AND repository.installation_id = $1
        AND pull_request.state = 'open'
        AND (
          $2::boolean
          OR pull_request.github_recovery_binding IS NULL
          OR pull_request.github_recovery_binding->>'installationId' = $3
        )`,
    [installationId, due, githubInstallationId],
  );
}

async function setRepositoryPullRequestRefresh(
  client: PoolClient,
  githubRepositoryIds: string[],
  due: boolean,
): Promise<void> {
  await client.query(
    `UPDATE pull_requests pull_request
        SET next_github_refresh_at = CASE WHEN $2 THEN now() ELSE NULL END,
            updated_at = now()
       FROM repositories repository
      WHERE pull_request.repository_id = repository.id
        AND repository.github_repository_id = ANY($1::text[])
        AND pull_request.state = 'open'`,
    [githubRepositoryIds, due],
  );
}

async function ensureInstallationForRepositoryRemoval(
  client: PoolClient,
  installation: InstallationBinding,
): Promise<{ id: string; status: string } | null> {
  const result = await client.query<{ id: string; status: string }>(
    `INSERT INTO installations
       (github_installation_id, account_id, account_login, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (github_installation_id) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       account_login = EXCLUDED.account_login,
       updated_at = now()
     WHERE installations.status <> 'removed'
     RETURNING id, status`,
    [
      installation.githubInstallationId,
      installation.accountId,
      installation.accountLogin,
    ],
  );
  return result.rows[0] ?? null;
}

async function findInstallationId(
  client: PoolClient,
  installation: InstallationBinding,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM installations
      WHERE github_installation_id = $1`,
    [installation.githubInstallationId],
  );
  return result.rows[0]?.id ?? null;
}

async function canEnqueueGithubPullRequest(
  client: PoolClient,
  githubInstallationId: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM installations
        WHERE github_installation_id = $1
          AND status IN ('active', 'suspended')
     ) AS exists`,
    [githubInstallationId],
  );
  return result.rows[0]?.exists === true;
}

async function isGithubAccountAllowlisted(
  client: PoolClient,
  githubAccountId: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM github_app_account_allowlist
        WHERE github_account_id = $1
          AND status = 'active'
     ) AS exists`,
    [githubAccountId],
  );
  return result.rows[0]?.exists === true;
}

async function resolveGithubAppTenantStatus(
  client: PoolClient,
  installation: InstallationBinding,
): Promise<InstallationTenantStatus> {
  if (await isGithubAccountAllowlisted(client, installation.accountId)) {
    return "active";
  }
  if (
    installation.senderId &&
    (await isGithubAccountAllowlisted(client, installation.senderId))
  ) {
    return "active";
  }
  return "pending";
}

async function loadInstallationStatus(
  client: PoolClient,
  installationId: string,
): Promise<string | null> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM installations WHERE id = $1`,
    [installationId],
  );
  return result.rows[0]?.status ?? null;
}

async function upsertInstallation(
  client: PoolClient,
  installation: InstallationBinding,
  status: "active" | "pending" | "suspended" | "removed",
  options: {
    allowReactivation: boolean;
    allowPendingPromotion: boolean;
  },
): Promise<{ id: string; status: string } | null> {
  const result = await client.query<{ id: string; status: string }>(
    `INSERT INTO installations
       (github_installation_id, account_id, account_login, status,
        suspended_at, removed_at)
     VALUES ($1, $2, $3, $4::github_lifecycle_status,
             CASE WHEN $4::github_lifecycle_status = 'suspended' THEN now() ELSE NULL END,
             CASE WHEN $4::github_lifecycle_status = 'removed' THEN now() ELSE NULL END)
     ON CONFLICT (github_installation_id) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       account_login = EXCLUDED.account_login,
       status = CASE
         WHEN EXCLUDED.status = 'pending' THEN installations.status
         ELSE EXCLUDED.status
       END,
       suspended_at = CASE
         WHEN EXCLUDED.status = 'pending' THEN installations.suspended_at
         WHEN EXCLUDED.status = 'suspended'
           THEN COALESCE(installations.suspended_at, EXCLUDED.suspended_at)
         ELSE NULL
       END,
       removed_at = CASE
         WHEN EXCLUDED.status = 'removed'
           THEN COALESCE(installations.removed_at, EXCLUDED.removed_at)
         WHEN EXCLUDED.status = 'pending' THEN installations.removed_at
         ELSE NULL
       END,
       updated_at = now()
     WHERE (installations.status <> 'removed' OR EXCLUDED.status = 'removed')
       AND (
         EXCLUDED.status <> 'active'
         OR installations.status = 'active'
         OR $5 = true
         OR ($6 = true AND installations.status = 'pending')
       )
     RETURNING id, status`,
    [
      installation.githubInstallationId,
      installation.accountId,
      installation.accountLogin,
      status,
      options.allowReactivation,
      options.allowPendingPromotion,
    ],
  );
  return result.rows[0] ?? null;
}

async function upsertRepository(
  client: PoolClient,
  installationId: string,
  repository: LifecycleRepository,
): Promise<void> {
  await client.query(
    `INSERT INTO repositories
       (installation_id, github_repository_id, owner, name, default_branch,
        status, suspended_at, removed_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NULL, NULL)
     ON CONFLICT (github_repository_id) DO UPDATE SET
       owner = EXCLUDED.owner,
       name = EXCLUDED.name,
       default_branch = COALESCE(EXCLUDED.default_branch, repositories.default_branch),
       updated_at = now()
     WHERE repositories.installation_id = EXCLUDED.installation_id`,
    // A delivery UUID carries no ordering information. Existing removed or
    // suspended rows are only reactivated after a fresh repository-scoped
    // GitHub read in the control process, never from this event alone.
    [
      installationId,
      repository.githubRepositoryId,
      repository.owner,
      repository.name,
      repository.defaultBranch,
    ],
  );
}

async function revokeSessionsForInstallation(
  client: PoolClient,
  installationId: string,
): Promise<void> {
  await client.query(
    `UPDATE auth_sessions session
        SET revoked_at = COALESCE(session.revoked_at, now())
      FROM repositories repository
     WHERE session.repository_id = repository.id
       AND repository.installation_id = $1
       AND session.revoked_at IS NULL`,
    [installationId],
  );
}

async function revokeSessionsForRepositories(
  client: PoolClient,
  repositoryIds: string[],
): Promise<void> {
  await client.query(
    `UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE repository_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
    [repositoryIds],
  );
}

async function setDeliveryStatus(
  client: PoolClient,
  deliveryId: string,
  status: "queued" | "processed" | "ignored",
): Promise<void> {
  await client.query(
    `UPDATE webhook_deliveries
        SET processing_status = $2,
            queued_at = CASE WHEN $2 = 'queued' THEN now() ELSE NULL END,
            next_retry_at = NULL,
            processed_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END
      WHERE delivery_id = $1`,
    [deliveryId, status],
  );
}

export { WebhookDeliveryConflictError };
