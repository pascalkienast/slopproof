import {
  HandoffRejectedError,
  createHandoff,
  exchangeHandoff,
  issueSession,
  verifyCsrf,
} from "@understandproof/auth";
import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@understandproof/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const sessionSecret = "integration-session-secret-at-least-32-characters";
const ids = {
  installation: "40000000-0000-4000-8000-000000000001",
  repository: "40000000-0000-4000-8000-000000000002",
  policy: "40000000-0000-4000-8000-000000000007",
  pullRequest: "40000000-0000-4000-8000-000000000003",
  revision: "40000000-0000-4000-8000-000000000004",
  plan: "40000000-0000-4000-8000-000000000005",
  attempt: "40000000-0000-4000-8000-000000000006",
} as const;

databaseDescribe("session-bound one-time mobile handoff", () => {
  let connection: DatabaseConnection;

  beforeAll(async () => {
    connection = connectDatabase(databaseUrl!);
    await migrateDatabase(connection.pool);
  });

  afterAll(async () => {
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
    await seedAttempt(connection);
  });

  it("stores only token hashes and consumes a valid grant exactly once", async () => {
    const desktop = await issueSession(
      connection.pool,
      {
        actorId: "author-99",
        actorRole: "author",
        repositoryId: ids.repository,
        ttlMs: 60 * 60_000,
      },
      sessionSecret,
    );
    expect(verifyCsrf(desktop.session, desktop.csrfToken, sessionSecret)).toBe(
      true,
    );
    expect(verifyCsrf(desktop.session, "wrong", sessionSecret)).toBe(false);

    const handoff = await createHandoff(
      connection.pool,
      { attemptId: ids.attempt, session: desktop.session },
      sessionSecret,
    );
    const stored = await connection.pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM handoff_tokens WHERE attempt_id = $1",
      [ids.attempt],
    );
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toContain(handoff.token);

    const exchangeInput = {
      token: handoff.token,
      wrappingMaterial: {
        keyId: "local:test-key-v1",
        algorithm: "RSA-OAEP-256" as const,
        spkiDer: "AQ",
        spkiSha256: "A".repeat(43),
      },
    };
    const exchanged = await exchangeHandoff(
      connection.pool,
      exchangeInput,
      sessionSecret,
    );
    expect(exchanged.mobileSession.session.actorId).toBe("author-99");
    expect(exchanged.wrappingMaterial).toMatchObject({
      version: 1,
      attemptId: ids.attempt,
      headSha: "a".repeat(40),
      algorithm: "RSA-OAEP-256",
    });
    await expect(
      exchangeHandoff(connection.pool, exchangeInput, sessionSecret),
    ).rejects.toBeInstanceOf(HandoffRejectedError);
  });

  it("rejects a desktop session that is not the PR author", async () => {
    const maintainer = await issueSession(
      connection.pool,
      {
        actorId: "maintainer-1",
        actorRole: "maintainer",
        repositoryId: ids.repository,
        ttlMs: 60 * 60_000,
      },
      sessionSecret,
    );
    await expect(
      createHandoff(
        connection.pool,
        { attemptId: ids.attempt, session: maintainer.session },
        sessionSecret,
      ),
    ).rejects.toBeInstanceOf(HandoffRejectedError);
  });
});

async function seedAttempt(connection: DatabaseConnection): Promise<void> {
  await connection.pool.query(
    `INSERT INTO installations
      (id, github_installation_id, account_id, account_login)
     VALUES ($1, 'demo-installation', 'demo-account', 'acme')`,
    [ids.installation],
  );
  await connection.pool.query(
    `INSERT INTO repositories
      (id, installation_id, github_repository_id, owner, name, default_branch)
     VALUES ($1, $2, 'demo-repository', 'acme', 'cachekit', 'main')`,
    [ids.repository, ids.installation],
  );
  await connection.pool.query(
    `INSERT INTO repository_policies
      (id, repository_id, version, schema_version, policy, policy_hash,
       created_by, activated_at)
     VALUES ($1, $2, 1, '1', '{"decisionMode":"maintainer_review"}', $3,
             'system', now())`,
    [ids.policy, ids.repository, "9".repeat(64)],
  );
  await connection.pool.query(
    `INSERT INTO pull_requests
      (id, repository_id, github_pull_request_id, number, author_id, state)
     VALUES ($1, $2, 'demo-pr', 184, 'author-99', 'open')`,
    [ids.pullRequest, ids.repository],
  );
  await connection.pool.query(
    `INSERT INTO pull_request_revisions
      (id, pull_request_id, head_sha, base_sha, is_current)
     VALUES ($1, $2, $3, $4, true)`,
    [ids.revision, ids.pullRequest, "a".repeat(40), "b".repeat(40)],
  );
  await connection.pool.query(
    `INSERT INTO proof_plans
      (id, revision_id, repository_policy_id, plan_version,
       deterministic_seed, risk_explanation, question_budget, plan_hash, status)
     VALUES ($1, $2, $3, 'planner-v1', 'seed-auth', '{}', 1, $4, 'ready')`,
    [ids.plan, ids.revision, ids.policy, "c".repeat(64)],
  );
  await connection.pool.query(
    `INSERT INTO attempts
      (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
       status, nonce_hash, expires_at)
     VALUES ($1, $2, $3, 'author-99', $4, $5, 'ready', $6,
             now() + interval '1 hour')`,
    [
      ids.attempt,
      ids.repository,
      ids.revision,
      ids.plan,
      "a".repeat(40),
      "d".repeat(64),
    ],
  );
}
