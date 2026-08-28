import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeWebRequestRateLimit: vi.fn(),
  getWebRuntime: vi.fn(),
  persistClosedBetaSignup: vi.fn(),
}));

vi.mock("../../../../lib/runtime", () => ({
  getWebRuntime: mocks.getWebRuntime,
}));
vi.mock("../../../../lib/closed-beta-signup", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  persistClosedBetaSignup: mocks.persistClosedBetaSignup,
}));
vi.mock("../../../../lib/request-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  consumeWebRequestRateLimit: mocks.consumeWebRequestRateLimit,
}));

import { POST } from "./route";

const SESSION_SECRET = "closed-beta-session-secret-000000000000000";

describe("POST /api/public/closed-beta", () => {
  beforeEach(() => {
    mocks.consumeWebRequestRateLimit.mockReset().mockResolvedValue(undefined);
    mocks.getWebRuntime.mockReset().mockResolvedValue({
      config: {
        DEPLOYMENT_PROFILE: "local",
        OAUTH_TRUSTED_PROXY_SECRET: undefined,
        SESSION_SECRET,
      },
      database: { pool: {} },
    });
    mocks.persistClosedBetaSignup
      .mockReset()
      .mockResolvedValue({ accepted: true, stored: true });
  });

  it("accepts a normalized signup without exposing whether it was new", async () => {
    const response = await POST(
      jsonRequest({
        email: "Pascal@Example.COM",
        githubUsername: "@Pascal-Kienast",
        contactConsent: true,
        website: "",
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "received" });
    expect(mocks.consumeWebRequestRateLimit).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: "closed_beta_signup" }),
    );
    expect(mocks.persistClosedBetaSignup).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        email: "pascal@example.com",
        githubUsername: "pascal-kienast",
        contactConsent: true,
      }),
    );
  });

  it("rejects invalid and oversized bodies before runtime work", async () => {
    const invalid = await POST(
      jsonRequest({
        email: "invalid",
        githubUsername: "pascal-kienast",
        contactConsent: true,
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_request" });

    const oversized = await POST(
      new Request("https://slopproof.example/api/public/closed-beta", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1025",
        },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({
      error: "request_too_large",
    });
    expect(mocks.getWebRuntime).not.toHaveBeenCalled();
    expect(mocks.persistClosedBetaSignup).not.toHaveBeenCalled();
  });

  it("fails closed when production lacks the authenticated proxy assertion", async () => {
    mocks.getWebRuntime.mockResolvedValueOnce({
      config: {
        DEPLOYMENT_PROFILE: "production",
        OAUTH_TRUSTED_PROXY_SECRET:
          "closed-beta-proxy-secret-000000000000000000",
        SESSION_SECRET,
      },
      database: { pool: {} },
    });

    const response = await POST(
      jsonRequest({
        email: "pascal@example.com",
        githubUsername: "pascal-kienast",
        contactConsent: true,
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
    expect(mocks.consumeWebRequestRateLimit).not.toHaveBeenCalled();
    expect(mocks.persistClosedBetaSignup).not.toHaveBeenCalled();
  });
});

function jsonRequest(input: unknown): Request {
  return new Request("https://slopproof.example/api/public/closed-beta", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(input),
  });
}
