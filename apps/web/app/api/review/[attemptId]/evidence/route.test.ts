import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyEvidenceCapability } from "../../../../../lib/evidence-capability";

const mocks = vi.hoisted(() => ({
  getWebRuntime: vi.fn(),
  requireEvidenceAccess: vi.fn(),
  requireSession: vi.fn(),
  writeReviewAudit: vi.fn(),
}));

vi.mock("../../../../../lib/runtime", () => ({
  getWebRuntime: mocks.getWebRuntime,
}));
vi.mock("../../../../../lib/http-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireSession: mocks.requireSession,
}));
vi.mock("../../../../../lib/maintainer-review", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireEvidenceAccess: mocks.requireEvidenceAccess,
  writeReviewAudit: mocks.writeReviewAudit,
}));

import { GET } from "./route";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "github-maintainer-42";
const SESSION_SECRET = "evidence-stream-session-secret-000000000";
const WORKER_SECRET = "evidence-stream-worker-secret-0000000000";

describe("GET /api/review/[attemptId]/evidence request protection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getWebRuntime.mockReset();
    mocks.requireEvidenceAccess.mockReset();
    mocks.requireSession.mockReset();
    mocks.writeReviewAudit.mockReset();
  });

  it("rejects a saturated stream quota before fresh authorization, its transaction, or the worker", async () => {
    const quotaQuery = vi.fn(
      async (rawSql: string, _values?: readonly unknown[]) => {
        const sql = String(rawSql);
        if (sql.includes("INSERT INTO web_request_rate_limits")) {
          return { rows: [{ retry_after_seconds: 45 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    );
    const quotaClient = { query: quotaQuery, release: vi.fn() };
    const connect = vi.fn(async () => quotaClient);
    mocks.getWebRuntime.mockResolvedValue({
      config: {
        APP_BASE_URL: "https://slopproof.example",
        SESSION_SECRET,
        WORKER_INTERNAL_SECRET: WORKER_SECRET,
        WORKER_INTERNAL_URL: "http://worker:4001",
      },
      database: { pool: { connect } },
    });
    mocks.requireSession.mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000003",
      actorId: ACTOR_ID,
      actorRole: "maintainer",
      repositoryId: REPOSITORY_ID,
      csrfHash: "c".repeat(64),
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    });
    const upstreamFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("worker must not be called"));

    const response = await GET(
      new Request(
        `https://slopproof.example/api/review/${ATTEMPT_ID}/evidence`,
      ),
      { params: Promise.resolve({ attemptId: ATTEMPT_ID }) },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(quotaClient.release).toHaveBeenCalledOnce();
    expect(mocks.requireEvidenceAccess).not.toHaveBeenCalled();
    expect(mocks.writeReviewAudit).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();

    const reservation = quotaQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO web_request_rate_limits"),
    );
    const parameters = reservation?.[1];
    expect(parameters?.[0]).toBe("evidence_stream");
    expect(parameters?.[1]).toMatch(/^[0-9a-f]{64}$/u);
    expect(parameters?.[1]).not.toContain(ACTOR_ID);
    expect(parameters?.[1]).not.toContain(REPOSITORY_ID);
  });

  it("proxies a 15MB-class WebM without forwarding Content-Length", async () => {
    const recording = webmOfSize(15_193_871);
    const quotaClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const accessClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(quotaClient)
      .mockResolvedValueOnce(accessClient);
    mocks.getWebRuntime.mockResolvedValue({
      config: {
        APP_BASE_URL: "https://slopproof.example",
        SESSION_SECRET,
        WORKER_INTERNAL_SECRET: WORKER_SECRET,
        WORKER_INTERNAL_URL: "http://worker:4001",
      },
      database: { pool: { connect } },
    });
    mocks.requireSession.mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000003",
      actorId: ACTOR_ID,
      actorRole: "maintainer",
      repositoryId: REPOSITORY_ID,
      csrfHash: "c".repeat(64),
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    });
    mocks.requireEvidenceAccess.mockResolvedValue({
      authorization: { actorId: ACTOR_ID, repositoryId: REPOSITORY_ID },
      evidence: {
        repositoryId: REPOSITORY_ID,
        attemptId: ATTEMPT_ID,
        recordingObjectId: "40000000-0000-4000-8000-000000000004",
        revisionId: "50000000-0000-4000-8000-000000000005",
        headSha: "a".repeat(40),
      },
    });
    mocks.writeReviewAudit.mockResolvedValue(undefined);
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(recording, {
        status: 200,
        headers: {
          "content-type": "video/webm;codecs=vp8,opus",
          "content-length": String(recording.byteLength),
        },
      }),
    );

    const response = await GET(
      new Request(
        `https://slopproof.example/api/review/${ATTEMPT_ID}/evidence`,
      ),
      { params: Promise.resolve({ attemptId: ATTEMPT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "video/webm;codecs=vp8,opus",
    );
    expect(response.headers.get("content-length")).toBeNull();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(recording.byteLength);
    expect([...body.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(String(upstreamFetch.mock.calls[0]?.[0])).toBe(
      `http://worker:4001/internal/review/evidence/${ATTEMPT_ID}`,
    );
    const authorization = new Headers(
      upstreamFetch.mock.calls[0]?.[1]?.headers,
    ).get("authorization");
    expect(authorization).toMatch(/^Bearer /u);
    expect(
      verifyEvidenceCapability(
        authorization?.slice("Bearer ".length) ?? "",
        WORKER_SECRET,
      ),
    ).toMatchObject({
      attemptId: ATTEMPT_ID,
      repositoryId: REPOSITORY_ID,
      actorId: ACTOR_ID,
    });
    expect(mocks.requireEvidenceAccess).toHaveBeenCalledOnce();
    expect(mocks.writeReviewAudit).toHaveBeenCalledTimes(2);
  });
});

function webmOfSize(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
}
