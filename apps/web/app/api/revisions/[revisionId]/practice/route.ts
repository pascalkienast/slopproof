import { NextResponse } from "next/server";
import { z } from "zod";
import {
  WORKER_PRACTICE_MAX_REQUEST_BYTES,
  WorkerPracticeMutationSchema,
} from "../../../../../lib/evidence-worker-contract";
import {
  authErrorResponse,
  requireMutationSession,
  requireSession,
} from "../../../../../lib/http-auth";
import {
  InvalidRequestBodyEncodingError,
  readBoundedUtf8Body,
  RequestBodyTooLargeError,
} from "../../../../../lib/bounded-body";
import { PracticeAuthorizationError } from "../../../../../lib/practice-authorization";
import {
  mutatePrivatePractice,
  PrivatePracticeRateLimitedError,
  PrivatePracticeUnavailableError,
  readPrivatePractice,
} from "../../../../../lib/private-practice";
import { getWebRuntime } from "../../../../../lib/runtime";

const RevisionIdSchema = z.string().uuid();
const PracticeSessionIdSchema = z.string().uuid();
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
} as const;

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ revisionId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireSession(request, app);
    const revisionId = RevisionIdSchema.parse(
      (await context.params).revisionId,
    );
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "sessionId")) {
      return jsonError("invalid_request", 400);
    }
    const sessionIds = url.searchParams.getAll("sessionId");
    if (sessionIds.length > 1) return jsonError("invalid_request", 400);
    const rawSessionId = sessionIds[0];
    const practiceSessionId = rawSessionId
      ? PracticeSessionIdSchema.parse(rawSessionId)
      : undefined;
    const view = await readPrivatePractice(
      app,
      session,
      revisionId,
      practiceSessionId,
    );
    return NextResponse.json(view, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return practiceRouteError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ revisionId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const revisionId = RevisionIdSchema.parse(
      (await context.params).revisionId,
    );
    if (new URL(request.url).searchParams.size !== 0) {
      return jsonError("invalid_request", 400);
    }
    const contentType = request.headers.get("content-type")?.toLowerCase();
    if (contentType?.split(";", 1)[0]?.trim() !== "application/json") {
      return jsonError("invalid_request", 400);
    }
    const body = await readBoundedUtf8Body(
      request,
      WORKER_PRACTICE_MAX_REQUEST_BYTES,
    );
    const mutation = WorkerPracticeMutationSchema.parse(JSON.parse(body));
    const view = await mutatePrivatePractice(
      app,
      session,
      revisionId,
      mutation,
    );
    return NextResponse.json(view, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return practiceRouteError(error);
  }
}

function practiceRouteError(error: unknown): NextResponse {
  const authentication = authErrorResponse(error);
  if (authentication) return withPrivateHeaders(authentication);
  if (error instanceof PracticeAuthorizationError) {
    return jsonError("forbidden", 403);
  }
  if (error instanceof RequestBodyTooLargeError) {
    return jsonError("request_too_large", 413);
  }
  if (
    error instanceof InvalidRequestBodyEncodingError ||
    error instanceof z.ZodError ||
    error instanceof SyntaxError
  ) {
    return jsonError("invalid_request", 400);
  }
  if (error instanceof PrivatePracticeUnavailableError) {
    return jsonError("practice_unavailable", 503);
  }
  if (error instanceof PrivatePracticeRateLimitedError) {
    const response = jsonError("rate_limited", 429);
    response.headers.set("retry-after", String(error.retryAfterSeconds));
    return response;
  }
  return jsonError("practice_unavailable", 503);
}

function jsonError(code: string, status: number): NextResponse {
  return NextResponse.json(
    { error: code },
    { status, headers: PRIVATE_HEADERS },
  );
}

function withPrivateHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
