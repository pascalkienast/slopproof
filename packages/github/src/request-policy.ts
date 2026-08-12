import { GithubControlError } from "./production-errors";

export type GithubResponseHeaders = Readonly<
  Record<string, string | number | undefined>
>;

export type GithubApiResponse<T = unknown> = {
  data: T;
  status?: number;
  headers?: GithubResponseHeaders;
};

export type GithubRequest<T> = (
  signal: AbortSignal,
) => Promise<GithubApiResponse<T>>;

export type GithubRequestPolicy = {
  maxAttempts?: number;
  deadlineMs?: number;
  attemptTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type Failure = {
  code: "RATE_LIMITED" | "TIMEOUT" | "UNAVAILABLE" | "REJECTED";
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  secondaryRateLimit?: boolean;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 3;
const SECONDARY_RATE_LIMIT_MINIMUM_RETRY_MS = 60_000;
const timeoutMarker = Symbol("github-request-timeout");

export async function executeGithubRequest<T>(
  request: GithubRequest<T>,
  policy: GithubRequestPolicy = {},
): Promise<GithubApiResponse<T>> {
  const maxAttempts = policy.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deadlineMs = policy.deadlineMs ?? 25_000;
  const attemptTimeoutMs = policy.attemptTimeoutMs ?? 10_000;
  const now = policy.now ?? Date.now;
  const random = policy.random ?? Math.random;
  const sleep =
    policy.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs < 1 ||
    !Number.isFinite(attemptTimeoutMs) ||
    attemptTimeoutMs < 1
  ) {
    throw new GithubControlError("INVALID_INPUT");
  }

  const deadlineAt = now() + deadlineMs;
  let lastFailure: Failure | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw new GithubControlError("TIMEOUT");
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const response = await Promise.race([
        Promise.resolve().then(() => request(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => {
              controller.abort();
              reject(timeoutMarker);
            },
            Math.max(1, Math.min(attemptTimeoutMs, remaining)),
          );
        }),
      ]);
      return response;
    } catch (error) {
      // Internal callers use this to enforce their own hard, cross-request
      // budgets. Never reinterpret or retry an already-safe control error.
      if (error instanceof GithubControlError) throw error;
      lastFailure =
        error === timeoutMarker
          ? { code: "TIMEOUT", retryable: true }
          : classifyFailure(error, now());
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    if (!lastFailure.retryable || attempt === maxAttempts) {
      throw toControlError(lastFailure);
    }

    const remainingBeforeSleep = deadlineAt - now();
    const delay = Math.max(
      jitteredBackoff(attempt, random),
      lastFailure.retryAfterMs ?? 0,
    );
    if (remainingBeforeSleep <= delay) throw toControlError(lastFailure);
    await sleep(delay);
  }

  throw toControlError(lastFailure ?? { code: "UNAVAILABLE", retryable: true });
}

function classifyFailure(error: unknown, now: number): Failure {
  const failure = readHttpFailure(error);
  if (failure.status === undefined) {
    return { code: "UNAVAILABLE", retryable: true };
  }

  const retryAfterMs = readRetryAfter(failure.headers, now);
  const exhaustedPrimaryLimit =
    header(failure.headers, "x-ratelimit-remaining") === "0";
  if (
    failure.status === 429 ||
    (failure.status === 403 &&
      (retryAfterMs !== undefined ||
        exhaustedPrimaryLimit ||
        failure.secondaryRateLimit === true))
  ) {
    const effectiveRetryAfterMs =
      retryAfterMs ??
      (failure.secondaryRateLimit
        ? SECONDARY_RATE_LIMIT_MINIMUM_RETRY_MS
        : undefined);
    return {
      code: "RATE_LIMITED",
      retryable: true,
      status: failure.status,
      ...(effectiveRetryAfterMs !== undefined
        ? { retryAfterMs: effectiveRetryAfterMs }
        : {}),
    };
  }
  if (failure.status >= 500 && failure.status <= 599) {
    return { code: "UNAVAILABLE", retryable: true, status: failure.status };
  }
  return { code: "REJECTED", retryable: false, status: failure.status };
}

function readHttpFailure(error: unknown): {
  status?: number;
  headers?: GithubResponseHeaders;
  secondaryRateLimit?: boolean;
} {
  if (typeof error !== "object" || error === null) return {};
  const record = error as Record<string, unknown>;
  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : undefined;
  const statusCandidate = record.status ?? response?.status;
  const headersCandidate = response?.headers ?? record.headers;
  const responseData =
    typeof response?.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>)
      : undefined;
  const secondaryRateLimit = isSecondaryRateLimitMessage(responseData?.message);
  const status =
    typeof statusCandidate === "number" &&
    Number.isInteger(statusCandidate) &&
    statusCandidate >= 400 &&
    statusCandidate <= 599
      ? statusCandidate
      : undefined;
  const headers =
    typeof headersCandidate === "object" && headersCandidate !== null
      ? (headersCandidate as GithubResponseHeaders)
      : undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(secondaryRateLimit ? { secondaryRateLimit: true } : {}),
  };
}

function isSecondaryRateLimitMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return [
    "You have exceeded a secondary rate limit.",
    "You have exceeded a secondary rate limit and have been temporarily blocked",
    "You have triggered an abuse detection mechanism.",
  ].some((marker) => message.startsWith(marker));
}

function readRetryAfter(
  headers: GithubResponseHeaders | undefined,
  now: number,
): number | undefined {
  const retryAfter = header(headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  if (header(headers, "x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(header(headers, "x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
      return Math.max(0, Math.round(resetSeconds * 1_000 - now));
    }
  }
  return undefined;
}

function header(
  headers: GithubResponseHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return entry === undefined ? undefined : String(entry);
}

function jitteredBackoff(attempt: number, random: () => number): number {
  const base = Math.min(150 * 2 ** (attempt - 1), 1_000);
  return Math.round(base * (0.75 + Math.max(0, Math.min(1, random())) * 0.5));
}

function toControlError(failure: Failure): GithubControlError {
  return new GithubControlError(failure.code, {
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.retryAfterMs !== undefined
      ? { retryAfterMs: failure.retryAfterMs }
      : {}),
  });
}
