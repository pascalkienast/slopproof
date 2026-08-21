import { z } from "zod";
import {
  JUDGE_HOP_USED,
  PROVIDER_ERROR_CODES,
  PROVIDER_FAILURE_KINDS,
  ProviderError,
  safeHttpStatus,
  type JudgeHopUsed,
  type ProviderErrorCode,
  type ProviderErrorDisposition,
  type ProviderFailureKind,
} from "./errors";

export const JudgeHopUsedSchema = z.enum(JUDGE_HOP_USED);

export const JudgeEvaluateFailureDiagnosticsV1Schema = z
  .object({
    httpStatus: z.number().int().min(100).max(599).optional(),
    errorClass: z.enum(["ProviderError", "Error", "UnknownError"]),
    errorCode: z.enum(PROVIDER_ERROR_CODES).optional(),
    disposition: z.enum(["retryable", "terminal", "review"]).optional(),
    lastFailureKind: z.enum(PROVIDER_FAILURE_KINDS).optional(),
    hopUsed: JudgeHopUsedSchema,
    invocationCount: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    latencyMs: z
      .number()
      .int()
      .nonnegative()
      .max(15 * 60_000),
    frameCount: z.number().int().nonnegative().max(32),
  })
  .strict();

export type JudgeEvaluateFailureDiagnosticsV1 = z.infer<
  typeof JudgeEvaluateFailureDiagnosticsV1Schema
>;

export function annotateProviderErrorHopUsed(
  error: unknown,
  hopUsed: JudgeHopUsed,
): unknown {
  if (!(error instanceof ProviderError)) return error;
  if (error.hopUsed === hopUsed) return error;
  return new ProviderError(error.code, error.disposition, error.message, {
    cause: error,
    hopUsed,
    ...(error.telemetry === undefined ? {} : { telemetry: error.telemetry }),
  });
}

export function describeJudgeEvaluateFailure(
  error: unknown,
  input: {
    hopUsed: JudgeHopUsed;
    latencyMs: number;
    frameCount: number;
  },
): JudgeEvaluateFailureDiagnosticsV1 {
  const latencyMs = Math.min(
    15 * 60_000,
    Math.max(0, Math.floor(input.latencyMs)),
  );
  const frameCount = Math.min(32, Math.max(0, Math.floor(input.frameCount)));
  if (error instanceof ProviderError) {
    const httpStatus = safeHttpStatus(error.telemetry?.httpStatus);
    const hopUsed = error.hopUsed ?? input.hopUsed;
    return JudgeEvaluateFailureDiagnosticsV1Schema.parse({
      ...(httpStatus === undefined ? {} : { httpStatus }),
      errorClass: "ProviderError",
      errorCode: error.code,
      disposition: error.disposition,
      ...(error.telemetry === undefined
        ? {}
        : { lastFailureKind: error.telemetry.lastFailureKind }),
      hopUsed,
      invocationCount: invocationCountForFailure(hopUsed),
      latencyMs,
      frameCount,
    });
  }
  return JudgeEvaluateFailureDiagnosticsV1Schema.parse({
    errorClass: error instanceof Error ? "Error" : "UnknownError",
    hopUsed: input.hopUsed,
    invocationCount: input.hopUsed === "transport_fallback" ? 2 : 1,
    latencyMs,
    frameCount,
  });
}

function invocationCountForFailure(hopUsed: JudgeHopUsed): 0 | 1 | 2 {
  return hopUsed === "transport_fallback" ? 2 : 1;
}

export type JudgeEvaluateFailureSummary = {
  httpStatus?: number;
  errorClass?: JudgeEvaluateFailureDiagnosticsV1["errorClass"];
  errorCode?: ProviderErrorCode;
  disposition?: ProviderErrorDisposition;
  lastFailureKind?: ProviderFailureKind;
  hopUsed: JudgeHopUsed;
  invocationCount: 0 | 1 | 2;
  latencyMs: number;
  frameCount: number;
};

export function judgeFailureLogFields(
  diagnostics: JudgeEvaluateFailureDiagnosticsV1,
): JudgeEvaluateFailureSummary {
  return {
    ...(diagnostics.httpStatus === undefined
      ? {}
      : { httpStatus: diagnostics.httpStatus }),
    errorClass: diagnostics.errorClass,
    ...(diagnostics.errorCode === undefined
      ? {}
      : { errorCode: diagnostics.errorCode }),
    ...(diagnostics.disposition === undefined
      ? {}
      : { disposition: diagnostics.disposition }),
    ...(diagnostics.lastFailureKind === undefined
      ? {}
      : { lastFailureKind: diagnostics.lastFailureKind }),
    hopUsed: diagnostics.hopUsed,
    invocationCount: diagnostics.invocationCount,
    latencyMs: diagnostics.latencyMs,
    frameCount: diagnostics.frameCount,
  };
}
