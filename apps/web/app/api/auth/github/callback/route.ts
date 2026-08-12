import { handleGithubOAuthCallback } from "../../../../../lib/github-oauth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleGithubOAuthCallback(request);
}
