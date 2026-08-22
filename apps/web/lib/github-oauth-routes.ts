import {
  GithubOAuthRejectedError,
  type GithubOAuthCallback,
} from "@slopproof/auth";
import { NextResponse } from "next/server";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  attachSessionCookies,
  requestCookieValue,
} from "./http-auth";
import {
  type GithubOAuthRuntimeResolver,
  type GithubOAuthWebRuntime,
  GithubOAuthStartPolicyError,
  GithubOAuthStartRateLimitError,
  resolveGithubOAuthRuntime,
  validateGithubOAuthRuntime,
} from "./github-oauth-runtime";
import { MAINTAINER_DIRECTORY_COOKIE } from "./maintainer-directory";
import { GITHUB_USER_TOKEN_COOKIE } from "./github-oauth-token";

export const GITHUB_OAUTH_FLOW_COOKIE = "__Secure-slopproof_github_oauth";

const START_PATH = "/api/auth/github/start";
const CALLBACK_PATH = "/api/auth/github/callback";
const LOGOUT_PATH = "/api/auth/github/logout";
const NO_STORE_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});
const CALLBACK_FAILURE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export async function handleGithubOAuthStart(
  request: Request,
  resolve: GithubOAuthRuntimeResolver = resolveGithubOAuthRuntime,
): Promise<NextResponse> {
  try {
    const url = exactRouteUrl(request, "GET", START_PATH);
    rejectUnknownQuery(url, new Set(["returnTo", "repositoryId"]));
    const requestedRedirectPath = singleQueryValue(url, "returnTo");
    const runtime = await resolvedRuntime(resolve, request);
    const binding = await runtime.resolveStartBinding({
      request,
      ...(requestedRedirectPath ? { requestedRedirectPath } : {}),
    });
    const started = await runtime.oauth.start({
      binding,
      ...(requestedRedirectPath ? { requestedRedirectPath } : {}),
    });
    const response = NextResponse.redirect(started.authorizationUrl, 302);
    setNoStoreHeaders(response);
    response.cookies.set(GITHUB_OAUTH_FLOW_COOKIE, started.sealedCookie, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: CALLBACK_PATH,
      maxAge: Math.floor(runtime.oauth.stateTtlMs / 1_000),
      expires: started.cookieExpiresAt,
      priority: "high",
    });
    return response;
  } catch (error) {
    if (error instanceof GithubOAuthStartRateLimitError) {
      return oauthFailure(429, error.retryAfterSeconds);
    }
    return oauthFailure(
      error instanceof GithubOAuthRejectedError ||
        error instanceof GithubOAuthStartPolicyError
        ? 400
        : 503,
    );
  }
}

export async function handleGithubOAuthCallback(
  request: Request,
  resolve: GithubOAuthRuntimeResolver = resolveGithubOAuthRuntime,
): Promise<NextResponse> {
  try {
    const url = exactRouteUrl(request, "GET", CALLBACK_PATH);
    if (url.searchParams.has("error")) {
      rejectUnknownQuery(
        url,
        new Set(["error", "error_description", "error_uri", "state", "iss"]),
      );
      throw new GithubOAuthRejectedError();
    }
    rejectUnknownQuery(url, new Set(["code", "state", "iss"]));
    const code = requiredSingleQueryValue(url, "code");
    const state = requiredSingleQueryValue(url, "state");
    const sealedCookie = requestCookieValue(request, GITHUB_OAUTH_FLOW_COOKIE);
    if (!sealedCookie) throw new GithubOAuthRejectedError();

    const runtime = await resolvedRuntime(resolve, request);
    const currentSessionToken = requestCookieValue(request, SESSION_COOKIE);
    const result = await runtime.oauth.callback({
      code,
      state,
      sealedCookie,
      ...(currentSessionToken ? { currentSessionToken } : {}),
    });
    const redirect = exactLocalRedirect(runtime, result);
    const response = NextResponse.redirect(redirect, 303);
    setNoStoreHeaders(response);
    if (result.kind === "identify") {
      if (
        result.sealedDirectory &&
        result.directoryExpiresAt &&
        result.directoryMaxAgeSeconds !== null
      ) {
        response.cookies.set(
          MAINTAINER_DIRECTORY_COOKIE,
          result.sealedDirectory,
          {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            path: "/",
            maxAge: result.directoryMaxAgeSeconds,
            expires: result.directoryExpiresAt,
            priority: "high",
          },
        );
      }
      clearFlowCookie(response);
      clearUserTokenCookie(response);
      return response;
    }
    attachSessionCookies(response, result.issuedSession, runtime.appBaseUrl);
    response.cookies.set(GITHUB_USER_TOKEN_COOKIE, result.sealedUserToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: result.userTokenMaxAgeSeconds,
      expires: result.userTokenExpiresAt,
      priority: "high",
    });
    clearFlowCookie(response);
    clearDirectoryCookie(response);
    return response;
  } catch (error) {
    const response = oauthCallbackFailure(
      error instanceof GithubOAuthRejectedError ? 400 : 503,
    );
    clearFlowCookie(response);
    clearUserTokenCookie(response);
    clearDirectoryCookie(response);
    return response;
  }
}

function oauthCallbackFailure(status: 400 | 503): NextResponse {
  const unavailable = status === 503;
  const title = unavailable
    ? "GitHub is temporarily unavailable"
    : "GitHub authorization did not finish";
  const detail = unavailable
    ? "SlopProof could not complete the secure GitHub exchange. Nothing was submitted. Please try again from the current GitHub Check in a moment."
    : "Nothing was submitted. Return to the current GitHub Check and start authorization again when you are ready.";
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · SlopProof</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f5f2ea; color: #171717; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      main { width: min(100%, 680px); border: 3px solid currentColor; border-radius: 24px; padding: clamp(28px, 7vw, 56px); background: #fffdf7; box-shadow: 8px 8px 0 #171717; }
      p:first-child { margin: 0 0 18px; font: 700 13px/1.2 ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; color: #d65332; }
      h1 { margin: 0; font-size: clamp(38px, 8vw, 68px); line-height: .98; letter-spacing: -.04em; }
      p { font-size: 18px; line-height: 1.55; }
      a { display: inline-block; margin-top: 12px; border: 2px solid currentColor; border-radius: 999px; padding: 12px 18px; color: inherit; font-weight: 750; text-decoration: none; background: #e9ff70; }
      a:focus-visible { outline: 4px solid #2f72ff; outline-offset: 4px; }
    </style>
  </head>
  <body>
    <main>
      <p>SlopProof · GitHub authorization</p>
      <h1>${title}</h1>
      <p>${detail}</p>
      <a href="/">Return to SlopProof</a>
    </main>
  </body>
</html>`;
  return new NextResponse(body, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CALLBACK_FAILURE_CSP,
    },
  });
}

export async function handleGithubOAuthLogout(
  request: Request,
  resolve: GithubOAuthRuntimeResolver = resolveGithubOAuthRuntime,
): Promise<NextResponse> {
  try {
    exactRouteUrl(request, "POST", LOGOUT_PATH);
    const runtime = await resolvedRuntime(resolve, request);
    if (request.headers.get("origin") !== new URL(runtime.appBaseUrl).origin) {
      return oauthFailure(403);
    }
    const sessionToken = requestCookieValue(request, SESSION_COOKIE);
    if (!sessionToken) {
      const response = emptyNoStoreResponse();
      clearAllAuthCookies(response);
      return response;
    }
    const csrfToken = request.headers.get("x-slopproof-csrf");
    if (!csrfToken || csrfToken.length > 1_024 || /[\0\r\n]/u.test(csrfToken)) {
      return oauthFailure(403);
    }
    await runtime.oauth.logout({ sessionToken, csrfToken });
    const response = emptyNoStoreResponse();
    clearAllAuthCookies(response);
    return response;
  } catch {
    return oauthFailure(503);
  }
}

async function resolvedRuntime(
  resolve: GithubOAuthRuntimeResolver,
  request: Request,
): Promise<GithubOAuthWebRuntime> {
  return validateGithubOAuthRuntime(await resolve(request));
}

function exactRouteUrl(
  request: Request,
  method: "GET" | "POST",
  pathname: string,
): URL {
  const url = new URL(request.url);
  if (request.method !== method || url.pathname !== pathname || url.hash) {
    throw new GithubOAuthRejectedError();
  }
  return url;
}

function rejectUnknownQuery(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new GithubOAuthRejectedError();
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new GithubOAuthRejectedError();
    }
  }
}

function singleQueryValue(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

function requiredSingleQueryValue(url: URL, name: string): string {
  const value = singleQueryValue(url, name);
  if (!value) throw new GithubOAuthRejectedError();
  return value;
}

function exactLocalRedirect(
  runtime: GithubOAuthWebRuntime,
  result: GithubOAuthCallback,
): URL {
  const base = new URL(runtime.appBaseUrl);
  const redirect = new URL(result.redirectPath, base);
  if (
    redirect.origin !== base.origin ||
    redirect.pathname !== result.redirectPath ||
    redirect.search ||
    redirect.hash
  ) {
    throw new GithubOAuthRejectedError();
  }
  return redirect;
}

function oauthFailure(
  status: 400 | 403 | 429 | 503,
  retryAfterSeconds?: number,
): NextResponse {
  const headers: Record<string, string> = { ...NO_STORE_HEADERS };
  if (
    status === 429 &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds! > 0
  ) {
    headers["retry-after"] = String(retryAfterSeconds);
  }
  return NextResponse.json(
    {
      error:
        status === 503
          ? "temporarily_unavailable"
          : status === 429
            ? "rate_limited"
            : "oauth_rejected",
    },
    { status, headers },
  );
}

function emptyNoStoreResponse(): NextResponse {
  return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
}

function setNoStoreHeaders(response: NextResponse): void {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
}

function clearAllAuthCookies(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", expiredCookie("/", true, "lax"));
  response.cookies.set(CSRF_COOKIE, "", expiredCookie("/", false, "lax"));
  clearFlowCookie(response);
  clearUserTokenCookie(response);
  clearDirectoryCookie(response);
}

function clearDirectoryCookie(response: NextResponse): void {
  response.cookies.set(
    MAINTAINER_DIRECTORY_COOKIE,
    "",
    expiredCookie("/", true, "lax"),
  );
}

function clearFlowCookie(response: NextResponse): void {
  response.cookies.set(
    GITHUB_OAUTH_FLOW_COOKIE,
    "",
    expiredCookie(CALLBACK_PATH, true, "lax"),
  );
}

function clearUserTokenCookie(response: NextResponse): void {
  response.cookies.set(
    GITHUB_USER_TOKEN_COOKIE,
    "",
    expiredCookie("/", true, "lax"),
  );
}

function expiredCookie(
  path: string,
  httpOnly: boolean,
  sameSite: "lax" | "strict",
) {
  return {
    httpOnly,
    secure: true,
    sameSite,
    path,
    maxAge: 0,
    expires: new Date(0),
  } as const;
}
