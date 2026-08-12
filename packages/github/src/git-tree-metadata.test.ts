import { describe, expect, it, vi } from "vitest";
import { GithubExactPathKindResolver } from "./git-tree-metadata";
import type { GithubRestClient } from "./octokit-client";
import { githubRestClientStub } from "./production-testkit";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const headRootSha = "1".repeat(40);
const baseRootSha = "2".repeat(40);

describe("GithubExactPathKindResolver", () => {
  it("resolves regular executable blobs and caches shared tree prefixes", async () => {
    const fixture = metadataFixture({
      head: {
        "src/first.ts": "100644",
        "src/tool.sh": "100755",
      },
      base: {
        "src/first.ts": "100644",
        "src/tool.sh": "100755",
      },
    });

    await expect(
      resolver(fixture.client).resolve({
        head: revision("fork", "cachekit", headSha),
        base: revision("acme", "cachekit", baseSha),
        files: [modified("src/first.ts"), modified("src/tool.sh")],
      }),
    ).resolves.toEqual(["blob", "blob"]);

    expect(fixture.getGitCommit).toHaveBeenCalledTimes(2);
    expect(fixture.getGitTree).toHaveBeenCalledTimes(4);
    for (const [input] of fixture.getGitTree.mock.calls) {
      expect(Object.keys(input).sort()).toEqual([
        "owner",
        "repositoryName",
        "treeSha",
      ]);
      expect(input).not.toHaveProperty("recursive");
    }
    expect(fixture.client).not.toHaveProperty("getBlob");
    expect(fixture.client).not.toHaveProperty("getContent");
  });

  it("classifies a symlink even when GitHub supplies a non-null patch", async () => {
    const fixture = metadataFixture({
      head: { "link.txt": "120000" },
      base: { "link.txt": "120000" },
    });
    const portFile = { ...modified("link.txt"), patch: "@@ symlink target" };

    await expect(
      resolver(fixture.client).resolve({
        head: revision("fork", "cachekit", headSha),
        base: revision("acme", "cachekit", baseSha),
        files: [portFile],
      }),
    ).resolves.toEqual(["symlink"]);
  });

  it("classifies submodules from mode 160000 and commit type", async () => {
    const fixture = metadataFixture({
      head: { vendor: "160000" },
      base: { vendor: "160000" },
    });
    await expect(
      resolver(fixture.client).resolve({
        head: revision("fork", "cachekit", headSha),
        base: revision("acme", "cachekit", baseSha),
        files: [modified("vendor")],
      }),
    ).resolves.toEqual(["submodule"]);
  });

  it("conservatively retains a special kind across a mode transition", async () => {
    const fixture = metadataFixture({
      head: { "config/current": "120000" },
      base: { "config/previous": "100644" },
    });
    await expect(
      resolver(fixture.client).resolve({
        head: revision("fork", "cachekit", headSha),
        base: revision("acme", "cachekit", baseSha),
        files: [renamed("config/current", "config/previous")],
      }),
    ).resolves.toEqual(["symlink"]);
  });

  it("resolves a removed symlink only from the base deletion side", async () => {
    const fixture = metadataFixture({
      head: {},
      base: { "old-link": "120000" },
    });
    await expect(
      resolver(fixture.client).resolve({
        head: null,
        base: revision("acme", "cachekit", baseSha),
        files: [removed("old-link")],
      }),
    ).resolves.toEqual(["symlink"]);
    expect(fixture.getGitCommit).toHaveBeenCalledTimes(1);
    expect(fixture.getGitCommit).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: baseSha }),
      expect.any(AbortSignal),
    );
  });

  it("fails closed for truncated, unknown, and missing path metadata", async () => {
    const truncated = metadataFixture({
      head: { "src/file.ts": "100644" },
      base: { "src/file.ts": "100644" },
      truncatedTreeSha: headRootSha,
    });
    await expect(
      resolver(truncated.client).resolve(singleModifiedInput()),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const unknown = metadataFixture({
      head: { "src/file.ts": "100664" },
      base: { "src/file.ts": "100644" },
    });
    await expect(
      resolver(unknown.client).resolve(singleModifiedInput()),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const missing = metadataFixture({
      head: {},
      base: { "src/file.ts": "100644" },
    });
    await expect(
      resolver(missing.client).resolve(singleModifiedInput()),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("fails closed at depth, per-call entry, total-entry, and API-call caps", async () => {
    const fixture = metadataFixture({
      head: { "src/file.ts": "100644", "src/other.ts": "100644" },
      base: { "src/file.ts": "100644", "src/other.ts": "100644" },
    });

    await expect(
      resolver(fixture.client, { maxDepth: 1 }).resolve(singleModifiedInput()),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(
      resolver(fixture.client, { maxEntriesPerTree: 1 }).resolve(
        singleModifiedInput(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      resolver(fixture.client, { maxTotalEntries: 1 }).resolve(
        singleModifiedInput(),
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(
      resolver(fixture.client, { maxApiCalls: 1 }).resolve(
        singleModifiedInput(),
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("propagates the bounded request timeout without a second metadata call", async () => {
    const getGitTree = vi.fn(
      async (_input: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const client = githubRestClientStub({
      getGitCommit: async (input) => ({
        data: { sha: input.commitSha, tree: { sha: headRootSha } },
      }),
      getGitTree,
    });

    await expect(
      new GithubExactPathKindResolver(
        client,
        { maxAttempts: 1, attemptTimeoutMs: 5, deadlineMs: 20 },
        {},
      ).resolve({
        head: revision("fork", "cachekit", headSha),
        base: revision("acme", "cachekit", baseSha),
        files: [{ ...modified("file.ts"), status: "added" }],
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(getGitTree).toHaveBeenCalledTimes(1);
  });
});

type Mode = "040000" | "100644" | "100755" | "100664" | "120000" | "160000";
type FixtureInput = {
  head: Record<string, Mode>;
  base: Record<string, Mode>;
  truncatedTreeSha?: string;
};

function metadataFixture(input: FixtureInput): {
  client: GithubRestClient;
  getGitCommit: ReturnType<typeof vi.fn>;
  getGitTree: ReturnType<typeof vi.fn>;
} {
  const trees = new Map<string, Array<Record<string, unknown>>>();
  buildTrees(trees, headRootSha, input.head);
  buildTrees(trees, baseRootSha, input.base);
  const getGitCommit = vi.fn(async (request: { commitSha: string }) => ({
    data: {
      sha: request.commitSha,
      tree: { sha: request.commitSha === headSha ? headRootSha : baseRootSha },
    },
  }));
  const getGitTree = vi.fn(async (request: { treeSha: string }) => ({
    data: {
      sha: request.treeSha,
      truncated: request.treeSha === input.truncatedTreeSha,
      tree: trees.get(request.treeSha) ?? [],
    },
  }));
  return {
    client: githubRestClientStub({ getGitCommit, getGitTree }),
    getGitCommit,
    getGitTree,
  };
}

function buildTrees(
  trees: Map<string, Array<Record<string, unknown>>>,
  rootSha: string,
  paths: Record<string, Mode>,
): void {
  trees.set(rootSha, []);
  let nextSha = 10;
  for (const [path, mode] of Object.entries(paths)) {
    const segments = path.split("/");
    let treeSha = rootSha;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment === undefined) throw new Error("invalid fixture path");
      const entries = trees.get(treeSha);
      if (entries === undefined) throw new Error("missing fixture tree");
      const last = index === segments.length - 1;
      const existing = entries.find((entry) => entry.path === segment);
      if (last) {
        entries.push(entry(segment, mode, objectSha(rootSha, nextSha++)));
      } else if (existing === undefined) {
        const childSha = objectSha(rootSha, nextSha++);
        entries.push(entry(segment, "040000", childSha));
        trees.set(childSha, []);
        treeSha = childSha;
      } else {
        treeSha = String(existing.sha);
      }
    }
  }
}

function entry(path: string, mode: Mode, sha: string): Record<string, unknown> {
  return {
    path,
    mode,
    type: mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob",
    sha,
  };
}

function objectSha(rootSha: string, value: number): string {
  return `${rootSha.slice(0, 36)}${value.toString(16).padStart(4, "0")}`;
}

function resolver(
  client: GithubRestClient,
  limits: ConstructorParameters<typeof GithubExactPathKindResolver>[2] = {},
): GithubExactPathKindResolver {
  return new GithubExactPathKindResolver(
    client,
    { maxAttempts: 1, deadlineMs: 100, attemptTimeoutMs: 50 },
    limits,
  );
}

function revision(owner: string, repositoryName: string, commitSha: string) {
  return { owner, repositoryName, commitSha };
}

function modified(filename: string) {
  return { filename, previousFilename: null, status: "modified" as const };
}

function removed(filename: string) {
  return { filename, previousFilename: null, status: "removed" as const };
}

function renamed(filename: string, previousFilename: string) {
  return { filename, previousFilename, status: "renamed" as const };
}

function singleModifiedInput() {
  return {
    head: revision("fork", "cachekit", headSha),
    base: revision("acme", "cachekit", baseSha),
    files: [modified("src/file.ts")],
  };
}
