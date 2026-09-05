import { IdempotencyKeySchema, UuidSchema } from "@understandproof/domain";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AttemptLifecycleConflictError,
  RetryAttemptRequestSchema,
  createReplacementAttempt,
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
import { createWebCheckIntentWriter } from "../../../../../lib/check-intent-writer";

const MAX_BODY_BYTES = 1_024;

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const sourceAttemptId = UuidSchema.parse((await context.params).attemptId);
    const idempotencyKey = IdempotencyKeySchema.parse(
      request.headers.get("idempotency-key"),
    );
    const body = await readBoundedUtf8Body(request, MAX_BODY_BYTES);
    const input = RetryAttemptRequestSchema.parse(JSON.parse(body));
    const result = await createReplacementAttempt(
      {
        pool: app.database.pool,
        queue: app.jobQueue,
        storage: app.storage,
        checkIntents: createWebCheckIntentWriter(app),
      },
      { sourceAttemptId, idempotencyKey, session, ...input },
    );
    return NextResponse.json(
      {
        ...result,
        expiresAt: result.expiresAt.toISOString(),
        contributorUrl: `/revisions/${result.revisionId}/contribute`,
      },
      { headers: { "cache-control": "no-store" } },
    );
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
      return NextResponse.json({ error: "retry_rejected" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
