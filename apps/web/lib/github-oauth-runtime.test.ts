import { describe, expect, it } from "vitest";
import {
  GithubOAuthWiringError,
  validateGithubOAuthRuntime,
  type GithubOAuthWebRuntime,
} from "./github-oauth-runtime";

function runtime(): GithubOAuthWebRuntime {
  return {
    appBaseUrl: "https://slopproof.example/",
    oauth: {
      callbackUrl: "https://slopproof.example/api/auth/github/callback",
      stateTtlMs: 300_000,
      freshTokenTtlMs: 600_000,
      start: async () => {
        throw new Error("not used");
      },
      callback: async () => {
        throw new Error("not used");
      },
      logout: async () => {},
    },
    resolveStartBinding: async () => ({
      purpose: "contributor_login",
      repositoryId: "10000000-0000-4000-8000-000000000002",
      githubRepositoryId: "987654321",
    }),
  };
}

describe("GitHub OAuth runtime wiring", () => {
  it("accepts only an exact HTTPS base/callback pairing", () => {
    const valid = runtime();
    expect(validateGithubOAuthRuntime(valid)).toBe(valid);
    expect(() =>
      validateGithubOAuthRuntime({
        ...valid,
        oauth: {
          ...valid.oauth,
          callbackUrl: "https://evil.example/api/auth/github/callback",
        },
      }),
    ).toThrow(GithubOAuthWiringError);
    expect(() =>
      validateGithubOAuthRuntime({
        ...valid,
        appBaseUrl: "http://slopproof.example/",
      }),
    ).toThrow(GithubOAuthWiringError);
  });
});
