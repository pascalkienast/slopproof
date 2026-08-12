import { createHandoff, HandoffRejectedError } from "@slopproof/auth";
import { NextResponse } from "next/server";
import {
  authErrorResponse,
  requireMutationSession,
} from "../../../../../lib/http-auth";
import { getWebRuntime } from "../../../../../lib/runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireMutationSession(request, app);
    const { attemptId } = await context.params;
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
    return NextResponse.json(
      { error: "temporarily_unavailable" },
      { status: 503 },
    );
  }
}
