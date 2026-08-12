import { Octokit } from "@octokit/rest";
import type { GithubApiResponse } from "./request-policy";

export type InstallationTokenRequest = {
  installationId: number;
  repositoryId: number;
};

export type PullRequestRequest = {
  owner: string;
  repositoryName: string;
  pullNumber: number;
};

export type PullRequestFilesRequest = PullRequestRequest & {
  page: number;
  perPage: number;
};

export type CheckRunRequest = {
  owner: string;
  repositoryName: string;
  name: string;
  headSha: string;
  detailsUrl: string;
  externalId: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "action_required" | "success" | "neutral" | "cancelled" | null;
  summary: string;
};

export type UpdateCheckRunRequest = Omit<CheckRunRequest, "headSha"> & {
  checkRunId: number;
};

export type GetCheckRunRequest = {
  owner: string;
  repositoryName: string;
  checkRunId: number;
};

export type ListCheckRunsForRefRequest = {
  owner: string;
  repositoryName: string;
  headSha: string;
  checkName: string;
  page: number;
  perPage: number;
};

export type CollaboratorPermissionRequest = {
  owner: string;
  repositoryName: string;
  username: string;
};

/** Narrow transport seam used by the production ports and offline tests. */
export interface GithubRestClient {
  createInstallationAccessToken(
    input: InstallationTokenRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
  getPullRequest(
    input: PullRequestRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
  listPullRequestFiles(
    input: PullRequestFilesRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
  createCheckRun(
    input: CheckRunRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
  updateCheckRun(
    input: UpdateCheckRunRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
  getCheckRun(
    input: GetCheckRunRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
  listCheckRunsForRef(
    input: ListCheckRunsForRefRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
  getAuthenticatedUser(signal: AbortSignal): Promise<GithubApiResponse>;
  getCollaboratorPermissionLevel(
    input: CollaboratorPermissionRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse>;
}

export type GithubRestClientFactory = (
  authorization: string,
) => GithubRestClient;

const silentLog = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/** Official Octokit-backed transport. It never installs a request logger. */
export class OctokitGithubRestClient implements GithubRestClient {
  private readonly octokit: Octokit;

  constructor(authorization: string) {
    this.octokit = new Octokit({
      auth: authorization,
      log: silentLog,
      userAgent: "slopproof/0.1.0",
    });
  }

  async createInstallationAccessToken(
    input: InstallationTokenRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.apps.createInstallationAccessToken({
      installation_id: input.installationId,
      repository_ids: [input.repositoryId],
      permissions: {
        checks: "write",
        contents: "read",
        metadata: "read",
        pull_requests: "read",
      },
      request: { signal },
    });
  }

  async getPullRequest(
    input: PullRequestRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repositoryName,
      pull_number: input.pullNumber,
      request: { signal },
    });
  }

  async listPullRequestFiles(
    input: PullRequestFilesRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.pulls.listFiles({
      owner: input.owner,
      repo: input.repositoryName,
      pull_number: input.pullNumber,
      page: input.page,
      per_page: input.perPage,
      request: { signal },
    });
  }

  async createCheckRun(
    input: CheckRunRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.checks.create({
      owner: input.owner,
      repo: input.repositoryName,
      name: input.name,
      head_sha: input.headSha,
      details_url: input.detailsUrl,
      external_id: input.externalId,
      status: input.status,
      ...(input.conclusion === null ? {} : { conclusion: input.conclusion }),
      output: {
        title: input.name,
        summary: input.summary,
      },
      request: { signal },
    });
  }

  async updateCheckRun(
    input: UpdateCheckRunRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.checks.update({
      owner: input.owner,
      repo: input.repositoryName,
      check_run_id: input.checkRunId,
      name: input.name,
      details_url: input.detailsUrl,
      external_id: input.externalId,
      status: input.status,
      ...(input.conclusion === null ? {} : { conclusion: input.conclusion }),
      output: {
        title: input.name,
        summary: input.summary,
      },
      request: { signal },
    });
  }

  async getCheckRun(
    input: GetCheckRunRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.checks.get({
      owner: input.owner,
      repo: input.repositoryName,
      check_run_id: input.checkRunId,
      request: { signal },
    });
  }

  async listCheckRunsForRef(
    input: ListCheckRunsForRefRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.checks.listForRef({
      owner: input.owner,
      repo: input.repositoryName,
      ref: input.headSha,
      check_name: input.checkName,
      filter: "all",
      page: input.page,
      per_page: input.perPage,
      request: { signal },
    });
  }

  async getAuthenticatedUser(signal: AbortSignal): Promise<GithubApiResponse> {
    return this.octokit.rest.users.getAuthenticated({ request: { signal } });
  }

  async getCollaboratorPermissionLevel(
    input: CollaboratorPermissionRequest,
    signal: AbortSignal,
  ): Promise<GithubApiResponse> {
    return this.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: input.owner,
      repo: input.repositoryName,
      username: input.username,
      request: { signal },
    });
  }
}

export const createOctokitGithubRestClient: GithubRestClientFactory = (
  authorization,
) => new OctokitGithubRestClient(authorization);
