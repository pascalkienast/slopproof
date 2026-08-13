import type { AuthenticatedSession } from "@slopproof/auth";
import {
  PrivateReviewContextSchema,
  type PrivateReviewContext,
} from "@slopproof/providers";
import { issueEvidenceCapability } from "./evidence-capability";
import { WORKER_REVIEW_CONTEXT_PATH } from "./evidence-worker-contract";
import type { MaintainerAuthorizationDependencies } from "./maintainer-authorization";
import { requireEvidenceAccess, writeReviewAudit } from "./maintainer-review";
import type { WebRuntime } from "./runtime";

const MAX_CONTEXT_BYTES = 8 * 1024 * 1024;

export async function loadPrivateReviewContext(
  app: WebRuntime,
  request: Request,
  session: AuthenticatedSession,
  attemptId: string,
  authorizationDependencies: MaintainerAuthorizationDependencies = {},
): Promise<PrivateReviewContext | null> {
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
      authorizationDependencies,
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
      action: "maintainer.context.capability_issued",
      objectType: "attempt",
      objectId: attemptId,
      metadata: {
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

  try {
    const url = new URL(
      `${WORKER_REVIEW_CONTEXT_PATH}/${encodeURIComponent(attemptId)}`,
      app.config.WORKER_INTERNAL_URL,
    );
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type")?.toLowerCase();
    const lengthHeader = response.headers.get("content-length");
    const contentLength = lengthHeader === null ? NaN : Number(lengthHeader);
    if (
      response.status !== 200 ||
      !contentType?.startsWith("application/json") ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 1 ||
      contentLength > MAX_CONTEXT_BYTES
    ) {
      await response.body?.cancel();
      return null;
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") !== contentLength) return null;
    return parsePrivateReviewContextResponse(body);
  } catch {
    return null;
  }
}

export function parsePrivateReviewContextResponse(
  body: string,
): PrivateReviewContext {
  return PrivateReviewContextSchema.parse(JSON.parse(body));
}
