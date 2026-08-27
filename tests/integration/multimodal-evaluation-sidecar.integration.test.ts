import {
  connectDatabase,
  migrateDatabase,
  type DatabaseConnection,
} from "@slopproof/db";
import { DEFAULT_REPOSITORY_POLICY_V1 } from "@slopproof/policy";
import {
  PayloadCipher,
  multimodalJudgeCandidateHashV1,
  type ProofEvaluationV1,
} from "@slopproof/providers";
import {
  PostgresMultimodalEvaluationRepository,
  type PersistMultimodalEvaluationPairInput,
} from "../../apps/worker/src/multimodal-evaluation-repository";
import type { MultimodalProofEvaluationV1 } from "../../apps/worker/src/multimodal-judge-service";
import { PostgresRetentionPersistence } from "../../apps/worker/src/retention";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;
const ids = {
  installation: "93000000-0000-4000-8000-000000000001",
  repository: "93000000-0000-4000-8000-000000000002",
  policy: "93000000-0000-4000-8000-000000000003",
  pullRequest: "93000000-0000-4000-8000-000000000004",
  revision: "93000000-0000-4000-8000-000000000005",
  plan: "93000000-0000-4000-8000-000000000006",
  question: "93000000-0000-4000-8000-000000000007",
  criterion: "93000000-0000-4000-8000-000000000008",
  sentinel: "93000000-0000-4000-8000-000000000009",
  attempt: "93000000-0000-4000-8000-000000000010",
  material: "93000000-0000-4000-8000-000000000011",
  materialObject: "93000000-0000-4000-8000-000000000012",
  recording: "93000000-0000-4000-8000-000000000013",
  transcript: "93000000-0000-4000-8000-000000000014",
  evaluation: "93000000-0000-4000-8000-000000000015",
  deletion: "93000000-0000-4000-8000-000000000016",
} as const;
const headSha = "3".repeat(40);
const baseSha = "4".repeat(40);
const inputHash = "5".repeat(64);

databaseDescribe("authoritative multimodal sidecar PostgreSQL contract", () => {
  let database: DatabaseConnection;
  let cipher: PayloadCipher;
  let createdAt: Date;
  let deleteAfter: Date;

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
        multimodal_evaluation_sidecars_v1, audit_events, deletion_jobs,
        check_runs, review_decisions, evaluations, frame_selections,
        transcripts, recording_objects, recording_parts, upload_sessions,
        wrapping_materials, handoff_tokens, auth_sessions, attempt_transitions,
        attempts, proof_questions, proof_plans, practice_sessions,
        analysis_snapshots, webhook_deliveries, pull_request_revisions,
        pull_requests, repository_policies, repositories, installations, github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
    createdAt = new Date();
    deleteAfter = new Date(createdAt.getTime() + 3 * 60 * 60_000);
    let nonce = 0;
    cipher = new PayloadCipher(new Uint8Array(32).fill(0x35), (length) => {
      nonce += 1;
      return new Uint8Array(length).fill(nonce);
    });
    await seedAttempt(database, deleteAfter);
  });

  it("persists, exact-replays, rejects conflicts and mutation, then retention-shreds with audit evidence", async () => {
    const repository = new PostgresMultimodalEvaluationRepository(
      database,
      cipher,
    );
    const input = pairInput(cipher, createdAt, deleteAfter);

    const created = await repository.persistPair(input);
    expect(created).toMatchObject({
      status: "created",
      downstreamScheduled: false,
      compatibilityEvaluation: {
        evaluationId: ids.evaluation,
        provider: "multimodal-compatibility-v1",
        model: "manual-review-projection-v1",
        recommendation: "review_required",
      },
      multimodalEvaluation: {
        candidate: {
          questionEvaluations: [
            {
              criterionResults: [
                expect.objectContaining({ result: "not_evaluable" }),
              ],
              contradictions: ["transcript_conflicts_with_patch_evidence"],
              uncertainty: ["criterion_requires_maintainer_assessment"],
            },
          ],
        },
      },
    });

    const replay = await repository.loadExistingAndSchedule({
      attemptId: ids.attempt,
      transcriptId: ids.transcript,
      expectedHeadSha: headSha,
      downstreamJobBase: {
        schemaVersion: "1",
        idempotencyKey: "gate6:integration:replay",
        attemptId: ids.attempt,
        expectedHeadSha: headSha,
      },
    });
    expect(replay).toEqual({
      sidecarId: created.sidecarId,
      multimodalEvaluation: input.multimodalEvaluation,
      compatibilityEvaluation: input.compatibilityEvaluation,
      downstreamScheduled: false,
    });
    await expect(repository.persistPair(input)).resolves.toMatchObject({
      status: "replayed",
      sidecarId: created.sidecarId,
    });
    await expect(
      repository.persistPair(conflictingPairInput(input)),
    ).rejects.toThrow("Conflicting multimodal evaluation replay");
    await expect(
      database.pool.query(
        "UPDATE multimodal_evaluation_sidecars_v1 SET provider = 'tampered' WHERE attempt_id = $1",
        [ids.attempt],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      database.pool.query(
        "DELETE FROM multimodal_evaluation_sidecars_v1 WHERE attempt_id = $1",
        [ids.attempt],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await database.pool.query(
      `INSERT INTO deletion_jobs
         (id, object_class, object_id, deadline, state)
       VALUES ($1, 'attempt_evidence', $2, $3, 'running')`,
      [ids.deletion, ids.attempt, deleteAfter],
    );
    const retention = new PostgresRetentionPersistence(
      database,
      {} as ConstructorParameters<typeof PostgresRetentionPersistence>[1],
    );
    const retentionNow = new Date(deleteAfter.getTime() + 1_000);
    await retention.completeDeletion(
      {
        deletionJobId: ids.deletion,
        attemptId: ids.attempt,
        objectKeys: ["evidence/gate6-sidecar.enc"],
        multipartUploads: [],
      },
      retentionNow,
    );

    const shredded = await database.pool.query<{
      encrypted_payload: unknown | null;
      deleted_at: Date | null;
      compatibility_payload: string;
      deletion_state: string;
      audit_metadata: Record<string, unknown>;
    }>(
      `SELECT sidecar.encrypted_payload, sidecar.deleted_at,
              evaluation.encrypted_payload AS compatibility_payload,
              deletion.state AS deletion_state,
              audit.metadata AS audit_metadata
         FROM multimodal_evaluation_sidecars_v1 sidecar
         JOIN evaluations evaluation ON evaluation.id = sidecar.evaluation_id
         JOIN deletion_jobs deletion ON deletion.id = $2
         JOIN audit_events audit ON audit.object_id = sidecar.attempt_id::text
          AND audit.action = 'evidence.deleted'
        WHERE sidecar.attempt_id = $1`,
      [ids.attempt, ids.deletion],
    );
    expect(shredded.rows).toEqual([
      expect.objectContaining({
        encrypted_payload: null,
        deleted_at: retentionNow,
        compatibility_payload: "",
        deletion_state: "completed",
        audit_metadata: {
          deletionJobId: ids.deletion,
          multimodalSidecarsShredded: 1,
        },
      }),
    ]);
    expect(JSON.stringify(shredded.rows)).not.toContain(
      "transcript_conflicts_with_patch_evidence",
    );
    await expect(
      repository.loadExistingAndSchedule({
        attemptId: ids.attempt,
        transcriptId: ids.transcript,
        expectedHeadSha: headSha,
        downstreamJobBase: {
          schemaVersion: "1",
          idempotencyKey: "gate6:integration:after-retention",
          attemptId: ids.attempt,
          expectedHeadSha: headSha,
        },
      }),
    ).rejects.toThrow("Authoritative multimodal evaluation is unavailable");
  });

  it("serializes a concurrent exact race into one pair", async () => {
    const repository = new PostgresMultimodalEvaluationRepository(
      database,
      cipher,
    );
    const input = pairInput(cipher, createdAt, deleteAfter);

    const outcomes = await Promise.all([
      repository.persistPair(input),
      repository.persistPair(input),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "created",
      "replayed",
    ]);
    const counts = await database.pool.query<{
      evaluations: number;
      sidecars: number;
    }>(
      `SELECT (SELECT count(*)::int FROM evaluations) AS evaluations,
              (SELECT count(*)::int FROM multimodal_evaluation_sidecars_v1)
                AS sidecars`,
    );
    expect(counts.rows[0]).toEqual({ evaluations: 1, sidecars: 1 });
  });

  it("rolls back the compatibility row on a real sidecar-insert crash", async () => {
    await database.pool.query(`
      CREATE FUNCTION gate6_test_reject_sidecar_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic sidecar crash' USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER gate6_test_sidecar_crash
      BEFORE INSERT ON multimodal_evaluation_sidecars_v1
      FOR EACH ROW EXECUTE FUNCTION gate6_test_reject_sidecar_insert();
    `);
    try {
      const repository = new PostgresMultimodalEvaluationRepository(
        database,
        cipher,
      );
      await expect(
        repository.persistPair(pairInput(cipher, createdAt, deleteAfter)),
      ).rejects.toThrow(
        "Authoritative multimodal evaluation persistence failed",
      );
      const counts = await database.pool.query<{
        evaluations: number;
        sidecars: number;
      }>(
        `SELECT (SELECT count(*)::int FROM evaluations) AS evaluations,
                (SELECT count(*)::int FROM multimodal_evaluation_sidecars_v1)
                  AS sidecars`,
      );
      expect(counts.rows[0]).toEqual({ evaluations: 0, sidecars: 0 });
    } finally {
      await database.pool.query(`
        DROP TRIGGER gate6_test_sidecar_crash
          ON multimodal_evaluation_sidecars_v1;
        DROP FUNCTION gate6_test_reject_sidecar_insert();
      `);
    }
  });

  it("rolls both artifacts back when atomic downstream scheduling fails", async () => {
    const queue = {
      async findJobs() {
        throw new Error("synthetic transactional queue failure");
      },
    } as unknown as ConstructorParameters<
      typeof PostgresMultimodalEvaluationRepository
    >[2];
    const repository = new PostgresMultimodalEvaluationRepository(
      database,
      cipher,
      queue,
    );

    await expect(
      repository.persistPair(pairInput(cipher, createdAt, deleteAfter)),
    ).rejects.toThrow("Authoritative multimodal evaluation persistence failed");
    const counts = await database.pool.query<{
      evaluations: number;
      sidecars: number;
    }>(
      `SELECT (SELECT count(*)::int FROM evaluations) AS evaluations,
              (SELECT count(*)::int FROM multimodal_evaluation_sidecars_v1)
                AS sidecars`,
    );
    expect(counts.rows[0]).toEqual({ evaluations: 0, sidecars: 0 });
  });
});

async function seedAttempt(database: DatabaseConnection, deadline: Date) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO installations
         (id, github_installation_id, account_id, account_login)
       VALUES ($1, 'gate6-sidecar-installation', 'gate6-account', 'acme')`,
      [ids.installation],
    );
    await client.query(
      `INSERT INTO repositories
         (id, installation_id, github_repository_id, owner, name, default_branch)
       VALUES ($1, $2, 'gate6-sidecar-repository', 'acme', 'sidecar', 'main')`,
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
        JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1),
        "6".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO pull_requests
         (id, repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, 'gate6-sidecar-pr', 930, 'author-930', 'open')`,
      [ids.pullRequest, ids.repository],
    );
    await client.query(
      `INSERT INTO pull_request_revisions
         (id, pull_request_id, head_sha, base_sha, is_current)
       VALUES ($1, $2, $3, $4, true)`,
      [ids.revision, ids.pullRequest, headSha, baseSha],
    );
    await client.query(
      `INSERT INTO proof_plans
         (id, revision_id, repository_policy_id, plan_version,
          deterministic_seed, risk_explanation, question_budget, plan_hash,
          status)
       VALUES ($1, $2, $3, 'proof-planner-v1', 'gate6-sidecar-seed',
               '{}'::jsonb, 1, $4, 'ready')`,
      [ids.plan, ids.revision, ids.policy, "7".repeat(64)],
    );
    await client.query(
      `INSERT INTO proof_questions
         (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
       VALUES ($1, $2, 0, 'explain', 'Explain the bounded change.',
               '{}'::jsonb, '{}'::jsonb, true)`,
      [ids.question, ids.plan],
    );
    await client.query(
      `INSERT INTO attempts
         (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
          status, nonce_hash, expires_at, started_at, evidence_delete_after)
       VALUES ($1, $2, $3, 'author-930', $4, $5, 'processing', $6,
               $7::timestamptz + interval '3 hours', now(), $7)`,
      [
        ids.attempt,
        ids.repository,
        ids.revision,
        ids.plan,
        headSha,
        "8".repeat(64),
        deadline,
      ],
    );
    await client.query(
      `INSERT INTO wrapping_materials
         (id, attempt_id, object_id, key_id, algorithm, spki_sha256, usable_until)
       VALUES ($1, $2, $3, 'gate6-sidecar-key', 'RSA-OAEP-256', $4, $5)`,
      [ids.material, ids.attempt, ids.materialObject, "9".repeat(64), deadline],
    );
    await client.query(
      `INSERT INTO recording_objects
         (id, attempt_id, object_key, wrapped_data_key, wrapped_key_sha256,
          wrapping_material_id, protocol_version, algorithm, byte_length,
          duration_ms, codec, manifest_hash, delete_after)
       VALUES ($1, $2, 'evidence/gate6-sidecar.enc', 'wrapped-secret', $3,
               $4, 'SP-RC1', 'AES-256-GCM', 1024, 60000,
               'video/webm;codecs=vp9,opus', $5, $6)`,
      [
        ids.recording,
        ids.attempt,
        "a".repeat(64),
        ids.material,
        "b".repeat(64),
        deadline,
      ],
    );
    await client.query(
      `INSERT INTO transcripts
         (id, attempt_id, provider, schema_version, encrypted_payload,
          delete_after)
       VALUES ($1, $2, 'openrouter', 'transcript-v1',
               'opaque-transcript-envelope', $3)`,
      [ids.transcript, ids.attempt, deadline],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function pairInput(
  cipher: PayloadCipher,
  now: Date,
  deadline: Date,
): PersistMultimodalEvaluationPairInput {
  const candidate = {
    schemaVersion: "1" as const,
    candidateVersion: "multimodal-judge-candidate-v1" as const,
    recommendation: "review_required" as const,
    questionEvaluations: [
      {
        questionId: ids.question,
        criterionResults: [
          {
            criterionId: ids.criterion,
            result: "not_evaluable" as const,
            supportedPatchAnchorIds: [],
            reason: "question_evidence_insufficient" as const,
          },
        ],
        contradictions: ["transcript_conflicts_with_patch_evidence" as const],
        uncertainty: ["criterion_requires_maintainer_assessment" as const],
      },
    ],
    privateReason: "stored_criteria_not_fully_supported" as const,
    warnings: ["frames_unavailable" as const],
  };
  const multimodalEvaluation: MultimodalProofEvaluationV1 = {
    schemaVersion: "1",
    evaluationVersion: "multimodal-proof-evaluation-v1",
    attemptId: ids.attempt,
    revisionId: ids.revision,
    headSha,
    candidate,
    invocationMetadata: {
      schemaVersion: "1",
      provider: "hetzner",
      model: `private-model-${"m".repeat(85)}`,
      promptVersion: "proof-judge-system-v2",
      outputSchemaVersion: "multimodal-judge-candidate-v1",
      inputHash,
      outputHash: multimodalJudgeCandidateHashV1(candidate),
      tokenUsage: { inputTokens: 100, outputTokens: 30 },
      latencyMs: 250,
      invocationCount: 1,
      outcome: "generated",
      degraded: false,
      completedAt: new Date(now.getTime() - 1_000),
    },
    frameWarnings: ["frames_unavailable"],
    workflowOutcome: "review_required",
    manualReviewRequired: true,
    createdAt: now,
  };
  const compatibility: ProofEvaluationV1 = {
    schemaVersion: "1",
    evaluationVersion: "proof-evaluation-v1",
    attemptId: ids.attempt,
    revisionId: ids.revision,
    headSha,
    provider: "multimodal-compatibility-v1",
    model: "manual-review-projection-v1",
    systemInstructionVersion: "proof-judge-system-v1",
    recommendation: "review_required",
    questionEvaluations: [
      {
        questionId: ids.question,
        outcome: "not_evaluable",
        rubricFindings: [
          {
            criterionId: ids.sentinel,
            result: "met",
            reason:
              "Compatibility-only sentinel; consult authoritative sidecar.",
          },
        ],
        supportedPatchAnchorIds: [],
        reason: "Compatibility-only manual-review projection.",
      },
    ],
    privateReason: "Compatibility-only projection; maintainer review required.",
    warnings: ["authoritative_multimodal_sidecar_required"],
    createdAt: now,
  };
  const compatibilityEnvelope = cipher.encryptJson(
    compatibility,
    `slopproof:evaluation:v1:${ids.attempt}:${ids.evaluation}`,
  );
  return {
    multimodalEvaluation,
    evaluationInputHash: inputHash,
    transcriptId: ids.transcript,
    deleteAfter: deadline,
    compatibilityEvaluation: {
      schemaVersion: "1",
      payloadKind: "proof_evaluation",
      evaluationId: ids.evaluation,
      attemptId: ids.attempt,
      provider: compatibility.provider,
      model: compatibility.model,
      promptVersion: compatibility.systemInstructionVersion,
      evaluationSchemaVersion: compatibility.evaluationVersion,
      rubricVersion: "rubric-v1",
      recommendation: "review_required",
      encryptedPayload: JSON.stringify(compatibilityEnvelope),
      deleteAfter: deadline,
    },
    downstreamJob: {
      schemaVersion: "1",
      idempotencyKey: "gate6:integration:persist",
      attemptId: ids.attempt,
      evaluationId: ids.evaluation,
      expectedHeadSha: headSha,
    },
  };
}

function conflictingPairInput(
  input: PersistMultimodalEvaluationPairInput,
): PersistMultimodalEvaluationPairInput {
  const candidate = {
    ...input.multimodalEvaluation.candidate,
    warnings: ["provider_evaluation_unavailable" as const],
  };
  return {
    ...input,
    multimodalEvaluation: {
      ...input.multimodalEvaluation,
      candidate,
      invocationMetadata: {
        ...input.multimodalEvaluation.invocationMetadata,
        outputHash: multimodalJudgeCandidateHashV1(candidate),
      },
    },
  };
}
