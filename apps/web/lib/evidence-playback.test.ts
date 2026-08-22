import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvidencePlaybackError,
  loadReviewEvidencePlayback,
} from "./evidence-playback";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);

describe("review evidence playback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("plays a valid WebM body when Content-Length is missing", async () => {
    const objectUrl = "blob:evidence-missing-length";
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => objectUrl),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          streamUrl: `/api/review/${ATTEMPT_ID}/evidence`,
          expiresAt: "2026-08-21T14:30:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        new Response(WEBM, {
          status: 200,
          headers: { "content-type": "video/webm" },
        }),
      );

    const result = await loadReviewEvidencePlayback({
      attemptId: ATTEMPT_ID,
      csrf: "csrf-token",
      fetchImpl,
    });

    expect(result).toEqual({
      objectUrl,
      expiresAt: "2026-08-21T14:30:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
    });
  });

  it("retries an aborted transfer with a fresh capability and then plays", async () => {
    const objectUrl = "blob:evidence-after-retry";
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => objectUrl),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          streamUrl: `/api/review/${ATTEMPT_ID}/evidence`,
          expiresAt: "2026-08-21T14:30:00.000Z",
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("The user aborted a request."), {
          name: "AbortError",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          streamUrl: `/api/review/${ATTEMPT_ID}/evidence`,
          expiresAt: "2026-08-21T14:31:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        new Response(WEBM, {
          status: 200,
          headers: {
            "content-type": "video/webm",
            "content-length": String(WEBM.byteLength),
          },
        }),
      );

    const events: Array<{ stage: string; aborted: boolean }> = [];
    const result = await loadReviewEvidencePlayback({
      attemptId: ATTEMPT_ID,
      csrf: "csrf-token",
      fetchImpl,
      onEvent: (event) => {
        events.push({ stage: event.stage, aborted: event.aborted });
      },
    });

    expect(result.objectUrl).toBe(objectUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "evidence-capability",
    );
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain(
      "evidence-capability",
    );
    expect(events.some((event) => event.aborted)).toBe(true);
  });

  it("reports a retryable message after an incomplete Content-Length mismatch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({
          streamUrl: `/api/review/${ATTEMPT_ID}/evidence`,
          expiresAt: "2026-08-21T14:30:00.000Z",
        }),
      )
      .mockResolvedValue(
        new Response(WEBM, {
          status: 200,
          headers: {
            "content-type": "video/webm",
            "content-length": "11301489",
          },
        }),
      );
    fetchImpl.mockReset().mockImplementation(async (url) => {
      if (String(url).includes("evidence-capability")) {
        return jsonResponse({
          streamUrl: `/api/review/${ATTEMPT_ID}/evidence`,
          expiresAt: "2026-08-21T14:30:00.000Z",
        });
      }
      return new Response(WEBM, {
        status: 200,
        headers: {
          "content-type": "video/webm",
          "content-length": "11301489",
        },
      });
    });

    await expect(
      loadReviewEvidencePlayback({
        attemptId: ATTEMPT_ID,
        csrf: "csrf-token",
        fetchImpl,
        maxAutomaticRetries: 1,
      }),
    ).rejects.toMatchObject({
      code: "transfer_incomplete",
      retryable: true,
      message:
        "The recording transfer was interrupted. Request fresh access and try again.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("plays a 15MB-class WebM when Content-Length is omitted", async () => {
    const objectUrl = "blob:evidence-15mb";
    const recording = webmOfSize(15_193_871);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => objectUrl),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          streamUrl: `/api/review/${ATTEMPT_ID}/evidence`,
          expiresAt: "2026-08-21T14:30:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        new Response(recording, {
          status: 200,
          headers: { "content-type": "video/webm;codecs=vp8,opus" },
        }),
      );

    await expect(
      loadReviewEvidencePlayback({
        attemptId: ATTEMPT_ID,
        csrf: "csrf-token",
        fetchImpl,
      }),
    ).resolves.toEqual({
      objectUrl,
      expiresAt: "2026-08-21T14:30:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a matching Content-Length success path unchanged", async () => {
    const objectUrl = "blob:evidence-success";
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => objectUrl),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          streamUrl: `/api/review/${ATTEMPT_ID}/evidence`,
          expiresAt: "2026-08-21T14:30:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        new Response(WEBM, {
          status: 200,
          headers: {
            "content-type": "video/webm",
            "content-length": String(WEBM.byteLength),
          },
        }),
      );

    await expect(
      loadReviewEvidencePlayback({
        attemptId: ATTEMPT_ID,
        csrf: "csrf-token",
        fetchImpl,
      }),
    ).resolves.toEqual({
      objectUrl,
      expiresAt: "2026-08-21T14:30:00.000Z",
    });
  });

  it("does not retry a missing CSRF credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      loadReviewEvidencePlayback({
        attemptId: ATTEMPT_ID,
        csrf: undefined,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(EvidencePlaybackError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains a rotated OAuth/CSRF pair instead of calling it a video transfer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "csrf_rejected" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      loadReviewEvidencePlayback({
        attemptId: ATTEMPT_ID,
        csrf: "stale-csrf-token",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: "capability_rejected",
      retryable: false,
      message:
        "Your review session changed. Authorize with GitHub again, then retry.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an interrupted capability request from a video transfer", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("private network detail"));

    await expect(
      loadReviewEvidencePlayback({
        attemptId: ATTEMPT_ID,
        csrf: "csrf-token",
        fetchImpl,
        maxAutomaticRetries: 0,
      }),
    ).rejects.toMatchObject({
      code: "capability_rejected",
      message: "The evidence access request was interrupted. Try again.",
    });
  });
});

function webmOfSize(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
