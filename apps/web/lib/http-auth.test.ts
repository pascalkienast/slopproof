import { describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { attachSessionCookies, HttpAuthError } from "./http-auth";

describe("review HTTP auth", () => {
  it("keeps rotated OAuth session and CSRF cookies on the same Lax policy", () => {
    const response = new NextResponse(null, { status: 204 });
    attachSessionCookies(
      response,
      {
        session: {
          id: "10000000-0000-4000-8000-000000000001",
          actorId: "42",
          actorRole: "maintainer",
          repositoryId: "10000000-0000-4000-8000-000000000002",
          csrfHash: "a".repeat(64),
          expiresAt: new Date(Date.now() + 60_000),
        },
        sessionToken: "session-token",
        csrfToken: "csrf-token",
      },
      "https://slopproof.example",
    );

    const cookies = response.headers.getSetCookie();
    expect(
      cookies.find((cookie) => cookie.startsWith("slopproof_session=")),
    ).toContain("SameSite=lax");
    expect(
      cookies.find((cookie) => cookie.startsWith("slopproof_csrf=")),
    ).toContain("SameSite=lax");
  });

  it("gives authentication failures an observable but content-free class", () => {
    const error = new HttpAuthError(403, "csrf_rejected");
    expect(error.name).toBe("HttpAuthError");
    expect(error).toMatchObject({ status: 403, code: "csrf_rejected" });
  });
});
