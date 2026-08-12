import { describe, expect, it, vi } from "vitest";
import type { RepositoryInstallationTokenProvider } from "./app-auth";
import { OctokitPullRequestPort } from "./pull-request";
import type { GithubRepositoryBinding } from "./production-ports";
import { githubRestClientStub as baseGithubRestClientStub } from "./production-testkit";
import type { GithubRestClient } from "./octokit-client";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const binding = {
  installationId: "17",
  repositoryId: "42",
  owner: "acme",
  repositoryName: "cachekit",
};
const readInput = {
  ...binding,
  pullNumber: 184,
  expectedHeadSha: headSha,
  expectedBaseSha: "b".repeat(40),
};

describe("OctokitPullRequestPort", () => {
  it("loads immutable PR metadata and all changed-file pages", async () => {
    const files = Array.from({ length: 101 }, (_, index) => changedFile(index));
    const getPullRequest = vi.fn(async () => ({
      data: pullRequest({ changed_files: files.length }),
    }));
    const listPullRequestFiles = vi.fn(async (input: { page: number }) => ({
      data: input.page === 1 ? files.slice(0, 100) : files.slice(100),
    }));
    const client = githubRestClientStub({
      getPullRequest,
      listPullRequestFiles,
    });
    const port = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () => client,
    });

    const snapshot = await port.load(readInput);

    expect(snapshot).toMatchObject({
      githubPullRequestId: "1840",
      number: 184,
      state: "open",
      title: "Untrusted PR title",
      authorId: "99",
      authorLogin: "octocat",
      headSha,
      baseSha,
      changedFiles: 101,
      isFork: true,
      limitsHit: {
        files: false,
        patchBytes: false,
        patchUnavailable: false,
      },
    });
    expect(snapshot.files).toHaveLength(101);
    expect(snapshot.files.every((file) => file.gitKind === "blob")).toBe(true);
    expect(getPullRequest).toHaveBeenCalledTimes(2);
    expect(listPullRequestFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ page: 1, perPage: 100 }),
      expect.any(AbortSignal),
    );
    expect(client.getGitCommit).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repositoryName: "cachekit" }),
      expect.any(AbortSignal),
    );
    expect(client.getGitCommit).not.toHaveBeenCalledWith(
      expect.objectContaining({ owner: "fork" }),
      expect.anything(),
    );
    expect(client.getGitTree).not.toHaveBeenCalledWith(
      expect.objectContaining({ owner: "fork" }),
      expect.anything(),
    );
    expect(listPullRequestFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2, perPage: 100 }),
      expect.any(AbortSignal),
    );
  });

  it("makes file and patch caps visible without persisting oversized patches", async () => {
    const files = Array.from({ length: 300 }, (_, index) =>
      changedFile(index, {
        ...(index === 0 ? { patch: "12345" } : {}),
        ...(index === 1 ? { patch: undefined } : {}),
      }),
    );
    const port = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest: async () => ({
            data: pullRequest({ changed_files: 301 }),
          }),
          listPullRequestFiles: async (input) => ({
            data: files.slice((input.page - 1) * 100, input.page * 100),
          }),
        }),
      limits: {
        maxPatchBytesPerFile: 4,
        maxTotalPatchBytes: 8,
      },
    });

    const snapshot = await port.load(readInput);
    expect(snapshot.files).toHaveLength(300);
    expect(snapshot.files.slice(0, 2).map((file) => file.patch)).toEqual([
      null,
      null,
    ]);
    expect(snapshot.limitsHit).toEqual({
      files: true,
      patchBytes: true,
      patchUnavailable: true,
    });
  });

  it("rejects a stale expected head before reading files", async () => {
    const listPullRequestFiles = vi.fn();
    const port = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest: async () => ({
            data: pullRequest({
              head: { sha: "c".repeat(40), repo: repo(99) },
            }),
          }),
          listPullRequestFiles,
        }),
    });
    await expect(port.load(readInput)).rejects.toMatchObject({
      code: "STALE_HEAD",
    });
    expect(listPullRequestFiles).not.toHaveBeenCalled();
  });

  it("detects a push or base movement while files are being paginated", async () => {
    const getPullRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: pullRequest() })
      .mockResolvedValueOnce({
        data: pullRequest({ head: { sha: "c".repeat(40), repo: repo(99) } }),
      });
    const port = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest,
          listPullRequestFiles: async () => ({ data: [changedFile(0)] }),
        }),
    });
    await expect(port.load(readInput)).rejects.toMatchObject({
      code: "STALE_HEAD",
    });
  });

  it("treats a freshly stable base movement as authoritative", async () => {
    const currentBase = "d".repeat(40);
    const port = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest: async () => ({
            data: pullRequest({
              base: { sha: currentBase, repo: repo(42) },
            }),
          }),
          listPullRequestFiles: async () => ({ data: [changedFile(0)] }),
        }),
    });

    await expect(port.load(readInput)).resolves.toMatchObject({
      headSha,
      baseSha: currentBase,
    });
  });

  it("fails closed for a mismatched base repository", async () => {
    const port = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest: async () => ({
            data: pullRequest({
              base: { sha: baseSha, repo: repo(43, "acme/other") },
            }),
          }),
        }),
    });
    await expect(port.load(readInput)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects duplicate filenames and incomplete pagination", async () => {
    const duplicatePort = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest: async () => ({
            data: pullRequest({ changed_files: 2 }),
          }),
          listPullRequestFiles: async () => ({
            data: [changedFile(0), changedFile(0)],
          }),
        }),
    });
    await expect(duplicatePort.load(readInput)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    let page = 0;
    const incompletePort = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest: async () => ({
            data: pullRequest({ changed_files: 2 }),
          }),
          listPullRequestFiles: async () => ({
            data: page++ === 0 ? [changedFile(0)] : [],
          }),
        }),
    });
    await expect(incompletePort.load(readInput)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("invalidates one rejected token and retries the read once", async () => {
    const provider = tokenProvider();
    const unauthorized = githubRestClientStub({
      getPullRequest: async () => {
        throw Object.assign(new Error("bad credentials"), { status: 401 });
      },
    });
    const authorized = githubRestClientStub({
      getPullRequest: async () => ({ data: pullRequest() }),
      listPullRequestFiles: async () => ({ data: [changedFile(0)] }),
    });
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(unauthorized)
      .mockReturnValueOnce(authorized);
    const port = new OctokitPullRequestPort(provider, {
      clientFactory,
      requestPolicy: { maxAttempts: 1 },
    });

    await expect(port.load(readInput)).resolves.toMatchObject({ headSha });
    expect(provider.invalidate).toHaveBeenCalledWith(
      expect.objectContaining(binding),
    );
    expect(provider.get).toHaveBeenCalledTimes(2);
  });

  it("returns a strict current-head view and rejects extra input fields", async () => {
    const port = new OctokitPullRequestPort(tokenProvider(), {
      clientFactory: () =>
        githubRestClientStub({
          getPullRequest: async () => ({ data: pullRequest() }),
        }),
    });
    await expect(
      port.getCurrentHead({ ...binding, pullNumber: 184 }),
    ).resolves.toEqual({
      headSha,
      baseSha: "b".repeat(40),
      state: "open",
    });
    await expect(
      port.load({ ...readInput, unexpected: true } as typeof readInput),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

function tokenProvider(): RepositoryInstallationTokenProvider & {
  get: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => "repository-installation-token"),
    invalidate: vi.fn((_binding: GithubRepositoryBinding) => undefined),
  };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1840,
    number: 184,
    state: "open",
    draft: false,
    title: "Untrusted PR title",
    body: "Untrusted PR body",
    changed_files: 1,
    user: { id: 99, login: "octocat" },
    head: { sha: headSha, repo: repo(99, "fork/cachekit") },
    base: { sha: baseSha, repo: repo(42) },
    ...overrides,
  };
}

function repo(id: number, fullName = "acme/cachekit") {
  return { id, full_name: fullName };
}

function changedFile(index: number, overrides: Record<string, unknown> = {}) {
  return {
    sha: "c".repeat(40),
    filename: `src/file-${index}.ts`,
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
    ...overrides,
  };
}

function githubRestClientStub(
  overrides: Partial<GithubRestClient> = {},
): GithubRestClient {
  const getGitCommit = vi.fn(async (input: { commitSha: string }) => ({
    data: {
      sha: input.commitSha,
      tree: { sha: `${input.commitSha.slice(0, 39)}0` },
    },
  }));
  const getGitTree = vi.fn(async (input: { treeSha: string }) => ({
    data: input.treeSha.endsWith("0")
      ? {
          sha: input.treeSha,
          truncated: false,
          tree: [
            {
              path: "src",
              mode: "040000",
              type: "tree",
              sha: `${input.treeSha.slice(0, 39)}1`,
            },
          ],
        }
      : {
          sha: input.treeSha,
          truncated: false,
          tree: Array.from({ length: 300 }, (_, index) => ({
            path: `file-${index}.ts`,
            mode: "100644",
            type: "blob",
            sha: "c".repeat(40),
          })),
        },
  }));
  return baseGithubRestClientStub({
    getGitCommit,
    getGitTree,
    ...overrides,
  });
}
