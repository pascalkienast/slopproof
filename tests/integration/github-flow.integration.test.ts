import { createHmac } from "node:crypto";
import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import {
  FakeGithubCheckAdapter,
  PgBossPullRequestQueue,
  WebhookDeliveryConflictError,
  ingestPullRequestWebhook,
  processPullRequestJob,
} from "@slopproof/github";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const webhookSecret = "integration-webhook-secret";

databaseDescribe("signed fake GitHub ingress", () => {
  let connection: DatabaseConnection;
  let queue: PgBossPullRequestQueue;
  let checkAdapter: FakeGithubCheckAdapter;

  beforeAll(async () => {
    connection = connectDatabase(databaseUrl!);
    await migrateDatabase(connection.pool);
    checkAdapter = new FakeGithubCheckAdapter(
      connection.pool,
      "https://slopproof.test",
    );
    queue = new PgBossPullRequestQueue(databaseUrl!);
    await queue.start();
    await queue.work(async (payload) => {
      await processPullRequestJob(connection.pool, checkAdapter, payload);
    });
  });

  afterAll(async () => {
    if (queue) await queue.stop();
    if (connection) await connection.close();
  });

  beforeEach(async () => {
    await connection.pool.query(`
      TRUNCATE TABLE
        audit_events, deletion_jobs, check_runs, review_decisions, evaluations,
        frame_selections, transcripts, recording_objects, recording_parts,
        upload_sessions, wrapping_materials, handoff_tokens, auth_sessions,
        attempt_transitions, attempts, proof_questions, proof_plans,
        practice_sessions, analysis_snapshots, webhook_deliveries,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations, github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
    await seedAllowlistedInstallation(connection, {
      githubInstallationId: "17",
      accountId: "7",
      accountLogin: "acme",
    });
  });

  it("deduplicates deliveries and invalidates the old SHA on synchronize", async () => {
    const first = webhook({
      deliveryId: "30000000-0000-4000-8000-000000000001",
      action: "opened",
      headSha: "a".repeat(40),
    });
    await expect(
      ingestPullRequestWebhook({
        pool: connection.pool,
        queue,
        secret: webhookSecret,
        ...first,
      }),
    ).resolves.toMatchObject({ duplicate: false });
    await waitForDelivery(connection, first.headers.deliveryId);

    const initial = await connection.pool.query<{
      revision_id: string;
      repository_id: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
      public_summary: string;
    }>(`
      SELECT revision.id AS revision_id, repository.id AS repository_id,
             revision.head_sha, check_run.status, check_run.conclusion,
             check_run.public_summary
      FROM pull_request_revisions revision
      JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
      JOIN repositories repository ON repository.id = pull_request.repository_id
      JOIN check_runs check_run ON check_run.revision_id = revision.id
      WHERE revision.is_current = true
    `);
    expect(initial.rows).toHaveLength(1);
    expect(initial.rows[0]).toMatchObject({
      head_sha: "a".repeat(40),
      status: "in_progress",
      conclusion: null,
      public_summary: `understanding required for head ${"a".repeat(40)}`,
    });

    await expect(
      ingestPullRequestWebhook({
        pool: connection.pool,
        queue,
        secret: webhookSecret,
        ...first,
      }),
    ).resolves.toMatchObject({ duplicate: true });
    expect(
      await scalar(
        connection,
        "SELECT count(*)::int FROM pull_request_revisions",
      ),
    ).toBe(1);

    const oldRevisionId = initial.rows[0]!.revision_id;
    const repositoryId = initial.rows[0]!.repository_id;
    const planId = "30000000-0000-4000-8000-000000000010";
    const attemptId = "30000000-0000-4000-8000-000000000011";
    const policyId = "30000000-0000-4000-8000-000000000012";
    await connection.pool.query(
      `INSERT INTO repository_policies
        (id, repository_id, version, schema_version, policy, policy_hash,
         created_by, activated_at)
       VALUES ($1, $2, 1, '1', '{"decisionMode":"maintainer_review"}', $3,
               'system', now())`,
      [policyId, repositoryId, "f".repeat(64)],
    );
    await connection.pool.query(
      `INSERT INTO proof_plans
        (id, revision_id, repository_policy_id, plan_version,
         deterministic_seed, risk_explanation, question_budget, plan_hash, status)
       VALUES ($1, $2, $3, 'planner-v1', 'seed-c', '{}', 1, $4, 'ready')`,
      [planId, oldRevisionId, policyId, "c".repeat(64)],
    );
    await connection.pool.query(
      `INSERT INTO attempts
        (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
         status, nonce_hash, expires_at, started_at)
       VALUES ($1, $2, $3, '99', $4, $5, 'active', $6,
               now() + interval '1 hour', now())`,
      [
        attemptId,
        repositoryId,
        oldRevisionId,
        planId,
        "a".repeat(40),
        "d".repeat(64),
      ],
    );

    const synchronized = webhook({
      deliveryId: "30000000-0000-4000-8000-000000000002",
      action: "synchronize",
      headSha: "e".repeat(40),
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...synchronized,
    });
    await waitForDelivery(connection, synchronized.headers.deliveryId);

    const revisions = await connection.pool.query<{
      id: string;
      head_sha: string;
      is_current: boolean;
      conclusion: string | null;
    }>(`
      SELECT revision.id, revision.head_sha, revision.is_current,
             check_run.conclusion
      FROM pull_request_revisions revision
      JOIN check_runs check_run ON check_run.revision_id = revision.id
      ORDER BY revision.received_at, revision.head_sha
    `);
    expect(revisions.rows).toHaveLength(2);
    expect(
      revisions.rows.find((row) => row.head_sha === "a".repeat(40)),
    ).toMatchObject({
      is_current: false,
      conclusion: "cancelled",
    });
    expect(
      revisions.rows.find((row) => row.head_sha === "e".repeat(40)),
    ).toMatchObject({
      is_current: true,
      conclusion: null,
    });
    const attempt = await connection.pool.query<{
      status: string;
      invalidated_at: Date | null;
    }>("SELECT status, invalidated_at FROM attempts WHERE id = $1", [
      attemptId,
    ]);
    expect(attempt.rows[0]?.status).toBe("invalidated");
    expect(attempt.rows[0]?.invalidated_at).toBeInstanceOf(Date);

    const conflicting = webhook({
      deliveryId: first.headers.deliveryId,
      action: "opened",
      headSha: "f".repeat(40),
    });
    await expect(
      ingestPullRequestWebhook({
        pool: connection.pool,
        queue,
        secret: webhookSecret,
        ...conflicting,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryConflictError);
  });

  it("activates only repository-scoped deliveries for selected installations", async () => {
    const created = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000018",
      eventName: "installation",
      body: {
        action: "created",
        installation: {
          id: 17,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories: [lifecycleRepository(42), lifecycleRepository(43)],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...created,
    });
    expect(
      await scalar(connection, "SELECT count(*)::int FROM repositories"),
    ).toBe(0);

    const added = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000019",
      eventName: "installation_repositories",
      body: {
        action: "added",
        installation: {
          id: 17,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories_added: [lifecycleRepository(42)],
        repositories_removed: [],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...added,
    });
    expect(
      await scalar(
        connection,
        "SELECT count(*)::int FROM repositories WHERE status = 'active'",
      ),
    ).toBe(1);
  });

  it("keeps repository removals as ordered-independent tombstones", async () => {
    const removed = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000020",
      eventName: "installation_repositories",
      body: {
        action: "removed",
        installation: {
          id: 17,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories_added: [],
        repositories_removed: [lifecycleRepository(42)],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...removed,
    });
    const first = await repositoryLifecycle(connection, "42");
    expect(first).toMatchObject({ status: "removed" });

    const added = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000021",
      eventName: "installation_repositories",
      body: {
        action: "added",
        installation: {
          id: 17,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories_added: [lifecycleRepository(42)],
        repositories_removed: [],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...added,
    });
    expect(await repositoryLifecycle(connection, "42")).toEqual(first);

    const suspended = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000022",
      eventName: "installation",
      body: {
        action: "suspend",
        installation: {
          id: 17,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories: [],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...suspended,
    });

    const removedWhileSuspended = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000023",
      eventName: "installation_repositories",
      body: {
        action: "removed",
        installation: {
          id: 17,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories_added: [],
        repositories_removed: [lifecycleRepository(43)],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...removedWhileSuspended,
    });
    expect(await repositoryLifecycle(connection, "43")).toMatchObject({
      status: "removed",
    });

    const unsuspended = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000024",
      eventName: "installation",
      body: {
        action: "unsuspend",
        installation: {
          id: 17,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories: [],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...unsuspended,
    });
    const installation = await connection.pool.query<{ status: string }>(
      "SELECT status FROM installations WHERE github_installation_id = '17'",
    );
    // Lifecycle deliveries have no ordering relation. Even an unsuspend event
    // stays fail-closed until a repository-scoped fresh PR read reactivates the
    // installation in the isolated control process.
    expect(installation.rows[0]?.status).toBe("suspended");
    expect(await repositoryLifecycle(connection, "43")).toMatchObject({
      status: "removed",
    });

    const staleAddedFromAnotherInstallation = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000025",
      eventName: "installation_repositories",
      body: {
        action: "added",
        installation: {
          id: 99,
          account: { id: 7, login: "acme" },
          repository_selection: "selected",
        },
        repositories_added: [lifecycleRepository(42)],
        repositories_removed: [],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...staleAddedFromAnotherInstallation,
    });
    const binding = await connection.pool.query<{
      github_installation_id: string;
      status: string;
    }>(
      `SELECT installation.github_installation_id, repository.status
         FROM repositories repository
         JOIN installations installation ON installation.id = repository.installation_id
        WHERE repository.github_repository_id = '42'`,
    );
    expect(binding.rows[0]).toMatchObject({
      github_installation_id: "17",
      status: "removed",
    });
  });

  it("persists unknown App installs as pending and ignores their pull requests", async () => {
    const created = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000030",
      eventName: "installation",
      body: {
        action: "created",
        installation: {
          id: 999017,
          account: { id: 999007, login: "stranger" },
          repository_selection: "all",
        },
        sender: { id: 999008, login: "installer" },
        repositories: [lifecycleRepository(999042)],
      },
    });
    await expect(
      ingestPullRequestWebhook({
        pool: connection.pool,
        queue,
        secret: webhookSecret,
        ...created,
      }),
    ).resolves.toMatchObject({ ignored: false });
    expect(
      await connection.pool.query<{ status: string }>(
        "SELECT status FROM installations WHERE github_installation_id = '999017'",
      ),
    ).toMatchObject({ rows: [{ status: "pending" }] });
    expect(
      await scalar(connection, "SELECT count(*)::int FROM repositories"),
    ).toBe(0);

    const added = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000031",
      eventName: "installation_repositories",
      body: {
        action: "added",
        installation: {
          id: 999017,
          account: { id: 999007, login: "stranger" },
          repository_selection: "selected",
        },
        repositories_added: [lifecycleRepository(999042)],
        repositories_removed: [],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...added,
    });
    expect(
      await scalar(connection, "SELECT count(*)::int FROM repositories"),
    ).toBe(0);

    const opened = webhook({
      deliveryId: "30000000-0000-4000-8000-000000000032",
      action: "opened",
      headSha: "a".repeat(40),
    });
    opened.rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "opened",
        installation: { id: 999017 },
        repository: {
          id: 999042,
          name: "cachekit",
          full_name: "stranger/cachekit",
          default_branch: "main",
          owner: { id: 999007, login: "stranger" },
        },
        pull_request: {
          id: 9991840,
          number: 184,
          state: "open",
          user: { id: 99, login: "octocat" },
          head: { sha: "a".repeat(40) },
          base: { sha: "b".repeat(40) },
        },
      }),
    );
    opened.headers.signature = `sha256=${createHmac("sha256", webhookSecret)
      .update(opened.rawBody)
      .digest("hex")}`;
    await expect(
      ingestPullRequestWebhook({
        pool: connection.pool,
        queue,
        secret: webhookSecret,
        ...opened,
      }),
    ).resolves.toMatchObject({ ignored: true, duplicate: false });
    expect(
      await scalar(
        connection,
        "SELECT count(*)::int FROM webhook_deliveries WHERE processing_status = 'queued'",
      ),
    ).toBe(0);
    expect(
      await scalar(connection, "SELECT count(*)::int FROM pull_requests"),
    ).toBe(0);
  });

  it("activates an org install when the installer sender is allowlisted", async () => {
    await connection.pool.query(
      `INSERT INTO github_app_account_allowlist (github_account_id, status)
       VALUES ('900007', 'active')`,
    );
    const created = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000033",
      eventName: "installation",
      body: {
        action: "created",
        installation: {
          id: 900017,
          account: { id: 900001, login: "new-org" },
          repository_selection: "all",
        },
        sender: { id: 900007, login: "pascal" },
        repositories: [
          {
            id: 900042,
            name: "cachekit",
            full_name: "new-org/cachekit",
            default_branch: "main",
          },
        ],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...created,
    });
    expect(
      await connection.pool.query<{ status: string }>(
        "SELECT status FROM installations WHERE github_installation_id = '900017'",
      ),
    ).toMatchObject({ rows: [{ status: "active" }] });
    expect(
      await scalar(
        connection,
        "SELECT count(*)::int FROM repositories WHERE status = 'active'",
      ),
    ).toBe(1);
  });

  it("does not demote an already-active installation when the account is not allowlisted", async () => {
    await connection.pool.query(
      `INSERT INTO installations
         (github_installation_id, account_id, account_login, status)
       VALUES ('800017', '800007', 'legacy', 'active')`,
    );
    const created = lifecycleWebhook({
      deliveryId: "30000000-0000-4000-8000-000000000034",
      eventName: "installation",
      body: {
        action: "created",
        installation: {
          id: 800017,
          account: { id: 800007, login: "legacy" },
          repository_selection: "all",
        },
        repositories: [
          {
            id: 800042,
            name: "cachekit",
            full_name: "legacy/cachekit",
            default_branch: "main",
          },
        ],
      },
    });
    await ingestPullRequestWebhook({
      pool: connection.pool,
      queue,
      secret: webhookSecret,
      ...created,
    });
    expect(
      await connection.pool.query<{ status: string }>(
        "SELECT status FROM installations WHERE github_installation_id = '800017'",
      ),
    ).toMatchObject({ rows: [{ status: "active" }] });
    expect(
      await scalar(
        connection,
        "SELECT count(*)::int FROM repositories WHERE github_repository_id = '800042'",
      ),
    ).toBe(1);
  });
});

async function seedAllowlistedInstallation(
  connection: DatabaseConnection,
  input: {
    githubInstallationId: string;
    accountId: string;
    accountLogin: string;
  },
): Promise<void> {
  await connection.pool.query(
    `INSERT INTO github_app_account_allowlist (github_account_id, status)
     VALUES ($1, 'active')
     ON CONFLICT (github_account_id) DO UPDATE SET
       status = 'active',
       updated_at = now()`,
    [input.accountId],
  );
  await connection.pool.query(
    `INSERT INTO installations
       (github_installation_id, account_id, account_login, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (github_installation_id) DO NOTHING`,
    [input.githubInstallationId, input.accountId, input.accountLogin],
  );
}

function lifecycleRepository(id: number) {
  return {
    id,
    name: `repo-${id}`,
    full_name: `acme/repo-${id}`,
    default_branch: "main",
  };
}

function lifecycleWebhook(input: {
  deliveryId: string;
  eventName: "installation" | "installation_repositories";
  body: unknown;
}) {
  const rawBody = new TextEncoder().encode(JSON.stringify(input.body));
  return {
    rawBody,
    headers: {
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      signature: `sha256=${createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex")}`,
    },
  };
}

async function repositoryLifecycle(
  connection: DatabaseConnection,
  githubRepositoryId: string,
): Promise<{ status: string; removedAt: string }> {
  const result = await connection.pool.query<{
    status: string;
    removed_at: Date;
  }>(
    `SELECT status, removed_at
       FROM repositories
      WHERE github_repository_id = $1`,
    [githubRepositoryId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("repository lifecycle row is missing");
  return { status: row.status, removedAt: row.removed_at.toISOString() };
}

function webhook(input: {
  deliveryId: string;
  action: "opened" | "synchronize";
  headSha: string;
}) {
  const rawBody = new TextEncoder().encode(
    JSON.stringify({
      action: input.action,
      installation: { id: 17 },
      repository: {
        id: 42,
        name: "cachekit",
        full_name: "acme/cachekit",
        default_branch: "main",
        owner: { id: 7, login: "acme" },
      },
      pull_request: {
        id: 1840,
        number: 184,
        state: "open",
        user: { id: 99, login: "octocat" },
        head: { sha: input.headSha },
        base: { sha: "b".repeat(40) },
      },
    }),
  );
  return {
    rawBody,
    headers: {
      deliveryId: input.deliveryId,
      eventName: "pull_request" as const,
      signature: `sha256=${createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex")}`,
    },
  };
}

async function waitForDelivery(
  connection: DatabaseConnection,
  deliveryId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await connection.pool.query<{ processing_status: string }>(
      "SELECT processing_status FROM webhook_deliveries WHERE delivery_id = $1",
      [deliveryId],
    );
    if (result.rows[0]?.processing_status === "processed") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `delivery ${deliveryId} was not processed before the deadline`,
  );
}

async function scalar(
  connection: DatabaseConnection,
  query: string,
): Promise<number> {
  const result = await connection.pool.query<{ count: number }>(query);
  return result.rows[0]?.count ?? 0;
}
