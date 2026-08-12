import { IdempotencyKeySchema, UuidSchema } from "@slopproof/domain";
import { FakeGithubCheckAdapter } from "@slopproof/github";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AttemptLifecycleConflictError,
  TechnicalAbortRequestSchema,
  abortAttemptForTechnicalRetry,
} from "../../../../../lib/attempt-lifecycle";
import {
  InvalidRequestBodyEncodingError,
  RequestBodyTooLargeError,
  readBoundedUtf8Body,
} from "../../../../../lib/bounded-body";
import {
  authErrorResponse,
  requireMutationSession,
} from "../../../../../lib/http-auth";
import { getWebRuntime } from "../../../../../lib/runtime";

const MAX_BODY_BYTES = 2 * 1_024;

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const attemptId = UuidSchema.parse((await context.params).attemptId);
    const idempotencyKey = IdempotencyKeySchema.parse(
      request.headers.get("idempotency-key"),
    );
    const body = await readBoundedUtf8Body(request, MAX_BODY_BYTES);
    const input = TechnicalAbortRequestSchema.parse(JSON.parse(body));
    const checks = new FakeGithubCheckAdapter(
      app.database.pool,
      app.config.APP_BASE_URL,
    );
    const result = await abortAttemptForTechnicalRetry(
      {
        pool: app.database.pool,
        queue: app.jobQueue,
        storage: app.storage,
        checks,
      },
      { attemptId, idempotencyKey, session, ...input },
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    if (
      error instanceof InvalidRequestBodyEncodingError ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError
    ) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    if (error instanceof AttemptLifecycleConflictError) {
      return NextResponse.json(
        { error: "technical_abort_rejected" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
