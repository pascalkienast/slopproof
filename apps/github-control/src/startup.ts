import type { GithubControlConfig } from "@understandproof/config";
import { createGithubAppJwt } from "@understandproof/github";

export type GithubControlAppMaterial = {
  appId: string;
  privateKeyPath: string;
};

/**
 * Performs the complete local key-file and RSA signing preflight before any
 * queue worker is registered. The short-lived JWT is intentionally discarded;
 * installation-token minting later creates a fresh one when it is needed.
 */
export async function validateGithubControlStartup(
  config: Pick<
    GithubControlConfig,
    | "GITHUB_ADAPTER"
    | "GITHUB_APP_ID"
    | "GITHUB_PRIVATE_KEY_CONTAINER_PATH"
    | "GITHUB_PRIVATE_KEY_PATH"
  >,
  createJwt: typeof createGithubAppJwt = createGithubAppJwt,
): Promise<GithubControlAppMaterial | null> {
  if (config.GITHUB_ADAPTER !== "octokit") return null;
  const privateKeyPath =
    config.GITHUB_PRIVATE_KEY_CONTAINER_PATH ?? config.GITHUB_PRIVATE_KEY_PATH;
  if (!config.GITHUB_APP_ID || !privateKeyPath) {
    throw new Error("GitHub App control material is not configured");
  }
  await createJwt({ appId: config.GITHUB_APP_ID, privateKeyPath });
  return { appId: config.GITHUB_APP_ID, privateKeyPath };
}
