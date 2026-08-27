import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const ids = {
  installation: "16000000-0000-4000-8000-000000000001",
  repository: "16000000-0000-4000-8000-000000000002",
  policy: "16000000-0000-4000-8000-000000000003",
  pullRequest: "16000000-0000-4000-8000-000000000004",
  revision: "16000000-0000-4000-8000-000000000005",
  plan: "16000000-0000-4000-8000-000000000006",
  attempt: "16000000-0000-4000-8000-000000000007",
  upload: "16000000-0000-4000-8000-000000000008",
} as const;

databaseDescribe("fixed multipart boundary overlap", () => {
  let connection: DatabaseConnection;

  beforeAll(async () => {
    connection = connectDatabase(databaseUrl!);
    await migrateDatabase(connection.pool);
  });

  afterAll(async () => {
    await connection.close();
  });

  beforeEach(async () => {
    await connection.pool.query(`
      TRUNCATE TABLE
        audit_events, deletion_jobs, check_runs, review_decisions, evaluations,
        frame_selections, transcripts, recording_objects, recording_parts,
        upload_sessions, wrapping_materials, handoff_tokens, auth_sessions,
        attempt_transitions, attempts, proof_questions, proof_plans,
        practice_sessions, generation_contexts, analysis_snapshots,
        github_revision_sources, webhook_deliveries,
        pull_request_revisions, pull_requests, repository_policies,
        repositories, installations, github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
    await seedUpload(connection);
  });

  it("accepts exactly one repeated boundary record and contiguous ranges", async () => {
    await insertPart(connection, 1, 0, 2);
    await expect(insertPart(connection, 2, 2, 4)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(insertPart(connection, 3, 5, 7)).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("rejects an overlap of more than the single boundary record", async () => {
    await insertPart(connection, 1, 0, 3);
    await expect(insertPart(connection, 2, 2, 5)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("rejects gaps and out-of-order part numbers", async () => {
    await insertPart(connection, 1, 0, 2);
    await expect(insertPart(connection, 2, 4, 6)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insertPart(connection, 3, 3, 5)).rejects.toMatchObject({
      code: "23514",
    });
  });
});

async function insertPart(
  connection: DatabaseConnection,
  partNumber: number,
  firstChunkIndex: number,
  lastChunkIndex: number,
): Promise<unknown> {
  return connection.pool.query(
    `INSERT INTO recording_parts
      (upload_session_id, part_number, first_chunk_index, last_chunk_index,
       byte_length, sha256, etag)
     VALUES ($1, $2, $3, $4, 8388608, $5, $6)`,
    [
      ids.upload,
      partNumber,
      firstChunkIndex,
      lastChunkIndex,
      String(partNumber).repeat(64),
      `"part-${String(partNumber)}"`,
    ],
  );
}

async function seedUpload(connection: DatabaseConnection): Promise<void> {
  await connection.pool.query(
    `INSERT INTO installations
      (id, github_installation_id, account_id, account_login)
     VALUES ($1, 'multipart-installation', 'multipart-account', 'acme')`,
    [ids.installation],
  );
  await connection.pool.query(
    `INSERT INTO repositories
      (id, installation_id, github_repository_id, owner, name, default_branch)
     VALUES ($1, $2, 'multipart-repository', 'acme', 'fixed-parts', 'main')`,
    [ids.repository, ids.installation],
  );
  await connection.pool.query(
    `INSERT INTO repository_policies
      (id, repository_id, version, schema_version, policy, policy_hash,
       created_by, activated_at)
     VALUES ($1, $2, 1, '1', '{"decisionMode":"maintainer_review"}',
             $3, 'system', now())`,
    [ids.policy, ids.repository, "a".repeat(64)],
  );
  await connection.pool.query(
    `INSERT INTO pull_requests
      (id, repository_id, github_pull_request_id, number, author_id, state)
     VALUES ($1, $2, 'multipart-pr', 16, 'github-user-16', 'open')`,
    [ids.pullRequest, ids.repository],
  );
  await connection.pool.query(
    `INSERT INTO pull_request_revisions
      (id, pull_request_id, head_sha, base_sha, is_current)
     VALUES ($1, $2, $3, $4, true)`,
    [ids.revision, ids.pullRequest, "b".repeat(40), "c".repeat(40)],
  );
  await connection.pool.query(
    `INSERT INTO proof_plans
      (id, revision_id, repository_policy_id, plan_version,
       deterministic_seed, risk_explanation, question_budget, plan_hash, status)
     VALUES ($1, $2, $3, 'planner-v1', 'seed-16', '{}', 1, $4, 'ready')`,
    [ids.plan, ids.revision, ids.policy, "d".repeat(64)],
  );
  await connection.pool.query(
    `INSERT INTO attempts
      (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
       status, nonce_hash, expires_at)
     VALUES ($1, $2, $3, 'github-user-16', $4, $5, 'uploading', $6,
             now() + interval '1 hour')`,
    [
      ids.attempt,
      ids.repository,
      ids.revision,
      ids.plan,
      "b".repeat(40),
      "e".repeat(64),
    ],
  );
  await connection.pool.query(
    `INSERT INTO upload_sessions
      (id, attempt_id, object_id, object_key, provider_upload_id, state,
       next_part_number, expires_at)
     VALUES ($1, $2, $3, 'evidence/v1/fixed-parts', 'provider-upload-16',
             'active', 1, now() + interval '1 hour')`,
    [ids.upload, ids.attempt, "16000000-0000-4000-8000-000000000009"],
  );
}
