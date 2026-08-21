import { MAX_RECORDING_OBJECT_BYTES } from "@slopproof/media";

export const EVIDENCE_PLAYBACK_AUTOMATIC_RETRIES = 2;

export type EvidencePlaybackEvent = {
  attemptId: string;
  stage: "capability" | "client";
  bytesExpected: number | null;
  bytesReceived: number | null;
  contentTypePresent: boolean;
  contentLengthPresent: boolean;
  aborted: boolean;
  httpStatus: number | null;
  retry: number;
};

export type EvidencePlaybackErrorCode =
  | "csrf_missing"
  | "capability_rejected"
  | "stream_rejected"
  | "transfer_incomplete"
  | "unavailable";

export class EvidencePlaybackError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: EvidencePlaybackErrorCode,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "EvidencePlaybackError";
    this.retryable = retryable;
  }
}

export type EvidencePlaybackResult = {
  objectUrl: string;
  expiresAt: string;
};

export async function loadReviewEvidencePlayback(input: {
  attemptId: string;
  csrf: string | undefined;
  fetchImpl?: typeof fetch;
  maxAutomaticRetries?: number;
  onEvent?: (event: EvidencePlaybackEvent) => void;
}): Promise<EvidencePlaybackResult> {
  if (!input.csrf) {
    throw new EvidencePlaybackError(
      "csrf_missing",
      "The CSRF credential is missing.",
      false,
    );
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxAutomaticRetries =
    input.maxAutomaticRetries ?? EVIDENCE_PLAYBACK_AUTOMATIC_RETRIES;
  let lastError: EvidencePlaybackError | undefined;
  for (let retry = 0; retry <= maxAutomaticRetries; retry += 1) {
    try {
      return await attemptEvidencePlayback({
        attemptId: input.attemptId,
        csrf: input.csrf,
        fetchImpl,
        retry,
        ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
      });
    } catch (error) {
      lastError = asPlaybackError(error);
      if (!lastError.retryable || retry === maxAutomaticRetries) {
        throw lastError;
      }
    }
  }
  throw (
    lastError ??
    new EvidencePlaybackError(
      "unavailable",
      "The video is not available. Request fresh access and try again.",
      false,
    )
  );
}

async function attemptEvidencePlayback(input: {
  attemptId: string;
  csrf: string;
  fetchImpl: typeof fetch;
  retry: number;
  onEvent?: (event: EvidencePlaybackEvent) => void;
}): Promise<EvidencePlaybackResult> {
  const emit = (
    stage: EvidencePlaybackEvent["stage"],
    fields: Partial<EvidencePlaybackEvent>,
  ): void => {
    input.onEvent?.({
      attemptId: input.attemptId,
      stage,
      bytesExpected: null,
      bytesReceived: null,
      contentTypePresent: false,
      contentLengthPresent: false,
      aborted: false,
      httpStatus: null,
      retry: input.retry,
      ...fields,
    });
  };

  let capabilityStatus: number | null = null;
  try {
    const response = await input.fetchImpl(
      `/api/review/${input.attemptId}/evidence-capability`,
      { method: "POST", headers: { "x-slopproof-csrf": input.csrf } },
    );
    capabilityStatus = response.status;
    const result = (await response.json().catch(() => null)) as {
      streamUrl?: string;
      expiresAt?: string;
      error?: string;
    } | null;
    emit("capability", {
      httpStatus: capabilityStatus,
      contentTypePresent: response.headers.has("content-type"),
    });
    if (!response.ok || !result?.streamUrl || !result.expiresAt) {
      throw new EvidencePlaybackError(
        "capability_rejected",
        result?.error ?? "Evidence access was rejected.",
        response.status >= 500,
      );
    }

    const stream = await input.fetchImpl(result.streamUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    const contentType = stream.headers.get("content-type")?.toLowerCase();
    const declaredLength = parseDeclaredLength(
      stream.headers.get("content-length"),
    );
    emit("client", {
      httpStatus: stream.status,
      contentTypePresent: Boolean(contentType),
      contentLengthPresent: declaredLength !== undefined,
      bytesExpected: declaredLength ?? null,
    });
    if (!stream.ok) {
      throw new EvidencePlaybackError(
        "stream_rejected",
        "The evidence stream was rejected.",
        stream.status >= 500 || stream.status === 404,
      );
    }
    if (!contentType?.startsWith("video/webm")) {
      await stream.body?.cancel();
      throw new EvidencePlaybackError(
        "stream_rejected",
        "The evidence stream was rejected.",
        false,
      );
    }
    if (
      declaredLength !== undefined &&
      (declaredLength <= 0 || declaredLength > MAX_RECORDING_OBJECT_BYTES)
    ) {
      await stream.body?.cancel();
      throw new EvidencePlaybackError(
        "stream_rejected",
        "The evidence stream was rejected.",
        false,
      );
    }

    const blob = await stream.blob();
    emit("client", {
      httpStatus: stream.status,
      contentTypePresent: true,
      contentLengthPresent: declaredLength !== undefined,
      bytesExpected: declaredLength ?? null,
      bytesReceived: blob.size,
    });
    if (blob.size <= 0 || blob.size > MAX_RECORDING_OBJECT_BYTES) {
      throw new EvidencePlaybackError(
        "transfer_incomplete",
        "The recording transfer was interrupted. Request fresh access and try again.",
        true,
      );
    }
    if (declaredLength !== undefined && blob.size < declaredLength) {
      throw new EvidencePlaybackError(
        "transfer_incomplete",
        "The recording transfer was interrupted. Request fresh access and try again.",
        true,
      );
    }
    if (!(await looksLikeWebm(blob))) {
      throw new EvidencePlaybackError(
        "stream_rejected",
        "The evidence stream was rejected.",
        false,
      );
    }
    return {
      objectUrl: URL.createObjectURL(blob),
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    if (error instanceof EvidencePlaybackError) throw error;
    emit("client", {
      httpStatus: capabilityStatus,
      aborted: isAbortLike(error),
    });
    throw new EvidencePlaybackError(
      "transfer_incomplete",
      "The recording transfer was interrupted. Request fresh access and try again.",
      true,
    );
  }
}

function parseDeclaredLength(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

const WEBM_EBML = [0x1a, 0x45, 0xdf, 0xa3] as const;

async function looksLikeWebm(blob: Blob): Promise<boolean> {
  const prefix = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return (
    prefix.byteLength >= 4 &&
    prefix[0] === WEBM_EBML[0] &&
    prefix[1] === WEBM_EBML[1] &&
    prefix[2] === WEBM_EBML[2] &&
    prefix[3] === WEBM_EBML[3]
  );
}

function asPlaybackError(error: unknown): EvidencePlaybackError {
  return error instanceof EvidencePlaybackError
    ? error
    : new EvidencePlaybackError(
        "unavailable",
        "The video is not available. Request fresh access and try again.",
        false,
      );
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export function evidencePlaybackUserMessage(error: unknown): string {
  if (error instanceof EvidencePlaybackError) return error.message;
  return "The video is not available. Request fresh access and try again.";
}
