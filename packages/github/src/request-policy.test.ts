import { describe, expect, it, vi } from "vitest";
import { GithubControlError } from "./production-errors";
import { executeGithubRequest } from "./request-policy";

describe("GitHub request policy", () => {
  it("honors Retry-After for rate limits before retrying", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, { "Retry-After": "2" }))
      .mockResolvedValueOnce({ data: { ok: true } });
    const sleep = vi.fn(async () => undefined);

    await expect(
      executeGithubRequest(request, {
        maxAttempts: 2,
        random: () => 0,
        sleep,
      }),
    ).resolves.toEqual({ data: { ok: true } });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("classifies exhausted primary rate limits and exposes only safe metadata", async () => {
    const secret = "github-token-that-must-not-leak";
    const error = await executeGithubRequest(
      async () => {
        throw Object.assign(new Error(`denied ${secret}`), {
          status: 403,
          response: {
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1786536060",
            },
          },
        });
      },
      {
        maxAttempts: 1,
        now: () => 1_786_536_000_000,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RATE_LIMITED",
      status: 403,
      retryAfterMs: 60_000,
    });
    expect(String(error)).not.toContain(secret);
  });

  it("recognizes an official secondary-limit marker but rejects an ordinary permission 403", async () => {
    const secondary = httpError(
      403,
      {},
      {
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      },
    );
    const secondaryRequest = vi.fn(async () => Promise.reject(secondary));
    const sleep = vi.fn(async () => undefined);
    await expect(
      executeGithubRequest(secondaryRequest, {
        maxAttempts: 3,
        deadlineMs: 25_000,
        sleep,
      }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 403,
      retryAfterMs: 60_000,
    });
    expect(secondaryRequest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    const permission = httpError(
      403,
      {},
      {
        message: "Resource not accessible by integration",
      },
    );
    await expect(
      executeGithubRequest(async () => Promise.reject(permission), {
        maxAttempts: 1,
      }),
    ).rejects.toMatchObject({ code: "REJECTED", status: 403 });
  });

  it("retries 5xx/network failures but not ordinary 4xx responses", async () => {
    const retryable = vi
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce({ data: "ok" });
    await expect(
      executeGithubRequest(retryable, {
        maxAttempts: 3,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({ data: "ok" });

    const rejected = vi.fn().mockRejectedValue(httpError(404));
    await expect(
      executeGithubRequest(rejected, { maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "REJECTED", status: 404 });
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("does not sleep beyond an overall deadline", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      executeGithubRequest(
        async () => {
          throw httpError(429, { "retry-after": "10" });
        },
        {
          maxAttempts: 3,
          deadlineMs: 5_000,
          now: () => 1_000,
          sleep,
        },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 10_000 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("aborts and returns a typed timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const error = await executeGithubRequest(
      (signal) => {
        observedSignal = signal;
        return new Promise<never>(() => undefined);
      },
      { maxAttempts: 1, attemptTimeoutMs: 5, deadlineMs: 20 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GithubControlError);
    expect(error).toMatchObject({ code: "TIMEOUT" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects policies that could silently exceed the retry cap", async () => {
    await expect(
      executeGithubRequest(async () => ({ data: null }), { maxAttempts: 4 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

function httpError(
  status: number,
  headers: Record<string, string> = {},
  data: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error("upstream response"), {
    status,
    response: { status, headers, data },
  });
}
