import {
  authenticateSession,
  verifyCsrf,
  type AuthenticatedSession,
  type IssuedSession,
} from "@slopproof/auth";
import type { WebRuntime } from "./runtime";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "slopproof_session";
export const CSRF_COOKIE = "slopproof_csrf";

export class HttpAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: "authentication_required" | "csrf_rejected" | "forbidden",
  ) {
    super(code);
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
  return session;
}

export async function readPageSession(
  app: WebRuntime,
): Promise<AuthenticatedSession | null> {
  const cookieStore = await cookies();
  return authenticateSession(
    app.database.pool,
    cookieStore.get(SESSION_COOKIE)?.value,
    app.config.SESSION_SECRET,
  );
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
    sameSite: "strict",
    path: "/",
    maxAge,
  });
}

export function authErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof HttpAuthError)) return null;
  return NextResponse.json({ error: error.code }, { status: error.status });
}
