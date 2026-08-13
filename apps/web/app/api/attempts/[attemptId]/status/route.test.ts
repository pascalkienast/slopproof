import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebRuntime: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("../../../../../lib/runtime", () => ({
  getWebRuntime: mocks.getWebRuntime,
}));
vi.mock("../../../../../lib/http-auth", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireSession: mocks.requireSession,
}));

import { GET } from "./route";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const REVISION_ID = "20000000-0000-4000-8000-000000000002";
const REPOSITORY_ID = "30000000-0000-4000-8000-000000000003";
const ACTOR_ID = "github-author-42";

describe("GET /api/attempts/[attemptId]/status", () => {
  beforeEach(() => {
    mocks.getWebRuntime.mockReset();
    mocks.requireSession.mockReset();
  });

  it("returns the author's authoritative server status without caching", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          status: "technical_retry",
          revision_id: REVISION_ID,
          head_sha: "a".repeat(40),
          is_current: true,
          author_id: ACTOR_ID,
          repository_id: REPOSITORY_ID,
        },
      ],
    }));
    mocks.getWebRuntime.mockResolvedValue({
      database: { pool: { query } },
    });
    mocks.requireSession.mockResolvedValue({
      actorId: ACTOR_ID,
      actorRole: "author",
      repositoryId: REPOSITORY_ID,
    });

    const response = await GET(
      new Request(
        `https://slopproof.example/api/attempts/${ATTEMPT_ID}/status`,
      ),
      { params: Promise.resolve({ attemptId: ATTEMPT_ID }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      attemptId: ATTEMPT_ID,
      revisionId: REVISION_ID,
      headSha: "a".repeat(40),
      status: "technical_retry",
      isCurrent: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("attempt.author_id = $2"),
      [ATTEMPT_ID, ACTOR_ID, REPOSITORY_ID],
    );
  });

  it("fails closed for another actor or an invalid stored status", async () => {
    mocks.requireSession.mockResolvedValue({
      actorId: ACTOR_ID,
      actorRole: "author",
      repositoryId: REPOSITORY_ID,
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            status: "invented",
            revision_id: REVISION_ID,
            head_sha: "a".repeat(40),
            is_current: true,
            author_id: ACTOR_ID,
            repository_id: REPOSITORY_ID,
          },
        ],
      });
    mocks.getWebRuntime.mockResolvedValue({
      database: { pool: { query } },
    });
    const request = new Request(
      `https://slopproof.example/api/attempts/${ATTEMPT_ID}/status`,
    );
    const context = { params: Promise.resolve({ attemptId: ATTEMPT_ID }) };

    await expect((await GET(request, context)).json()).resolves.toEqual({
      error: "status_rejected",
    });
    const invalidStatus = await GET(request, context);
    expect(invalidStatus.status).toBe(403);
    await expect(invalidStatus.json()).resolves.toEqual({
      error: "status_rejected",
    });
  });
});
