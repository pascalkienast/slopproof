import { NextResponse } from "next/server";
import {
  EVIDENCE_CAPABILITY_COOKIE,
  EVIDENCE_CAPABILITY_MAX_TTL_MS,
  issueEvidenceCapability,
} from "../../../../../lib/evidence-capability";
import { requireMutationSession } from "../../../../../lib/http-auth";
import {
  requireEvidenceAccess,
  writeReviewAudit,
} from "../../../../../lib/maintainer-review";
import {
  jsonError,
  ReviewAttemptIdSchema,
  reviewRouteErrorResponse,
} from "../../../../../lib/review-http";
import { getWebRuntime } from "../../../../../lib/runtime";

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
    const client = await app.database.pool.connect();
    let issued: ReturnType<typeof issueEvidenceCapability>;
    try {
      await client.query("BEGIN");
      const access = await requireEvidenceAccess(
        app,
        request,
        session,
        attemptId,
        client,
      );
      issued = issueEvidenceCapability(
        {
          attemptId,
          repositoryId: access.authorization.repositoryId,
          actorId: access.authorization.actorId,
        },
        app.config.WORKER_INTERNAL_SECRET,
      );
      await writeReviewAudit(client, {
        actorId: access.authorization.actorId,
        action: "maintainer.evidence.capability_issued",
        objectType: "recording_object",
        objectId: access.evidence.recordingObjectId,
        metadata: {
          attemptId,
          repositoryId: access.authorization.repositoryId,
          revisionId: access.evidence.revisionId,
          headSha: access.evidence.headSha,
          capabilityJti: issued.payload.jti,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const streamUrl = `/api/review/${attemptId}/evidence`;
    const response = NextResponse.json(
      { streamUrl, expiresAt: issued.payload.expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
    response.cookies.set(EVIDENCE_CAPABILITY_COOKIE, issued.token, {
      httpOnly: true,
      secure: new URL(app.config.APP_BASE_URL).protocol === "https:",
      sameSite: "strict",
      path: streamUrl,
      maxAge: EVIDENCE_CAPABILITY_MAX_TTL_MS / 1_000,
    });
    return response;
  } catch (error) {
    return (
      reviewRouteErrorResponse(error) ??
      jsonError("temporarily_unavailable", 503)
    );
  }
}
