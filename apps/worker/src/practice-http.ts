import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseConnection } from "@slopproof/db";
import { ContributorPracticeAnswerV1Schema } from "@slopproof/providers";
import {
  LearningBundleV1Schema,
  PracticeFeedbackV1Schema,
  PracticeQuestionV2Schema,
} from "@slopproof/questions";
import { z } from "zod";
import {
  WorkerPracticeCapabilityError,
  verifyWorkerPracticeCapability,
  type WorkerPracticeCapability,
} from "./practice-capability";
import type {
  PracticeView,
  ReadPracticeViewInput,
  StartPracticeSessionInput,
  SubmitPracticeAnswerInput,
} from "./semantic-generation-contracts";

const PRACTICE_PATH = /^\/internal\/practice\/([0-9a-f-]{36})$/u;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ANSWER_BYTES = 4_000;

const PracticeMutationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start") }).strict(),
  z
    .object({
      operation: z.literal("answer"),
      sessionId: z.string().uuid(),
      questionId: z.string().uuid(),
      answer: z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().min(1).max(4_000))
        .refine(
          (value) => Buffer.byteLength(value, "utf8") <= MAX_ANSWER_BYTES,
        ),
    })
    .strict(),
]);

const PracticeSessionSchema = z
  .object({
    id: z.string().uuid(),
    deleteAfter: z.date(),
    questions: z.array(PracticeQuestionV2Schema).min(3).max(5),
    pendingQuestionIds: z.array(z.string().uuid()).max(5),
    feedbackByQuestionId: z.record(z.string().uuid(), PracticeFeedbackV1Schema),
  })
  .strict()
  .superRefine((session, context) => {
    const questionIds = new Set(
      session.questions.map((question) => question.id),
    );
    if (
      new Set(session.pendingQuestionIds).size !==
        session.pendingQuestionIds.length ||
      session.pendingQuestionIds.some(
        (questionId) =>
          !questionIds.has(questionId) ||
          session.feedbackByQuestionId[questionId] !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingQuestionIds"],
        message: "Pending practice questions are outside the session",
      });
    }
    for (const [questionId, feedback] of Object.entries(
      session.feedbackByQuestionId,
    )) {
      if (
        !questionIds.has(questionId) ||
        feedback.practiceQuestionId !== questionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["feedbackByQuestionId", questionId],
          message: "Practice feedback is outside the session",
        });
      }
    }
  });

const PracticeViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }).strict(),
  z
    .object({
      state: z.literal("generating"),
      revisionId: z.string().uuid(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/u),
    })
    .strict(),
  z
    .object({
      state: z.literal("ready"),
      revisionId: z.string().uuid(),
      headSha: z.string().regex(/^[0-9a-f]{40}$/u),
      learning: LearningBundleV1Schema,
      practiceSession: PracticeSessionSchema.nullable(),
    })
    .strict(),
]);

export interface PracticeHttpRepository {
  readPracticeView(input: ReadPracticeViewInput): Promise<PracticeView>;
  startPracticeSession(
    input: StartPracticeSessionInput,
  ): Promise<{ sessionId: string; deleteAfter: Date }>;
  submitPracticeAnswer(
    input: SubmitPracticeAnswerInput,
  ): Promise<{ answerId: string; replayed: boolean }>;
}

export type PracticeHttpDependencies = {
  database: DatabaseConnection;
  repository: PracticeHttpRepository;
  capabilitySecret: string;
  now?: () => Date;
};

type PracticeBinding = {
  repositoryId: string;
  revisionId: string;
  generationContextId: string;
  learningBundleId: string | null;
  actorId: string;
};

class PracticeRequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 413,
    readonly publicCode: "invalid_request" | "forbidden" | "request_too_large",
  ) {
    super(publicCode);
    this.name = "PracticeRequestError";
  }
}

export async function handlePracticeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: PracticeHttpDependencies,
): Promise<boolean> {
  const url = request.url ? new URL(request.url, "http://worker") : null;
  const match = url ? PRACTICE_PATH.exec(url.pathname) : null;
  if (!url || !match) return false;
  if (request.method !== "GET" && request.method !== "POST") {
    jsonError(response, 405, "method_not_allowed", { allow: "GET, POST" });
    return true;
  }

  const bearer = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice("Bearer ".length)
    : undefined;
  if (!bearer) {
    jsonError(response, 401, "capability_required");
    return true;
  }

  try {
    const now = dependencies.now?.() ?? new Date();
    const capability = verifyWorkerPracticeCapability(
      bearer,
      dependencies.capabilitySecret,
      now,
    );
    const revisionId = match[1]!;
    if (capability.revisionId !== revisionId) {
      throw new WorkerPracticeCapabilityError(
        "Capability belongs to another revision",
      );
    }

    if (request.method === "GET") {
      if (capability.action !== "practice.read") {
        throw new WorkerPracticeCapabilityError(
          "Capability action does not permit reads",
        );
      }
      const sessionId = parseReadQuery(url);
      const binding = await authorizeAndConsumePracticeCapability(
        dependencies.database,
        capability,
        now,
        dependencies.capabilitySecret,
        sessionId,
      );
      const view = await dependencies.repository.readPracticeView({
        repositoryId: binding.repositoryId,
        revisionId: binding.revisionId,
        generationContextId: binding.generationContextId,
        userId: binding.actorId,
        ...(sessionId ? { practiceSessionId: sessionId } : {}),
      });
      writePracticeView(response, view, binding.revisionId);
      return true;
    }

    if (
      capability.action !== "practice.submit" ||
      url.searchParams.size !== 0
    ) {
      throw new WorkerPracticeCapabilityError(
        "Capability action does not permit this mutation",
      );
    }
    const contentType = request.headers["content-type"]?.toLowerCase();
    if (contentType?.split(";", 1)[0]?.trim() !== "application/json") {
      throw new PracticeRequestError(400, "invalid_request");
    }
    const mutation = PracticeMutationSchema.parse(
      JSON.parse(await readBoundedUtf8Body(request, MAX_REQUEST_BYTES)),
    );
    const practiceSessionId =
      mutation.operation === "answer" ? mutation.sessionId : undefined;
    const binding = await authorizeAndConsumePracticeCapability(
      dependencies.database,
      capability,
      now,
      dependencies.capabilitySecret,
      practiceSessionId,
    );
    const actorKeyHash = createHmac("sha256", dependencies.capabilitySecret)
      .update("slopproof:practice-rate-actor:v1:", "utf8")
      .update(binding.repositoryId, "utf8")
      .update(":", "utf8")
      .update(binding.actorId, "utf8")
      .digest("hex");

    let sessionId: string;
    if (mutation.operation === "start") {
      if (binding.learningBundleId === null) {
        throw new PracticeRequestError(403, "forbidden");
      }
      const started = await dependencies.repository.startPracticeSession({
        repositoryId: binding.repositoryId,
        revisionId: binding.revisionId,
        generationContextId: binding.generationContextId,
        learningBundleId: binding.learningBundleId,
        userId: binding.actorId,
        actorKeyHash,
      });
      sessionId = started.sessionId;
    } else {
      await dependencies.repository.submitPracticeAnswer({
        repositoryId: binding.repositoryId,
        revisionId: binding.revisionId,
        generationContextId: binding.generationContextId,
        practiceSessionId: mutation.sessionId,
        practiceQuestionId: mutation.questionId,
        userId: binding.actorId,
        actorKeyHash,
        answer: ContributorPracticeAnswerV1Schema.parse({
          trust: "untrusted",
          source: "contributor_answer",
          content: mutation.answer,
        }),
      });
      sessionId = mutation.sessionId;
    }
    const view = await dependencies.repository.readPracticeView({
      repositoryId: binding.repositoryId,
      revisionId: binding.revisionId,
      generationContextId: binding.generationContextId,
      userId: binding.actorId,
      practiceSessionId: sessionId,
    });
    writePracticeView(response, view, binding.revisionId);
  } catch (error) {
    if (error instanceof WorkerPracticeCapabilityError) {
      jsonError(response, 401, "invalid_capability");
    } else if (error instanceof PracticeRequestError) {
      jsonError(response, error.status, error.publicCode);
    } else if (error instanceof z.ZodError || error instanceof SyntaxError) {
      jsonError(response, 400, "invalid_request");
    } else if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "SEMANTIC_PRACTICE_RATE_LIMITED"
    ) {
      const retryAfter =
        "retryAfter" in error && error.retryAfter instanceof Date
          ? Math.max(
              1,
              Math.ceil((error.retryAfter.getTime() - Date.now()) / 1_000),
            )
          : 60;
      jsonError(response, 429, "rate_limited", {
        "retry-after": String(retryAfter),
      });
    } else {
      jsonError(response, 503, "practice_unavailable");
    }
  }
  return true;
}

function parseReadQuery(url: URL): string | undefined {
  if ([...url.searchParams.keys()].some((key) => key !== "sessionId")) {
    throw new PracticeRequestError(400, "invalid_request");
  }
  const values = url.searchParams.getAll("sessionId");
  if (values.length > 1) {
    throw new PracticeRequestError(400, "invalid_request");
  }
  const raw = values[0];
  return raw === undefined ? undefined : z.string().uuid().parse(raw);
}

async function authorizeAndConsumePracticeCapability(
  database: DatabaseConnection,
  capability: WorkerPracticeCapability,
  now: Date,
  databaseCapabilitySecret: string,
  practiceSessionId?: string,
): Promise<PracticeBinding> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`practice-capability:${capability.jti}`],
    );
    const result = await client.query<{
      repository_id: string;
      revision_id: string;
      generation_context_id: string;
      author_id: string;
      learning_bundle_id: string | null;
    }>(
      `SELECT repository.id AS repository_id,
              revision.id AS revision_id,
              context.id AS generation_context_id,
              pull_request.author_id,
              bundle.id AS learning_bundle_id
         FROM pull_request_revisions revision
         JOIN pull_requests pull_request
           ON pull_request.id = revision.pull_request_id
         JOIN repositories repository
           ON repository.id = pull_request.repository_id
         JOIN installations installation
           ON installation.id = repository.installation_id
         JOIN generation_contexts context
           ON context.revision_id = revision.id
          AND context.head_sha = revision.head_sha
         JOIN semantic_generation_budgets budget
           ON budget.generation_context_id = context.id
          AND budget.repository_id = repository.id
          AND budget.revision_id = revision.id
          AND budget.head_sha = revision.head_sha
         LEFT JOIN semantic_learning_bundles bundle
           ON bundle.generation_context_id = context.id
          AND bundle.revision_id = revision.id
          AND bundle.repository_id = repository.id
          AND bundle.deleted_at IS NULL
          AND bundle.delete_after > $4
        WHERE revision.id = $1
          AND repository.id = $2
          AND pull_request.author_id = $3
          AND revision.is_current = true
          AND pull_request.state = 'open'
          AND repository.status = 'active'
          AND installation.status = 'active'
        ORDER BY context.created_at DESC
        LIMIT 1
        FOR SHARE OF revision, pull_request, repository, installation,
                     context, budget`,
      [capability.revisionId, capability.repositoryId, capability.actorId, now],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      row.repository_id !== capability.repositoryId ||
      row.revision_id !== capability.revisionId ||
      row.author_id !== capability.actorId
    ) {
      throw new PracticeRequestError(403, "forbidden");
    }
    if (practiceSessionId !== undefined) {
      const session = await client.query(
        `SELECT 1
           FROM practice_sessions session
          WHERE session.id = $1
            AND session.repository_id = $2
            AND session.revision_id = $3
            AND session.generation_context_id = $4
            AND session.user_id = $5
            AND session.invalidated_at IS NULL
            AND session.deleted_at IS NULL
            AND session.delete_after > $6
          FOR SHARE OF session`,
        [
          practiceSessionId,
          row.repository_id,
          row.revision_id,
          row.generation_context_id,
          capability.actorId,
          now,
        ],
      );
      if ((session.rowCount ?? 0) !== 1) {
        throw new PracticeRequestError(403, "forbidden");
      }
    }
    const actorKeyHash = createHmac("sha256", databaseCapabilitySecret)
      .update("slopproof:practice-capability-actor:v1:", "utf8")
      .update(row.repository_id, "utf8")
      .update(":", "utf8")
      .update(row.author_id, "utf8")
      .digest("hex");
    const action = practiceCapabilityUseAction(
      capability.action,
      practiceSessionId,
    );
    const consumed = await client.query(
      `INSERT INTO semantic_practice_capability_uses
        (jti, repository_id, revision_id, actor_key_hash, action, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (jti) DO NOTHING
       RETURNING jti`,
      [
        capability.jti,
        row.repository_id,
        row.revision_id,
        actorKeyHash,
        action,
        new Date(capability.expiresAt),
      ],
    );
    if ((consumed.rowCount ?? 0) !== 1) {
      throw new WorkerPracticeCapabilityError(
        "Practice capability has already been consumed",
      );
    }
    if (capability.action === "practice.submit") {
      await client.query(
        `INSERT INTO audit_events
          (actor_id, action, object_type, object_id, metadata)
         VALUES ($1, 'practice.capability_consumed', 'revision', $2,
                 jsonb_build_object(
                   'repositoryId', $3::text,
                   'capabilityAction', $4::text,
                   'capabilityJti', $5::text))`,
        [
          capability.actorId,
          capability.revisionId,
          capability.repositoryId,
          capability.action,
          capability.jti,
        ],
      );
    }
    await client.query("COMMIT");
    return {
      repositoryId: row.repository_id,
      revisionId: row.revision_id,
      generationContextId: row.generation_context_id,
      learningBundleId: row.learning_bundle_id,
      actorId: row.author_id,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function practiceCapabilityUseAction(
  action: WorkerPracticeCapability["action"],
  practiceSessionId?: string,
): "read" | "start_session" | "submit_answer" {
  if (action === "practice.read") return "read";
  return practiceSessionId === undefined ? "start_session" : "submit_answer";
}

function writePracticeView(
  response: ServerResponse,
  rawView: PracticeView,
  expectedRevisionId: string,
): void {
  const view = PracticeViewSchema.parse(rawView);
  if (view.state !== "unavailable" && view.revisionId !== expectedRevisionId) {
    throw new PracticeRequestError(403, "forbidden");
  }
  const body = JSON.stringify({ schemaVersion: "1", ...view });
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_RESPONSE_BYTES) {
    throw new Error("Private practice response is too large");
  }
  response.writeHead(200, {
    "cache-control": "private, no-store, max-age=0",
    "content-type": "application/json",
    "content-length": String(bodyBytes),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readBoundedUtf8Body(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<string> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumBytes)
  ) {
    throw new PracticeRequestError(413, "request_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new PracticeRequestError(413, "request_too_large");
    }
    chunks.push(chunk);
  }
  if (contentLength !== undefined && Number(contentLength) !== total) {
    throw new PracticeRequestError(400, "invalid_request");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new PracticeRequestError(400, "invalid_request");
  }
}

function jsonError(
  response: ServerResponse,
  status: number,
  code: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: code });
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}
