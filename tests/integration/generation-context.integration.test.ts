import { createHash } from "node:crypto";
import {
  connectDatabase,
  migrateDatabase,
  persistGithubRevisionSourceInTransaction,
  type DatabaseConnection,
} from "@slopproof/db";
import { analyzePullRequestPatch } from "../../packages/analysis/src/index";
import {
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  buildGenerationContextV1,
  canonicalGenerationContextMaterialV1,
  canonicalGenerationProviderMaterialV1,
  githubRevisionSourceHash,
  type BoundedRevisionSourceV1,
  type GenerationContextV1,
} from "../../packages/analysis/src/generation-context";
import {
  GenerationContextPersistenceError,
  loadGenerationContextV1,
  persistGenerationContextV1InTransaction,
} from "../../apps/worker/src/generation-context-repository";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseDescribe = databaseUrl ? describe : describe.skip;

const INSTALLATION_ID = "71000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "71000000-0000-4000-8000-000000000002";
const PULL_REQUEST_ID = "71000000-0000-4000-8000-000000000003";
const REVISION_ID = "71000000-0000-4000-8000-000000000004";
const ANALYSIS_ID = "71000000-0000-4000-8000-000000000005";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

databaseDescribe("GenerationContextV1 PostgreSQL persistence", () => {
  let database: DatabaseConnection;
  let boundedSource: BoundedRevisionSourceV1;
  let context: GenerationContextV1;

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
        generation_contexts, github_revision_sources, analysis_snapshots,
        pull_request_revisions, pull_requests, repositories, installations, github_app_account_allowlist
      RESTART IDENTITY CASCADE
    `);
    const seeded = await seedRevision(database);
    boundedSource = seeded.boundedSource;
    context = seeded.context;
  });

  it("persists exactly once under concurrency and loads the immutable binding", async () => {
    const outcomes = await Promise.all([
      persistInOwnTransaction(database, context),
      persistInOwnTransaction(database, context),
      persistInOwnTransaction(database, context),
    ]);

    expect(outcomes.filter((outcome) => !outcome.replay)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.replay)).toHaveLength(2);
    expect(new Set(outcomes.map((outcome) => outcome.id))).toHaveLength(1);

    await expect(
      loadGenerationContextV1(database.pool, {
        revisionId: REVISION_ID,
        analysisSnapshotId: ANALYSIS_ID,
        headSha: HEAD_SHA,
      }),
    ).resolves.toMatchObject({ context });
    await expect(
      database.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM generation_contexts",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("matches the existing canonical github_revision_sources hash contract", async () => {
    const stored = await database.pool.query<{ source_hash: string }>(
      "SELECT source_hash FROM github_revision_sources WHERE revision_id = $1",
      [REVISION_ID],
    );
    expect(stored.rows).toEqual([{ source_hash: boundedSource.sourceHash }]);
    expect(context.sourceHash).toBe(boundedSource.sourceHash);
  });

  it("rejects a different valid context for the same analysis snapshot", async () => {
    await persistInOwnTransaction(database, context);
    const analysis = analyzePullRequestPatch(
      boundedRevisionSourcePatch(boundedSource),
    );
    const conflicting = buildGenerationContextV1({
      revisionId: REVISION_ID,
      analysisSnapshotId: ANALYSIS_ID,
      boundedSource,
      analysis,
      excerpts: [
        {
          path: "src/cache.ts",
          side: "head",
          startLine: 1,
          endLine: 1,
          content: "return cache.get(key) ?? null;",
        },
      ],
    });
    expect(conflicting.contextHash).not.toBe(context.contextHash);

    await expect(
      persistInOwnTransaction(database, conflicting),
    ).rejects.toBeInstanceOf(GenerationContextPersistenceError);
  });

  it("enforces exact source, SHA, snapshot, and anchor binding in PostgreSQL", async () => {
    const unknownAnchorContext = {
      ...context,
      contextHash: "c".repeat(64),
      allowedAnchorIds: ["a999"],
    };
    await expect(
      insertRawContext(database, unknownAnchorContext),
    ).rejects.toMatchObject({ code: "23514" });

    const wrongSourceContext = {
      ...context,
      contextHash: "d".repeat(64),
      sourceHash: "e".repeat(64),
    };
    await expect(
      insertRawContext(database, wrongSourceContext),
    ).rejects.toMatchObject({ code: "23514" });

    const wrongHeadContext = {
      ...context,
      contextHash: "e".repeat(64),
      headSha: "f".repeat(40),
    };
    await expect(
      insertRawContext(database, wrongHeadContext),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      database.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM generation_contexts",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("blocks update and deletion after a successful insert", async () => {
    const persisted = await persistInOwnTransaction(database, context);

    await expect(
      database.pool.query(
        "UPDATE generation_contexts SET created_at = now() WHERE id = $1",
        [persisted.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      database.pool.query("DELETE FROM generation_contexts WHERE id = $1", [
        persisted.id,
      ]),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      database.pool.query(
        `UPDATE analysis_snapshots
            SET snapshot = jsonb_set(snapshot, '{summary}', '"tampered"')
          WHERE id = $1`,
        [ANALYSIS_ID],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      database.pool.query(
        "UPDATE pull_request_revisions SET base_sha = $2 WHERE id = $1",
        [REVISION_ID, "c".repeat(40)],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects snapshot/revision base drift and exact anchor descriptor tampering", async () => {
    await database.pool.query(
      `UPDATE analysis_snapshots
          SET snapshot = jsonb_set(snapshot, '{baseSha}', to_jsonb($2::text))
        WHERE id = $1`,
      [ANALYSIS_ID, "c".repeat(40)],
    );
    await expect(insertRawContext(database, context)).rejects.toMatchObject({
      code: "23514",
    });

    await database.pool.query(
      `UPDATE analysis_snapshots
          SET snapshot = jsonb_set(snapshot, '{baseSha}', to_jsonb($2::text))
        WHERE id = $1`,
      [ANALYSIS_ID, BASE_SHA],
    );
    await database.pool.query(
      "UPDATE pull_request_revisions SET base_sha = $2 WHERE id = $1",
      [REVISION_ID, "c".repeat(40)],
    );
    await expect(insertRawContext(database, context)).rejects.toMatchObject({
      code: "23514",
    });

    await database.pool.query(
      "UPDATE pull_request_revisions SET base_sha = $2 WHERE id = $1",
      [REVISION_ID, BASE_SHA],
    );
    const tamperedAnchor = {
      ...context,
      anchors: context.anchors.map((anchor, index) =>
        index === 0
          ? {
              ...anchor,
              evidence: { ...anchor.evidence, content: "cross-hunk tamper" },
            }
          : anchor,
      ),
    };
    await expect(
      insertRawContext(database, tamperedAnchor),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects context JSON tampering even when the claimed hash is unchanged", async () => {
    const canonicalMaterial = canonicalGenerationContextMaterialV1(context);
    const providerMaterial = canonicalGenerationProviderMaterialV1(context);
    const tampered = {
      ...context,
      title: { ...context.title, content: "tampered title" },
    };
    await expect(
      database.pool.query(
        `INSERT INTO generation_contexts
           (revision_id, analysis_snapshot_id, head_sha, analyzer_version,
            context_version, context_hash, canonical_material, provider_material,
            source_hash, allowed_anchor_ids, limits, exclusions, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
                 $11::jsonb, $12::jsonb, $13::jsonb)`,
        [
          context.revisionId,
          context.analysisSnapshotId,
          context.headSha,
          context.analyzerVersion,
          context.contextVersion,
          context.contextHash,
          canonicalMaterial,
          providerMaterial,
          context.sourceHash,
          JSON.stringify(context.allowedAnchorIds),
          JSON.stringify(context.limits),
          JSON.stringify(context.exclusions),
          JSON.stringify(tampered),
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("serializes snapshot mutation against context insertion", async () => {
    const contextClient = await database.pool.connect();
    const mutationClient = await database.pool.connect();
    let contextComplete = false;
    let mutationComplete = false;
    try {
      await contextClient.query("BEGIN");
      await mutationClient.query("BEGIN");
      const mutationPid = await mutationClient.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await contextClient.query(
        "SELECT id FROM analysis_snapshots WHERE id = $1 FOR SHARE",
        [ANALYSIS_ID],
      );
      const mutation = mutationClient.query(
        `UPDATE analysis_snapshots
            SET snapshot = jsonb_set(snapshot, '{summary}', '"raced"')
          WHERE id = $1`,
        [ANALYSIS_ID],
      );
      await waitForLock(database, mutationPid.rows[0]!.pid);

      await persistGenerationContextV1InTransaction(contextClient, context);
      await contextClient.query("COMMIT");
      contextComplete = true;
      await expect(mutation).rejects.toMatchObject({ code: "55000" });
      await mutationClient.query("ROLLBACK");
      mutationComplete = true;
      await expect(
        loadGenerationContextV1(database.pool, {
          revisionId: REVISION_ID,
          analysisSnapshotId: ANALYSIS_ID,
          headSha: HEAD_SHA,
        }),
      ).resolves.toMatchObject({ context });
    } finally {
      if (!contextComplete) {
        await contextClient.query("ROLLBACK").catch(() => undefined);
      }
      contextClient.release();
      if (!mutationComplete) {
        await mutationClient.query("ROLLBACK").catch(() => undefined);
      }
      mutationClient.release();
    }
  });

  it("requires every new proof plan and question to bind the exact context", async () => {
    const persisted = await persistInOwnTransaction(database, context);
    const policy = await database.pool.query<{ id: string }>(
      `INSERT INTO repository_policies
         (repository_id, version, schema_version, policy, policy_hash,
          created_by, activated_at)
       VALUES ($1, 1, '1', '{}'::jsonb, $2, 'test', now())
       RETURNING id`,
      [REPOSITORY_ID, "f".repeat(64)],
    );
    const planId = "71000000-0000-4000-8000-000000000006";
    const planValues = [
      planId,
      REVISION_ID,
      policy.rows[0]!.id,
      "proof-planner-v1",
      "seed",
      JSON.stringify({}),
      1,
      "e".repeat(64),
    ];
    await expect(
      database.pool.query(
        `INSERT INTO proof_plans
           (id, revision_id, repository_policy_id, plan_version,
            deterministic_seed, risk_explanation, question_budget, plan_hash,
            status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'ready')`,
        planValues,
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await database.pool.query(
      `INSERT INTO proof_plans
         (id, revision_id, generation_context_id, repository_policy_id,
          plan_version, deterministic_seed, risk_explanation, question_budget,
          plan_hash, status)
       VALUES ($1, $2, $9, $3, $4, $5, $6::jsonb, $7, $8, 'ready')`,
      [...planValues, persisted.id],
    );
    await expect(
      database.pool.query(
        `INSERT INTO proof_questions
           (proof_plan_id, ordinal, type, prompt, diff_anchor, rubric, required)
         VALUES ($1, 0, 'explain', 'prompt', $2::jsonb, '{}'::jsonb, true)`,
        [planId, JSON.stringify({ ...context.anchors[0], id: "a999" })],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

async function waitForLock(
  database: DatabaseConnection,
  backendPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await database.pool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [backendPid],
    );
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Snapshot mutation did not reach the lock barrier");
}

async function seedRevision(database: DatabaseConnection): Promise<{
  boundedSource: BoundedRevisionSourceV1;
  context: GenerationContextV1;
}> {
  const source = sourceFixture();
  const sourceHash = githubRevisionSourceHash(source);
  const boundedSource = buildBoundedRevisionSourceV1(source);
  const patch = boundedRevisionSourcePatch(boundedSource);
  const analysis = analyzePullRequestPatch(patch);
  const diffHash = createHash("sha256")
    .update(JSON.stringify(patch), "utf8")
    .digest("hex");
  const context = buildGenerationContextV1({
    revisionId: REVISION_ID,
    analysisSnapshotId: ANALYSIS_ID,
    boundedSource,
    analysis,
  });

  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO installations
         (id, github_installation_id, account_id, account_login, status)
       VALUES ($1, '7101', '7102', 'acme', 'active')`,
      [INSTALLATION_ID],
    );
    await client.query(
      `INSERT INTO repositories
         (id, installation_id, github_repository_id, owner, name,
          default_branch, active_policy_version, status)
       VALUES ($1, $2, '7103', 'acme', 'cache', 'main', 1, 'active')`,
      [REPOSITORY_ID, INSTALLATION_ID],
    );
    await client.query(
      `INSERT INTO pull_requests
         (id, repository_id, github_pull_request_id, number, author_id, state)
       VALUES ($1, $2, '7104', 41, '7105', 'open')`,
      [PULL_REQUEST_ID, REPOSITORY_ID],
    );
    await client.query(
      `INSERT INTO pull_request_revisions
         (id, pull_request_id, head_sha, base_sha, is_current)
       VALUES ($1, $2, $3, $4, true)`,
      [REVISION_ID, PULL_REQUEST_ID, HEAD_SHA, BASE_SHA],
    );
    const persistedSource = await persistGithubRevisionSourceInTransaction(
      client,
      {
        revisionId: REVISION_ID,
        fetchedAt: new Date("2026-08-12T10:00:00.000Z"),
        source,
      },
    );
    if (persistedSource.sourceHash !== sourceHash) {
      throw new Error("GitHub revision source hash contract mismatch");
    }
    await client.query(
      `INSERT INTO analysis_snapshots
         (id, revision_id, analyzer_version, diff_hash, snapshot, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'ready')`,
      [
        ANALYSIS_ID,
        REVISION_ID,
        analysis.analyzerVersion,
        diffHash,
        JSON.stringify(analysis),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { boundedSource, context };
}

async function persistInOwnTransaction(
  database: DatabaseConnection,
  context: GenerationContextV1,
) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await persistGenerationContextV1InTransaction(
      client,
      context,
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertRawContext(
  database: DatabaseConnection,
  context: Record<string, unknown>,
) {
  const { contextHash: _contextHash, ...material } = context;
  const canonicalMaterial = stableJson(material);
  const rawContext = {
    ...context,
    contextHash: createHash("sha256")
      .update(canonicalMaterial, "utf8")
      .digest("hex"),
  } as unknown as GenerationContextV1;
  const providerMaterial = stableJson({
    schemaVersion: "1",
    trust: "untrusted_github_revision",
    title: rawContext.title,
    body: rawContext.body,
    files: rawContext.files,
    anchors: rawContext.anchors,
    excerpts: rawContext.excerpts,
    deterministicTestFiles: rawContext.deterministicTestFiles,
    allowedAnchorIds: rawContext.allowedAnchorIds,
    limits: rawContext.limits,
    limitsHit: rawContext.limitsHit,
    exclusions: rawContext.exclusions,
  });
  return database.pool.query(
    `INSERT INTO generation_contexts
       (revision_id, analysis_snapshot_id, head_sha, analyzer_version,
        context_version, context_hash, canonical_material, provider_material,
        source_hash, allowed_anchor_ids, limits, exclusions, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             $11::jsonb, $12::jsonb, $13::jsonb)`,
    [
      rawContext.revisionId,
      rawContext.analysisSnapshotId,
      rawContext.headSha,
      rawContext.analyzerVersion,
      rawContext.contextVersion,
      rawContext.contextHash,
      canonicalMaterial,
      providerMaterial,
      rawContext.sourceHash,
      JSON.stringify(rawContext.allowedAnchorIds),
      JSON.stringify(rawContext.limits),
      JSON.stringify(rawContext.exclusions),
      JSON.stringify(rawContext),
    ],
  );
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sourceFixture() {
  return {
    githubPullRequestId: "7104",
    number: 41,
    state: "open" as const,
    draft: false,
    title: "Harden cache lookup",
    body: "Return an explicit cache miss and cover it with a deterministic test.",
    authorId: "7105",
    authorLogin: "contributor",
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    changedFiles: 2,
    isFork: false,
    files: [
      changedFile(
        "src/cache.ts",
        "@@ -1,1 +1,1 @@\n-return cache.get(key) ?? '';\n+return cache.get(key) ?? null;",
      ),
      changedFile(
        "tests/cache.test.ts",
        "@@ -1,1 +1,1 @@\n-expect(cache('x')).toBe('');\n+expect(cache('x')).toBeNull();",
      ),
    ],
    limitsHit: {
      files: false,
      patchBytes: false,
      patchUnavailable: false,
    },
  };
}

function changedFile(path: string, patch: string) {
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = patch
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return {
    sha: "d".repeat(40),
    filename: path,
    previousFilename: null,
    status: "modified" as const,
    additions,
    deletions,
    changes: additions + deletions,
    patch,
    gitKind: "blob" as const,
  };
}
