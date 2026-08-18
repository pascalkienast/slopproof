import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  OpenRouterTranscriptionProvider,
  type OpenRouterTranscriptionProviderDependencies,
  type QuestionAudioTranscriptionRequestV1,
} from "./openrouter-transcription";
import type { ProviderContextV1 } from "./contracts";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const API_KEY = "openrouter-provider-secret-never-log";
const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const QUESTION_ID = "10000000-0000-4000-8000-000000000002";

describe("OpenRouter transcription provider", () => {
  it("sends a bounded no-store WAV multipart request and returns untrusted text", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      receivedUrl = String(url);
      receivedInit = init;
      return Response.json({
        text: "The route now rejects a stale revision.",
        language: "english",
        duration: 1,
        segments: [{ text: "ignored provider timestamps" }],
      });
    });
    const provider = new OpenRouterTranscriptionProvider(
      configuration("account_enforced"),
      dependencies(fetchImpl),
    );
    const input = request();

    await expect(
      provider.transcribeQuestion(input, context()),
    ).resolves.toMatchObject({
      questionId: QUESTION_ID,
      provider: "openrouter",
      model: "openai/whisper-large-v3-turbo",
      language: "en",
      text: {
        trust: "untrusted",
        source: "transcript",
        content: "The route now rejects a stale revision.",
      },
      privacy: {
        storeRequested: false,
        zeroDataRetention: "account_enforced",
      },
    });
    expect(receivedUrl).toBe(
      "https://openrouter.example.test/api/v1/audio/transcriptions",
    );
    expect(receivedInit).toMatchObject({
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(receivedInit?.headers).toMatchObject({
      accept: "application/json",
      authorization: `Bearer ${API_KEY}`,
    });
    const form = receivedInit?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("missing multipart body");
    expect(form.get("model")).toBe("openai/whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("store")).toBe("false");
    expect(form.get("language")).toBeNull();
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    if (!(file instanceof Blob)) throw new Error("missing WAV body");
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(input.audio.byteLength);
  });

  it.each([
    {
      name: "429",
      first: () => new Response(null, { status: 429 }),
    },
    {
      name: "5xx",
      first: () => new Response(null, { status: 503 }),
    },
    {
      name: "network",
      first: () => Promise.reject(new TypeError("private network detail")),
    },
  ])(
    "retries bounded $name failures with a fresh multipart body",
    async ({ first }) => {
      const bodies: BodyInit[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.body) bodies.push(init.body);
        if (bodies.length === 1) return first();
        return Response.json({ text: "Bound answer", language: "en" });
      });
      const sleep = vi.fn(async () => undefined);
      const provider = new OpenRouterTranscriptionProvider(
        configuration(),
        dependencies(fetchImpl, { sleep }),
      );

      await expect(
        provider.transcribeQuestion(request(), context()),
      ).resolves.toMatchObject({ text: { content: "Bound answer" } });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).not.toBe(bodies[1]);
      for (const body of bodies) {
        expect(body).toBeInstanceOf(FormData);
        const file = (body as FormData).get("file");
        expect(file).toBeInstanceOf(Blob);
      }
      expect((bodies[0] as FormData).get("file")).not.toBe(
        (bodies[1] as FormData).get("file"),
      );
    },
  );

  it.each([400, 401, 403, 408, 422])(
    "does not retry terminal HTTP %s or expose its response body",
    async (status) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(`private transcript ${API_KEY}`, { status }),
        );
      const provider = new OpenRouterTranscriptionProvider(
        configuration(),
        dependencies(fetchImpl),
      );
      let failure: unknown;
      try {
        await provider.transcribeQuestion(request(), context());
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        disposition: "terminal",
      });
      expect(String(failure)).not.toContain(API_KEY);
      expect(String(failure)).not.toContain("private transcript");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("hard-times out a fetch that ignores AbortSignal", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Promise<Response>(() => undefined),
    );
    const provider = new OpenRouterTranscriptionProvider(
      configuration(),
      dependencies(fetchImpl, {
        maxAttempts: 1,
        attemptTimeoutMs: 5,
        now: Date.now,
      }),
    );

    await expect(
      provider.transcribeQuestion(request(), {
        ...context(),
        deadlineAt: new Date(Date.now() + 1_000),
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      disposition: "retryable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After without extending the absolute deadline", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 429, headers: { "retry-after": "60" } }),
      );
    const provider = new OpenRouterTranscriptionProvider(
      configuration(),
      dependencies(fetchImpl, { sleep }),
    );

    await expect(
      provider.transcribeQuestion(request(), context()),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized, empty and fixed-language contradictory success envelopes without retry", async () => {
    const fixtures = [
      new Response("not-json", { status: 200 }),
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(257 * 1_024) },
      }),
      Response.json({ text: "   ", language: "en" }),
      Response.json({ text: "Bound answer", language: "german" }),
      new Response("{}", {
        status: 200,
        headers: { "content-length": "not-a-number" },
      }),
    ];
    for (const response of fixtures) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      const provider = new OpenRouterTranscriptionProvider(
        configuration(),
        dependencies(fetchImpl),
      );
      await expect(
        provider.transcribeQuestion(
          request({ languagePolicy: { mode: "fixed", language: "en" } }),
          context(),
        ),
      ).rejects.toMatchObject({
        code: "INVALID_OUTPUT",
        disposition: "review",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("accepts the documented text-only response and ignores advisory duration drift", async () => {
    const responses = [
      Response.json({ text: "Bound answer", usage: { seconds: 1 } }),
      Response.json({
        text: "Bound answer",
        language: null,
        duration: 99,
      }),
    ];
    for (const response of responses) {
      const provider = new OpenRouterTranscriptionProvider(
        configuration(),
        dependencies(vi.fn<typeof fetch>().mockResolvedValue(response)),
      );
      await expect(
        provider.transcribeQuestion(request(), context()),
      ).resolves.toMatchObject({ language: "und" });
    }
  });

  it("validates the WAV profile, digest, attempt binding and deadline before fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new OpenRouterTranscriptionProvider(
      configuration(),
      dependencies(fetchImpl),
    );
    const invalidWav = request();
    invalidWav.audio[0] = 0;
    await expect(
      provider.transcribeQuestion(invalidWav, context()),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.transcribeQuestion(
        request({ clipSha256: "f".repeat(64) }),
        context(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.transcribeQuestion(request(), {
        ...context(),
        attemptId: "20000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      provider.transcribeQuestion(request(), {
        ...context(),
        deadlineAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes a fixed language policy in multipart and normalizes provider language names", async () => {
    let form: FormData | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.body instanceof FormData) form = init.body;
      return Response.json({
        text: "Die Route lehnt stale Daten ab.",
        language: "German",
      });
    });
    const provider = new OpenRouterTranscriptionProvider(
      configuration(),
      dependencies(fetchImpl),
    );

    await expect(
      provider.transcribeQuestion(
        request({ languagePolicy: { mode: "fixed", language: "de" } }),
        context(),
      ),
    ).resolves.toMatchObject({ language: "de" });
    expect(form?.get("language")).toBe("de");
  });
});

function configuration(
  zeroDataRetention: "account_enforced" | "not_verified" = "not_verified",
) {
  return {
    baseUrl: "https://openrouter.example.test/api/v1",
    apiKey: API_KEY,
    model: "openai/whisper-large-v3-turbo",
    zeroDataRetention,
  };
}

function dependencies(
  fetchImpl: typeof fetch,
  policy: NonNullable<
    OpenRouterTranscriptionProviderDependencies["policy"]
  > = {},
): OpenRouterTranscriptionProviderDependencies {
  return {
    fetchImpl,
    policy: {
      maxAttempts: 3,
      attemptTimeoutMs: 100,
      now: () => NOW.getTime(),
      random: () => 0,
      sleep: async () => undefined,
      ...policy,
    },
  };
}

function context(): ProviderContextV1 {
  return {
    schemaVersion: "1",
    requestId: "10000000-0000-4000-8000-000000000003",
    attemptId: ATTEMPT_ID,
    deadlineAt: new Date(NOW.getTime() + 30_000),
  };
}

function request(
  overrides: Partial<QuestionAudioTranscriptionRequestV1> = {},
): QuestionAudioTranscriptionRequestV1 {
  const audio = overrides.audio ?? wav(1_000);
  return {
    schemaVersion: "1",
    requestVersion: "question-audio-transcription-v1",
    attemptId: ATTEMPT_ID,
    questionId: QUESTION_ID,
    sourceSha256: "a".repeat(64),
    clipSha256: sha256(audio),
    startMs: 0,
    endMs: 1_000,
    languagePolicy: { mode: "detect" },
    audio,
    ...overrides,
  };
}

function wav(durationMs: number): Uint8Array<ArrayBuffer> {
  const dataBytes = durationMs * 32;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of [...value].entries()) {
    bytes[offset + index] = character.charCodeAt(0);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
