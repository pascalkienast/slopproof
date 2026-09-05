import { describe, expect, it, vi } from "vitest";
import type { RepositoryInstallationTokenProvider } from "./app-auth";
import {
  buildPullRequestCommentBody,
  OctokitPullRequestCommentAdapter,
} from "./pull-request-comment";
import type { GithubPullRequestHeadPort } from "./production-ports";
import { githubRestClientStub } from "./production-testkit";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const input = {
  installationId: "17",
  repositoryId: "42",
  owner: "acme",
  repositoryName: "cachekit",
  pullNumber: 184,
  revisionId: "10000000-0000-4000-8000-000000000004",
  headSha,
  baseSha,
  expectedPullRequestState: "open" as const,
  detailsUrl:
    "https://slopproof.test/revisions/10000000-0000-4000-8000-000000000004",
};

describe("OctokitPullRequestCommentAdapter", () => {
  it("creates one App-owned contributor entry after a current-head check", async () => {
    const calls: string[] = [];
    const body = buildPullRequestCommentBody(input);
    const createIssueComment = vi.fn(async () => {
      calls.push("create");
      return { data: issueComment(701, body) };
    });
    const adapter = new OctokitPullRequestCommentAdapter(
      tokenProvider(),
      headPort(() => calls.push("head")),
      {
        appId: "123",
        clientFactory: () =>
          githubRestClientStub({
            listIssueComments: async () => {
              calls.push("list");
              return { data: [] };
            },
            createIssueComment,
          }),
      },
    );

    await expect(adapter.upsert(input)).resolves.toBeUndefined();
    expect(calls).toEqual(["list", "head", "create"]);
    expect(createIssueComment).toHaveBeenCalledWith(
      {
        owner: "acme",
        repositoryName: "cachekit",
        pullNumber: 184,
        body,
      },
      expect.any(AbortSignal),
    );
    expect(body).toContain(input.detailsUrl);
    expect(body).toContain(headSha);
    expect(body).toContain("## Proof of Understanding");
    expect(body).toContain("same UnderstandProof page");
    expect(body).not.toContain("SlopProof understanding check");
    expect(body).not.toContain("same SlopProof page");
  });

  it("updates the existing App comment when a new revision becomes current", async () => {
    const body = buildPullRequestCommentBody(input);
    const updateIssueComment = vi.fn(async () => ({
      data: issueComment(701, body),
    }));
    const adapter = new OctokitPullRequestCommentAdapter(
      tokenProvider(),
      headPort(),
      {
        appId: "123",
        clientFactory: () =>
          githubRestClientStub({
            listIssueComments: async () => ({
              data: [
                issueComment(
                  701,
                  "<!-- slopproof:understanding-check -->\nold revision",
                ),
              ],
            }),
            updateIssueComment,
          }),
      },
    );

    await expect(adapter.upsert(input)).resolves.toBeUndefined();
    expect(updateIssueComment).toHaveBeenCalledWith(
      {
        owner: "acme",
        repositoryName: "cachekit",
        commentId: 701,
        body,
      },
      expect.any(AbortSignal),
    );
  });

  it("does not write when the exact current comment already exists", async () => {
    const body = buildPullRequestCommentBody(input);
    const createIssueComment = vi.fn();
    const updateIssueComment = vi.fn();
    const adapter = new OctokitPullRequestCommentAdapter(
      tokenProvider(),
      headPort(),
      {
        appId: "123",
        clientFactory: () =>
          githubRestClientStub({
            listIssueComments: async () => ({
              data: [issueComment(701, body)],
            }),
            createIssueComment,
            updateIssueComment,
          }),
      },
    );

    await expect(adapter.upsert(input)).resolves.toBeUndefined();
    expect(createIssueComment).not.toHaveBeenCalled();
    expect(updateIssueComment).not.toHaveBeenCalled();
  });

  it("ignores a marker copied by another App and creates its own comment", async () => {
    const body = buildPullRequestCommentBody(input);
    const createIssueComment = vi.fn(async () => ({
      data: issueComment(702, body),
    }));
    const adapter = new OctokitPullRequestCommentAdapter(
      tokenProvider(),
      headPort(),
      {
        appId: "123",
        clientFactory: () =>
          githubRestClientStub({
            listIssueComments: async () => ({
              data: [issueComment(701, body, 999)],
            }),
            createIssueComment,
          }),
      },
    );

    await expect(adapter.upsert(input)).resolves.toBeUndefined();
    expect(createIssueComment).toHaveBeenCalledOnce();
  });

  it("fails closed for duplicate App comments or a stale PR head", async () => {
    const body = buildPullRequestCommentBody(input);
    const duplicateAdapter = new OctokitPullRequestCommentAdapter(
      tokenProvider(),
      headPort(),
      {
        appId: "123",
        clientFactory: () =>
          githubRestClientStub({
            listIssueComments: async () => ({
              data: [issueComment(701, body), issueComment(702, body)],
            }),
          }),
      },
    );
    await expect(duplicateAdapter.upsert(input)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const write = vi.fn();
    const staleAdapter = new OctokitPullRequestCommentAdapter(
      tokenProvider(),
      headPort(undefined, "c".repeat(40)),
      {
        appId: "123",
        clientFactory: () =>
          githubRestClientStub({
            listIssueComments: async () => ({ data: [] }),
            createIssueComment: write,
          }),
      },
    );
    await expect(staleAdapter.upsert(input)).rejects.toMatchObject({
      code: "STALE_HEAD",
    });
    expect(write).not.toHaveBeenCalled();
  });
});

function issueComment(id: number, body: string, appId = 123) {
  return {
    id,
    body,
    performed_via_github_app: { id: appId, name: "UnderstandProof" },
  };
}

function tokenProvider(): RepositoryInstallationTokenProvider {
  return {
    get: vi.fn(async () => "installation-token-123456"),
    invalidate: vi.fn(),
  };
}

function headPort(
  onRead?: () => void,
  currentHeadSha = headSha,
): GithubPullRequestHeadPort {
  return {
    getCurrentHead: vi.fn(async () => {
      onRead?.();
      return { headSha: currentHeadSha, baseSha, state: "open" as const };
    }),
  };
}
