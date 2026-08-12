import { describe, expect, it, vi } from "vitest";
import {
  analyzePullRequestPatch,
  canonicalGenerationContextMaterialV1,
  canonicalGenerationProviderMaterialV1,
} from "@slopproof/analysis";
import {
  boundedRevisionSourcePatch,
  buildBoundedRevisionSourceV1,
  buildGenerationContextV1,
  type GenerationContextV1,
} from "../../../packages/analysis/src/generation-context";
import {
  GenerationContextPersistenceError,
  loadGenerationContextV1,
  persistGenerationContextV1InTransaction,
} from "./generation-context-repository";

const REVISION_ID = "10000000-0000-4000-8000-000000000001";
const ANALYSIS_ID = "20000000-0000-4000-8000-000000000002";
const CONTEXT_ID = "30000000-0000-4000-8000-000000000003";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

describe("GenerationContextV1 persistence", () => {
  it("inserts only the strict immutable projection", async () => {
    const context = contextFixture();
    const query = vi.fn(async (_statement: string, _values?: unknown[]) => ({
      rows: [{ id: CONTEXT_ID }],
    }));

    await expect(
      persistGenerationContextV1InTransaction({ query }, context),
    ).resolves.toEqual({ id: CONTEXT_ID, replay: false });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO generation_contexts");
    expect(sql).toContain(
      "ON CONFLICT (analysis_snapshot_id, context_version) DO NOTHING",
    );
    expect(values).toEqual([
      REVISION_ID,
      ANALYSIS_ID,
      HEAD_SHA,
      "bounded-diff-v1",
      "generation-context-v1",
      context.contextHash,
      context.sourceHash,
      JSON.stringify(context.allowedAnchorIds),
      canonicalGenerationContextMaterialV1(context),
      canonicalGenerationProviderMaterialV1(context),
      JSON.stringify(context.limits),
      JSON.stringify(context.exclusions),
      JSON.stringify(context),
    ]);
  });

  it("accepts an exact replay independent of JSONB object key order", async () => {
    const context = contextFixture();
    const createdAt = new Date("2026-08-12T10:00:00.000Z");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          persistedRow(context, createdAt, {
            limits: reverseObject(context.limits),
            context: reverseObject(context),
          }),
        ],
      });

    await expect(
      persistGenerationContextV1InTransaction({ query }, context),
    ).resolves.toEqual({ id: CONTEXT_ID, replay: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a conflicting replay without exposing context data", async () => {
    const privateMarker = "private-context-marker";
    const context = contextFixture(privateMarker);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          persistedRow(context, new Date(), { source_hash: "f".repeat(64) }),
        ],
      });

    try {
      await persistGenerationContextV1InTransaction({ query }, context);
      throw new Error("expected persistence rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationContextPersistenceError);
      expect(String(error)).not.toContain(privateMarker);
    }
  });

  it("loads only an exactly bound, schema-valid context", async () => {
    const context = contextFixture();
    const createdAt = new Date("2026-08-12T10:00:00.000Z");
    const query = vi.fn(async (_statement: string, _values?: unknown[]) => ({
      rows: [persistedRow(context, createdAt)],
    }));

    await expect(
      loadGenerationContextV1(
        { query },
        {
          revisionId: REVISION_ID,
          analysisSnapshotId: ANALYSIS_ID,
          headSha: HEAD_SHA,
        },
      ),
    ).resolves.toEqual({ id: CONTEXT_ID, context, createdAt });

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("snapshot.status = 'ready'");
    expect(sql).toContain("revision.head_sha = generation_context.head_sha");
    expect(values).toEqual([REVISION_ID, ANALYSIS_ID, HEAD_SHA]);
  });

  it("returns null for absence and rejects malformed or duplicate rows", async () => {
    const context = contextFixture();
    const emptyQuery = vi.fn(async () => ({ rows: [] }));
    await expect(
      loadGenerationContextV1(
        { query: emptyQuery },
        {
          revisionId: REVISION_ID,
          analysisSnapshotId: ANALYSIS_ID,
          headSha: HEAD_SHA,
        },
      ),
    ).resolves.toBeNull();

    const invalidInputQuery = vi.fn();
    await expect(
      loadGenerationContextV1(
        { query: invalidInputQuery },
        {
          revisionId: "not-a-revision",
          analysisSnapshotId: ANALYSIS_ID,
          headSha: HEAD_SHA,
        },
      ),
    ).rejects.toBeInstanceOf(GenerationContextPersistenceError);
    expect(invalidInputQuery).not.toHaveBeenCalled();

    const duplicateQuery = vi.fn(async () => ({
      rows: [
        persistedRow(context, new Date()),
        persistedRow(context, new Date()),
      ],
    }));
    await expect(
      loadGenerationContextV1(
        { query: duplicateQuery },
        {
          revisionId: REVISION_ID,
          analysisSnapshotId: ANALYSIS_ID,
          headSha: HEAD_SHA,
        },
      ),
    ).rejects.toBeInstanceOf(GenerationContextPersistenceError);

    const tamperedQuery = vi.fn(async () => ({
      rows: [
        persistedRow(context, new Date(), {
          context: { ...context, contextHash: "f".repeat(64) },
        }),
      ],
    }));
    await expect(
      loadGenerationContextV1(
        { query: tamperedQuery },
        {
          revisionId: REVISION_ID,
          analysisSnapshotId: ANALYSIS_ID,
          headSha: HEAD_SHA,
        },
      ),
    ).rejects.toBeInstanceOf(GenerationContextPersistenceError);
  });

  it("maps database failures to a value-free error", async () => {
    const privateMarker = "private-database-error";
    const query = vi.fn(async () => {
      throw new Error(privateMarker);
    });

    try {
      await persistGenerationContextV1InTransaction(
        { query },
        contextFixture(),
      );
      throw new Error("expected database rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationContextPersistenceError);
      expect(String(error)).not.toContain(privateMarker);
    }
  });
});

function contextFixture(body = "Bounded context fixture"): GenerationContextV1 {
  const source = {
    githubPullRequestId: "3001",
    number: 41,
    state: "open" as const,
    draft: false,
    title: "Cache patch",
    body,
    authorId: "4001",
    authorLogin: "contributor",
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    changedFiles: 1,
    isFork: false,
    files: [
      {
        sha: "d".repeat(40),
        filename: "src/cache.ts",
        previousFilename: null,
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        gitKind: "blob" as const,
      },
    ],
    limitsHit: {
      files: false,
      patchBytes: false,
      patchUnavailable: false,
    },
  };
  const boundedSource = buildBoundedRevisionSourceV1(source);
  const analysis = analyzePullRequestPatch(
    boundedRevisionSourcePatch(boundedSource),
  );
  return buildGenerationContextV1({
    revisionId: REVISION_ID,
    analysisSnapshotId: ANALYSIS_ID,
    boundedSource,
    analysis,
  });
}

function persistedRow(
  context: GenerationContextV1,
  createdAt: Date,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: CONTEXT_ID,
    revision_id: context.revisionId,
    analysis_snapshot_id: context.analysisSnapshotId,
    head_sha: context.headSha,
    analyzer_version: context.analyzerVersion,
    context_version: context.contextVersion,
    context_hash: context.contextHash,
    source_hash: context.sourceHash,
    canonical_material: canonicalGenerationContextMaterialV1(context),
    provider_material: canonicalGenerationProviderMaterialV1(context),
    allowed_anchor_ids: context.allowedAnchorIds,
    limits: context.limits,
    exclusions: context.exclusions,
    context,
    created_at: createdAt,
    ...overrides,
  };
}

function reverseObject(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}
