import type { GithubRestClient } from "./octokit-client";

export function githubRestClientStub(
  overrides: Partial<GithubRestClient> = {},
): GithubRestClient {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected GitHub test transport call");
  };
  return {
    createInstallationAccessToken: unexpected,
    getPullRequest: unexpected,
    listPullRequestFiles: unexpected,
    getGitCommit: unexpected,
    getGitTree: unexpected,
    createCheckRun: unexpected,
    updateCheckRun: unexpected,
    getCheckRun: unexpected,
    listCheckRunsForRef: unexpected,
    listIssueComments: unexpected,
    createIssueComment: unexpected,
    updateIssueComment: unexpected,
    getAuthenticatedUser: unexpected,
    getCollaboratorPermissionLevel: unexpected,
    ...overrides,
  };
}
