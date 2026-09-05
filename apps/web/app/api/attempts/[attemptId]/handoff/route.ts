import { createHandoff, HandoffRejectedError } from "@understandproof/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  InvalidRequestBodyError,
  requireEmptyRequestBody,
} from "../../../../../lib/bounded-body";
import {
  authErrorResponse,
  requireMutationSession,
} from "../../../../../lib/http-auth";
import { getWebRuntime } from "../../../../../lib/runtime";
import {
  consumeWebRequestRateLimit,
  createWebRequestSubjectHash,
  WebRequestRateLimitExceededError,
  webRequestRateLimitResponse,
} from "../../../../../lib/request-rate-limit";

const AttemptIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const attemptId = AttemptIdSchema.parse((await context.params).attemptId);
    await requireEmptyRequestBody(request);
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "handoff_create",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "handoff_create",
        [session.actorId, session.repositoryId ?? "repository-unbound"],
      ),
    });
    const grant = await createHandoff(
      app.database.pool,
      { attemptId, session },
      app.config.SESSION_SECRET,
    );
    const handoffUrl = new URL("/m/handoff", app.config.APP_BASE_URL);
    handoffUrl.searchParams.set("token", grant.token);
    return NextResponse.json({
      handoffUrl: handoffUrl.toString(),
      expiresAt: grant.expiresAt.toISOString(),
    });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    if (error instanceof HandoffRejectedError) {
      return NextResponse.json({ error: "handoff_rejected" }, { status: 409 });
    }
    if (error instanceof WebRequestRateLimitExceededError) {
      return webRequestRateLimitResponse(error);
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    if (error instanceof InvalidRequestBodyError) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
