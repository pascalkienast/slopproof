import {
  canonicalGenerationContextMaterialV1,
  canonicalGenerationProviderMaterialV1,
  GenerationContextV1Schema,
  type GenerationContextV1,
} from "@understandproof/analysis";

type GenerationContextRow = {
  id: string;
  revision_id: string;
  analysis_snapshot_id: string;
  head_sha: string;
  analyzer_version: string;
  context_version: string;
  context_hash: string;
  canonical_material: string;
  provider_material: string;
  source_hash: string;
  allowed_anchor_ids: unknown;
  limits: unknown;
  exclusions: unknown;
  context: unknown;
  created_at: Date;
};

export type PersistedGenerationContextV1 = {
  id: string;
  context: GenerationContextV1;
  createdAt: Date;
};

export interface GenerationContextQueryPort {
  query(
    statement: string,
    parameters?: unknown[],
  ): Promise<{ rows: unknown[] }>;
}

export class GenerationContextPersistenceError extends Error {
  readonly code = "GENERATION_CONTEXT_PERSISTENCE_INVALID" as const;

  constructor() {
    super("Generation context persistence is unavailable or invalid.");
    this.name = "GenerationContextPersistenceError";
  }
}

/** Caller owns the transaction; 0011 enforces immutable SHA/source/anchor binding. */
export async function persistGenerationContextV1InTransaction(
  client: GenerationContextQueryPort,
  rawContext: unknown,
): Promise<{ id: string; replay: boolean }> {
  const parsed = GenerationContextV1Schema.safeParse(rawContext);
  if (!parsed.success) throw new GenerationContextPersistenceError();
  const context = parsed.data;
  try {
    const inserted = await client.query(
      `INSERT INTO generation_contexts
         (revision_id, analysis_snapshot_id, head_sha, analyzer_version,
          context_version, context_hash, source_hash, allowed_anchor_ids,
          canonical_material, provider_material, limits, exclusions, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb)
       ON CONFLICT (analysis_snapshot_id, context_version) DO NOTHING
       RETURNING id`,
      parameters(context),
    );
    if (inserted.rows.length === 1) {
      const insertedId = insertedIdFromRow(inserted.rows[0]);
      if (!insertedId) throw new GenerationContextPersistenceError();
      return { id: insertedId, replay: false };
    }
    if (inserted.rows.length !== 0) {
      throw new GenerationContextPersistenceError();
    }

    const existing = await client.query(
      `SELECT id, revision_id, analysis_snapshot_id, head_sha,
              analyzer_version, context_version, context_hash, source_hash,
              allowed_anchor_ids, canonical_material, provider_material,
              limits, exclusions, context, created_at
         FROM generation_contexts
        WHERE analysis_snapshot_id = $1 AND context_version = $2
        LIMIT 1`,
      [context.analysisSnapshotId, context.contextVersion],
    );
    const row =
      existing.rows.length === 1
        ? parseGenerationContextRow(existing.rows[0])
        : null;
    if (!row || !rowMatchesContext(row, context)) {
      throw new GenerationContextPersistenceError();
    }
    return { id: row.id, replay: true };
  } catch (error) {
    if (error instanceof GenerationContextPersistenceError) throw error;
    throw new GenerationContextPersistenceError();
  }
}

export async function loadGenerationContextV1(
  pool: GenerationContextQueryPort,
  input: Readonly<{
    revisionId: string;
    analysisSnapshotId: string;
    headSha: string;
  }>,
): Promise<PersistedGenerationContextV1 | null> {
  if (
    !uuid(input.revisionId) ||
    !uuid(input.analysisSnapshotId) ||
    !/^[a-f0-9]{40}$/u.test(input.headSha)
  ) {
    throw new GenerationContextPersistenceError();
  }
  let result: { rows: unknown[] };
  try {
    result = await pool.query(
      `SELECT generation_context.id, generation_context.revision_id,
              generation_context.analysis_snapshot_id,
              generation_context.head_sha,
              generation_context.analyzer_version,
              generation_context.context_version,
              generation_context.context_hash,
              generation_context.source_hash,
              generation_context.allowed_anchor_ids,
              generation_context.canonical_material,
              generation_context.provider_material,
              generation_context.limits,
              generation_context.exclusions,
              generation_context.context,
              generation_context.created_at
         FROM generation_contexts generation_context
         JOIN analysis_snapshots snapshot
           ON snapshot.id = generation_context.analysis_snapshot_id
          AND snapshot.revision_id = generation_context.revision_id
         JOIN pull_request_revisions revision
           ON revision.id = generation_context.revision_id
         JOIN github_revision_sources source
           ON source.revision_id = generation_context.revision_id
        WHERE generation_context.revision_id = $1
          AND generation_context.analysis_snapshot_id = $2
          AND generation_context.head_sha = $3
          AND snapshot.status = 'ready'
          AND snapshot.analyzer_version = generation_context.analyzer_version
          AND revision.head_sha = generation_context.head_sha
          AND revision.base_sha = generation_context.context->>'baseSha'
          AND snapshot.snapshot->>'headSha' = generation_context.head_sha
          AND snapshot.snapshot->>'baseSha' = generation_context.context->>'baseSha'
          AND source.head_sha = generation_context.head_sha
          AND source.base_sha = generation_context.context->>'baseSha'
          AND source.source_hash = generation_context.source_hash
        LIMIT 2`,
      [input.revisionId, input.analysisSnapshotId, input.headSha],
    );
  } catch {
    throw new GenerationContextPersistenceError();
  }
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw new GenerationContextPersistenceError();
  const row = parseGenerationContextRow(result.rows[0]);
  if (!row) throw new GenerationContextPersistenceError();
  const context = GenerationContextV1Schema.safeParse(row.context);
  if (
    !context.success ||
    row.revision_id !== input.revisionId ||
    row.analysis_snapshot_id !== input.analysisSnapshotId ||
    row.head_sha !== input.headSha ||
    !rowMatchesContext(row, context.data) ||
    !(row.created_at instanceof Date) ||
    !Number.isFinite(row.created_at.getTime())
  ) {
    throw new GenerationContextPersistenceError();
  }
  return { id: row.id, context: context.data, createdAt: row.created_at };
}

function parameters(context: GenerationContextV1): unknown[] {
  return [
    context.revisionId,
    context.analysisSnapshotId,
    context.headSha,
    context.analyzerVersion,
    context.contextVersion,
    context.contextHash,
    context.sourceHash,
    JSON.stringify(context.allowedAnchorIds),
    canonicalGenerationContextMaterialV1(context),
    canonicalGenerationProviderMaterialV1(context),
    JSON.stringify(context.limits),
    JSON.stringify(context.exclusions),
    JSON.stringify(context),
  ];
}

function rowMatchesContext(
  row: GenerationContextRow,
  context: GenerationContextV1,
): boolean {
  try {
    return (
      row.revision_id === context.revisionId &&
      row.analysis_snapshot_id === context.analysisSnapshotId &&
      row.head_sha === context.headSha &&
      row.analyzer_version === context.analyzerVersion &&
      row.context_version === context.contextVersion &&
      row.context_hash === context.contextHash &&
      row.source_hash === context.sourceHash &&
      row.canonical_material ===
        canonicalGenerationContextMaterialV1(context) &&
      row.provider_material ===
        canonicalGenerationProviderMaterialV1(context) &&
      jsonEqual(row.allowed_anchor_ids, context.allowedAnchorIds) &&
      jsonEqual(row.limits, context.limits) &&
      jsonEqual(row.exclusions, context.exclusions) &&
      jsonEqual(GenerationContextV1Schema.parse(row.context), context)
    );
  } catch {
    return false;
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function insertedIdFromRow(value: unknown): string | null {
  if (!isRecord(value) || typeof value.id !== "string" || !uuid(value.id)) {
    return null;
  }
  return value.id;
}

function parseGenerationContextRow(
  value: unknown,
): GenerationContextRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    !uuid(value.id) ||
    typeof value.revision_id !== "string" ||
    typeof value.analysis_snapshot_id !== "string" ||
    typeof value.head_sha !== "string" ||
    typeof value.analyzer_version !== "string" ||
    typeof value.context_version !== "string" ||
    typeof value.context_hash !== "string" ||
    typeof value.source_hash !== "string" ||
    typeof value.canonical_material !== "string" ||
    typeof value.provider_material !== "string" ||
    !(value.created_at instanceof Date)
  ) {
    return null;
  }
  return {
    id: value.id,
    revision_id: value.revision_id,
    analysis_snapshot_id: value.analysis_snapshot_id,
    head_sha: value.head_sha,
    analyzer_version: value.analyzer_version,
    context_version: value.context_version,
    context_hash: value.context_hash,
    source_hash: value.source_hash,
    canonical_material: value.canonical_material,
    provider_material: value.provider_material,
    allowed_anchor_ids: value.allowed_anchor_ids,
    limits: value.limits,
    exclusions: value.exclusions,
    context: value.context,
    created_at: value.created_at,
  };
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
