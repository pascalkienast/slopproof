import { describe, expect, it, vi } from "vitest";
import {
  postReplacementAttempt,
  postTechnicalAbort,
} from "./technical-recovery";

describe("mobile technical recovery requests", () => {
  it("awaits a reason-bound idempotent abort and preserves already-progressed", async () => {
    const fetchPort = vi.fn(async () =>
      Response.json({ status: "already_progressed" }),
    );
    await expect(
      postTechnicalAbort(
        {
          attemptId: "10000000-0000-4000-8000-000000000001",
          headSha: "a".repeat(40),
          csrfToken: "csrf-token",
          idempotencyKey: "technical-abort:one",
          reason: "media_track_ended",
        },
        fetchPort,
      ),
    ).resolves.toEqual({ status: "already_progressed" });
    expect(fetchPort).toHaveBeenCalledOnce();
    expect(fetchPort).toHaveBeenCalledWith(
      "/api/attempts/10000000-0000-4000-8000-000000000001/technical-abort",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-slopproof-csrf": "csrf-token",
          "idempotency-key": "technical-abort:one",
        }),
        body: JSON.stringify({
          expectedHeadSha: "a".repeat(40),
          reason: "media_track_ended",
        }),
      }),
    );
  });

  it("creates a replacement only through the SHA-bound retry endpoint", async () => {
    const fetchPort = vi.fn(async () =>
      Response.json({
        contributorUrl:
          "/revisions/20000000-0000-4000-8000-000000000002/contribute",
      }),
    );
    await expect(
      postReplacementAttempt(
        {
          attemptId: "10000000-0000-4000-8000-000000000001",
          headSha: "b".repeat(40),
          csrfToken: "csrf-token",
          idempotencyKey: "technical-retry:one",
        },
        fetchPort,
      ),
    ).resolves.toEqual({
      contributorUrl:
        "/revisions/20000000-0000-4000-8000-000000000002/contribute",
    });
    expect(fetchPort).toHaveBeenCalledWith(
      "/api/attempts/10000000-0000-4000-8000-000000000001/retry",
      expect.objectContaining({
        body: JSON.stringify({ expectedHeadSha: "b".repeat(40) }),
      }),
    );
  });

  it("does not turn a rejected abort into a replacement", async () => {
    const fetchPort = vi.fn(async () =>
      Response.json({ error: "technical_abort_rejected" }, { status: 409 }),
    );
    await expect(
      postTechnicalAbort(
        {
          attemptId: "10000000-0000-4000-8000-000000000001",
          headSha: "c".repeat(40),
          csrfToken: "csrf-token",
          idempotencyKey: "technical-abort:two",
          reason: "encryption_or_upload_failed",
        },
        fetchPort,
      ),
    ).rejects.toThrow("technical_abort_rejected");
  });
});
