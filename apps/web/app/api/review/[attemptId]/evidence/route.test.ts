import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_CAPABILITY_COOKIE,
  issueEvidenceCapability,
} from "../../../../../lib/evidence-capability";

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
    const capability = issueEvidenceCapability(
      {
        attemptId: ATTEMPT_ID,
        repositoryId: REPOSITORY_ID,
        actorId: ACTOR_ID,
      },
      WORKER_SECRET,
    );
    const upstreamFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("worker must not be called"));

    const response = await GET(
      new Request(
        `https://slopproof.example/api/review/${ATTEMPT_ID}/evidence`,
        {
          headers: {
            cookie: `${EVIDENCE_CAPABILITY_COOKIE}=${capability.token}`,
          },
        },
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
});
