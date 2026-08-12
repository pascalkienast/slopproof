import { describe, expect, it, vi } from "vitest";
import type { RepositoryInstallationTokenProvider } from "./app-auth";
import { OctokitCheckRunAdapter } from "./check-run";
import {
  GITHUB_CHECK_NAME,
  type GithubPullRequestHeadPort,
} from "./production-ports";
import { githubRestClientStub } from "./production-testkit";

const headSha = "a".repeat(40);
const revisionId = "10000000-0000-4000-8000-000000000004";
const intent = {
  installationId: "17",
  repositoryId: "42",
  owner: "acme",
  repositoryName: "cachekit",
  revisionId,
  pullNumber: 184,
  headSha,
  baseSha: "b".repeat(40),
  expectedPullRequestState: "open" as const,
  status: "in_progress" as const,
  conclusion: null,
  summary: "Understanding is required for this revision.",
  detailsUrl: `https://slopproof.test/revisions/${revisionId}`,
};

describe("OctokitCheckRunAdapter", () => {
  it("looks up a replay key, checks the current head, then creates once", async () => {
    const calls: string[] = [];
    const createCheckRun = vi.fn(async (input: unknown) => {
      calls.push("create");
      return { data: checkRun(701), request: input };
    });
    const adapter = new OctokitCheckRunAdapter(
      tokenProvider(),
      headPort(() => calls.push("head")),
      {
        clientFactory: () =>
          githubRestClientStub({
            listCheckRunsForRef: async () => {
              calls.push("lookup");
              return { data: { total_count: 0, check_runs: [] } };
            },
            createCheckRun,
          }),
      },
    );

    await expect(adapter.create(intent)).resolves.toEqual({
      checkRunId: "701",
    });
    expect(calls).toEqual(["lookup", "head", "create"]);
    expect(createCheckRun).toHaveBeenCalledWith(
      {
        owner: "acme",
        repositoryName: "cachekit",
        name: GITHUB_CHECK_NAME,
        headSha,
        detailsUrl: intent.detailsUrl,
        externalId: revisionId,
        status: "in_progress",
        conclusion: null,
        summary: intent.summary,
      },
      expect.any(AbortSignal),
    );
  });

  it("reuses and updates one exact external-id match after a replay", async () => {
    const createCheckRun = vi.fn();
    const updateCheckRun = vi.fn(async () => ({ data: checkRun(701) }));
    const adapter = new OctokitCheckRunAdapter(tokenProvider(), headPort(), {
      clientFactory: () =>
        githubRestClientStub({
          listCheckRunsForRef: async () => ({
            data: { total_count: 1, check_runs: [checkRun(701)] },
          }),
          createCheckRun,
          updateCheckRun,
        }),
    });

    await expect(adapter.create(intent)).resolves.toEqual({
      checkRunId: "701",
    });
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        checkRunId: 701,
        externalId: revisionId,
        name: GITHUB_CHECK_NAME,
      }),
      expect.any(AbortSignal),
    );
  });

  it("fails closed for duplicate replay matches or an unbounded result set", async () => {
    const write = vi.fn();
    const duplicates = new OctokitCheckRunAdapter(tokenProvider(), headPort(), {
      clientFactory: () =>
        githubRestClientStub({
          listCheckRunsForRef: async () => ({
            data: {
              total_count: 2,
              check_runs: [checkRun(701), checkRun(702)],
            },
          }),
          createCheckRun: write,
          updateCheckRun: write,
        }),
    });
    await expect(duplicates.create(intent)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(write).not.toHaveBeenCalled();

    const unbounded = new OctokitCheckRunAdapter(tokenProvider(), headPort(), {
      clientFactory: () =>
        githubRestClientStub({
          listCheckRunsForRef: async () => ({
            data: { total_count: 301, check_runs: [] },
          }),
        }),
    });
    await expect(unbounded.create(intent)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
  });

  it("does not write when the current PR head changed", async () => {
    const createCheckRun = vi.fn();
    const adapter = new OctokitCheckRunAdapter(
      tokenProvider(),
      headPort(undefined, "b".repeat(40)),
      {
        clientFactory: () =>
          githubRestClientStub({
            listCheckRunsForRef: async () => ({
              data: { total_count: 0, check_runs: [] },
            }),
            createCheckRun,
          }),
      },
    );
    await expect(adapter.create(intent)).rejects.toMatchObject({
      code: "STALE_HEAD",
    });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("does not write when PR state changes after the preflight snapshot", async () => {
    const createCheckRun = vi.fn();
    const adapter = new OctokitCheckRunAdapter(
      tokenProvider(),
      headPort(undefined, headSha, "open"),
      {
        clientFactory: () =>
          githubRestClientStub({
            listCheckRunsForRef: async () => ({
              data: { total_count: 0, check_runs: [] },
            }),
            createCheckRun,
          }),
      },
    );
    await expect(
      adapter.create({
        ...intent,
        expectedPullRequestState: "closed",
        status: "completed",
        conclusion: "cancelled",
      }),
    ).rejects.toMatchObject({ code: "STALE_HEAD" });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("updates a persisted check only after a fresh head lookup", async () => {
    const calls: string[] = [];
    const updateCheckRun = vi.fn(async () => {
      calls.push("update");
      return { data: checkRun(701) };
    });
    const adapter = new OctokitCheckRunAdapter(
      tokenProvider(),
      headPort(() => calls.push("head")),
      {
        clientFactory: () =>
          githubRestClientStub({
            getCheckRun: async () => {
              calls.push("get");
              return { data: checkRun(701) };
            },
            updateCheckRun,
          }),
      },
    );
    await expect(
      adapter.update({ ...intent, checkRunId: "701" }),
    ).resolves.toEqual({ checkRunId: "701" });
    expect(calls).toEqual(["get", "head", "update"]);
  });

  it("fails closed when a persisted remote ID is bound to another check", async () => {
    const updateCheckRun = vi.fn();
    const head = headPort();
    const adapter = new OctokitCheckRunAdapter(tokenProvider(), head, {
      clientFactory: () =>
        githubRestClientStub({
          getCheckRun: async () => ({
            data: checkRun(701, { external_id: "wrong-revision" }),
          }),
          updateCheckRun,
        }),
    });

    await expect(
      adapter.update({ ...intent, checkRunId: "701" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(head.getCurrentHead).not.toHaveBeenCalled();
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it("never automatically retries an ambiguous write", async () => {
    const createCheckRun = vi.fn(async () => {
      throw Object.assign(new Error("upstream 503"), { status: 503 });
    });
    const adapter = new OctokitCheckRunAdapter(tokenProvider(), headPort(), {
      clientFactory: () =>
        githubRestClientStub({
          listCheckRunsForRef: async () => ({
            data: { total_count: 0, check_runs: [] },
          }),
          createCheckRun,
        }),
      requestPolicy: { maxAttempts: 3, sleep: async () => undefined },
    });
    await expect(adapter.create(intent)).rejects.toMatchObject({
      code: "AMBIGUOUS_WRITE",
      status: 503,
    });
    expect(createCheckRun).toHaveBeenCalledTimes(1);
  });

  it("preserves a write Retry-After contract without retrying", async () => {
    const createCheckRun = vi.fn(async () => {
      throw Object.assign(new Error("rate limited"), {
        status: 429,
        response: { headers: { "retry-after": "3" } },
      });
    });
    const adapter = new OctokitCheckRunAdapter(tokenProvider(), headPort(), {
      clientFactory: () =>
        githubRestClientStub({
          listCheckRunsForRef: async () => ({
            data: { total_count: 0, check_runs: [] },
          }),
          createCheckRun,
        }),
    });
    await expect(adapter.create(intent)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 3_000,
    });
    expect(createCheckRun).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched responses and strict invalid inputs", async () => {
    const adapter = new OctokitCheckRunAdapter(tokenProvider(), headPort(), {
      clientFactory: () =>
        githubRestClientStub({
          listCheckRunsForRef: async () => ({
            data: { total_count: 0, check_runs: [] },
          }),
          createCheckRun: async () => ({
            data: checkRun(701, { external_id: "wrong-revision" }),
          }),
        }),
    });
    await expect(adapter.create(intent)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(
      adapter.create({
        ...intent,
        privateTranscript: "never public",
      } as typeof intent),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("invalidates a token after an unambiguous 401 rejection", async () => {
    const provider = tokenProvider();
    const adapter = new OctokitCheckRunAdapter(provider, headPort(), {
      clientFactory: () =>
        githubRestClientStub({
          listCheckRunsForRef: async () => {
            throw Object.assign(new Error("unauthorized"), { status: 401 });
          },
        }),
      requestPolicy: { maxAttempts: 1 },
    });
    await expect(adapter.create(intent)).rejects.toMatchObject({
      code: "REJECTED",
      status: 401,
    });
    expect(provider.invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "42" }),
    );
  });
});

function tokenProvider(): RepositoryInstallationTokenProvider & {
  get: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => "repository-installation-token"),
    invalidate: vi.fn(() => undefined),
  };
}

function headPort(
  onCall?: () => void,
  currentHead = headSha,
  state: "open" | "closed" = "open",
): GithubPullRequestHeadPort {
  return {
    getCurrentHead: vi.fn(async () => {
      onCall?.();
      return {
        headSha: currentHead,
        baseSha: "b".repeat(40),
        state,
      };
    }),
  };
}

function checkRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: GITHUB_CHECK_NAME,
    head_sha: headSha,
    external_id: revisionId,
    ...overrides,
  };
}
