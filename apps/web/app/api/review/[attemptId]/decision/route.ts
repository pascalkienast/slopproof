import { NextResponse } from "next/server";
import { z } from "zod";
import {
  InvalidRequestBodyError,
  InvalidRequestBodyEncodingError,
  readBoundedJson,
  RequestBodyTooLargeError,
} from "../../../../../lib/bounded-body";
import { requireMutationSession } from "../../../../../lib/http-auth";
import {
  decideReview,
  ReviewDecisionInputSchema,
} from "../../../../../lib/maintainer-review";
import { createWebCheckIntentWriter } from "../../../../../lib/check-intent-writer";
import {
  jsonError,
  ReviewAttemptIdSchema,
  reviewRouteErrorResponse,
} from "../../../../../lib/review-http";
import { getWebRuntime } from "../../../../../lib/runtime";

const MAX_DECISION_BODY_BYTES = 16 * 1_024;

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const attemptId = ReviewAttemptIdSchema.parse(
      (await context.params).attemptId,
    );
    const input = await readBoundedJson(
      request,
      MAX_DECISION_BODY_BYTES,
      ReviewDecisionInputSchema,
    );
    const result = await decideReview(
      app,
      request,
      session,
      attemptId,
      input,
      createWebCheckIntentWriter(app),
    );
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonError("request_too_large", 413);
    }
    if (
      error instanceof InvalidRequestBodyError ||
      error instanceof InvalidRequestBodyEncodingError ||
      error instanceof z.ZodError
    ) {
      return jsonError("invalid_request", 400);
    }
    return (
      reviewRouteErrorResponse(error) ??
      jsonError("temporarily_unavailable", 503)
    );
  }
}
