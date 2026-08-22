import { NextResponse } from "next/server";
import { issueEvidenceCapability } from "../../../../../lib/evidence-capability";
import {
  evidenceProxyResponseHeaders,
  tapEvidenceProxyBody,
} from "../../../../../lib/evidence-proxy";
import { WORKER_REVIEW_EVIDENCE_PATH } from "../../../../../lib/evidence-worker-contract";
import { requireSession } from "../../../../../lib/http-auth";
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    await consumeWebRequestRateLimit(app.database.pool, {
      action: "evidence_stream",
      subjectKeyHash: createWebRequestSubjectHash(
        app.config.SESSION_SECRET,
        "evidence_stream",
        [session.actorId, session.repositoryId ?? "repository-unbound"],
      ),
    });

    const client = await app.database.pool.connect();
    let token: string;
    try {
      await client.query("BEGIN");
      const access = await requireEvidenceAccess(
        app,
        request,
        session,
        attemptId,
        client,
      );
      const issued = issueEvidenceCapability(
        {
          attemptId,
          repositoryId: access.authorization.repositoryId,
          actorId: access.authorization.actorId,
        },
        app.config.WORKER_INTERNAL_SECRET,
      );
      token = issued.token;
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

    const workerUrl = new URL(
      `${WORKER_REVIEW_EVIDENCE_PATH}/${encodeURIComponent(attemptId)}`,
      app.config.WORKER_INTERNAL_URL,
    );
    const aborted = { value: false };
    const bytesReceived = { value: 0 };
    const bytesExpected = { value: null as number | null };
    logWebEvidenceStream({
      attemptId,
      stage: "proxy",
      aborted: false,
    });
    request.signal.addEventListener(
      "abort",
      () => {
        aborted.value = true;
        logWebEvidenceStream({
          attemptId,
          stage: "proxy",
          aborted: true,
          bytesExpected: bytesExpected.value,
          bytesReceived: bytesReceived.value,
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

    const { headers, declaredLength } = evidenceProxyResponseHeaders(
      upstream.headers,
    );
    bytesExpected.value = declaredLength ?? null;
    logWebEvidenceStream({
      attemptId,
      stage: "proxy",
      httpStatus: 200,
      contentTypePresent: true,
      contentLengthPresent: declaredLength !== undefined,
      bytesExpected: declaredLength ?? null,
      aborted: aborted.value,
    });
    const body = tapEvidenceProxyBody(upstream.body, (received) => {
      bytesReceived.value = received;
    });
    return new NextResponse(body, {
      status: 200,
      headers,
    });
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
