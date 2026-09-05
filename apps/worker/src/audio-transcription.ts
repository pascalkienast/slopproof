import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import {
  FinalizeRecordingSchema,
  MAX_PROOF_QUESTION_COUNT,
  MAX_RECORDING_DURATION_MS,
  MAX_RECORDING_OBJECT_BYTES,
  ProofQuestionIntervalV1Schema,
  RECORDING_CODEC,
  validateProofQuestionIntervalsV1,
  type FinalizeRecording,
  type ProofQuestionIntervalV1,
  type RecordingManifest,
} from "@understandproof/media";
import {
  OpenRouterQuestionTranscriptionResultV1Schema,
  ProviderContextV1Schema,
  ProviderError,
  TranscriptV1Schema,
  TranscriptionLanguagePolicyV1Schema,
  type OpenRouterQuestionTranscriptionResultV1,
  type ProviderContextV1,
  type QuestionAudioTranscriptionRequestV1,
  type TranscriptV1,
  type TranscriptionLanguagePolicyV1,
} from "@understandproof/providers";
import { z } from "zod";
import {
  authenticateRecordingFinalization,
  streamDecryptedRecording,
} from "./recording-reader";

const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_BYTES_PER_MILLISECOND =
  (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE) / 1_000;
const WAV_HEADER_BYTES = 44;
const MAX_PCM_BYTES = 16 * 1_024 * 1_024;
const MAX_QUESTION_AUDIO_BYTES = 16 * 1_024 * 1_024;
const MAX_DECODE_DURATION_DRIFT_MS = 1_500;
const MAX_QUESTION_CLIP_END_CLAMP_MS = 250;
const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;

export const RecordingAudioTranscriptionSourceV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    sourceVersion: z.literal("recording-audio-source-v1"),
    attemptId: z.string().uuid(),
    recordingObjectId: z.string().uuid(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    recordingDurationMs: z
      .number()
      .int()
      .positive()
      .max(MAX_RECORDING_DURATION_MS),
    recordingCiphertextBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_RECORDING_OBJECT_BYTES),
    recordingCodec: z.literal(RECORDING_CODEC),
    materialId: z.string().uuid(),
    materialKeyId: z.string().min(1).max(128),
    finalization: FinalizeRecordingSchema,
    proofQuestionIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_PROOF_QUESTION_COUNT)
      .refine((ids) => new Set(ids).size === ids.length),
    questionIntervals: z
      .array(ProofQuestionIntervalV1Schema)
      .min(1)
      .max(MAX_PROOF_QUESTION_COUNT),
    languagePolicy: TranscriptionLanguagePolicyV1Schema,
  })
  .strict()
  .superRefine((source, context) => {
    const questionIds = new Set<string>();
    let previousEnd = 0;
    for (const [index, interval] of source.questionIntervals.entries()) {
      if (
        interval.ordinal !== index ||
        interval.recordedDurationMs !==
          source.finalization.manifest.durationMs ||
        interval.endMs > source.recordingDurationMs ||
        interval.startMs < previousEnd ||
        questionIds.has(interval.questionId) ||
        source.proofQuestionIds[index] !== interval.questionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["questionIntervals", index],
          message:
            "Question intervals must be unique, complete in order and non-overlapping",
        });
      }
      previousEnd = interval.endMs;
      questionIds.add(interval.questionId);
    }
    if (source.proofQuestionIds.length !== source.questionIntervals.length) {
      context.addIssue({
        code: "custom",
        path: ["proofQuestionIds"],
        message: "Every stored proof question needs one exact interval",
      });
    }
  });

export type RecordingAudioTranscriptionSourceV1 = z.infer<
  typeof RecordingAudioTranscriptionSourceV1Schema
>;

export interface RecordingCiphertextAccess {
  openCiphertext(): Promise<ReadableStream<Uint8Array>>;
}

export interface QuestionAudioTranscriptionTransport {
  readonly descriptor: {
    provider: "openrouter";
    model: string;
    zeroDataRetention: "account_enforced" | "not_verified";
  };
  transcribeQuestion(
    input: QuestionAudioTranscriptionRequestV1,
    context: ProviderContextV1,
  ): Promise<OpenRouterQuestionTranscriptionResultV1>;
}

export type AudioExtractorHandle = {
  child: Pick<ReturnType<typeof spawn>, "kill">;
  stdin: Writable;
  result: Promise<Uint8Array>;
};

export type RecordingAudioTranscriptionDependencies = {
  privateKeyPath: string;
  ffmpegPath: string;
  provider: QuestionAudioTranscriptionTransport;
  now?: () => Date;
  ffmpegTimeoutMs?: number;
  authenticateRecording?: typeof authenticateRecordingFinalization;
  streamRecording?: typeof streamDecryptedRecording;
  startAudioExtractor?: (
    ffmpegPath: string,
    maximumOutputBytes: number,
    timeoutMs: number,
  ) => AudioExtractorHandle;
};

/**
 * Worker-only recording transcription. Ciphertext is authenticated while its
 * transient plaintext is piped straight into FFmpeg. Only bounded mono PCM and
 * one bounded WAV question clip exist in memory; no plaintext path is opened.
 */
export class EncryptedRecordingAudioTranscriptionAdapter {
  constructor(
    private readonly dependencies: RecordingAudioTranscriptionDependencies,
  ) {}

  async transcribe(
    rawSource: RecordingAudioTranscriptionSourceV1,
    access: RecordingCiphertextAccess,
    rawContext: ProviderContextV1,
  ): Promise<TranscriptV1> {
    const parsed =
      RecordingAudioTranscriptionSourceV1Schema.safeParse(rawSource);
    if (!parsed.success) throw technicalInputError();
    const source = parsed.data;
    const context = parseProviderContext(
      rawContext,
      source.attemptId,
      this.now(),
    );
    assertSourceBinding(source);
    const pcm = await this.extractPcm(source, access, context);
    try {
      assertDecodedPcmDuration(pcm, source.recordingDurationMs);
      const results: OpenRouterQuestionTranscriptionResultV1[] = [];
      for (const interval of source.questionIntervals) {
        assertProviderDeadline(context, this.now());
        const wav = questionWavFromPcm(pcm, interval);
        try {
          const clipSha256 = sha256(wav);
          assertProviderDeadline(context, this.now());
          const result = await this.dependencies.provider.transcribeQuestion(
            {
              schemaVersion: "1",
              requestVersion: "question-audio-transcription-v1",
              attemptId: source.attemptId,
              questionId: interval.questionId,
              sourceSha256: source.sourceSha256,
              clipSha256,
              startMs: interval.startMs,
              endMs: interval.endMs,
              languagePolicy: source.languagePolicy,
              audio: wav,
            },
            {
              ...context,
              requestId: deterministicUuid(
                `transcription-call:${context.requestId}:${interval.questionId}:${clipSha256}`,
              ),
            },
          );
          results.push(
            validateQuestionResult(
              result,
              interval,
              clipSha256,
              source,
              this.dependencies.provider.descriptor,
            ),
          );
        } finally {
          wav.fill(0);
        }
      }
      return assembleTranscript(source, results, this.now());
    } finally {
      pcm.fill(0);
    }
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private async extractPcm(
    source: RecordingAudioTranscriptionSourceV1,
    access: RecordingCiphertextAccess,
    context: ProviderContextV1,
  ): Promise<Uint8Array> {
    const authenticate =
      this.dependencies.authenticateRecording ??
      authenticateRecordingFinalization;
    const streamRecording =
      this.dependencies.streamRecording ?? streamDecryptedRecording;
    const encryptionKey = await authenticate(
      source.finalization,
      { materialId: source.materialId, keyId: source.materialKeyId },
      this.dependencies.privateKeyPath,
    );
    assertProviderDeadline(context, this.now());
    const maximumOutputBytes = Math.min(
      MAX_PCM_BYTES,
      Math.ceil(source.recordingDurationMs * PCM_BYTES_PER_MILLISECOND) +
        Math.ceil(MAX_DECODE_DURATION_DRIFT_MS * PCM_BYTES_PER_MILLISECOND),
    );
    const startExtractor =
      this.dependencies.startAudioExtractor ?? startPcmExtractor;
    const deadline = createAudioExtractionDeadlineFence(
      context,
      this.dependencies.ffmpegTimeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS,
      () => this.now(),
    );
    let pcm: Uint8Array | undefined;
    try {
      const extractor = startExtractor(
        this.dependencies.ffmpegPath,
        maximumOutputBytes,
        deadline.timeoutMs,
      );
      deadline.bindExtractor(extractor);
      pcm = await runAudioExtractorPipeline(async (onPlaintext) => {
        deadline.assertProviderActive();
        const ciphertext = await access.openCiphertext();
        const cancellable = cancellableCiphertextStream(ciphertext);
        deadline.bindCiphertextCancellation(cancellable.cancel);
        try {
          deadline.assertProviderActive();
          await streamRecording(
            cancellable.stream,
            source.finalization.manifest,
            encryptionKey,
            async (plaintext) => {
              try {
                deadline.assertProviderActive();
                await onPlaintext(plaintext);
                deadline.assertProviderActive();
              } finally {
                plaintext.fill(0);
              }
            },
          );
          deadline.assertProviderActive();
        } finally {
          await cancellable.dispose();
        }
      }, extractor);
      deadline.assertProviderActive();
      return pcm;
    } catch (error) {
      pcm?.fill(0);
      await deadline.settleCancellation();
      throw deadline.failure() ?? error;
    } finally {
      deadline.clear();
      await deadline.settleCancellation();
    }
  }
}

type AudioExtractionDeadlineFence = {
  timeoutMs: number;
  bindExtractor(extractor: AudioExtractorHandle): void;
  bindCiphertextCancellation(cancel: (reason: unknown) => Promise<void>): void;
  assertProviderActive(): void;
  failure(): ProviderError | undefined;
  clear(): void;
  settleCancellation(): Promise<void>;
};

function createAudioExtractionDeadlineFence(
  context: ProviderContextV1,
  configuredTimeoutMs: number,
  now: () => Date,
): AudioExtractionDeadlineFence {
  const remainingProviderMs = context.deadlineAt.getTime() - now().getTime();
  if (remainingProviderMs <= 0) throw transcriptionDeadlineError();
  const boundedFfmpegTimeoutMs = Math.max(1, configuredTimeoutMs);
  const providerIsEffectiveBoundary =
    remainingProviderMs <= boundedFfmpegTimeoutMs;
  const timeoutMs = Math.max(
    1,
    Math.min(boundedFfmpegTimeoutMs, remainingProviderMs),
  );
  let extractor: AudioExtractorHandle | undefined;
  let cancelCiphertext: ((reason: unknown) => Promise<void>) | undefined;
  let cancellation: Promise<void> | undefined;
  let failure: ProviderError | undefined;

  const startCiphertextCancellation = () => {
    if (!failure || !cancelCiphertext || cancellation) return;
    cancellation = Promise.resolve()
      .then(() => cancelCiphertext?.(failure))
      .then(() => undefined)
      .catch(() => undefined);
  };
  const expire = (error: ProviderError) => {
    if (failure) return;
    failure = error;
    try {
      extractor?.child.kill("SIGKILL");
    } catch {
      // Cancellation cleanup must preserve the authoritative deadline error.
    }
    startCiphertextCancellation();
  };
  const timer = setTimeout(
    () =>
      expire(
        providerIsEffectiveBoundary
          ? transcriptionDeadlineError()
          : ffmpegDeadlineError(),
      ),
    timeoutMs,
  );

  return {
    timeoutMs,
    bindExtractor(value) {
      extractor = value;
      if (failure) {
        try {
          extractor.child.kill("SIGKILL");
        } catch {
          // Cancellation cleanup must preserve the authoritative failure.
        }
      }
    },
    bindCiphertextCancellation(cancel) {
      cancelCiphertext = cancel;
      startCiphertextCancellation();
    },
    assertProviderActive() {
      if (context.deadlineAt.getTime() <= now().getTime()) {
        expire(transcriptionDeadlineError());
      }
      if (failure) throw failure;
    },
    failure: () => failure,
    clear: () => clearTimeout(timer),
    settleCancellation: async () => {
      await cancellation;
    },
  };
}

type CancellableCiphertextStream = {
  stream: ReadableStream<Uint8Array>;
  cancel(reason: unknown): Promise<void>;
  dispose(): Promise<void>;
};

function cancellableCiphertextStream(
  source: ReadableStream<Uint8Array>,
): CancellableCiphertextStream {
  const sourceReader = source.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let terminal = false;
  let released = false;
  let cancellation: Promise<void> | undefined;

  const releaseSourceReader = () => {
    if (released) return;
    released = true;
    try {
      sourceReader.releaseLock();
    } catch {
      // A pending read releases its lock after cancellation settles.
    }
  };
  const cancel = (reason: unknown): Promise<void> => {
    if (cancellation) return cancellation;
    if (terminal) return Promise.resolve();
    terminal = true;
    cancellation = (async () => {
      let sourceCancellation: Promise<void>;
      try {
        sourceCancellation = sourceReader.cancel(reason);
      } catch {
        sourceCancellation = Promise.resolve();
      }
      try {
        controller?.error(reason);
      } catch {
        // The facade may already have been released by its consumer.
      }
      try {
        await sourceCancellation;
      } catch {
        // Deadline cleanup must not replace its sanitized provider error.
      } finally {
        releaseSourceReader();
      }
    })();
    return cancellation;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(value) {
      if (terminal) return;
      try {
        const read = await sourceReader.read();
        if (terminal) return;
        if (read.done) {
          terminal = true;
          value.close();
          releaseSourceReader();
          return;
        }
        value.enqueue(read.value);
      } catch (error) {
        if (!terminal) {
          terminal = true;
          value.error(error);
        }
        releaseSourceReader();
      }
    },
    cancel,
  });

  return {
    stream,
    cancel,
    dispose: () =>
      cancel(
        new ProviderError(
          "INVALID_INPUT",
          "terminal",
          "Ciphertext stream closed after bounded audio extraction",
        ),
      ),
  };
}

function assertSourceBinding(
  source: RecordingAudioTranscriptionSourceV1,
): void {
  const finalization = source.finalization;
  const manifest = finalization.manifest;
  try {
    validateProofQuestionIntervalsV1({
      intervals: source.questionIntervals,
      expectedQuestionIds: source.proofQuestionIds,
      recordingDurationMs: source.recordingDurationMs,
    });
  } catch {
    throw technicalInputError();
  }
  if (
    manifest.attemptId !== source.attemptId ||
    manifest.headSha !== source.headSha ||
    manifest.durationMs !== source.recordingDurationMs ||
    manifest.totalObjectBytes !== source.recordingCiphertextBytes ||
    manifest.codec !== source.recordingCodec ||
    manifest.wrapping.materialId !== source.materialId ||
    manifest.wrapping.keyId !== source.materialKeyId ||
    finalization.manifestDigest !== source.sourceSha256 ||
    manifest.questionIntervals === undefined ||
    JSON.stringify(manifest.questionIntervals) !==
      JSON.stringify(source.questionIntervals) ||
    Math.abs(manifest.durationMs - source.recordingDurationMs) >
      allowedDurationDriftMs(source.recordingDurationMs)
  ) {
    throw technicalInputError();
  }
}

function validateQuestionResult(
  rawResult: OpenRouterQuestionTranscriptionResultV1,
  interval: ProofQuestionIntervalV1,
  clipSha256: string,
  source: RecordingAudioTranscriptionSourceV1,
  descriptor: QuestionAudioTranscriptionTransport["descriptor"],
): OpenRouterQuestionTranscriptionResultV1 {
  const parsed =
    OpenRouterQuestionTranscriptionResultV1Schema.safeParse(rawResult);
  if (
    !parsed.success ||
    parsed.data.questionId !== interval.questionId ||
    parsed.data.startMs !== interval.startMs ||
    parsed.data.endMs !== interval.endMs ||
    parsed.data.clipSha256 !== clipSha256 ||
    parsed.data.provider !== descriptor.provider ||
    parsed.data.model !== descriptor.model ||
    parsed.data.privacy.zeroDataRetention !== descriptor.zeroDataRetention ||
    parsed.data.text.content.trim().length === 0 ||
    (source.languagePolicy.mode === "fixed" &&
      baseLanguage(parsed.data.language) !==
        baseLanguage(source.languagePolicy.language))
  ) {
    throw reviewOutputError(
      "Question transcript is not bound to its exact stored interval",
    );
  }
  return parsed.data;
}

function assembleTranscript(
  source: RecordingAudioTranscriptionSourceV1,
  results: OpenRouterQuestionTranscriptionResultV1[],
  createdAt: Date,
): TranscriptV1 {
  if (results.length !== source.questionIntervals.length) {
    throw reviewOutputError(
      "Transcription omitted a stored proof question interval",
    );
  }
  const languages = new Set(
    results
      .map((result) => baseLanguage(result.language))
      .filter((language) => language !== "und"),
  );
  const language =
    source.languagePolicy.mode === "fixed"
      ? source.languagePolicy.language
      : languages.size === 1
        ? [...languages][0]
        : "und";
  if (language === undefined) {
    throw reviewOutputError("Transcription did not produce a language");
  }
  const provider = results[0]?.provider;
  const model = results[0]?.model;
  if (
    provider === undefined ||
    model === undefined ||
    results.some(
      (result) => result.provider !== provider || result.model !== model,
    )
  ) {
    throw reviewOutputError(
      "Question transcripts contain contradictory provider metadata",
    );
  }
  return TranscriptV1Schema.parse({
    schemaVersion: "1",
    transcriptVersion: "transcript-v1",
    id: deterministicUuid(
      [
        "recording-transcript-v1",
        source.attemptId,
        source.sourceSha256,
        provider,
        model,
        ...results.map(
          (result) =>
            `${result.questionId}:${result.startMs}:${result.endMs}:${result.clipSha256}`,
        ),
      ].join(":"),
    ),
    attemptId: source.attemptId,
    provider,
    model,
    language,
    durationMs: source.recordingDurationMs,
    sourceSha256: source.sourceSha256,
    segments: results.map((result) => ({
      id: deterministicUuid(
        `transcript-segment-v1:${source.attemptId}:${result.questionId}:${result.startMs}:${result.endMs}:${result.clipSha256}`,
      ),
      questionId: result.questionId,
      startMs: result.startMs,
      endMs: result.endMs,
      speaker: "contributor" as const,
      text: result.text,
    })),
    createdAt,
  });
}

function parseProviderContext(
  rawContext: ProviderContextV1,
  attemptId: string,
  now: Date,
): ProviderContextV1 {
  const parsed = ProviderContextV1Schema.safeParse(rawContext);
  if (!parsed.success || parsed.data.attemptId !== attemptId) {
    throw technicalInputError();
  }
  if (parsed.data.deadlineAt.getTime() <= now.getTime()) {
    assertProviderDeadline(parsed.data, now);
  }
  return parsed.data;
}

function assertProviderDeadline(context: ProviderContextV1, now: Date): void {
  if (context.deadlineAt.getTime() <= now.getTime()) {
    throw transcriptionDeadlineError();
  }
}

function transcriptionDeadlineError(): ProviderError {
  return new ProviderError(
    "DEADLINE_EXCEEDED",
    "retryable",
    "Recording transcription deadline was exceeded",
  );
}

function ffmpegDeadlineError(): ProviderError {
  return new ProviderError(
    "INVALID_INPUT",
    "terminal",
    "FFmpeg audio extraction exceeded its deadline",
  );
}

function assertDecodedPcmDuration(
  pcm: Uint8Array,
  recordingDurationMs: number,
): void {
  if (pcm.byteLength === 0 || pcm.byteLength % PCM_BYTES_PER_SAMPLE !== 0) {
    throw technicalInputError();
  }
  const decodedDurationMs = pcm.byteLength / PCM_BYTES_PER_MILLISECOND;
  if (
    Math.abs(decodedDurationMs - recordingDurationMs) >
    allowedDurationDriftMs(recordingDurationMs)
  ) {
    throw reviewOutputError(
      "Decoded audio duration is empty, truncated or contradictory",
    );
  }
}

function allowedDurationDriftMs(durationMs: number): number {
  return Math.min(
    MAX_DECODE_DURATION_DRIFT_MS,
    Math.max(500, durationMs * 0.1),
  );
}

export function questionWavFromPcm(
  pcm: Uint8Array,
  rawInterval: ProofQuestionIntervalV1,
): Uint8Array<ArrayBuffer> {
  const interval = ProofQuestionIntervalV1Schema.safeParse(rawInterval);
  if (!interval.success) throw technicalInputError();
  const startByte = Math.floor(
    interval.data.startMs * PCM_BYTES_PER_MILLISECOND,
  );
  const requestedEndByte = Math.floor(
    interval.data.endMs * PCM_BYTES_PER_MILLISECOND,
  );
  const alignedPcmBytes =
    pcm.byteLength - (pcm.byteLength % PCM_BYTES_PER_SAMPLE);
  const endByte = clampQuestionClipEndByte(requestedEndByte, alignedPcmBytes);
  const dataBytes = endByte - startByte;
  if (
    startByte < 0 ||
    endByte > alignedPcmBytes ||
    dataBytes <= 0 ||
    dataBytes + WAV_HEADER_BYTES > MAX_QUESTION_AUDIO_BYTES ||
    dataBytes % PCM_BYTES_PER_SAMPLE !== 0
  ) {
    throw reviewOutputError(
      "Stored question interval is not available in decoded audio",
    );
  }
  const wav = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, wav.byteLength - 8, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, PCM_CHANNELS, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(
    28,
    PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE,
    true,
  );
  view.setUint16(32, PCM_CHANNELS * PCM_BYTES_PER_SAMPLE, true);
  view.setUint16(34, PCM_BYTES_PER_SAMPLE * 8, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataBytes, true);
  wav.set(pcm.subarray(startByte, endByte), WAV_HEADER_BYTES);
  return wav;
}

function clampQuestionClipEndByte(
  requestedEndByte: number,
  pcmByteLength: number,
): number {
  if (requestedEndByte <= pcmByteLength) return requestedEndByte;
  const overflowBytes = requestedEndByte - pcmByteLength;
  const overflowMs = overflowBytes / PCM_BYTES_PER_MILLISECOND;
  if (overflowMs > MAX_QUESTION_CLIP_END_CLAMP_MS) return requestedEndByte;
  return pcmByteLength;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of [...value].entries()) {
    bytes[offset + index] = character.charCodeAt(0);
  }
}

export function buildPcmExtractorArguments(): string[] {
  return [
    "-v",
    "error",
    "-nostdin",
    "-cpucount",
    "1",
    "-max_alloc",
    "134217728",
    "-threads",
    "1",
    "-protocol_whitelist",
    "pipe",
    "-probesize",
    "16777216",
    "-analyzeduration",
    "30000000",
    "-i",
    "pipe:0",
    "-map",
    "0:a:0",
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(PCM_SAMPLE_RATE),
    "-ac",
    String(PCM_CHANNELS),
    "-f",
    "s16le",
    "pipe:1",
  ];
}

function startPcmExtractor(
  path: string,
  maximumOutputBytes: number,
  timeoutMs: number,
): AudioExtractorHandle {
  const child = spawn(path, buildPcmExtractorArguments(), {
    stdio: "pipe",
    env: { NODE_ENV: "production", PATH: process.env.PATH ?? "", LANG: "C" },
  });
  const output = new Uint8Array(maximumOutputBytes);
  let total = 0;
  let tooLarge = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (tooLarge) return;
    if (total + chunk.byteLength > maximumOutputBytes) {
      tooLarge = true;
      child.kill("SIGKILL");
      return;
    }
    output.set(chunk, total);
    total += chunk.byteLength;
  });
  child.stderr.resume();
  const result = new Promise<Uint8Array>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      output.fill(0);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || tooLarge || timedOut || total === 0) {
        output.fill(0);
        reject(
          new ProviderError(
            "INVALID_INPUT",
            "terminal",
            timedOut
              ? "FFmpeg audio extraction exceeded its deadline"
              : tooLarge
                ? "Decoded audio exceeded its memory bound"
                : "FFmpeg could not decode the accepted recording profile",
          ),
        );
        return;
      }
      const boundedOutput = output.slice(0, total);
      output.fill(0);
      resolve(boundedOutput);
    });
  });
  return { child, stdin: child.stdin, result };
}

export async function runAudioExtractorPipeline(
  writePlaintext: (
    onPlaintext: (bytes: Uint8Array) => Promise<void>,
  ) => Promise<void>,
  extractor: AudioExtractorHandle,
): Promise<Uint8Array> {
  let acceptingInput = true;
  let stdinError: unknown;
  const onStdinError = (error: unknown) => {
    stdinError ??= error;
    acceptingInput = false;
  };
  extractor.stdin.on("error", onStdinError);
  const extractorOutcome = extractor.result.then(
    (value) => {
      acceptingInput = false;
      return { status: "fulfilled", value } as const;
    },
    (error: unknown) => {
      acceptingInput = false;
      return { status: "rejected", error } as const;
    },
  );
  try {
    await writePlaintext(async (plaintext) => {
      if (!acceptingInput) return;
      try {
        await writeAll(extractor.stdin, plaintext);
      } catch (error) {
        if (!isExpectedClosedDecoderInput(error)) throw error;
        stdinError ??= error;
        acceptingInput = false;
      }
    });
    if (acceptingInput) extractor.stdin.end();
    const outcome = await extractorOutcome;
    if (outcome.status === "rejected") throw outcome.error;
    if (stdinError && !isExpectedClosedDecoderInput(stdinError)) {
      throw stdinError;
    }
    return outcome.value;
  } catch (error) {
    extractor.child.kill("SIGKILL");
    const outcome = await extractorOutcome;
    if (outcome.status === "fulfilled") outcome.value.fill(0);
    throw error;
  } finally {
    extractor.stdin.off("error", onStdinError);
  }
}

function isExpectedClosedDecoderInput(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

async function writeAll(stream: Writable, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw technicalInputError();
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function baseLanguage(value: string): string {
  return value.split("-")[0] ?? value;
}

function technicalInputError(): ProviderError {
  return new ProviderError(
    "INVALID_INPUT",
    "terminal",
    "Recording transcription input failed its authenticated bounded contract",
  );
}

function reviewOutputError(message: string): ProviderError {
  return new ProviderError("INVALID_OUTPUT", "review", message);
}

export type {
  FinalizeRecording,
  RecordingManifest,
  TranscriptionLanguagePolicyV1,
};
