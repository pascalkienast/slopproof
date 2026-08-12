export type TechnicalAbortReason =
  | "visibility_lost"
  | "media_track_ended"
  | "recorder_error"
  | "duration_exceeded"
  | "encryption_or_upload_failed";

export type TechnicalAbortStatus =
  "technical_retry" | "invalidated" | "already_progressed";

type FetchPort = (input: string, init?: RequestInit) => Promise<Response>;

export async function postTechnicalAbort(
  input: {
    attemptId: string;
    headSha: string;
    csrfToken: string;
    idempotencyKey: string;
    reason: TechnicalAbortReason;
  },
  fetchPort: FetchPort = fetch,
): Promise<{ status: TechnicalAbortStatus }> {
  const payload = await postJson(
    fetchPort,
    `/api/attempts/${input.attemptId}/technical-abort`,
    input.csrfToken,
    input.idempotencyKey,
    { expectedHeadSha: input.headSha, reason: input.reason },
  );
  if (
    payload.status !== "technical_retry" &&
    payload.status !== "invalidated" &&
    payload.status !== "already_progressed"
  ) {
    throw new Error("The technical abort returned an invalid status.");
  }
  return { status: payload.status };
}

export async function postReplacementAttempt(
  input: {
    attemptId: string;
    headSha: string;
    csrfToken: string;
    idempotencyKey: string;
  },
  fetchPort: FetchPort = fetch,
): Promise<{ contributorUrl: string }> {
  const payload = await postJson(
    fetchPort,
    `/api/attempts/${input.attemptId}/retry`,
    input.csrfToken,
    input.idempotencyKey,
    { expectedHeadSha: input.headSha },
  );
  if (
    typeof payload.contributorUrl !== "string" ||
    !payload.contributorUrl.startsWith("/revisions/")
  ) {
    throw new Error("The replacement attempt returned an invalid link.");
  }
  return { contributorUrl: payload.contributorUrl };
}

async function postJson(
  fetchPort: FetchPort,
  url: string,
  csrfToken: string,
  idempotencyKey: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetchPort(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slopproof-csrf": csrfToken,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Request failed with ${String(response.status)}`,
    );
  }
  return payload;
}
