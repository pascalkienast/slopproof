import { NextResponse } from "next/server";
import { authErrorResponse, requireSession } from "../../../lib/http-auth";
import { getWebRuntime } from "../../../lib/runtime";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireSession(request, app);
    return NextResponse.json({
      actorId: session.actorId,
      role: session.actorRole,
      repositoryId: session.repositoryId,
      expiresAt: session.expiresAt.toISOString(),
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 })
    );
  }
}
