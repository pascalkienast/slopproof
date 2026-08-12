import { createHash } from "node:crypto";
import {
  PullRequestPatchSchema,
  analyzePullRequestPatch,
  type PullRequestPatch,
} from "@slopproof/analysis";
import {
  PgBossGithubCheckOutbox,
  parseJobPayload,
  persistGithubCheckIntentInTransaction,
  scheduleJobInPgTransaction,
  type JobPayload,
} from "@slopproof/db";
import {
  DEFAULT_REPOSITORY_POLICY_V1,
  RepositoryPolicyV1Schema,
  type RepositoryPolicyV1,
} from "@slopproof/policy";
import { planProof } from "@slopproof/questions";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";

const ACTIVE_ATTEMPT_STATUSES = [
  "preparing",
  "ready",
  "active",
  "uploading",
  "processing",
  "review_required",
] as const;

const GITHUB_CHECK_NAME = "SlopProof / understanding required";

export type WorkerCheckIntentWriterInput = {
  revisionId: string;
  headSha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "action_required" | "success" | "neutral" | "cancelled" | null;
  summary: string;
  reason:
    | "analysis_ready"
    | "review_required"
    | "technical_retry"
    | "attempt_expired";
  idempotencyKey: string;
};

/** DB/outbox-only boundary. Implementations must never call GitHub remotely. */
export interface CheckIntentWriter {
  write(client: PoolClient, input: WorkerCheckIntentWriterInput): Promise<void>;
}

export function createWorkerCheckIntentWriter(
  queue: PgBoss,
  appBaseUrl: string,
): CheckIntentWriter {
  const baseUrl = new URL(appBaseUrl);
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.protocol !== "https:" &&
      !(
        baseUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)
      ))
  ) {
    throw new Error("Worker check details URL must use HTTPS or loopback HTTP");
  }
  const outbox = new PgBossGithubCheckOutbox(queue);
  return {
    async write(client, input): Promise<void> {
      await persistGithubCheckIntentInTransaction(client, outbox, {
        revisionId: input.revisionId,
        expectedHeadSha: input.headSha,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        name: GITHUB_CHECK_NAME,
        status: input.status,
        conclusion: input.conclusion,
        publicSummary: input.summary,
        detailsUrl: new URL(
          `/revisions/${input.revisionId}`,
          baseUrl,
        ).toString(),
      });
    },
  };
}

export type RevisionPatchRequest = {
  revisionId: string;
  owner: string;
  repositoryName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
};

export interface RevisionPatchSource {
  loadPatch(input: RevisionPatchRequest): Promise<PullRequestPatch>;
}

/**
 * Explicit offline adapter for the fake-GitHub MVP. A productive adapter must
 * replace this with an installation-authorized, bounded patch fetch.
 */
export class LocalFakeRevisionPatchSource implements RevisionPatchSource {
  async loadPatch(input: RevisionPatchRequest): Promise<PullRequestPatch> {
    return PullRequestPatchSchema.parse({
      baseSha: input.baseSha,
      headSha: input.headSha,
      files: [
        {
          path: `pull-requests/${String(input.pullRequestNumber)}.md`,
          kind: "text",
          additions: 2,
          deletions: 1,
          patch: [
            "@@ -1,1 +1,2 @@ bounded fake-GitHub patch",
            `-Previous behavior for ${input.owner}/${input.repositoryName}.`,
            `+Updated behavior for pull request #${String(input.pullRequestNumber)}.`,
            "+The contributor must explain the observable change and recovery path.",
          ].join("\n"),
        },
      ],
    });
  }
}

export type PrepareRevisionDependencies = {
  pool: Pool;
  queue: PgBoss;
  checkIntents: CheckIntentWriter;
  patchSource: RevisionPatchSource;
  clock?: { now(): Date };
};

export type PrepareRevisionResult =
  | { outcome: "stale" | "closed" | "split_recommended" }
  | {
      outcome: "ready" | "replayed";
      attemptId: string;
      revisionId: string;
      headSha: string;
    };

type RevisionContext = {
  revision_id: string;
  repository_id: string;
  owner: string;
  repository_name: string;
  active_policy_version: number;
  pull_request_number: number;
  author_id: string;
  pull_request_state: string;
  base_sha: string;
  head_sha: string;
  is_current: boolean;
  received_at: Date;
};

export async function prepareRevision(
  rawPayload: JobPayload<"analysis.prepare-revision">,
  dependencies: PrepareRevisionDependencies,
): Promise<PrepareRevisionResult> {
  const payload = parseJobPayload("analysis.prepare-revision", rawPayload);
  const context = await loadRevisionContext(
    dependencies.pool,
    payload.revisionId,
  );
  if (
    !context ||
    !context.is_current ||
    context.head_sha !== payload.expectedHeadSha
  ) {
    return { outcome: "stale" };
  }
  if (context.pull_request_state !== "open") return { outcome: "closed" };

  const policy = await loadPolicy(dependencies.pool, context);
  const patch = PullRequestPatchSchema.parse(
    await dependencies.patchSource.loadPatch({
      revisionId: context.revision_id,
      owner: context.owner,
      repositoryName: context.repository_name,
      pullRequestNumber: context.pull_request_number,
      baseSha: context.base_sha,
      headSha: context.head_sha,
    }),
  );
  if (
    patch.baseSha !== context.base_sha ||
    patch.headSha !== context.head_sha
  ) {
    throw new Error("Patch source returned data for a different revision");
  }
  const analysis = analyzePullRequestPatch(patch);
  const proof = planProof(
    {
      analysis,
      policy,
      serverSeed: sha256(
        `proof-plan:${context.revision_id}:${context.head_sha}`,
      ),
      versions: {
        planner: "proof-planner-v1",
        questionTemplates: "proof-questions-v1",
      },
    },
    { clock: { now: () => context.received_at } },
  );
  const diffHash = sha256(JSON.stringify(patch));
  const now = dependencies.clock?.now() ?? new Date();
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<RevisionContext>(
      `${REVISION_CONTEXT_SQL} AND revision.id = $1
       FOR UPDATE OF revision, repository`,
      [payload.revisionId],
    );
    const current = locked.rows[0];
    if (
      !current ||
      !current.is_current ||
      current.head_sha !== payload.expectedHeadSha ||
      current.pull_request_state !== "open" ||
      current.active_policy_version !== context.active_policy_version
    ) {
      await client.query("ROLLBACK");
      return { outcome: "stale" };
    }

    const frozenPolicyId = await ensureDefaultPolicy(
      client,
      current,
      policy,
      now,
    );
    await client.query(
      `INSERT INTO analysis_snapshots
        (revision_id, analyzer_version, diff_hash, snapshot, status)
       VALUES ($1, $2, $3, $4::jsonb, 'ready')
       ON CONFLICT (revision_id, analyzer_version, diff_hash) DO NOTHING`,
      [
        current.revision_id,
        analysis.analyzerVersion,
        diffHash,
        JSON.stringify(analysis),
      ],
    );

    if (proof.status === "split_recommended") {
      await dependencies.checkIntents.write(client, {
        revisionId: current.revision_id,
        headSha: current.head_sha,
        status: "completed",
        conclusion: "action_required",
        summary: `split or narrow the pull request for head ${current.head_sha}`,
        reason: "analysis_ready",
        idempotencyKey: payload.idempotencyKey,
      });
      await insertAuditOnce(client, {
        action: "analysis.split_recommended",
        objectId: current.revision_id,
        metadata: { headSha: current.head_sha, diffHash },
      });
      await client.query("COMMIT");
      return { outcome: "split_recommended" };
    }

    await client.query(
      `INSERT INTO proof_plans
        (id, revision_id, repository_policy_id, plan_version,
         deterministic_seed, risk_explanation, question_budget, plan_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'ready')
       ON CONFLICT (id) DO NOTHING`,
      [
        proof.id,
        current.revision_id,
        frozenPolicyId,
        proof.plannerVersion,
        proof.seedCommitment,
        JSON.stringify({
          title: `PR #${String(current.pull_request_number)}`,
          riskLevel: proof.riskLevel,
          rationale: proof.rationale,
        }),
        proof.questionBudget,
        proof.planHash,
      ],
    );
    const persistedPlan = await client.query<{
      plan_hash: string;
      repository_policy_id: string;
    }>(
      "SELECT plan_hash, repository_policy_id FROM proof_plans WHERE id = $1",
      [proof.id],
    );
    if (
      persistedPlan.rows[0]?.plan_hash !== proof.planHash ||
      persistedPlan.rows[0]?.repository_policy_id !== frozenPolicyId
    ) {
      throw new Error("Deterministic proof plan conflicts with persisted data");
    }
    for (const question of proof.questions) {
      await client.query(
        `INSERT INTO proof_questions
          (id, proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, true)
         ON CONFLICT (proof_plan_id, ordinal) DO NOTHING`,
        [
          question.id,
          proof.id,
          question.order - 1,
          question.intent,
          question.prompt,
          JSON.stringify(question.anchor),
          JSON.stringify(question.rubric),
        ],
      );
    }

    const active = await client.query<{ id: string; expires_at: Date }>(
      `SELECT id, expires_at FROM attempts
       WHERE revision_id = $1 AND author_id = $2
         AND status = ANY($3::attempt_status[])
       ORDER BY created_at DESC LIMIT 1`,
      [current.revision_id, current.author_id, ACTIVE_ATTEMPT_STATUSES],
    );
    let attemptId = active.rows[0]?.id;
    let expiresAt = active.rows[0]?.expires_at;
    let created = false;
    if (!attemptId || !expiresAt) {
      const history = await client.query<{
        id: string;
        status: string;
        ordinal: number;
      }>(
        `SELECT id, status,
                count(*) OVER ()::int AS ordinal
         FROM attempts
         WHERE revision_id = $1 AND author_id = $2
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [current.revision_id, current.author_id],
      );
      const latest = history.rows[0];
      if (latest && latest.status !== "invalidated") {
        await client.query("COMMIT");
        return {
          outcome: "replayed",
          attemptId: latest.id,
          revisionId: current.revision_id,
          headSha: current.head_sha,
        };
      }
      const ordinal = (latest?.ordinal ?? 0) + 1;
      attemptId = deterministicUuid(
        `attempt:${current.revision_id}:${current.author_id}:${proof.id}:${String(ordinal)}`,
      );
      expiresAt = new Date(now.getTime() + 8 * 60 * 60_000);
      await client.query(
        `INSERT INTO attempts
          (id, repository_id, revision_id, author_id, proof_plan_id, head_sha,
           status, nonce_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          attemptId,
          current.repository_id,
          current.revision_id,
          current.author_id,
          proof.id,
          current.head_sha,
          sha256(`attempt-nonce:${attemptId}`),
          expiresAt,
        ],
      );
      created = true;
    }

    await scheduleJobInPgTransaction(
      dependencies.queue,
      client,
      "proof.expire-attempt",
      {
        schemaVersion: "1",
        idempotencyKey: `attempt-expiry:${attemptId}:${current.head_sha}`,
        attemptId,
        expectedHeadSha: current.head_sha,
      },
      expiresAt,
    );
    await dependencies.checkIntents.write(client, {
      revisionId: current.revision_id,
      headSha: current.head_sha,
      status: "in_progress",
      conclusion: null,
      summary: `proof ready for head ${current.head_sha}`,
      reason: "analysis_ready",
      idempotencyKey: payload.idempotencyKey,
    });
    await insertAuditOnce(client, {
      action: "analysis.proof_ready",
      objectId: attemptId,
      metadata: {
        revisionId: current.revision_id,
        headSha: current.head_sha,
        planId: proof.id,
      },
    });
    await client.query("COMMIT");
    return {
      outcome: created ? "ready" : "replayed",
      attemptId,
      revisionId: current.revision_id,
      headSha: current.head_sha,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const REVISION_CONTEXT_SQL = `
  SELECT revision.id AS revision_id, repository.id AS repository_id,
         repository.owner, repository.name AS repository_name,
         repository.active_policy_version, pull_request.number AS pull_request_number,
         pull_request.author_id, pull_request.state AS pull_request_state,
         revision.base_sha, revision.head_sha, revision.is_current,
         revision.received_at
  FROM pull_request_revisions revision
  JOIN pull_requests pull_request ON pull_request.id = revision.pull_request_id
  JOIN repositories repository ON repository.id = pull_request.repository_id
  WHERE true`;

async function loadRevisionContext(
  pool: Pool,
  revisionId: string,
): Promise<RevisionContext | undefined> {
  const result = await pool.query<RevisionContext>(
    `${REVISION_CONTEXT_SQL} AND revision.id = $1`,
    [revisionId],
  );
  return result.rows[0];
}

async function loadPolicy(
  pool: Pool,
  context: RevisionContext,
): Promise<RepositoryPolicyV1> {
  const result = await pool.query<{ policy: unknown }>(
    `SELECT policy FROM repository_policies
     WHERE repository_id = $1 AND version = $2`,
    [context.repository_id, context.active_policy_version],
  );
  if (!result.rows[0]) {
    if (context.active_policy_version !== 1) {
      throw new Error("The active repository policy is missing");
    }
    return DEFAULT_REPOSITORY_POLICY_V1;
  }
  return RepositoryPolicyV1Schema.parse(result.rows[0].policy);
}

async function ensureDefaultPolicy(
  client: PoolClient,
  context: RevisionContext,
  policy: RepositoryPolicyV1,
  now: Date,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM repository_policies
     WHERE repository_id = $1 AND version = $2`,
    [context.repository_id, context.active_policy_version],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  if (
    context.active_policy_version !== 1 ||
    JSON.stringify(policy) !== JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1)
  ) {
    throw new Error("The active repository policy disappeared during analysis");
  }
  const serialized = JSON.stringify(DEFAULT_REPOSITORY_POLICY_V1);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO repository_policies
      (repository_id, version, schema_version, policy, policy_hash,
       created_by, activated_at)
     VALUES ($1, 1, '1', $2::jsonb, $3, 'system-default', $4)
     ON CONFLICT (repository_id, version) DO NOTHING
     RETURNING id`,
    [context.repository_id, serialized, sha256(serialized), now],
  );
  const raced = inserted.rows[0]
    ? inserted
    : await client.query<{ id: string }>(
        `SELECT id FROM repository_policies
         WHERE repository_id = $1 AND version = $2`,
        [context.repository_id, context.active_policy_version],
      );
  const id = raced.rows[0]?.id;
  if (!id) throw new Error("Could not freeze the repository policy");
  return id;
}

async function insertAuditOnce(
  client: PoolClient,
  input: {
    action: string;
    objectId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (actor_id, action, object_type, object_id, metadata)
     SELECT 'analysis-worker', $1, 'attempt', $2, $3::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_events
       WHERE action = $1 AND object_type = 'attempt' AND object_id = $2
     )`,
    [input.action, input.objectId, JSON.stringify(input.metadata)],
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
