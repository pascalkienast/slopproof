import { PassThrough } from "node:stream";
import {
  buildChunkNonce,
  encodeBase64Url,
  RECORD_HEADER_BYTES,
  type FinalizeRecording,
} from "@slopproof/media";
import {
  ProviderError,
  type OpenRouterQuestionTranscriptionResultV1,
  type QuestionAudioTranscriptionRequestV1,
} from "@slopproof/providers";
import { describe, expect, it, vi } from "vitest";
import {
  EncryptedRecordingAudioTranscriptionAdapter,
  buildPcmExtractorArguments,
  questionWavFromPcm,
  runAudioExtractorPipeline,
  type AudioExtractorHandle,
  type QuestionAudioTranscriptionTransport,
  type RecordingAudioTranscriptionDependencies,
  type RecordingAudioTranscriptionSourceV1,
} from "./audio-transcription";
import type {
  authenticateRecordingFinalization,
  streamDecryptedRecording,
} from "./recording-reader";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const RECORDING_OBJECT_ID = "10000000-0000-4000-8000-000000000002";
const MATERIAL_ID = "10000000-0000-4000-8000-000000000003";
const QUESTION_ONE = "10000000-0000-4000-8000-000000000004";
const QUESTION_TWO = "10000000-0000-4000-8000-000000000005";
const REQUEST_ID = "10000000-0000-4000-8000-000000000006";
const HEAD_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(64);
const MODEL = "openai/whisper-large-v3-turbo";

describe("worker-only recording audio transcription", () => {
  it("authenticates and pipes recording plaintext once, then transcribes exact server intervals", async () => {
    const fixture = await dependencies();
    const source = recordingSource();
    const transcript = await fixture.adapter.transcribe(
      source,
      {
        openCiphertext: vi.fn(async () =>
          new Blob([new Uint8Array([7, 8, 9])]).stream(),
        ),
      },
      providerContext(),
    );

    expect(fixture.authenticateRecording).toHaveBeenCalledWith(
      source.finalization,
      { materialId: MATERIAL_ID, keyId: "recording-key-v1" },
      "/run/secrets/wrapping-private.pem",
    );
    expect(fixture.streamRecording).toHaveBeenCalledTimes(1);
    expect(fixture.startAudioExtractor).toHaveBeenCalledWith(
      "/usr/bin/ffmpeg",
      112_000,
      60_000,
    );
    expect(fixture.ffmpegInput.toString("utf8")).toBe(
      "authenticated-webm-plaintext",
    );
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.map((request) => request.questionId)).toEqual([
      QUESTION_ONE,
      QUESTION_TWO,
    ]);
    expect(
      fixture.requests.map((request) => [request.startMs, request.endMs]),
    ).toEqual([
      [0, 1_000],
      [1_000, 2_000],
    ]);
    expect(fixture.requests.map((request) => request.audio.byteLength)).toEqual(
      [32_044, 32_044],
    );
    for (const request of fixture.requests) {
      expect(ascii(request.audio, 0, 4)).toBe("RIFF");
      expect(ascii(request.audio, 8, 4)).toBe("WAVE");
      expect(request.audio.every((byte) => byte === 0)).toBe(false);
    }
    expect(fixture.providerContexts).toHaveLength(2);
    expect(fixture.providerContexts[0]?.requestId).not.toBe(REQUEST_ID);
    expect(fixture.providerContexts[0]?.requestId).not.toBe(
      fixture.providerContexts[1]?.requestId,
    );
    expect(transcript).toMatchObject({
      schemaVersion: "1",
      transcriptVersion: "transcript-v1",
      attemptId: ATTEMPT_ID,
      provider: "openrouter",
      model: MODEL,
      language: "en",
      durationMs: 2_000,
      sourceSha256: SOURCE_SHA,
      createdAt: NOW,
      segments: [
        {
          questionId: QUESTION_ONE,
          startMs: 0,
          endMs: 1_000,
          speaker: "contributor",
          text: { trust: "untrusted", source: "transcript" },
        },
        {
          questionId: QUESTION_TWO,
          startMs: 1_000,
          endMs: 2_000,
          speaker: "contributor",
          text: { trust: "untrusted", source: "transcript" },
        },
      ],
    });
    expect(transcript.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(transcript.segments[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects missing, duplicate, unordered, overlapping and duration-unbound intervals before decryption", async () => {
    const invalidSources: RecordingAudioTranscriptionSourceV1[] = [
      recordingSource({ questionIntervals: [] }),
      recordingSource({
        questionIntervals: [
          interval(QUESTION_ONE, 0, 0, 1_000),
          interval(QUESTION_ONE, 1, 1_000, 2_000),
        ],
      }),
      recordingSource({
        questionIntervals: [interval(QUESTION_ONE, 1, 0, 1_000)],
      }),
      recordingSource({
        questionIntervals: [
          interval(QUESTION_ONE, 0, 0, 1_200),
          interval(QUESTION_TWO, 1, 1_000, 2_000),
        ],
      }),
      recordingSource({
        questionIntervals: [
          { ...interval(QUESTION_ONE, 0, 0, 1_000), recordedDurationMs: 1_999 },
        ],
      }),
      recordingSource({ proofQuestionIds: [QUESTION_ONE] }),
    ];
    for (const source of invalidSources) {
      const fixture = await dependencies();
      await expect(
        fixture.adapter.transcribe(
          source,
          ciphertextAccess(),
          providerContext(),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        disposition: "terminal",
      });
      expect(fixture.authenticateRecording).not.toHaveBeenCalled();
      expect(fixture.provider.transcribeQuestion).not.toHaveBeenCalled();
    }
  });

  it("rejects manifest, source hash, media profile and attempt/deadline mismatches before plaintext access", async () => {
    const invalidSources: RecordingAudioTranscriptionSourceV1[] = [
      recordingSource({ headSha: "c".repeat(40) }),
      recordingSource({ sourceSha256: "d".repeat(64) }),
      recordingSource({ recordingDurationMs: 1_999 }),
      recordingSource({ recordingCiphertextBytes: 149 }),
    ];
    for (const source of invalidSources) {
      const fixture = await dependencies();
      await expect(
        fixture.adapter.transcribe(
          source,
          ciphertextAccess(),
          providerContext(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(fixture.authenticateRecording).not.toHaveBeenCalled();
    }

    const fixture = await dependencies();
    await expect(
      fixture.adapter.transcribe(recordingSource(), ciphertextAccess(), {
        ...providerContext(),
        attemptId: "20000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const expiredAccess = ciphertextAccess();
    await expect(
      fixture.adapter.transcribe(recordingSource(), expiredAccess, {
        ...providerContext(),
        deadlineAt: NOW,
      }),
    ).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
      disposition: "retryable",
    });
    expect(fixture.authenticateRecording).not.toHaveBeenCalled();
    expect(expiredAccess.openCiphertext).not.toHaveBeenCalled();
    expect(fixture.startAudioExtractor).not.toHaveBeenCalled();
    expect(fixture.streamRecording).not.toHaveBeenCalled();
    expect(fixture.provider.transcribeQuestion).not.toHaveBeenCalled();
  });

  it("cancels extraction and wipes plaintext when it crosses the retention deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      let signalStreamingStarted: (() => void) | undefined;
      const streamingStarted = new Promise<void>((resolve) => {
        signalStreamingStarted = resolve;
      });
      let retainedPlaintext: Uint8Array | undefined;
      const pcm = patternedPcm(2_000);
      const stdin = new PassThrough();
      stdin.resume();
      let resolveExtractor: ((value: Uint8Array) => void) | undefined;
      const kill = vi.fn(() => {
        resolveExtractor?.(pcm);
        return true;
      });
      const startAudioExtractor = () => ({
        child: { kill },
        stdin,
        result: new Promise<Uint8Array>((resolve) => {
          resolveExtractor = resolve;
        }),
      });
      const fixture = await dependencies({
        now: () => new Date(Date.now()),
        streamRecording: async (stream, _manifest, _key, onPlaintext) => {
          const reader = stream.getReader();
          const plaintext = new Uint8Array([91, 92, 93, 94]);
          retainedPlaintext = plaintext;
          try {
            await onPlaintext(plaintext);
            signalStreamingStarted?.();
            await reader.read();
          } finally {
            plaintext.fill(0);
            reader.releaseLock();
          }
        },
        startAudioExtractor,
      });
      const cancelCiphertext = vi.fn();
      const access = {
        openCiphertext: vi.fn(
          async () =>
            new ReadableStream<Uint8Array>({
              pull() {
                // Keep the authenticated ciphertext read pending at deadline.
              },
              cancel: cancelCiphertext,
            }),
        ),
      };
      const context = {
        ...providerContext(),
        deadlineAt: new Date(NOW.getTime() + 50),
      };
      const operation = fixture.adapter.transcribe(
        recordingSource(),
        access,
        context,
      );
      const rejected = expect(operation).rejects.toMatchObject({
        code: "DEADLINE_EXCEEDED",
        disposition: "retryable",
      });

      await streamingStarted;
      expect(fixture.startAudioExtractor).toHaveBeenCalledWith(
        "/usr/bin/ffmpeg",
        112_000,
        50,
      );
      await vi.advanceTimersByTimeAsync(50);
      await rejected;

      expect(access.openCiphertext).toHaveBeenCalledTimes(1);
      expect(cancelCiphertext).toHaveBeenCalledTimes(1);
      expect(cancelCiphertext.mock.calls[0]?.[0]).toMatchObject({
        code: "DEADLINE_EXCEEDED",
      });
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(retainedPlaintext?.every((byte) => byte === 0)).toBe(true);
      expect(pcm.every((byte) => byte === 0)).toBe(true);
      expect(fixture.provider.transcribeQuestion).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects intervals that differ from the authenticated manifest before any plaintext access", async () => {
    const fixture = await dependencies();
    const source = recordingSource();
    const altered = {
      ...source,
      questionIntervals: [
        { ...source.questionIntervals[0]!, endMs: 999 },
        { ...source.questionIntervals[1]!, startMs: 999 },
      ],
    };
    const access = ciphertextAccess();

    await expect(
      fixture.adapter.transcribe(altered, access, providerContext()),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      disposition: "terminal",
    });
    expect(fixture.authenticateRecording).not.toHaveBeenCalled();
    expect(fixture.startAudioExtractor).not.toHaveBeenCalled();
    expect(fixture.provider.transcribeQuestion).not.toHaveBeenCalled();
  });

  it("routes empty, truncated or interval-incomplete decoded audio to review", async () => {
    for (const pcm of [new Uint8Array(0), new Uint8Array(32 * 100)]) {
      const fixture = await dependencies({ pcm });
      await expect(
        fixture.adapter.transcribe(
          recordingSource(),
          ciphertextAccess(),
          providerContext(),
        ),
      ).rejects.toMatchObject({
        code: pcm.byteLength === 0 ? "INVALID_INPUT" : "INVALID_OUTPUT",
        disposition: pcm.byteLength === 0 ? "terminal" : "review",
      });
      expect(fixture.provider.transcribeQuestion).not.toHaveBeenCalled();
    }

    const intervalMissing = await dependencies({
      pcm: new Uint8Array(32 * 1_700),
    });
    await expect(
      intervalMissing.adapter.transcribe(
        recordingSource(),
        ciphertextAccess(),
        providerContext(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_OUTPUT", disposition: "review" });
    expect(intervalMissing.provider.transcribeQuestion).toHaveBeenCalledTimes(
      1,
    );
  });

  it("rejects provider question, model, text and language contradictions as review", async () => {
    const mutations: Array<
      (value: OpenRouterQuestionTranscriptionResultV1) => unknown
    > = [
      (value) => ({ ...value, questionId: QUESTION_TWO }),
      (value) => ({ ...value, model: "different-model" }),
      (value) => ({
        ...value,
        text: { ...value.text, content: " " },
      }),
      (value) => ({ ...value, language: "de" }),
      (value) => ({
        ...value,
        privacy: { ...value.privacy, zeroDataRetention: "account_enforced" },
      }),
    ];
    for (const mutate of mutations) {
      const fixture = await dependencies({
        mutateProviderResult: mutate,
      });
      await expect(
        fixture.adapter.transcribe(
          recordingSource({
            languagePolicy: { mode: "fixed", language: "en" },
          }),
          ciphertextAccess(),
          providerContext(),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_OUTPUT",
        disposition: "review",
      });
    }
  });

  it("marks mixed per-question detected languages as undetermined and propagates technical provider retries", async () => {
    let call = 0;
    const contradictory = await dependencies({
      mutateProviderResult(value) {
        call += 1;
        return call === 2 ? { ...value, language: "de" } : value;
      },
    });
    await expect(
      contradictory.adapter.transcribe(
        recordingSource(),
        ciphertextAccess(),
        providerContext(),
      ),
    ).resolves.toMatchObject({ language: "und" });

    const retry = new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "retryable",
      "Provider unavailable without private content",
    );
    const unavailable = await dependencies({ providerFailure: retry });
    await expect(
      unavailable.adapter.transcribe(
        recordingSource(),
        ciphertextAccess(),
        providerContext(),
      ),
    ).rejects.toBe(retry);
  });
});

describe("bounded FFmpeg audio pipeline", () => {
  it("uses stdin/stdout pipes with a single mono 16 kHz PCM profile", () => {
    const args = buildPcmExtractorArguments();
    expect(args).toEqual(
      expect.arrayContaining([
        "-i",
        "pipe:0",
        "-map",
        "0:a:0",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ]),
    );
    expect(args.join(" ")).not.toMatch(/(?:\/tmp|\.wav|\.webm)/u);
  });

  it("pipes every authenticated chunk and returns the bounded extractor output", async () => {
    const stdin = new PassThrough();
    const inputChunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => inputChunks.push(Buffer.from(chunk)));
    const kill = vi.fn();
    const result = new Uint8Array([1, 2, 3, 4]);
    const extractorResult = new Promise<Uint8Array>((resolve) => {
      stdin.once("finish", () => resolve(result));
    });

    await expect(
      runAudioExtractorPipeline(
        async (write) => {
          await write(new Uint8Array([5, 6]));
          await write(new Uint8Array([7, 8]));
        },
        { child: { kill }, stdin, result: extractorResult },
      ),
    ).resolves.toBe(result);
    expect(Buffer.concat(inputChunks)).toEqual(Buffer.from([5, 6, 7, 8]));
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills FFmpeg and observes its rejection when authenticated streaming fails", async () => {
    const stdin = new PassThrough();
    const kill = vi.fn();
    let rejectExtractor: ((error: Error) => void) | undefined;
    const result = new Promise<Uint8Array>((_resolve, reject) => {
      rejectExtractor = reject;
    });
    kill.mockImplementation(() => {
      rejectExtractor?.(new Error("decoder stopped"));
      return true;
    });
    const streamFailure = new Error("ciphertext authentication failed");
    await expect(
      runAudioExtractorPipeline(
        async () => {
          throw streamFailure;
        },
        { child: { kill }, stdin, result },
      ),
    ).rejects.toBe(streamFailure);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("continues authenticating after a successful decoder closes input early", async () => {
    const stdin = new PassThrough();
    const inputChunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => inputChunks.push(Buffer.from(chunk)));
    const kill = vi.fn();
    const extracted = new Uint8Array([9, 8, 7, 6]);
    let resolveExtractor: ((value: Uint8Array) => void) | undefined;
    const result = new Promise<Uint8Array>((resolve) => {
      resolveExtractor = resolve;
    });
    let authenticatedChunks = 0;

    await expect(
      runAudioExtractorPipeline(
        async (write) => {
          authenticatedChunks += 1;
          await write(new Uint8Array([1, 2]));
          resolveExtractor?.(extracted);
          await Promise.resolve();
          authenticatedChunks += 1;
          await write(new Uint8Array([3, 4]));
        },
        { child: { kill }, stdin, result },
      ),
    ).resolves.toBe(extracted);
    expect(authenticatedChunks).toBe(2);
    expect(Buffer.concat(inputChunks)).toEqual(Buffer.from([1, 2]));
    expect(kill).not.toHaveBeenCalled();
  });

  it("builds canonical bounded WAV clips from exact PCM intervals", () => {
    const pcm = new Uint8Array(32 * 2_000);
    pcm.fill(1, 0, 32 * 1_000);
    pcm.fill(2, 32 * 1_000);
    const first = questionWavFromPcm(pcm, interval(QUESTION_ONE, 0, 0, 1_000));
    const second = questionWavFromPcm(
      pcm,
      interval(QUESTION_TWO, 1, 1_000, 2_000),
    );
    expect(first.byteLength).toBe(32_044);
    expect(second.byteLength).toBe(32_044);
    expect(ascii(first, 0, 4)).toBe("RIFF");
    expect(ascii(first, 8, 4)).toBe("WAVE");
    expect(new DataView(first.buffer).getUint32(40, true)).toBe(32_000);
    expect(first[44]).toBe(1);
    expect(second[44]).toBe(2);
  });

  it("clamps a 12ms last-question tail that overruns decoded PCM", () => {
    const pcm = patternedPcm(1_988);
    const wav = questionWavFromPcm(
      pcm,
      interval(QUESTION_TWO, 1, 1_000, 2_000),
    );
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(988 * 32);
    expect(wav.subarray(44)).toEqual(pcm.subarray(1_000 * 32));
  });

  it("still rejects a last-question tail that overruns decoded PCM by more than 250ms", () => {
    expect(() =>
      questionWavFromPcm(
        patternedPcm(1_700),
        interval(QUESTION_TWO, 1, 1_000, 2_000),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OUTPUT",
        disposition: "review",
      }),
    );
  });

  it("transcribes when the last stored interval ends 12ms after decoded audio", async () => {
    const fixture = await dependencies({ pcm: patternedPcm(1_988) });
    const transcript = await fixture.adapter.transcribe(
      recordingSource(),
      ciphertextAccess(),
      providerContext(),
    );
    expect(fixture.provider.transcribeQuestion).toHaveBeenCalledTimes(2);
    expect(
      fixture.requests.map((request) => [request.startMs, request.endMs]),
    ).toEqual([
      [0, 1_000],
      [1_000, 2_000],
    ]);
    expect(fixture.requests[1]?.audio.byteLength).toBe(44 + 988 * 32);
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.durationMs).toBe(2_000);
  });
});

type DependencyOptions = {
  pcm?: Uint8Array;
  now?: () => Date;
  streamRecording?: typeof streamDecryptedRecording;
  startAudioExtractor?: RecordingAudioTranscriptionDependencies["startAudioExtractor"];
  mutateProviderResult?: (
    value: OpenRouterQuestionTranscriptionResultV1,
  ) => unknown;
  providerFailure?: Error;
};

async function dependencies(options: DependencyOptions = {}) {
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const authenticateRecording = vi.fn<typeof authenticateRecordingFinalization>(
    async () => encryptionKey,
  );
  const streamRecording = vi.fn<typeof streamDecryptedRecording>(
    options.streamRecording ??
      (async (_stream, _manifest, _key, onPlaintext) => {
        const plaintext = new TextEncoder().encode(
          "authenticated-webm-plaintext",
        );
        try {
          await onPlaintext(plaintext);
        } finally {
          plaintext.fill(0);
        }
      }),
  );
  const stdin = new PassThrough();
  const ffmpegChunks: Buffer[] = [];
  stdin.on("data", (chunk: Buffer) => ffmpegChunks.push(Buffer.from(chunk)));
  const pcm = options.pcm ?? patternedPcm(2_000);
  const startAudioExtractor = vi.fn(
    options.startAudioExtractor ??
      ((): AudioExtractorHandle => {
        const result = new Promise<Uint8Array>((resolve) => {
          stdin.once("finish", () => resolve(pcm));
        });
        return {
          child: { kill: vi.fn(() => true) },
          stdin,
          result,
        };
      }),
  );
  const requests: QuestionAudioTranscriptionRequestV1[] = [];
  const providerContexts: Array<{ requestId: string }> = [];
  const provider: QuestionAudioTranscriptionTransport = {
    descriptor: {
      provider: "openrouter",
      model: MODEL,
      zeroDataRetention: "not_verified",
    },
    transcribeQuestion: vi.fn(async (request, context) => {
      if (options.providerFailure) throw options.providerFailure;
      requests.push({ ...request, audio: request.audio.slice() });
      providerContexts.push({ requestId: context.requestId });
      const value: OpenRouterQuestionTranscriptionResultV1 = {
        schemaVersion: "1",
        resultVersion: "question-transcription-result-v1",
        questionId: request.questionId,
        clipSha256: request.clipSha256,
        startMs: request.startMs,
        endMs: request.endMs,
        provider: "openrouter",
        model: MODEL,
        language: "en",
        text: {
          trust: "untrusted",
          source: "transcript",
          content: `Answer for question ${request.questionId}`,
        },
        privacy: {
          storeRequested: false,
          zeroDataRetention: "not_verified",
        },
      };
      return (options.mutateProviderResult?.(value) ??
        value) as OpenRouterQuestionTranscriptionResultV1;
    }),
  };
  const deps: RecordingAudioTranscriptionDependencies = {
    privateKeyPath: "/run/secrets/wrapping-private.pem",
    ffmpegPath: "/usr/bin/ffmpeg",
    provider,
    now: options.now ?? (() => NOW),
    authenticateRecording,
    streamRecording,
    startAudioExtractor,
  };
  return {
    adapter: new EncryptedRecordingAudioTranscriptionAdapter(deps),
    provider,
    authenticateRecording,
    streamRecording,
    startAudioExtractor,
    requests,
    providerContexts,
    get ffmpegInput() {
      return Buffer.concat(ffmpegChunks);
    },
  };
}

function recordingSource(
  overrides: Partial<RecordingAudioTranscriptionSourceV1> = {},
): RecordingAudioTranscriptionSourceV1 {
  return {
    schemaVersion: "1",
    sourceVersion: "recording-audio-source-v1",
    attemptId: ATTEMPT_ID,
    recordingObjectId: RECORDING_OBJECT_ID,
    headSha: HEAD_SHA,
    sourceSha256: SOURCE_SHA,
    recordingDurationMs: 2_000,
    recordingCiphertextBytes: 148,
    recordingCodec: "video/webm;codecs=vp8,opus",
    materialId: MATERIAL_ID,
    materialKeyId: "recording-key-v1",
    finalization: finalization(),
    proofQuestionIds: [QUESTION_ONE, QUESTION_TWO],
    questionIntervals: [
      interval(QUESTION_ONE, 0, 0, 1_000),
      interval(QUESTION_TWO, 1, 1_000, 2_000),
    ],
    languagePolicy: { mode: "detect" },
    ...overrides,
  };
}

function interval(
  questionId: string,
  ordinal: number,
  startMs: number,
  endMs: number,
) {
  return {
    schemaVersion: "1" as const,
    intervalVersion: "proof-question-interval-v1" as const,
    questionId,
    ordinal,
    startMs,
    endMs,
    recordedDurationMs: 2_000,
    source: "mobile_navigation_v1" as const,
  };
}

function finalization(): FinalizeRecording {
  const noncePrefix = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const plaintextBytes = 100;
  const sealedBytes = plaintextBytes + 16;
  const totalObjectBytes = RECORD_HEADER_BYTES + sealedBytes;
  return {
    manifest: {
      protocolVersion: 1,
      suiteId: "SP-RC1",
      attemptId: ATTEMPT_ID,
      headSha: HEAD_SHA,
      objectId: "10000000-0000-4000-8000-000000000007",
      codec: "video/webm;codecs=vp8,opus",
      noncePrefixBase64url: encodeBase64Url(noncePrefix),
      wrapping: {
        materialId: MATERIAL_ID,
        keyId: "recording-key-v1",
        algorithm: "RSA-OAEP-256",
        wrappedKeySha256: "c".repeat(64),
      },
      durationMs: 2_000,
      totalPlaintextBytes: plaintextBytes,
      totalObjectBytes,
      questionIntervals: [
        interval(QUESTION_ONE, 0, 0, 1_000),
        interval(QUESTION_TWO, 1, 1_000, 2_000),
      ],
      chunks: [
        {
          index: 0,
          nonce: encodeBase64Url(buildChunkNonce(noncePrefix, 0)),
          plaintextBytes,
          sealedBytes,
          ciphertextSha256: "d".repeat(64),
        },
      ],
      parts: [
        {
          partNumber: 1,
          firstChunkIndex: 0,
          lastChunkIndex: 0,
          byteLength: totalObjectBytes,
          sha256: "e".repeat(64),
        },
      ],
    },
    manifestTagBase64url: encodeBase64Url(new Uint8Array(32)),
    manifestDigest: SOURCE_SHA,
    wrappedKey: {
      materialId: MATERIAL_ID,
      keyId: "recording-key-v1",
      algorithm: "RSA-OAEP-256",
      wrappedKeyBase64url: encodeBase64Url(new Uint8Array([1, 2, 3])),
      wrappedKeySha256: "c".repeat(64),
    },
    uploadedParts: [{ partNumber: 1, etag: '"etag"' }],
  };
}

function providerContext() {
  return {
    schemaVersion: "1" as const,
    requestId: REQUEST_ID,
    attemptId: ATTEMPT_ID,
    deadlineAt: new Date(NOW.getTime() + 60_000),
  };
}

function ciphertextAccess() {
  return {
    openCiphertext: vi.fn(async () => new Blob([new Uint8Array([1])]).stream()),
  };
}

function patternedPcm(durationMs: number): Uint8Array<ArrayBuffer> {
  const pcm = new Uint8Array(durationMs * 32);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = (index % 251) + 1;
  }
  return pcm;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
