import { describe, expect, it, vi } from "vitest";
import { validateGithubControlStartup } from "./startup";

describe("GitHub control startup preflight", () => {
  it("validates Octokit App material locally and discards the preflight JWT", async () => {
    const createJwt = vi.fn(async () => "short-lived-preflight-jwt");
    await expect(
      validateGithubControlStartup(
        {
          GITHUB_ADAPTER: "octokit",
          GITHUB_APP_ID: "123",
          GITHUB_PRIVATE_KEY_PATH: "/run/secrets/github-app.pem",
          GITHUB_PRIVATE_KEY_CONTAINER_PATH: undefined,
        },
        createJwt,
      ),
    ).resolves.toEqual({
      appId: "123",
      privateKeyPath: "/run/secrets/github-app.pem",
    });
    expect(createJwt).toHaveBeenCalledOnce();
  });

  it("fails before startup can continue when App material is missing or invalid", async () => {
    const createJwt = vi.fn(async () => {
      throw new Error("invalid key");
    });
    await expect(
      validateGithubControlStartup(
        {
          GITHUB_ADAPTER: "octokit",
          GITHUB_APP_ID: undefined,
          GITHUB_PRIVATE_KEY_PATH: undefined,
          GITHUB_PRIVATE_KEY_CONTAINER_PATH: undefined,
        },
        createJwt,
      ),
    ).rejects.toThrow("not configured");
    expect(createJwt).not.toHaveBeenCalled();

    await expect(
      validateGithubControlStartup(
        {
          GITHUB_ADAPTER: "octokit",
          GITHUB_APP_ID: "123",
          GITHUB_PRIVATE_KEY_PATH: "/run/secrets/bad.pem",
          GITHUB_PRIVATE_KEY_CONTAINER_PATH: undefined,
        },
        createJwt,
      ),
    ).rejects.toThrow("invalid key");
  });

  it("does not require GitHub App material for the fake adapter", async () => {
    const createJwt = vi.fn();
    await expect(
      validateGithubControlStartup(
        {
          GITHUB_ADAPTER: "fake",
          GITHUB_APP_ID: undefined,
          GITHUB_PRIVATE_KEY_PATH: undefined,
          GITHUB_PRIVATE_KEY_CONTAINER_PATH: undefined,
        },
        createJwt,
      ),
    ).resolves.toBeNull();
    expect(createJwt).not.toHaveBeenCalled();
  });
});
