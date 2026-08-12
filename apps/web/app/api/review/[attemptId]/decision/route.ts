import { NextResponse } from "next/server";
import { requireMutationSession } from "../../../../../lib/http-auth";
import { decideReview } from "../../../../../lib/maintainer-review";
import { createWebCheckIntentWriter } from "../../../../../lib/check-intent-writer";
import {
  jsonError,
  ReviewAttemptIdSchema,
  reviewRouteErrorResponse,
} from "../../../../../lib/review-http";
import { getWebRuntime } from "../../../../../lib/runtime";

const MAX_DECISION_BODY_BYTES = 16 * 1_024;

class DecisionBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super("Invalid review decision body");
  }
}

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
    const input = await readBoundedJson(request);
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
    if (error instanceof DecisionBodyError) {
      return jsonError(
        error.status === 413 ? "request_too_large" : "invalid_request",
        error.status,
      );
    }
    return (
      reviewRouteErrorResponse(error) ??
      jsonError("temporarily_unavailable", 503)
    );
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new DecisionBodyError(400);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new DecisionBodyError(400);
    }
    if (parsed > MAX_DECISION_BODY_BYTES) throw new DecisionBodyError(413);
  }
  if (!request.body) throw new DecisionBodyError(400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DECISION_BODY_BYTES) {
        await reader.cancel();
        throw new DecisionBodyError(413);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof DecisionBodyError) throw error;
    throw new DecisionBodyError(400);
  } finally {
    reader.releaseLock();
  }
}
