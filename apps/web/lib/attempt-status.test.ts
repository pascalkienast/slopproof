import { describe, expect, it, vi } from "vitest";
import { readAttemptStatus, waitForPostUploadStatus } from "./attempt-status";

describe("authoritative attempt status", () => {
  it("polls processing until maintainer review is actually required", async () => {
    const fetchPort = vi
      .fn()
      .mockResolvedValueOnce(json({ status: "processing" }))
      .mockResolvedValueOnce(json({ status: "review_required" }));
    const delayPort = vi.fn(async () => undefined);

    await expect(
      waitForPostUploadStatus("attempt", {
        fetchPort,
        delayPort,
        maximumPolls: 3,
        intervalMs: 10,
      }),
    ).resolves.toBe("review_required");
    expect(fetchPort).toHaveBeenCalledTimes(2);
    expect(delayPort).toHaveBeenCalledOnce();
  });

  it("surfaces a worker technical retry instead of claiming review", async () => {
    const fetchPort = vi.fn(async () => json({ status: "technical_retry" }));

    await expect(
      waitForPostUploadStatus("attempt", { fetchPort }),
    ).resolves.toBe("technical_retry");
  });

  it("rejects unrecognized or failed status responses", async () => {
    await expect(
      readAttemptStatus("attempt", async () => json({ status: "mystery" })),
    ).rejects.toThrow();
    await expect(
      readAttemptStatus("attempt", async () =>
        json({ error: "status_rejected" }, 403),
      ),
    ).rejects.toThrow("status_rejected");
  });

  it("returns processing after the bounded polling window", async () => {
    const delayPort = vi.fn(async () => undefined);
    await expect(
      waitForPostUploadStatus("attempt", {
        fetchPort: async () => json({ status: "processing" }),
        delayPort,
        maximumPolls: 2,
      }),
    ).resolves.toBe("processing");
    expect(delayPort).toHaveBeenCalledTimes(2);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
