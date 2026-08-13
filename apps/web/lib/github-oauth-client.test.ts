import { describe, expect, it, vi } from "vitest";
import {
  GithubOAuthHttpClient,
  GithubOAuthProviderError,
} from "./github-oauth-client";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

function authenticatedUser(extra: Record<string, unknown> = {}) {
  return {
    login: "octocat",
    id: 12345678,
    node_id: "MDQ6VXNlcjU4MzIzMQ==",
    avatar_url: "https://avatars.githubusercontent.com/u/12345678?v=4",
    gravatar_id: "",
    url: "https://api.github.com/users/octocat",
    html_url: "https://github.com/octocat",
    followers_url: "https://api.github.com/users/octocat/followers",
    following_url:
      "https://api.github.com/users/octocat/following{/other_user}",
    gists_url: "https://api.github.com/users/octocat/gists{/gist_id}",
    starred_url: "https://api.github.com/users/octocat/starred{/owner}{/repo}",
    subscriptions_url: "https://api.github.com/users/octocat/subscriptions",
    organizations_url: "https://api.github.com/users/octocat/orgs",
    repos_url: "https://api.github.com/users/octocat/repos",
    events_url: "https://api.github.com/users/octocat/events{/privacy}",
    received_events_url: "https://api.github.com/users/octocat/received_events",
    type: "User",
    site_admin: false,
    name: "The Octocat",
    company: "@github",
    blog: "https://github.blog",
    location: "San Francisco",
    email: null,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: 8,
    public_gists: 8,
    followers: 10_000,
    following: 9,
    created_at: "2011-01-25T18:44:36Z",
    updated_at: "2026-08-12T10:00:00Z",
    ...extra,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

describe("GitHub OAuth HTTP client", () => {
  it("exchanges PKCE code with repository_id and drops refresh material", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> =>
        jsonResponse({
          access_token: "github-user-access-token",
          token_type: "bearer",
          scope: "",
          expires_in: 28_800,
          refresh_token: "github-refresh-token-value",
          refresh_token_expires_in: 15897600,
        }),
    );
    const client = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      fetchImpl: fetchImpl as typeof fetch,
      now: () => NOW,
    });
    const result = await client.exchangeCode({
      code: "one-use-code",
      codeVerifier: "a".repeat(43),
      redirectUri: "https://slopproof.example/api/auth/github/callback",
      repositoryId: "987654321",
    });

    expect(result).toEqual({
      accessToken: "github-user-access-token",
      expiresAt: new Date("2026-08-12T20:00:00.000Z"),
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    if (!init) throw new Error("test expected fetch init");
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        credentials: "omit",
      }),
    );
    expect(
      Object.fromEntries((init.body as URLSearchParams).entries()),
    ).toEqual({
      client_id: "Iv1.client",
      client_secret: "client-secret-placeholder",
      code: "one-use-code",
      redirect_uri: "https://slopproof.example/api/auth/github/callback",
      code_verifier: "a".repeat(43),
      repository_id: "987654321",
    });
    expect(JSON.stringify(result)).not.toContain("github-refresh-token-value");
  });

  it("performs exact GET /user and strictly projects only server identity", async () => {
    const fetchImpl = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => jsonResponse(authenticatedUser()),
    );
    const client = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.getUser("github-user-access-token")).resolves.toEqual({
      githubUserId: "12345678",
      login: "octocat",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    if (!init) throw new Error("test expected fetch init");
    expect(url).toBe("https://api.github.com/user");
    expect(init).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer github-user-access-token",
          "x-github-api-version": "2022-11-28",
        }),
        cache: "no-store",
        redirect: "error",
      }),
    );
  });

  it("tolerates additive /user fields but strictly projects them away", async () => {
    const privatePayload = "provider-additive-field-marker";
    const fetchImpl = vi.fn(async () =>
      jsonResponse(authenticatedUser({ unexpected: privatePayload })),
    );
    const client = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      fetchImpl,
    });
    const user = await client.getUser("github-user-access-token");
    expect(user).toEqual({ githubUserId: "12345678", login: "octocat" });
    expect(JSON.stringify(user)).not.toContain(privatePayload);
  });

  it("accepts the minimal identity shape returned by a restricted GitHub App token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        login: "octocat",
        id: 12345678,
        notification_email: null,
      }),
    );
    const client = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      fetchImpl,
    });

    await expect(client.getUser("github-user-access-token")).resolves.toEqual({
      githubUserId: "12345678",
      login: "octocat",
    });
  });

  it("bounds a GitHub App token without expires_in to a local 15-minute grant", async () => {
    const client = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      now: () => NOW,
      fetchImpl: async () =>
        jsonResponse({
          access_token: "github-user-access-token",
          token_type: "bearer",
        }),
    });
    await expect(
      client.exchangeCode({
        code: "one-use-code",
        codeVerifier: "a".repeat(43),
        redirectUri: "https://slopproof.example/api/auth/github/callback",
        repositoryId: "987654321",
      }),
    ).resolves.toEqual({
      accessToken: "github-user-access-token",
      expiresAt: new Date("2026-08-12T12:15:00.000Z"),
    });
  });

  it("rejects non-success and oversized responses with one fixed error", async () => {
    const failures: string[] = [];
    const statusClient = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      onFailure: (stage) => failures.push(stage),
      fetchImpl: async () =>
        jsonResponse({ private: "provider-error-body" }, { status: 401 }),
    });
    await expect(
      statusClient.getUser("github-user-access-token"),
    ).rejects.toEqual(
      expect.objectContaining({
        message: "GitHub OAuth provider request failed.",
      }),
    );

    const sizeClient = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      maxResponseBytes: 1_024,
      fetchImpl: async () =>
        jsonResponse({}, { headers: { "content-length": "1025" } }),
    });
    await expect(
      sizeClient.getUser("github-user-access-token"),
    ).rejects.toBeInstanceOf(GithubOAuthProviderError);
    expect(failures).toEqual(["user_fetch"]);
  });

  it("reports only a fixed token-exchange stage when provider payloads fail", async () => {
    const failures: string[] = [];
    const client = new GithubOAuthHttpClient({
      clientId: "Iv1.client",
      clientSecret: "client-secret-placeholder",
      onFailure: (stage) => failures.push(stage),
      fetchImpl: async () => jsonResponse({ error: "provider-private-marker" }),
    });

    await expect(
      client.exchangeCode({
        code: "one-use-code",
        codeVerifier: "a".repeat(43),
        redirectUri: "https://slopproof.example/api/auth/github/callback",
        repositoryId: "987654321",
      }),
    ).rejects.toBeInstanceOf(GithubOAuthProviderError);
    expect(failures).toEqual(["token_exchange"]);
  });
});
