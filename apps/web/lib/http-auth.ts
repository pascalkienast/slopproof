import {
  authenticateSession,
  verifyCsrf,
  type AuthenticatedSession,
  type IssuedSession,
} from "@slopproof/auth";
import type { WebRuntime } from "./runtime";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "slopproof_session";
export const CSRF_COOKIE = "slopproof_csrf";

export class HttpAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "authentication_required" | "csrf_rejected" | "forbidden",
  ) {
    super(code);
    this.name = "HttpAuthError";
  }
}

export function requestCookieValue(
  request: Request,
  name: string,
): string | undefined {
  const raw = request.headers.get("cookie");
  if (!raw) return undefined;
  for (const pair of raw.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }
  return undefined;
}

export async function requireSession(
  request: Request,
  app: WebRuntime,
): Promise<AuthenticatedSession> {
  const session = await authenticateSession(
    app.database.pool,
    requestCookieValue(request, SESSION_COOKIE),
    app.config.SESSION_SECRET,
  );
  if (!session) throw new HttpAuthError(401, "authentication_required");
  if (!(await hasActiveRepositoryBinding(app, session))) {
    throw new HttpAuthError(403, "forbidden");
  }
  return session;
}

export async function readPageSession(
  app: WebRuntime,
): Promise<AuthenticatedSession | null> {
  const cookieStore = await cookies();
  const session = await authenticateSession(
    app.database.pool,
    cookieStore.get(SESSION_COOKIE)?.value,
    app.config.SESSION_SECRET,
  );
  if (!session || !(await hasActiveRepositoryBinding(app, session))) {
    return null;
  }
  return session;
}

/**
 * Reads one immutable incoming Cookie header for both the server-rendered page
 * session and the request-near GitHub user-token check. Only the Cookie header
 * is forwarded, and the synthetic request URL is restricted to an exact local
 * path under the configured application origin.
 */
export async function readPageSessionRequest(
  app: WebRuntime,
  pathname: string,
): Promise<Readonly<{
  request: Request;
  session: AuthenticatedSession;
}> | null> {
  const baseUrl = new URL(app.config.APP_BASE_URL);
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    /[\0\r\n]/u.test(pathname)
  ) {
    throw new HttpAuthError(403, "forbidden");
  }
  const requestUrl = new URL(pathname, baseUrl);
  if (
    requestUrl.origin !== baseUrl.origin ||
    requestUrl.pathname !== pathname ||
    requestUrl.search ||
    requestUrl.hash
  ) {
    throw new HttpAuthError(403, "forbidden");
  }

  const incomingHeaders = await headers();
  const cookieHeader = incomingHeaders.get("cookie");
  const forwardedHeaders = new Headers();
  if (cookieHeader) forwardedHeaders.set("cookie", cookieHeader);
  const request = new Request(requestUrl, { headers: forwardedHeaders });
  const session = await authenticateSession(
    app.database.pool,
    requestCookieValue(request, SESSION_COOKIE),
    app.config.SESSION_SECRET,
  );
  if (!session || !(await hasActiveRepositoryBinding(app, session))) {
    return null;
  }
  return Object.freeze({ request, session });
}

/**
 * Rechecks the installation/repository trust boundary for every authenticated
 * request. Attempt-specific handlers still compare this repository id with
 * their locked aggregate before mutating it.
 */
async function hasActiveRepositoryBinding(
  app: WebRuntime,
  session: AuthenticatedSession,
): Promise<boolean> {
  if (!session.repositoryId) return true;
  const active = await app.database.pool.query(
    `SELECT 1
       FROM repositories repository
       JOIN installations installation ON installation.id = repository.installation_id
      WHERE repository.id = $1
        AND repository.status = 'active'
        AND installation.status = 'active'
      LIMIT 1`,
    [session.repositoryId],
  );
  return active.rowCount === 1;
}

export async function requireMutationSession(
  request: Request,
  app: WebRuntime,
): Promise<AuthenticatedSession> {
  const session = await requireSession(request, app);
  if (
    !verifyCsrf(
      session,
      request.headers.get("x-slopproof-csrf") ?? undefined,
      app.config.SESSION_SECRET,
    )
  ) {
    throw new HttpAuthError(403, "csrf_rejected");
  }
  return session;
}

export function attachSessionCookies(
  response: NextResponse,
  issued: IssuedSession,
  appBaseUrl: string,
): void {
  const secure = new URL(appBaseUrl).protocol === "https:";
  const maxAge = Math.max(
    0,
    Math.floor((issued.session.expiresAt.getTime() - Date.now()) / 1_000),
  );
  response.cookies.set(SESSION_COOKIE, issued.sessionToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  response.cookies.set(CSRF_COOKIE, issued.csrfToken, {
    httpOnly: false,
    secure,
    // The token still has to be echoed in a non-simple same-origin header.
    // Lax keeps the OAuth callback's rotated session and CSRF pair coherent
    // across Safari/WebKit's cross-site redirect chain.
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}

export function authErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof HttpAuthError)) return null;
  return NextResponse.json({ error: error.code }, { status: error.status });
}
