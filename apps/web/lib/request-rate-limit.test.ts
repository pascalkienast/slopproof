import { describe, expect, it, vi } from "vitest";
import { trustedProxyHeaders } from "./oauth-start-protection";
import {
  consumeWebRequestRateLimit,
  createTrustedProxySubjectHash,
  createWebRequestSubjectHash,
  TrustedProxyRequestError,
  WebRequestRateLimitExceededError,
  webRequestRateLimitResponse,
} from "./request-rate-limit";

const SUBJECT_SECRET = "request-rate-limit-subject-secret-000000000";
const PROXY_SECRET = "trusted-proxy-authenticator-000000000000";

describe("web request rate-limit boundary", () => {
  it("creates stable, action-separated HMAC subjects without raw identifiers", () => {
    const actor = "github-user-private-42";
    const repository = "10000000-0000-4000-8000-000000000001";
    const first = createWebRequestSubjectHash(SUBJECT_SECRET, "upload_start", [
      actor,
      repository,
    ]);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toContain(actor);
    expect(first).toBe(
      createWebRequestSubjectHash(SUBJECT_SECRET, "upload_start", [
        actor,
        repository,
      ]),
    );
    expect(first).not.toBe(
      createWebRequestSubjectHash(SUBJECT_SECRET, "upload_finalize", [
        actor,
        repository,
      ]),
    );
  });

  it("accepts only an authenticated proxy address and returns only its HMAC", () => {
    const headers = trustedProxyHeaders(PROXY_SECRET, "2001:db8::10");
    const request = new Request(
      "https://slopproof.example/api/handoff/exchange",
      {
        method: "POST",
        headers,
      },
    );
    const subject = createTrustedProxySubjectHash(request, {
      proxySecret: PROXY_SECRET,
      subjectSecret: SUBJECT_SECRET,
      action: "handoff_exchange",
    });
    expect(subject).toMatch(/^[0-9a-f]{64}$/u);
    expect(subject).not.toContain("2001:db8");

    const tampered = new Request(request.url, {
      method: "POST",
      headers: {
        ...headers,
        "x-slopproof-proxy-authenticator": "x".repeat(32),
      },
    });
    expect(() =>
      createTrustedProxySubjectHash(tampered, {
        proxySecret: PROXY_SECRET,
        subjectSecret: SUBJECT_SECRET,
        action: "handoff_exchange",
      }),
    ).toThrow(TrustedProxyRequestError);
  });

  it("commits bounded cleanup and exposes only controlled Retry-After on rejection", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: null }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // cleanup
      .mockResolvedValueOnce({
        rows: [{ retry_after_seconds: 37 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: null }); // COMMIT
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };

    await expect(
      consumeWebRequestRateLimit(pool as never, {
        action: "review_decision",
        subjectKeyHash: "a".repeat(64),
      }),
    ).rejects.toMatchObject({
      retryAfterSeconds: 37,
    } satisfies Partial<WebRequestRateLimitExceededError>);
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    expect(query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns a value-free 429 with a bounded Retry-After", async () => {
    const response = webRequestRateLimitResponse(
      new WebRequestRateLimitExceededError(37),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });

    const invalid = webRequestRateLimitResponse(
      new WebRequestRateLimitExceededError(Number.POSITIVE_INFINITY),
    );
    expect(invalid.headers.get("retry-after")).toBe("60");
  });
});
