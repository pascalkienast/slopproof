import {
  AttemptStatusSchema,
  type AttemptStatus,
} from "@understandproof/domain";

type FetchPort = (input: string, init?: RequestInit) => Promise<Response>;
type DelayPort = (milliseconds: number) => Promise<void>;

const SETTLED_AFTER_UPLOAD = new Set<AttemptStatus>([
  "review_required",
  "passed",
  "retry_required",
  "technical_retry",
  "expired",
  "invalidated",
]);

export async function readAttemptStatus(
  attemptId: string,
  fetchPort: FetchPort = fetch,
): Promise<AttemptStatus> {
  const response = await fetchPort(`/api/attempts/${attemptId}/status`, {
    method: "GET",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    status?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Request failed with ${String(response.status)}`,
    );
  }
  return AttemptStatusSchema.parse(payload.status);
}

export async function waitForPostUploadStatus(
  attemptId: string,
  options: {
    fetchPort?: FetchPort;
    delayPort?: DelayPort;
    maximumPolls?: number;
    intervalMs?: number;
  } = {},
): Promise<AttemptStatus> {
  const fetchPort = options.fetchPort ?? fetch;
  const delayPort = options.delayPort ?? delay;
  const maximumPolls = options.maximumPolls ?? 450;
  const intervalMs = options.intervalMs ?? 2_000;
  let lastStatus: AttemptStatus = "processing";
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    lastStatus = await readAttemptStatus(attemptId, fetchPort);
    if (SETTLED_AFTER_UPLOAD.has(lastStatus)) return lastStatus;
    if (lastStatus !== "uploading" && lastStatus !== "processing") {
      throw new Error("The attempt returned an unexpected upload status.");
    }
    await delayPort(intervalMs);
  }
  return lastStatus;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
