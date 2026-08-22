import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWebRuntime: vi.fn(),
  requireMutationSession: vi.fn(),
}));

vi.mock("./runtime", () => ({ getWebRuntime: mocks.getWebRuntime }));
vi.mock("./http-auth", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    requireMutationSession: mocks.requireMutationSession,
  };
});

import { POST as createHandoff } from "../app/api/attempts/[attemptId]/handoff/route";
import { POST as startUpload } from "../app/api/attempts/[attemptId]/uploads/route";
import { POST as exchangeHandoff } from "../app/api/handoff/exchange/route";
import { POST as issueEvidenceCapability } from "../app/api/review/[attemptId]/evidence-capability/route";
import { POST as decideReview } from "../app/api/review/[attemptId]/decision/route";
import { POST as finalizeUpload } from "../app/api/uploads/finalize/route";
import { POST as acknowledgePart } from "../app/api/uploads/part-complete/route";
import { POST as presignPart } from "../app/api/uploads/part-url/route";
import { HttpAuthError } from "./http-auth";

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";

describe("production mutation request-body boundaries", () => {
  beforeEach(() => {
    mocks.getWebRuntime.mockReset();
    mocks.requireMutationSession.mockReset();
    mocks.getWebRuntime.mockResolvedValue({
      config: {
        APP_BASE_URL: "https://slopproof.example",
        DEPLOYMENT_PROFILE: "local",
        KEY_WRAPPING_PROVIDER: "local",
        OAUTH_TRUSTED_PROXY_SECRET: undefined,
        SESSION_SECRET: "request-route-test-secret-0000000000000",
        WORKER_INTERNAL_SECRET: "worker-route-test-secret-0000000000000",
      },
      database: { pool: forbiddenPool() },
    });
    mocks.requireMutationSession.mockResolvedValue({
      id: "20000000-0000-4000-8000-000000000002",
      actorId: "github-user-42",
      actorRole: "author",
      repositoryId: "30000000-0000-4000-8000-000000000003",
      csrfHash: "c".repeat(64),
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    });
  });

  it.each([
    ["handoff exchange", exchangeHandoff, 513, "request_too_large"],
    ["upload start", startUpload, 513, "request_too_large"],
    ["part presign", presignPart, 2 * 1_024 + 1, "request_too_large"],
    [
      "part acknowledgement",
      acknowledgePart,
      3 * 1_024 + 1,
      "request_too_large",
    ],
    ["upload finalize", finalizeUpload, 512 * 1_024 + 1, "payload_too_large"],
    ["review decision", decideReview, 16 * 1_024 + 1, "request_too_large"],
  ] as const)(
    "rejects an oversized declared %s JSON body before database or storage work",
    async (_name, handler, declaredBytes, errorCode) => {
      const response = await call(handler, oversizedJsonRequest(declaredBytes));
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: errorCode });
      expect(forbiddenQuery()).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed UTF-8 and an unsupported JSON charset", async () => {
    const malformed = await call(
      startUpload,
      new Request(
        `https://slopproof.example/api/attempts/${ATTEMPT_ID}/uploads`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new Uint8Array([0xff]),
        },
      ),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({
      error: "invalid_request",
    });

    const unsupportedCharset = await call(
      presignPart,
      new Request("https://slopproof.example/api/uploads/part-url", {
        method: "POST",
        headers: { "content-type": "application/json; charset=latin1" },
        body: "{}",
      }),
    );
    expect(unsupportedCharset.status).toBe(400);
    await expect(unsupportedCharset.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });

  it.each([
    ["handoff create", createHandoff],
    ["evidence capability", issueEvidenceCapability],
  ] as const)(
    "rejects any body on bodyless %s mutations",
    async (_name, handler) => {
      const response = await call(
        handler,
        new Request(`https://slopproof.example/api/attempts/${ATTEMPT_ID}`, {
          method: "POST",
          body: "{}",
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_request",
      });
      expect(forbiddenQuery()).not.toHaveBeenCalled();
    },
  );

  it("returns the exact safe CSRF failure before issuing evidence access", async () => {
    mocks.requireMutationSession.mockRejectedValueOnce(
      new HttpAuthError(403, "csrf_rejected"),
    );

    const response = await call(
      issueEvidenceCapability,
      new Request(
        `https://slopproof.example/api/review/${ATTEMPT_ID}/evidence-capability`,
        { method: "POST", headers: { "x-slopproof-csrf": "stale-token" } },
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "csrf_rejected" });
    expect(forbiddenQuery()).not.toHaveBeenCalled();
  });
});

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
) => Promise<Response>;

async function call(
  handler: ((request: Request) => Promise<Response>) | RouteHandler,
  request: Request,
): Promise<Response> {
  return handler(request, {
    params: Promise.resolve({ attemptId: ATTEMPT_ID }),
  });
}

function oversizedJsonRequest(declaredBytes: number): Request {
  return new Request(`https://slopproof.example/api/attempts/${ATTEMPT_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(declaredBytes),
    },
    body: "{}",
  });
}

let lastForbiddenQuery = vi.fn();

function forbiddenPool() {
  lastForbiddenQuery = vi.fn(() => {
    throw new Error("Body rejection must happen before a database query.");
  });
  return { query: lastForbiddenQuery, connect: lastForbiddenQuery };
}

function forbiddenQuery() {
  return lastForbiddenQuery;
}
