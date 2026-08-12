import { describe, expect, it, vi } from "vitest";
import { githubRevisionSourceHash } from "@slopproof/analysis";
import {
  GithubRevisionPatchSourceError,
  PostgresGithubRevisionPatchSource,
} from "./github-revision-patch-source";

const REVISION_ID = "10000000-0000-4000-8000-000000000001";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

describe("PostgresGithubRevisionPatchSource", () => {
  it("performs one exact DB read and returns only bounded patch material", async () => {
    const source = sourceFixture();
    const query = vi.fn(
      async (_statement: string, _parameters?: unknown[]) => ({
        rows: [row(source, sourceHash(source))],
      }),
    );
    const patchSource = new PostgresGithubRevisionPatchSource({ query });

    const patch = await patchSource.loadPatch(request());

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("FROM github_revision_sources source");
    expect(sql).toContain("revision.is_current = true");
    expect(sql).toContain("installation.status = 'active'");
    expect(sql).not.toMatch(/octokit|https?:|archive|search|clone|checkout/iu);
    expect(parameters).toEqual([
      REVISION_ID,
      HEAD_SHA,
      BASE_SHA,
      "acme",
      "cache",
      41,
    ]);
    expect(patch).toEqual({
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [
        {
          path: "assets/logo.png",
          kind: "binary",
          additions: 0,
          deletions: 0,
        },
        {
          path: "src/cache.ts",
          kind: "text",
          additions: 1,
          deletions: 1,
          patch: "@@ -1,1 +1,1 @@\n-old\n+new",
        },
      ],
    });
  });

  it("rejects missing, duplicate, stale, cross-repository, and malformed requests value-free", async () => {
    const source = sourceFixture();
    for (const rows of [
      [],
      [row(source, sourceHash(source)), row(source, sourceHash(source))],
      [row(source, sourceHash(source), { source_head_sha: "c".repeat(40) })],
      [row(source, sourceHash(source), { repository_name: "other" })],
    ]) {
      const query = vi.fn(async () => ({ rows }));
      const patchSource = new PostgresGithubRevisionPatchSource({ query });
      await expect(patchSource.loadPatch(request())).rejects.toEqual(
        expect.objectContaining({
          name: "GithubRevisionPatchSourceError",
          message: "Stored revision patch source is unavailable or invalid.",
        }),
      );
    }

    const query = vi.fn(async () => ({ rows: [] }));
    const patchSource = new PostgresGithubRevisionPatchSource({ query });
    await expect(
      patchSource.loadPatch({ ...request(), owner: "acme\nprivate" }),
    ).rejects.toBeInstanceOf(GithubRevisionPatchSourceError);
    expect(query).not.toHaveBeenCalled();
  });

  it("revalidates the canonical stored source hash before interpreting patches", async () => {
    const source = sourceFixture();
    const query = vi.fn(async () => ({
      rows: [row(source, "f".repeat(64))],
    }));
    const patchSource = new PostgresGithubRevisionPatchSource({ query });

    await expect(patchSource.loadPatch(request())).rejects.toBeInstanceOf(
      GithubRevisionPatchSourceError,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects stored source identity or lifecycle drift from the bound pull request", async () => {
    const variants = [
      { ...sourceFixture(), githubPullRequestId: "9999" },
      { ...sourceFixture(), number: 42 },
      { ...sourceFixture(), authorId: "9999" },
      { ...sourceFixture(), state: "closed" as const },
    ];
    for (const source of variants) {
      const query = vi.fn(async () => ({
        rows: [row(sourceFixture(), sourceHash(source), { source })],
      }));
      const patchSource = new PostgresGithubRevisionPatchSource({ query });

      await expect(patchSource.loadPatch(request())).rejects.toBeInstanceOf(
        GithubRevisionPatchSourceError,
      );
    }
  });

  it("keeps LFS, submodule, archive, unusual, generated, and lock paths metadata-only", async () => {
    const source = {
      ...sourceFixture(),
      changedFiles: 6,
      limitsHit: {
        files: false,
        patchBytes: false,
        patchUnavailable: false,
      },
      files: [
        changedFile(
          "asset.dat",
          `@@ -0,0 +1,3 @@\n+version https://git-lfs.github.com/spec/v1\n+oid sha256:${"c".repeat(64)}\n+size 10`,
        ),
        changedFile(
          "module",
          `@@ -1 +1 @@\n-Subproject commit ${"c".repeat(40)}\n+Subproject commit ${"d".repeat(40)}`,
        ),
        changedFile("release.zip", "@@ -1 +1 @@\n-old\n+new"),
        changedFile("../unusual.ts", "@@ -1 +1 @@\n-old\n+new"),
        changedFile("dist/app.generated.js", "@@ -1 +1 @@\n-old\n+new"),
        changedFile("pnpm-lock.yaml", "@@ -1 +1 @@\n-old\n+new"),
      ],
    };
    const query = vi.fn(async () => ({
      rows: [row(source, sourceHash(source))],
    }));
    const patchSource = new PostgresGithubRevisionPatchSource({ query });

    const bounded = await patchSource.loadBoundedSource(request());
    expect(bounded.files.every((file) => file.kind === "binary")).toBe(true);
    expect(bounded.files.every((file) => file.patch === undefined)).toBe(true);
    expect(bounded.exclusions.map((item) => item.reason)).toEqual(
      expect.arrayContaining([
        "lfs_pointer",
        "submodule",
        "archive",
        "unusual_path",
        "generated",
        "lockfile",
      ]),
    );
  });

  it("does not leak stored data through errors", async () => {
    const privatePatchMarker = "private-patch-marker";
    const source = {
      ...sourceFixture(),
      body: "private-body-marker",
      files: [
        changedFile(
          "private-filename-marker.ts",
          `@@ -1 +1 @@\n-old\n+${privatePatchMarker}`,
        ),
      ],
    };
    const query = vi.fn(async () => ({
      rows: [row(source, "f".repeat(64))],
    }));
    const patchSource = new PostgresGithubRevisionPatchSource({ query });

    try {
      await patchSource.loadPatch(request());
      throw new Error("expected source rejection");
    } catch (error) {
      expect(String(error)).not.toContain(privatePatchMarker);
      expect(String(error)).not.toContain("private-body-marker");
      expect(String(error)).not.toContain("private-filename-marker.ts");
    }
  });
});

function request() {
  return {
    revisionId: REVISION_ID,
    owner: "acme",
    repositoryName: "cache",
    pullRequestNumber: 41,
    githubPullRequestId: "3001",
    authorId: "4001",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  };
}

function row(
  source: ReturnType<typeof sourceFixture>,
  hash: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    revision_id: REVISION_ID,
    revision_head_sha: HEAD_SHA,
    revision_base_sha: BASE_SHA,
    owner: "acme",
    repository_name: "cache",
    pull_request_number: 41,
    github_pull_request_id: "3001",
    pull_request_author_id: "4001",
    pull_request_state: "open",
    source_head_sha: HEAD_SHA,
    source_base_sha: BASE_SHA,
    source,
    source_hash: hash,
    ...overrides,
  };
}

function sourceFixture() {
  return {
    githubPullRequestId: "3001",
    number: 41,
    state: "open" as const,
    draft: false,
    title: "Cache patch",
    body: "Bounded source fixture",
    authorId: "4001",
    authorLogin: "contributor",
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    changedFiles: 2,
    isFork: false,
    files: [
      changedFile("src/cache.ts", "@@ -1,1 +1,1 @@\n-old\n+new"),
      {
        ...changedFile("assets/logo.png", "@@ -1 +1 @@\n-old\n+new"),
        patch: null,
        additions: 0,
        deletions: 0,
        changes: 0,
      },
    ],
    limitsHit: {
      files: false,
      patchBytes: false,
      patchUnavailable: true,
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
    patch: patch as string | null,
    gitKind: "blob" as const,
  };
}

function sourceHash(value: unknown): string {
  return githubRevisionSourceHash(value);
}
