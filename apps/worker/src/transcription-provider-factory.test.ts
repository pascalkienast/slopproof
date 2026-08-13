import { describe, expect, it, vi } from "vitest";
import { createTranscriptionPipelineSelection } from "./transcription-provider-factory";

const clock = { now: () => new Date("2026-08-13T00:00:00.000Z") };

describe("transcription provider factory", () => {
  it("keeps the local fake profile fully offline", () => {
    const selected = createTranscriptionPipelineSelection(
      {
        TRANSCRIPTION_PROVIDER: "fake",
        FFMPEG_PATH: "ffmpeg",
      },
      {
        privateKeyPath: "/run/secrets/wrapping.pem",
        storage: { getObjectStream: vi.fn() },
        clock,
      },
    );
    expect(selected.transcriptionProvider).toBeDefined();
    expect(selected.recordingTranscription).toBeUndefined();
  });

  it("selects worker-only OpenRouter recording transcription in production", async () => {
    const getObjectStream = vi.fn(async () =>
      new Blob(["ciphertext"]).stream(),
    );
    const selected = createTranscriptionPipelineSelection(
      {
        TRANSCRIPTION_PROVIDER: "openrouter",
        TRANSCRIPTION_BASE_URL: "https://openrouter.ai/api/v1",
        TRANSCRIPTION_API_KEY: "x".repeat(32),
        TRANSCRIPTION_MODEL: "openai/whisper-large-v3-turbo",
        FFMPEG_PATH: "/usr/bin/ffmpeg",
      },
      {
        privateKeyPath: "/run/secrets/wrapping.pem",
        storage: { getObjectStream },
        clock,
      },
    );
    expect(selected.transcriptionProvider).toBeUndefined();
    expect(selected.recordingTranscription).toBeDefined();
    await selected.recordingTranscription
      ?.ciphertextAccess("private/recording")
      .openCiphertext();
    expect(getObjectStream).toHaveBeenCalledWith("private/recording");
  });

  it("fails closed when OpenRouter fields are absent", () => {
    expect(() =>
      createTranscriptionPipelineSelection(
        {
          TRANSCRIPTION_PROVIDER: "openrouter",
          FFMPEG_PATH: "ffmpeg",
        },
        {
          privateKeyPath: "/run/secrets/wrapping.pem",
          storage: { getObjectStream: vi.fn() },
          clock,
        },
      ),
    ).toThrow("incomplete");
  });
});
