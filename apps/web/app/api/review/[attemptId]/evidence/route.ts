import { NextResponse } from "next/server";
import {
  EVIDENCE_CAPABILITY_COOKIE,
  verifyEvidenceCapability,
} from "../../../../../lib/evidence-capability";
import {
  WORKER_EVIDENCE_RESPONSE_HEADERS,
  WORKER_REVIEW_EVIDENCE_PATH,
} from "../../../../../lib/evidence-worker-contract";
import {
  requestCookieValue,
  requireSession,
} from "../../../../../lib/http-auth";
import {
  requireEvidenceAccess,
  writeReviewAudit,
} from "../../../../../lib/maintainer-review";
import {
  jsonError,
  ReviewAttemptIdSchema,
  reviewRouteErrorResponse,
} from "../../../../../lib/review-http";
import {
  consumeWebRequestRateLimit,
  createWebRequestSubjectHash,
} from "../../../../../lib/request-rate-limit";
import { logWebEvidenceStream } from "../../../../../lib/evidence-stream-log";
import { getWebRuntime } from "../../../../../lib/runtime";

export async function GET(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<NextResponse> {
  try {
    const app = await getWebRuntime();
    const session = await requireSession(request, app);
    const attemptId = ReviewAttemptIdSchema.parse(
      (await context.params).attemptId,
    );
    const token = requestCookieValue(request, EVIDENCE_CAPABILITY_COOKIE);
    if (!token) return jsonError("capability_required", 401);
    const capability = verifyEvidenceCapability(
      token,
      app.config.WORKER_INTERNAL_SECRET,
    );
    if (
      capability.attemptId !== attemptId ||
      capability.actorId !== session.actorId ||
      capability.repositoryId !== session.repositoryId
    ) {
      return jsonError("forbidden", 403);
    }
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "evidence_stream",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "evidence_stream",
        [session.actorId, capability.repositoryId],
      ),
    });

    const client = await app.database.pool.connect();
    try {
      await client.query("BEGIN");
      const access = await requireEvidenceAccess(
        app,
        request,
        session,
        attemptId,
        client,
      );
      if (
        access.evidence.repositoryId !== capability.repositoryId ||
        access.evidence.attemptId !== capability.attemptId
      ) {
        throw new Error("Capability authorization binding changed");
      }
      await writeReviewAudit(client, {
        actorId: access.authorization.actorId,
        action: "maintainer.evidence.request_authorized",
        objectType: "recording_object",
        objectId: access.evidence.recordingObjectId,
        metadata: {
          attemptId,
          repositoryId: access.authorization.repositoryId,
          revisionId: access.evidence.revisionId,
          headSha: access.evidence.headSha,
          capabilityJti: capability.jti,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const workerUrl = new URL(
      `${WORKER_REVIEW_EVIDENCE_PATH}/${encodeURIComponent(attemptId)}`,
      app.config.WORKER_INTERNAL_URL,
    );
    const aborted = { value: false };
    request.signal.addEventListener(
      "abort",
      () => {
        aborted.value = true;
        logWebEvidenceStream({
          attemptId,
          stage: "proxy",
          aborted: true,
        });
      },
      { once: true },
    );
    const upstream = await fetch(workerUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
    });
    if (upstream.status !== 200 || !upstream.body) {
      await upstream.body?.cancel();
      const httpStatus = upstream.status >= 500 ? 503 : 404;
      logWebEvidenceStream({
        attemptId,
        stage: "proxy",
        httpStatus,
        aborted: aborted.value,
        contentTypePresent: Boolean(upstream.headers.get("content-type")),
        contentLengthPresent: Boolean(upstream.headers.get("content-length")),
        errorClass: "UpstreamUnavailable",
      });
      return jsonError("evidence_unavailable", httpStatus);
    }
    const contentType = upstream.headers.get("content-type")?.toLowerCase();
    if (!contentType?.startsWith("video/webm")) {
      await upstream.body.cancel();
      logWebEvidenceStream({
        attemptId,
        stage: "proxy",
        httpStatus: 503,
        contentTypePresent: Boolean(contentType),
        contentLengthPresent: Boolean(upstream.headers.get("content-length")),
        errorClass: "InvalidContentType",
      });
      return jsonError("evidence_unavailable", 503);
    }

    const declaredLength = Number(upstream.headers.get("content-length"));
    const headers = new Headers({
      "cache-control": "private, no-store, max-age=0",
      "content-disposition": "inline",
      "x-content-type-options": "nosniff",
    });
    for (const name of WORKER_EVIDENCE_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    logWebEvidenceStream({
      attemptId,
      stage: "proxy",
      httpStatus: 200,
      contentTypePresent: true,
      contentLengthPresent: Number.isSafeInteger(declaredLength),
      bytesExpected: Number.isSafeInteger(declaredLength)
        ? declaredLength
        : null,
      aborted: aborted.value,
    });
    const response = new NextResponse(upstream.body, {
      status: 200,
      headers,
    });
    response.cookies.set(EVIDENCE_CAPABILITY_COOKIE, "", {
      httpOnly: true,
      secure: new URL(app.config.APP_BASE_URL).protocol === "https:",
      sameSite: "strict",
      path: `/api/review/${attemptId}/evidence`,
      maxAge: 0,
    });
    return response;
  } catch (error) {
    const attemptId = await context.params
      .then((params) => ReviewAttemptIdSchema.safeParse(params.attemptId).data)
      .catch(() => undefined);
    if (attemptId) {
      logWebEvidenceStream({
        attemptId,
        stage: "proxy",
        aborted: request.signal.aborted,
        errorClass: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return (
      reviewRouteErrorResponse(error) ?? jsonError("evidence_unavailable", 503)
    );
  }
}
