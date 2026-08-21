import { NextResponse } from "next/server";
import {
  InvalidRequestBodyError,
  requireEmptyRequestBody,
} from "../../../../../lib/bounded-body";
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
import { logWebEvidenceStream } from "../../../../../lib/evidence-stream-log";
import { getWebRuntime } from "../../../../../lib/runtime";
import {
  consumeWebRequestRateLimit,
  createWebRequestSubjectHash,
} from "../../../../../lib/request-rate-limit";

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
    await requireEmptyRequestBody(request);
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "evidence_capability",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "evidence_capability",
        [session.actorId, session.repositoryId ?? "repository-unbound"],
      ),
    });
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

    logWebEvidenceStream({
      attemptId,
      stage: "capability",
      httpStatus: 200,
    });
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
    const attemptId = await context.params
      .then((params) => ReviewAttemptIdSchema.safeParse(params.attemptId).data)
      .catch(() => undefined);
    if (attemptId) {
      logWebEvidenceStream({
        attemptId,
        stage: "capability",
        errorClass: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof InvalidRequestBodyError ? { httpStatus: 400 } : {}),
      });
    }
    if (error instanceof InvalidRequestBodyError) {
      return jsonError("invalid_request", 400);
    }
    return (
      reviewRouteErrorResponse(error) ??
      jsonError("temporarily_unavailable", 503)
    );
  }
}
