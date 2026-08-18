import { createHash } from "node:crypto";
import { Sha256Schema, UuidSchema } from "@slopproof/domain";
import { z } from "zod";
import {
  ProviderContextV1Schema,
  UntrustedDataSchema,
  type ProviderContextV1,
} from "./contracts";
import { ProviderError } from "./errors";
import type {
  ProviderFailureTelemetry,
  ProviderHttpStatusClass,
} from "./errors";

const MAX_HTTP_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 1024 * 1_024;
const MAX_AUDIO_BYTES = 16 * 1_024 * 1_024;
const MAX_CLIP_DURATION_MS = 8 * 60 * 1_000;
const MAX_TRANSCRIPT_BYTES = 100_000;
const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;
const STANDARD_WAV_HEADER_BYTES = 44;
const timeoutMarker = Symbol("openrouter-transcription-timeout");

export const TranscriptionLanguagePolicyV1Schema = z.discriminatedUnion(
  "mode",
  [
    z.object({ mode: z.literal("detect") }).strict(),
    z
      .object({
        mode: z.literal("fixed"),
        language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
      })
      .strict(),
  ],
);

export type TranscriptionLanguagePolicyV1 = z.infer<
  typeof TranscriptionLanguagePolicyV1Schema
>;

export const QuestionAudioTranscriptionRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    requestVersion: z.literal("question-audio-transcription-v1"),
    attemptId: UuidSchema,
    questionId: UuidSchema,
    sourceSha256: Sha256Schema,
    clipSha256: Sha256Schema,
    startMs: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CLIP_DURATION_MS - 1),
    endMs: z.number().int().positive().max(MAX_CLIP_DURATION_MS),
    languagePolicy: TranscriptionLanguagePolicyV1Schema,
    audio: z.instanceof(Uint8Array),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.endMs <= request.startMs) {
      context.addIssue({
        code: "custom",
        path: ["endMs"],
        message: "Question audio interval must have positive duration",
      });
    }
    if (
      request.audio.byteLength < STANDARD_WAV_HEADER_BYTES ||
      request.audio.byteLength > MAX_AUDIO_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["audio"],
        message: "Question audio exceeds its byte contract",
      });
    }
  });

export type QuestionAudioTranscriptionRequestV1 = z.infer<
  typeof QuestionAudioTranscriptionRequestV1Schema
>;

export const OpenRouterQuestionTranscriptionResultV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    resultVersion: z.literal("question-transcription-result-v1"),
    questionId: UuidSchema,
    clipSha256: Sha256Schema,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    provider: z.literal("openrouter"),
    model: z.string().min(1).max(200),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
    text: UntrustedDataSchema.refine(
      (value) => value.source === "transcript",
      "Transcription output must stay labeled as untrusted transcript data",
    ),
    privacy: z
      .object({
        storeRequested: z.literal(false),
        zeroDataRetention: z.enum(["account_enforced", "not_verified"]),
      })
      .strict(),
  })
  .strict()
  .refine((result) => result.endMs > result.startMs, {
    path: ["endMs"],
    message: "Question transcription interval must have positive duration",
  });

export type OpenRouterQuestionTranscriptionResultV1 = z.infer<
  typeof OpenRouterQuestionTranscriptionResultV1Schema
>;

export const OpenRouterTranscriptionProviderConfigV1Schema = z
  .object({
    baseUrl: z.url().refine(isSafeProviderBaseUrl),
    apiKey: z
      .string()
      .min(16)
      .max(4_096)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    zeroDataRetention: z.enum(["account_enforced", "not_verified"]),
  })
  .strict();

export type OpenRouterTranscriptionProviderConfigV1 = z.infer<
  typeof OpenRouterTranscriptionProviderConfigV1Schema
>;

export type OpenRouterTranscriptionRequestPolicy = {
  maxAttempts?: number;
  attemptTimeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type OpenRouterTranscriptionProviderDependencies = {
  fetchImpl?: typeof fetch;
  policy?: OpenRouterTranscriptionRequestPolicy;
};

type ResolvedRequestPolicy = {
  maxAttempts: number;
  attemptTimeoutMs: number;
  maxResponseBytes: number;
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
};

type RetryableFailure = {
  kind: "network" | "timeout" | "rate_limited" | "unavailable";
  httpStatusClass?: ProviderHttpStatusClass;
  retryAfterMs?: number;
};

const OpenRouterTranscriptionResponseSchema = z
  .object({
    text: z.string(),
    language: z.unknown().optional(),
    duration: z.unknown().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

export class OpenRouterTranscriptionProvider {
  readonly descriptor: {
    provider: "openrouter";
    model: string;
    zeroDataRetention: "account_enforced" | "not_verified";
  };

  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly policy: ResolvedRequestPolicy;

  constructor(
    rawConfig: OpenRouterTranscriptionProviderConfigV1,
    dependencies: OpenRouterTranscriptionProviderDependencies = {},
  ) {
    const parsed =
      OpenRouterTranscriptionProviderConfigV1Schema.safeParse(rawConfig);
    if (!parsed.success) {
      throw safeProviderError(
        "INVALID_INPUT",
        "terminal",
        "OpenRouter transcription configuration is invalid",
      );
    }
    this.endpoint = transcriptionEndpoint(parsed.data.baseUrl);
    this.apiKey = parsed.data.apiKey;
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    this.policy = resolvePolicy(dependencies.policy);
    this.descriptor = Object.freeze({
      provider: "openrouter" as const,
      model: parsed.data.model,
      zeroDataRetention: parsed.data.zeroDataRetention,
    });
  }

  async transcribeQuestion(
    rawInput: QuestionAudioTranscriptionRequestV1,
    rawContext: ProviderContextV1,
  ): Promise<OpenRouterQuestionTranscriptionResultV1> {
    const input = parseInput(rawInput);
    const context = parseContext(rawContext, input.attemptId, this.policy.now);
    assertPcmWav(input.audio, input.endMs - input.startMs);
    if (sha256(input.audio) !== input.clipSha256) {
      throw safeProviderError(
        "INVALID_INPUT",
        "terminal",
        "Question audio digest does not match its request binding",
      );
    }

    const response = await requestTranscriptionWithRetry({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      model: this.descriptor.model,
      audio: input.audio,
      languagePolicy: input.languagePolicy,
      deadlineAtMs: context.deadlineAt.getTime(),
      fetchImpl: this.fetchImpl,
      policy: this.policy,
    });
    const parsedResponse = OpenRouterTranscriptionResponseSchema.safeParse(
      response.payload,
    );
    if (!parsedResponse.success) {
      throw invalidOutputError(response.transportAttemptCount);
    }
    const text = parsedResponse.data.text.trim();
    if (
      text.length === 0 ||
      Buffer.byteLength(text, "utf8") > MAX_TRANSCRIPT_BYTES ||
      text.includes("\0")
    ) {
      throw invalidOutputError(response.transportAttemptCount);
    }
    const language =
      typeof parsedResponse.data.language === "string"
        ? normalizeDetectedLanguage(parsedResponse.data.language)
        : undefined;
    if (
      input.languagePolicy.mode === "fixed" &&
      language !== undefined &&
      baseLanguage(language) !== baseLanguage(input.languagePolicy.language)
    ) {
      throw safeProviderError(
        "INVALID_OUTPUT",
        "review",
        "Transcription language contradicts the accepted language policy",
        invalidOutputTelemetry(response.transportAttemptCount),
      );
    }

    return OpenRouterQuestionTranscriptionResultV1Schema.parse({
      schemaVersion: "1",
      resultVersion: "question-transcription-result-v1",
      questionId: input.questionId,
      clipSha256: input.clipSha256,
      startMs: input.startMs,
      endMs: input.endMs,
      provider: this.descriptor.provider,
      model: this.descriptor.model,
      language:
        input.languagePolicy.mode === "fixed"
          ? input.languagePolicy.language
          : (language ?? "und"),
      text: {
        trust: "untrusted",
        source: "transcript",
        content: text,
      },
      privacy: {
        storeRequested: false,
        zeroDataRetention: this.descriptor.zeroDataRetention,
      },
    });
  }
}

async function requestTranscriptionWithRetry(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  audio: Uint8Array;
  languagePolicy: TranscriptionLanguagePolicyV1;
  deadlineAtMs: number;
  fetchImpl: typeof fetch;
  policy: ResolvedRequestPolicy;
}): Promise<{ payload: unknown; transportAttemptCount: number }> {
  let lastFailure: RetryableFailure | undefined;
  for (let attempt = 1; attempt <= input.policy.maxAttempts; attempt += 1) {
    const remaining = input.deadlineAtMs - input.policy.now();
    if (remaining <= 0) throw deadlineError();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    try {
      const operation = (async () => {
        const form = buildMultipartRequest(
          input.model,
          input.audio,
          input.languagePolicy,
        );
        response = await input.fetchImpl(input.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${input.apiKey}`,
          },
          body: form,
          signal: controller.signal,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw responseStatusMarker(response.status);
        const text = await readBoundedResponseText(
          response,
          input.policy.maxResponseBytes,
        );
        try {
          return JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
        } catch {
          throw new SafeProtocolError("malformed_response");
        }
      })();
      const payload = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => {
              controller.abort();
              reject(timeoutMarker);
            },
            Math.max(1, Math.min(input.policy.attemptTimeoutMs, remaining)),
          );
        }),
      ]);
      return { payload, transportAttemptCount: attempt };
    } catch (error) {
      if (error instanceof SafeProtocolError) {
        if (error.kind === "response_stream") {
          lastFailure = { kind: "network" };
        } else {
          throw invalidOutputError(attempt);
        }
      } else if (isResponseStatusMarker(error)) {
        try {
          await response?.body?.cancel();
        } catch {
          // Rejected bodies are deliberately neither consumed nor logged.
        }
        if (error.status === 429) {
          lastFailure = {
            kind: "rate_limited",
            httpStatusClass: "4xx",
            ...(response === undefined
              ? {}
              : {
                  retryAfterMs: retryAfterMilliseconds(
                    response.headers,
                    input.policy.now(),
                  ),
                }),
          };
        } else if (error.status >= 500 && error.status <= 599) {
          lastFailure = { kind: "unavailable", httpStatusClass: "5xx" };
        } else {
          throw safeProviderError(
            "PROVIDER_UNAVAILABLE",
            "terminal",
            "OpenRouter rejected the bounded transcription request",
            {
              lastFailureKind: "request_rejected",
              httpStatusClass: "4xx",
              transportAttemptCount: attempt,
            },
          );
        }
      } else {
        lastFailure =
          error === timeoutMarker || controller.signal.aborted
            ? { kind: "timeout" }
            : { kind: "network" };
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    if (attempt === input.policy.maxAttempts) {
      throw retryableProviderError(lastFailure, attempt);
    }
    const delay = Math.max(
      jitteredBackoffMilliseconds(attempt, input.policy.random),
      lastFailure?.retryAfterMs ?? 0,
    );
    if (input.deadlineAtMs - input.policy.now() <= delay) {
      throw deadlineError({
        lastFailureKind: "deadline_exceeded",
        httpStatusClass: lastFailure?.httpStatusClass ?? null,
        transportAttemptCount: attempt,
      });
    }
    await input.policy.sleep(delay);
  }
  throw retryableProviderError(lastFailure, input.policy.maxAttempts);
}

function buildMultipartRequest(
  model: string,
  audio: Uint8Array,
  languagePolicy: TranscriptionLanguagePolicyV1,
): FormData {
  const form = new FormData();
  form.set("model", model);
  form.set("response_format", "json");
  form.set("store", "false");
  if (languagePolicy.mode === "fixed") {
    form.set("language", languagePolicy.language);
  }
  form.set(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
    "question.wav",
  );
  return form;
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const rawDeclaredLength = response.headers.get("content-length");
  const declaredLength =
    rawDeclaredLength === null || !/^(?:0|[1-9]\d*)$/u.test(rawDeclaredLength)
      ? undefined
      : Number(rawDeclaredLength);
  if (
    rawDeclaredLength !== null &&
    (declaredLength === undefined ||
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maximumBytes)
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // Cancellation is best effort for an already rejected response.
    }
    throw new SafeProtocolError("response_too_large");
  }
  if (!response.body) throw new SafeProtocolError("malformed_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        throw new SafeProtocolError("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof SafeProtocolError) throw error;
    throw new SafeProtocolError("response_stream");
  }
}

function assertPcmWav(bytes: Uint8Array, durationMs: number): void {
  if (
    durationMs <= 0 ||
    durationMs > MAX_CLIP_DURATION_MS ||
    bytes.byteLength < STANDARD_WAV_HEADER_BYTES ||
    bytes.byteLength > MAX_AUDIO_BYTES ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WAVE" ||
    ascii(bytes, 12, 4) !== "fmt " ||
    ascii(bytes, 36, 4) !== "data"
  ) {
    throw invalidInputAudioError();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredFileBytes = view.getUint32(4, true) + 8;
  const formatChunkBytes = view.getUint32(16, true);
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  const expectedDataBytes = Math.floor(
    (durationMs * PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8)) /
      1_000,
  );
  if (
    declaredFileBytes !== bytes.byteLength ||
    formatChunkBytes !== 16 ||
    format !== 1 ||
    channels !== PCM_CHANNELS ||
    sampleRate !== PCM_SAMPLE_RATE ||
    byteRate !== PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8) ||
    blockAlign !== PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8) ||
    bitsPerSample !== PCM_BITS_PER_SAMPLE ||
    dataBytes !== bytes.byteLength - STANDARD_WAV_HEADER_BYTES ||
    Math.abs(dataBytes - expectedDataBytes) > PCM_SAMPLE_RATE / 2
  ) {
    throw invalidInputAudioError();
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function normalizeDetectedLanguage(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (/^[a-z]{2,3}$/u.test(normalized)) return normalized;
  return LANGUAGE_NAMES[normalized];
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  chinese: "zh",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  finnish: "fi",
  french: "fr",
  german: "de",
  italian: "it",
  japanese: "ja",
  korean: "ko",
  norwegian: "no",
  polish: "pl",
  portuguese: "pt",
  spanish: "es",
  swedish: "sv",
  turkish: "tr",
  ukrainian: "uk",
});

function baseLanguage(value: string): string {
  return value.split("-")[0] ?? value;
}

function parseInput(
  value: QuestionAudioTranscriptionRequestV1,
): QuestionAudioTranscriptionRequestV1 {
  const parsed = QuestionAudioTranscriptionRequestV1Schema.safeParse(value);
  if (!parsed.success) {
    throw safeProviderError(
      "INVALID_INPUT",
      "terminal",
      "Question audio failed its versioned transcription contract",
    );
  }
  return parsed.data;
}

function parseContext(
  value: ProviderContextV1,
  attemptId: string,
  now: () => number,
): ProviderContextV1 {
  const parsed = ProviderContextV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.attemptId !== attemptId) {
    throw safeProviderError(
      "INVALID_INPUT",
      "terminal",
      "Transcription context is not bound to the requested attempt",
    );
  }
  if (parsed.data.deadlineAt.getTime() <= now()) throw deadlineError();
  return parsed.data;
}

function resolvePolicy(
  rawPolicy: OpenRouterTranscriptionRequestPolicy = {},
): ResolvedRequestPolicy {
  const numeric = z
    .object({
      maxAttempts: z
        .number()
        .int()
        .min(1)
        .max(MAX_HTTP_ATTEMPTS)
        .default(MAX_HTTP_ATTEMPTS),
      attemptTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(120_000)
        .default(DEFAULT_ATTEMPT_TIMEOUT_MS),
      maxResponseBytes: z
        .number()
        .int()
        .positive()
        .max(MAX_RESPONSE_BYTES)
        .default(DEFAULT_MAX_RESPONSE_BYTES),
    })
    .strict()
    .safeParse({
      maxAttempts: rawPolicy.maxAttempts,
      attemptTimeoutMs: rawPolicy.attemptTimeoutMs,
      maxResponseBytes: rawPolicy.maxResponseBytes,
    });
  if (
    !numeric.success ||
    (rawPolicy.now !== undefined && typeof rawPolicy.now !== "function") ||
    (rawPolicy.random !== undefined &&
      typeof rawPolicy.random !== "function") ||
    (rawPolicy.sleep !== undefined && typeof rawPolicy.sleep !== "function")
  ) {
    throw safeProviderError(
      "INVALID_INPUT",
      "terminal",
      "OpenRouter transcription request policy is invalid",
    );
  }
  return {
    ...numeric.data,
    now: rawPolicy.now ?? Date.now,
    random: rawPolicy.random ?? Math.random,
    sleep:
      rawPolicy.sleep ??
      ((milliseconds) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
  };
}

function transcriptionEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/audio/transcriptions`;
  return url.toString();
}

function isSafeProviderBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function retryAfterMilliseconds(headers: Headers, now: number): number {
  const value = headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), 60_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - now, 0), 60_000) : 0;
}

function jitteredBackoffMilliseconds(
  attempt: number,
  random: () => number,
): number {
  const base = Math.min(250 * 2 ** (attempt - 1), 2_000);
  return Math.round(base * (0.75 + Math.min(Math.max(random(), 0), 1) * 0.5));
}

type ResponseStatusMarker = { marker: "response_status"; status: number };

function responseStatusMarker(status: number): ResponseStatusMarker {
  return { marker: "response_status", status };
}

function isResponseStatusMarker(value: unknown): value is ResponseStatusMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    "marker" in value &&
    value.marker === "response_status" &&
    "status" in value &&
    typeof value.status === "number"
  );
}

class SafeProtocolError extends Error {
  constructor(
    readonly kind:
      "malformed_response" | "response_too_large" | "response_stream",
  ) {
    super("OpenRouter response violated a bounded transport contract");
    this.name = "SafeProtocolError";
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeProviderError(
  code: ConstructorParameters<typeof ProviderError>[0],
  disposition: ConstructorParameters<typeof ProviderError>[1],
  message: string,
  telemetry?: ProviderFailureTelemetry,
): ProviderError {
  return new ProviderError(
    code,
    disposition,
    message,
    telemetry === undefined ? undefined : { telemetry },
  );
}

function invalidInputAudioError(): ProviderError {
  return safeProviderError(
    "INVALID_INPUT",
    "terminal",
    "Question audio is not bounded mono 16 kHz PCM WAV",
  );
}

function invalidOutputTelemetry(
  transportAttemptCount: number,
): ProviderFailureTelemetry {
  return {
    lastFailureKind: "invalid_output",
    httpStatusClass: null,
    transportAttemptCount,
  };
}

function invalidOutputError(transportAttemptCount = 0): ProviderError {
  return safeProviderError(
    "INVALID_OUTPUT",
    "review",
    "Transcription provider returned an invalid bounded response",
    invalidOutputTelemetry(transportAttemptCount),
  );
}

function deadlineError(telemetry?: ProviderFailureTelemetry): ProviderError {
  return safeProviderError(
    "DEADLINE_EXCEEDED",
    "retryable",
    "Transcription provider deadline was exceeded",
    telemetry ?? {
      lastFailureKind: "deadline_exceeded",
      httpStatusClass: null,
      transportAttemptCount: 0,
    },
  );
}

function retryableProviderError(
  failure: RetryableFailure | undefined,
  transportAttemptCount: number,
): ProviderError {
  return safeProviderError(
    "PROVIDER_UNAVAILABLE",
    "retryable",
    failure?.kind === "rate_limited"
      ? "Transcription provider remained rate limited"
      : "Transcription provider remained unavailable",
    {
      lastFailureKind:
        failure?.kind === "unavailable"
          ? "upstream_unavailable"
          : (failure?.kind ?? "network"),
      httpStatusClass: failure?.httpStatusClass ?? null,
      transportAttemptCount,
    },
  );
}
