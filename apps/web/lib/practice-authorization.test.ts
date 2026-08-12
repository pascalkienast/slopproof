import { describe, expect, it, vi } from "vitest";
import { requirePracticeAuthorAccess } from "./practice-authorization";

const revisionId = "11111111-1111-4111-8111-111111111111";
const repositoryId = "22222222-2222-4222-8222-222222222222";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    actorId: "author-42",
    actorRole: "author" as const,
    repositoryId,
    csrfHash: "c".repeat(64),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("practice author authorization", () => {
  it("returns only an exact current author/repository binding", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          revision_id: revisionId,
          repository_id: repositoryId,
          author_id: "author-42",
          head_sha: "a".repeat(40),
        },
      ],
    });

    await expect(
      requirePracticeAuthorAccess(session(), revisionId, { query } as never),
    ).resolves.toEqual({
      revisionId,
      repositoryId,
      actorId: "author-42",
      headSha: "a".repeat(40),
    });
    expect(query.mock.calls[0]?.[0]).toContain("revision.is_current = true");
    expect(query.mock.calls[0]?.[0]).toContain("pull_request.author_id = $3");
    expect(query.mock.calls[0]?.[0]).toContain(
      "installation.status = 'active'",
    );
    expect(query.mock.calls[0]?.[1]).toEqual([
      revisionId,
      repositoryId,
      "author-42",
    ]);
  });

  it.each([
    [{ actorRole: "maintainer" }],
    [{ repositoryId: null }],
    [{ actorId: "" }],
  ])("rejects a session outside the author boundary", async (overrides) => {
    const query = vi.fn();
    await expect(
      requirePracticeAuthorAccess(session(overrides), revisionId, {
        query,
      } as never),
    ).rejects.toMatchObject({ code: "PRACTICE_AUTHORIZATION_REQUIRED" });
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed when the current binding cannot be loaded", async () => {
    await expect(
      requirePracticeAuthorAccess(session(), revisionId, {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      } as never),
    ).rejects.toMatchObject({ code: "PRACTICE_AUTHORIZATION_REQUIRED" });
  });
});
