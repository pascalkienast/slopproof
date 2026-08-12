import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseConnection } from "@slopproof/db";
import { describe, expect, it, vi } from "vitest";
import {
  handlePracticeRequest,
  type PracticeHttpRepository,
} from "./practice-http";

const REVISION_ID = "72000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "72000000-0000-4000-8000-000000000002";
const CONTEXT_ID = "72000000-0000-4000-8000-000000000003";
const BUNDLE_ID = "72000000-0000-4000-8000-000000000004";
const SESSION_ID = "72000000-0000-4000-8000-000000000005";
const QUESTION_ID = "72000000-0000-4000-8000-000000000006";
const JTI = "72000000-0000-4000-8000-000000000007";
const ACTOR_ID = "github-user-42";
const SECRET = "private-practice-worker-secret-00000000";
const NOW = new Date("2026-08-13T00:00:00.000Z");

describe("private practice worker HTTP boundary", () => {
  it("rechecks current author binding, atomically consumes a read JTI and returns no-store JSON", async () => {
    let consumed = false;
    const { database, clientQuery } = databaseFixture(
      () => consumed,
      () => {
        consumed = true;
      },
    );
    const repository = repositoryFixture();
    const first = responseFixture();

    await expect(
      handlePracticeRequest(
        requestFixture("GET", capabilityToken("practice.read")),
        first.response,
        { database, repository, capabilitySecret: SECRET, now: () => NOW },
      ),
    ).resolves.toBe(true);

    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(JSON.parse(first.body)).toEqual({
      schemaVersion: "1",
      state: "generating",
      revisionId: REVISION_ID,
      headSha: "a".repeat(40),
    });
    expect(repository.readPracticeView).toHaveBeenCalledWith({
      repositoryId: REPOSITORY_ID,
      revisionId: REVISION_ID,
      generationContextId: CONTEXT_ID,
      userId: ACTOR_ID,
    });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("pull_request.author_id = $3"),
      [REVISION_ID, REPOSITORY_ID, ACTOR_ID, NOW],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("semantic_practice_capability_uses"),
      [
        JTI,
        REPOSITORY_ID,
        REVISION_ID,
        createHmac("sha256", SECRET)
          .update("slopproof:practice-capability-actor:v1:", "utf8")
          .update(REPOSITORY_ID, "utf8")
          .update(":", "utf8")
          .update(ACTOR_ID, "utf8")
          .digest("hex"),
        "read",
        new Date("2026-08-13T00:00:30.000Z"),
      ],
    );

    const replay = responseFixture();
    await handlePracticeRequest(
      requestFixture("GET", capabilityToken("practice.read")),
      replay.response,
      { database, repository, capabilitySecret: SECRET, now: () => NOW },
    );
    expect(replay.status).toBe(401);
    expect(JSON.parse(replay.body)).toEqual({ error: "invalid_capability" });
    expect(repository.readPracticeView).toHaveBeenCalledTimes(1);
  });

  it("binds an answer to the authorized actor and passes only a domain-separated actor hash", async () => {
    const { database, clientQuery } = databaseFixture(
      () => false,
      () => undefined,
      true,
    );
    const repository = repositoryFixture();
    const output = responseFixture();
    const answer =
      "The new branch rolls back before publishing the cache entry.";

    await handlePracticeRequest(
      requestFixture(
        "POST",
        capabilityToken("practice.submit"),
        JSON.stringify({
          operation: "answer",
          sessionId: SESSION_ID,
          questionId: QUESTION_ID,
          answer,
        }),
      ),
      output.response,
      { database, repository, capabilitySecret: SECRET, now: () => NOW },
    );

    expect(output.status).toBe(200);
    expect(repository.submitPracticeAnswer).toHaveBeenCalledWith({
      repositoryId: REPOSITORY_ID,
      revisionId: REVISION_ID,
      generationContextId: CONTEXT_ID,
      practiceSessionId: SESSION_ID,
      practiceQuestionId: QUESTION_ID,
      userId: ACTOR_ID,
      actorKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      answer: {
        trust: "untrusted",
        source: "contributor_answer",
        content: answer,
      },
    });
    const submitted = vi.mocked(repository.submitPracticeAnswer).mock
      .calls[0]?.[0];
    expect(submitted?.actorKeyHash).not.toBe(ACTOR_ID);
    expect(
      clientQuery.mock.calls.some((call) =>
        JSON.stringify(call).includes(answer),
      ),
    ).toBe(false);
    expect(repository.readPracticeView).toHaveBeenLastCalledWith({
      repositoryId: REPOSITORY_ID,
      revisionId: REVISION_ID,
      generationContextId: CONTEXT_ID,
      userId: ACTOR_ID,
      practiceSessionId: SESSION_ID,
    });
  });

  it("rejects an answer over 4,000 UTF-8 bytes before authorization or persistence", async () => {
    const connect = vi.fn();
    const database = { pool: { connect } } as unknown as DatabaseConnection;
    const repository = repositoryFixture();
    const output = responseFixture();
    const answer = "🧠".repeat(1_001);

    await handlePracticeRequest(
      requestFixture(
        "POST",
        capabilityToken("practice.submit"),
        JSON.stringify({
          operation: "answer",
          sessionId: SESSION_ID,
          questionId: QUESTION_ID,
          answer,
        }),
      ),
      output.response,
      { database, repository, capabilitySecret: SECRET, now: () => NOW },
    );

    expect(output.status).toBe(400);
    expect(JSON.parse(output.body)).toEqual({ error: "invalid_request" });
    expect(connect).not.toHaveBeenCalled();
    expect(repository.submitPracticeAnswer).not.toHaveBeenCalled();
    expect(output.body).not.toContain(answer.slice(0, 8));
  });

  it("does not widen a read capability into a mutation", async () => {
    const connect = vi.fn();
    const output = responseFixture();
    await handlePracticeRequest(
      requestFixture(
        "POST",
        capabilityToken("practice.read"),
        JSON.stringify({ operation: "start" }),
      ),
      output.response,
      {
        database: { pool: { connect } } as unknown as DatabaseConnection,
        repository: repositoryFixture(),
        capabilitySecret: SECRET,
        now: () => NOW,
      },
    );
    expect(output.status).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });
});

function databaseFixture(
  isConsumed: () => boolean,
  consume: () => void,
  hasSession = false,
) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT repository.id AS repository_id")) {
      return {
        rows: [
          {
            repository_id: REPOSITORY_ID,
            revision_id: REVISION_ID,
            generation_context_id: CONTEXT_ID,
            author_id: ACTOR_ID,
            learning_bundle_id: BUNDLE_ID,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM practice_sessions session")) {
      return { rows: hasSession ? [{}] : [], rowCount: hasSession ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO semantic_practice_capability_uses")) {
      if (isConsumed()) return { rows: [], rowCount: 0 };
      consume();
      return { rows: [{ jti: JTI }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query: clientQuery, release: vi.fn() };
  const database = {
    pool: { connect: vi.fn(async () => client) },
  } as unknown as DatabaseConnection;
  return { database, clientQuery };
}

function repositoryFixture(): PracticeHttpRepository {
  return {
    readPracticeView: vi.fn(async () => ({
      state: "generating" as const,
      revisionId: REVISION_ID,
      headSha: "a".repeat(40),
    })),
    startPracticeSession: vi.fn(async () => ({
      sessionId: SESSION_ID,
      deleteAfter: new Date("2026-08-13T12:00:00.000Z"),
    })),
    submitPracticeAnswer: vi.fn(async () => ({
      answerId: "72000000-0000-4000-8000-000000000008",
      replayed: false,
    })),
  };
}

function capabilityToken(action: "practice.read" | "practice.submit"): string {
  const document = JSON.stringify({
    version: 1,
    revisionId: REVISION_ID,
    repositoryId: REPOSITORY_ID,
    actorId: ACTOR_ID,
    action,
    jti: JTI,
    expiresAt: "2026-08-13T00:00:30.000Z",
  });
  const signature = createHmac("sha256", SECRET)
    .update("slopproof:practice-capability:v1:", "utf8")
    .update(document, "utf8")
    .digest("base64url");
  return `${Buffer.from(document, "utf8").toString("base64url")}.${signature}`;
}

function requestFixture(
  method: "GET" | "POST",
  token: string,
  body?: string,
): IncomingMessage {
  const bytes = body === undefined ? [] : [Buffer.from(body, "utf8")];
  return {
    url: `/internal/practice/${REVISION_ID}`,
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body, "utf8")),
          }),
    },
    async *[Symbol.asyncIterator]() {
      yield* bytes;
    },
  } as unknown as IncomingMessage;
}

function responseFixture(): {
  response: ServerResponse;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
} {
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const responseState: {
    headersSent: boolean;
    writeHead(code: number, nextHeaders: Record<string, string>): unknown;
    end(chunk?: string): unknown;
    destroy: ReturnType<typeof vi.fn>;
  } = {
    headersSent: false,
    writeHead(code: number, nextHeaders: Record<string, string>) {
      status = code;
      headers = nextHeaders;
      responseState.headersSent = true;
      return responseState;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      return responseState;
    },
    destroy: vi.fn(),
  };
  const response = responseState as unknown as ServerResponse;
  return {
    response,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
  };
}
