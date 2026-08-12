import { handleGithubOAuthLogout } from "../../../../../lib/github-oauth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleGithubOAuthLogout(request);
}
