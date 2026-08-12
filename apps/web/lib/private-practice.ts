import type { AuthenticatedSession } from "@slopproof/auth";
import { z } from "zod";
import {
  WORKER_PRACTICE_MAX_RESPONSE_BYTES,
  WORKER_PRACTICE_PATH,
  WorkerPracticeMutationSchema,
  WorkerPracticeViewSchema,
  type WorkerPracticeMutation,
  type WorkerPracticeView,
} from "./evidence-worker-contract";
import { issuePracticeCapability } from "./practice-capability";
import { requirePracticeAuthorAccess } from "./practice-authorization";
import type { WebRuntime } from "./runtime";

export class PrivatePracticeUnavailableError extends Error {
  readonly code = "PRIVATE_PRACTICE_UNAVAILABLE" as const;

  constructor() {
    super("Private practice is temporarily unavailable.");
    this.name = "PrivatePracticeUnavailableError";
  }
}

export class PrivatePracticeRateLimitedError extends Error {
  readonly code = "PRIVATE_PRACTICE_RATE_LIMITED" as const;

  constructor(readonly retryAfterSeconds: number) {
    super("Private practice is rate limited.");
    this.name = "PrivatePracticeRateLimitedError";
  }
}

export async function readPrivatePractice(
  app: WebRuntime,
  session: AuthenticatedSession,
  revisionId: string,
  practiceSessionId?: string,
): Promise<WorkerPracticeView> {
  const token = await authorizePracticeCapability(
    app,
    session,
    revisionId,
    "practice.read",
  );
  return proxyPracticeRequest(app, {
    revisionId,
    token,
    method: "GET",
    ...(practiceSessionId ? { practiceSessionId } : {}),
  });
}

export async function mutatePrivatePractice(
  app: WebRuntime,
  session: AuthenticatedSession,
  revisionId: string,
  rawMutation: unknown,
): Promise<WorkerPracticeView> {
  const mutation = WorkerPracticeMutationSchema.parse(rawMutation);
  const token = await authorizePracticeCapability(
    app,
    session,
    revisionId,
    "practice.submit",
  );
  return proxyPracticeRequest(app, {
    revisionId,
    token,
    method: "POST",
    mutation,
  });
}

async function authorizePracticeCapability(
  app: WebRuntime,
  session: AuthenticatedSession,
  revisionId: string,
  action: "practice.read" | "practice.submit",
): Promise<string> {
  const client = await app.database.pool.connect();
  try {
    await client.query("BEGIN");
    const access = await requirePracticeAuthorAccess(
      session,
      revisionId,
      client,
    );
    const issued = issuePracticeCapability(
      {
        revisionId: access.revisionId,
        repositoryId: access.repositoryId,
        actorId: access.actorId,
        action,
      },
      app.config.WORKER_INTERNAL_SECRET,
    );
    if (action === "practice.submit") {
      await client.query(
        `INSERT INTO audit_events
          (actor_id, action, object_type, object_id, metadata)
         VALUES ($1, 'practice.capability_issued', 'revision', $2,
                 jsonb_build_object(
                   'repositoryId', $3::text,
                   'headSha', $4::text,
                   'capabilityAction', $5::text,
                   'capabilityJti', $6::text))`,
        [
          access.actorId,
          access.revisionId,
          access.repositoryId,
          access.headSha,
          action,
          issued.payload.jti,
        ],
      );
    }
    await client.query("COMMIT");
    return issued.token;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function proxyPracticeRequest(
  app: WebRuntime,
  input:
    | {
        revisionId: string;
        token: string;
        method: "GET";
        practiceSessionId?: string;
      }
    | {
        revisionId: string;
        token: string;
        method: "POST";
        mutation: WorkerPracticeMutation;
      },
): Promise<WorkerPracticeView> {
  try {
    const url = new URL(
      `${WORKER_PRACTICE_PATH}/${encodeURIComponent(input.revisionId)}`,
      app.config.WORKER_INTERNAL_URL,
    );
    if (input.method === "GET" && input.practiceSessionId) {
      url.searchParams.set("sessionId", input.practiceSessionId);
    }
    const body =
      input.method === "POST" ? JSON.stringify(input.mutation) : null;
    const requestSignal = AbortSignal.timeout(5_000);
    const response = await fetch(url, {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(body === null
          ? {}
          : {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body, "utf8")),
            }),
      },
      ...(body === null ? {} : { body }),
      cache: "no-store",
      redirect: "manual",
      signal: requestSignal,
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterSeconds = retryAfter ? Number(retryAfter) : 60;
      await response.body?.cancel();
      throw new PrivatePracticeRateLimitedError(
        Number.isSafeInteger(retryAfterSeconds) &&
          retryAfterSeconds >= 1 &&
          retryAfterSeconds <= 3_600
          ? retryAfterSeconds
          : 60,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (
      response.status !== 200 ||
      !contentType?.startsWith("application/json") ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new PrivatePracticeUnavailableError();
    }
    const bytes = await readBoundedResponse(
      response,
      WORKER_PRACTICE_MAX_RESPONSE_BYTES,
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const view = WorkerPracticeViewSchema.parse(JSON.parse(decoded));
    if (view.state !== "unavailable" && view.revisionId !== input.revisionId) {
      throw new PrivatePracticeUnavailableError();
    }
    return view;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new PrivatePracticeUnavailableError();
    }
    if (error instanceof PrivatePracticeUnavailableError) throw error;
    if (error instanceof PrivatePracticeRateLimitedError) throw error;
    throw new PrivatePracticeUnavailableError();
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)
  ) {
    await response.body?.cancel();
    throw new PrivatePracticeUnavailableError();
  }
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new PrivatePracticeUnavailableError();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== total) {
    throw new PrivatePracticeUnavailableError();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
