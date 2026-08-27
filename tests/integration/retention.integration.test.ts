import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import {
  PostgresRetentionPersistence,
  deleteEvidenceJob,
  type EvidenceDeletionStorage,
} from "../../apps/worker/src/retention";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const ids = {
  installation: "70000000-0000-4000-8000-000000000001",
  repository: "70000000-0000-4000-8000-000000000002",
  pullRequest: "70000000-0000-4000-8000-000000000003",
  revision: "70000000-0000-4000-8000-000000000004",
  plan: "70000000-0000-4000-8000-000000000005",
  attempt: "70000000-0000-4000-8000-000000000006",
  material: "70000000-0000-4000-8000-000000000007",
  object: "70000000-0000-4000-8000-000000000008",
  upload: "70000000-0000-4000-8000-000000000009",
  recording: "70000000-0000-4000-8000-000000000010",
  transcript: "70000000-0000-4000-8000-000000000011",
  frame: "70000000-0000-4000-8000-000000000012",
  evaluation: "70000000-0000-4000-8000-000000000013",
  policy: "70000000-0000-4000-8000-000000000014",
  question: "70000000-0000-4000-8000-000000000015",
} as const;
const headSha = "7".repeat(40);
const now = new Date("2026-08-12T12:00:00.000Z");

databaseDescribe("physical evidence retention", () => {
  let database: DatabaseConnection;

  beforeAll(async () => {
    database = connectDatabase(databaseUrl!);
    await migrateDatabase(database.pool);
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  beforeEach(async () => {
    await database.pool.query(`
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
    await seedExpiredEvidence(database);
  });

  it("deletes storage targets and shreds keys, payloads, manifests and derivatives idempotently", async () => {
    const queue = {
      async send() {
        return "71000000-0000-4000-8000-000000000001";
      },
    } as unknown as ConstructorParameters<
      typeof PostgresRetentionPersistence
    >[1];
    const persistence = new PostgresRetentionPersistence(database, queue);
    const queued = await persistence.enqueueDueDeletions({
      now,
      staleBefore: new Date(now.getTime() - 60_000),
      limit: 10,
    });
    expect(queued).toHaveLength(1);

    const storage = new FakeStorage();
    const payload = {
      schemaVersion: "1" as const,
      idempotencyKey: `retention-integration:${queued[0]}`,
      deletionJobId: queued[0]!,
    };
    await deleteEvidenceJob(payload, {
      persistence,
      storage,
      clock: { now: () => now },
    });
    await deleteEvidenceJob(payload, {
      persistence,
      storage,
      clock: { now: () => now },
    });

    expect(storage.deleted.sort()).toEqual(
      ["evidence/frame-secret", "evidence/video-secret"].sort(),
    );
    expect(storage.aborted).toEqual([]);

    const state = await database.pool.query<{
      recording_key: string;
      recording_wrapped_key: string;
      recording_deleted_at: Date | null;
      transcript_payload: string;
      evaluation_payload: string;
      frame_key: string;
      upload_key: string;
      finalize_envelope: unknown;
      material_key: string;
      material_destroyed_at: Date | null;
      deletion_state: string;
      parts: number;
      interval_sets: number;
    }>(
      `SELECT recording.object_key AS recording_key,
              recording.wrapped_data_key AS recording_wrapped_key,
              recording.deleted_at AS recording_deleted_at,
              transcript.encrypted_payload AS transcript_payload,
              evaluation.encrypted_payload AS evaluation_payload,
              frame.object_key AS frame_key, upload.object_key AS upload_key,
              upload.finalize_envelope, material.key_id AS material_key,
              material.destroyed_at AS material_destroyed_at,
              deletion.state AS deletion_state,
              (SELECT count(*)::int FROM recording_parts) AS parts,
              (SELECT count(*)::int FROM proof_question_interval_sets)
                AS interval_sets
       FROM recording_objects recording
       JOIN transcripts transcript ON transcript.attempt_id = recording.attempt_id
       JOIN evaluations evaluation ON evaluation.attempt_id = recording.attempt_id
       JOIN frame_selections frame ON frame.attempt_id = recording.attempt_id
       JOIN upload_sessions upload ON upload.attempt_id = recording.attempt_id
       JOIN wrapping_materials material ON material.attempt_id = recording.attempt_id
       JOIN deletion_jobs deletion ON deletion.object_id = recording.attempt_id::text
       WHERE recording.attempt_id = $1`,
      [ids.attempt],
    );
    expect(state.rows[0]).toMatchObject({
      recording_wrapped_key: "",
      transcript_payload: "",
      evaluation_payload: "",
      finalize_envelope: null,
      deletion_state: "completed",
      parts: 0,
      interval_sets: 0,
    });
    expect(state.rows[0]?.recording_key).toBe(`deleted/${ids.recording}`);
    expect(state.rows[0]?.frame_key).toBe(`deleted/${ids.frame}`);
    expect(state.rows[0]?.upload_key).toBe(`deleted/${ids.upload}`);
    expect(state.rows[0]?.material_key).toBe(`destroyed:${ids.material}`);
    expect(state.rows[0]?.recording_deleted_at).toBeInstanceOf(Date);
    expect(state.rows[0]?.material_destroyed_at).toBeInstanceOf(Date);

    const residual = await database.pool.query<{ document: string }>(
      `SELECT concat_ws('|', recording.object_key, recording.wrapped_data_key,
                        transcript.encrypted_payload, evaluation.encrypted_payload,
                        frame.object_key, upload.object_key,
                        coalesce(upload.finalize_envelope::text, ''),
                        material.key_id) AS document
       FROM recording_objects recording
       JOIN transcripts transcript ON transcript.attempt_id = recording.attempt_id
       JOIN evaluations evaluation ON evaluation.attempt_id = recording.attempt_id
       JOIN frame_selections frame ON frame.attempt_id = recording.attempt_id
       JOIN upload_sessions upload ON upload.attempt_id = recording.attempt_id
       JOIN wrapping_materials material ON material.attempt_id = recording.attempt_id
       WHERE recording.attempt_id = $1`,
      [ids.attempt],
    );
    expect(residual.rows[0]?.document).not.toContain("sensitive-");
    expect(residual.rows[0]?.document).not.toContain("evidence/video-secret");
    expect(residual.rows[0]?.document).not.toContain("evidence/frame-secret");
  });

  it("re-enqueues a stale failed deletion so retention remains eventual", async () => {
    let sends = 0;
    const singletonKeys: string[] = [];
    const queue = {
      async send(
        _name: string,
        _payload: unknown,
        options: { singletonKey?: string },
      ) {
        sends += 1;
        if (options.singletonKey) singletonKeys.push(options.singletonKey);
        return `71000000-0000-4000-8000-${String(sends).padStart(12, "0")}`;
      },
    } as unknown as ConstructorParameters<
      typeof PostgresRetentionPersistence
    >[1];
    const persistence = new PostgresRetentionPersistence(database, queue);
    const initial = await persistence.enqueueDueDeletions({
      now,
      staleBefore: new Date(now.getTime() - 60_000),
      limit: 10,
    });
    const claimed = await persistence.claimDeletion(initial[0]!, now);
    expect(claimed).not.toBeNull();
    await persistence.failDeletion(
      claimed!,
      "SyntheticStorageFailure",
      new Date(now.getTime() - 2 * 60 * 60_000),
    );

    const requeued = await persistence.enqueueDueDeletions({
      now,
      staleBefore: new Date(now.getTime() - 60 * 60_000),
      limit: 10,
    });

    expect(requeued).toHaveLength(1);
    expect(sends).toBe(2);
    expect(singletonKeys).toEqual([
      `${requeued[0]}:0:${String(now.getTime())}`,
      `${requeued[0]}:1:${String(now.getTime())}`,
    ]);
    const state = await database.pool.query<{ state: string }>(
      "SELECT state FROM deletion_jobs WHERE object_id = $1",
      [ids.attempt],
    );
    expect(state.rows[0]?.state).toBe("running");
  });
});

class FakeStorage implements EvidenceDeletionStorage {
  readonly aborted: string[] = [];
  readonly deleted: string[] = [];

  async abortMultipartUpload(
    objectKey: string,
    uploadId: string,
  ): Promise<void> {
    this.aborted.push(`${objectKey}:${uploadId}`);
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.deleted.push(objectKey);
  }
}

async function seedExpiredEvidence(
  database: DatabaseConnection,
): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO installations
        (id, github_installation_id, account_id, account_login)
       VALUES ($1, 'retention-installation', 'retention-account', 'acme')`,
      [ids.installation],
    );
    await client.query(
      `INSERT INTO repositories
        (id, installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $2, 'retention-repository', 'acme', 'retention', 'main')`,
      [ids.repository, ids.installation],
    );
    await client.query(
      `INSERT INTO repository_policies
        (id, repository_id, version, schema_version, policy, policy_hash,
         created_by, activated_at)
       VALUES ($1, $2, 1, '1', $3::jsonb, $4, 'system', now())`,
      [
        ids.policy,
        ids.repository,
        JSON.stringify({
          schemaVersion: "1",
          decisionMode: "maintainer_review",
          proof: {
            minimumQuestions: 1,
            maximumQuestions: 5,
            maximumDurationSeconds: 480,
            maximumUploadBytes: 134_217_728,
          },
          evidence: {
            retentionHours: 24,
            deleteAfterMaintainerPass: true,
          },
        }),
        "5".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO pull_requests
        (id, repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, 'retention-pr', 900, 'author-900', 'open')`,
      [ids.pullRequest, ids.repository],
    );
    await client.query(
      `INSERT INTO pull_request_revisions
        (id, pull_request_id, head_sha, base_sha, is_current)
       VALUES ($1, $2, $3, $4, true)`,
      [ids.revision, ids.pullRequest, headSha, "6".repeat(40)],
    );
    await client.query(
      `INSERT INTO proof_plans
        (id, revision_id, repository_policy_id, plan_version,
         deterministic_seed, risk_explanation, question_budget, plan_hash, status)
       VALUES ($1, $2, $3, 'planner-v1', 'retention-seed', '{}', 1, $4, 'ready')`,
      [ids.plan, ids.revision, ids.policy, "8".repeat(64)],
    );
    await client.query(
      `INSERT INTO proof_questions
        (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
       VALUES ($1, $2, 0, 'explain', 'Explain the exact behavior.',
               '{}'::jsonb, '{}'::jsonb, true)`,
      [ids.question, ids.plan],
    );
    await client.query(
      `INSERT INTO attempts
        (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
         status, nonce_hash, expires_at, evidence_delete_after, created_at)
       VALUES ($1, $2, $3, 'author-900', $4, $5, 'processing', $6,
               $7::timestamptz - interval '1 hour',
               $7::timestamptz - interval '1 hour',
               $7::timestamptz - interval '2 hours')`,
      [
        ids.attempt,
        ids.repository,
        ids.revision,
        ids.plan,
        headSha,
        "9".repeat(64),
        now,
      ],
    );
    await client.query(
      `INSERT INTO wrapping_materials
        (id, attempt_id, object_id, key_id, algorithm, spki_sha256, usable_until)
       VALUES ($1, $2, $3, 'sensitive-worker-key', 'RSA-OAEP-256', $4,
               $5::timestamptz - interval '1 hour')`,
      [ids.material, ids.attempt, ids.object, "a".repeat(64), now],
    );
    await client.query(
      `INSERT INTO upload_sessions
        (id, attempt_id, object_id, object_key, provider_upload_id, state,
         expires_at, manifest_digest, finalize_envelope)
       VALUES ($1, $2, $3, 'evidence/video-secret', 'sensitive-upload-id',
               'pending_finalization', $4::timestamptz - interval '1 hour', $5,
               $6::jsonb)`,
      [
        ids.upload,
        ids.attempt,
        ids.object,
        now,
        "b".repeat(64),
        JSON.stringify({
          sensitiveFinalize: "payload",
          manifest: {
            durationMs: 1_000,
            questionIntervals: [
              {
                schemaVersion: "1",
                intervalVersion: "proof-question-interval-v1",
                questionId: ids.question,
                ordinal: 0,
                startMs: 0,
                endMs: 1_000,
                recordedDurationMs: 1_000,
                source: "mobile_navigation_v1",
              },
            ],
          },
        }),
      ],
    );
    await client.query(
      `INSERT INTO proof_question_interval_sets
        (attempt_id, upload_session_id, manifest_digest, interval_version,
         maximum_question_duration_ms, recorded_duration_ms, intervals)
       VALUES ($1, $2, $3, 'proof-question-interval-v1', 120000, 1000,
               $4::jsonb)`,
      [
        ids.attempt,
        ids.upload,
        "b".repeat(64),
        JSON.stringify([
          {
            schemaVersion: "1",
            intervalVersion: "proof-question-interval-v1",
            questionId: ids.question,
            ordinal: 0,
            startMs: 0,
            endMs: 1_000,
            recordedDurationMs: 1_000,
            source: "mobile_navigation_v1",
          },
        ]),
      ],
    );
    await client.query(
      `UPDATE upload_sessions SET state = 'completed' WHERE id = $1`,
      [ids.upload],
    );
    await client.query(
      `UPDATE attempts SET status = 'review_required' WHERE id = $1`,
      [ids.attempt],
    );
    await client.query(
      `INSERT INTO recording_parts
        (upload_session_id, part_number, first_chunk_index, last_chunk_index,
         byte_length, sha256, etag)
       VALUES ($1, 1, 0, 0, 128, $2, 'sensitive-etag')`,
      [ids.upload, "c".repeat(64)],
    );
    await client.query(
      `INSERT INTO recording_objects
        (id, attempt_id, object_key, wrapped_data_key, wrapped_key_sha256,
         wrapping_material_id, protocol_version, algorithm, byte_length,
         duration_ms, codec, manifest_hash, delete_after)
       VALUES ($1, $2, 'evidence/video-secret', 'sensitive-wrapped-key', $3,
               $4, 'SP-RC1', 'AES-256-GCM', 128, 1000,
               'video/webm;codecs=vp8,opus', $5,
               $6::timestamptz - interval '1 hour')`,
      [
        ids.recording,
        ids.attempt,
        "d".repeat(64),
        ids.material,
        "e".repeat(64),
        now,
      ],
    );
    await client.query(
      `INSERT INTO transcripts
        (id, attempt_id, provider, schema_version, encrypted_payload, delete_after)
       VALUES ($1, $2, 'fake', '1', 'sensitive-transcript-envelope',
               $3::timestamptz - interval '1 hour')`,
      [ids.transcript, ids.attempt, now],
    );
    await client.query(
      `INSERT INTO frame_selections
        (id, attempt_id, timestamp_ms, reason_code, object_key, delete_after)
       VALUES ($1, $2, 500, 'quality_check', 'evidence/frame-secret',
               $3::timestamptz - interval '1 hour')`,
      [ids.frame, ids.attempt, now],
    );
    await client.query(
      `INSERT INTO evaluations
        (id, attempt_id, provider, model, prompt_version, schema_version,
         rubric_version, encrypted_payload, recommendation, delete_after)
       VALUES ($1, $2, 'fake', 'fake-v1', 'prompt-v1', '1', 'rubric-v1',
               'sensitive-evaluation-envelope', 'review_required',
               $3::timestamptz - interval '1 hour')`,
      [ids.evaluation, ids.attempt, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
