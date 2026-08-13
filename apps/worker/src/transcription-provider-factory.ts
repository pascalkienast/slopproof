import type { WorkerConfig } from "@slopproof/config";
import {
  LocalFakeTranscriptionProvider,
  OpenRouterTranscriptionProvider,
  type ProviderClock,
} from "@slopproof/providers";
import type { S3EvidenceStore } from "@slopproof/storage";
import { EncryptedRecordingAudioTranscriptionAdapter } from "./audio-transcription";
import type { ProviderPipelineDependencies } from "./provider-pipeline";

type TranscriptionPipelineSelection = Pick<
  ProviderPipelineDependencies,
  "transcriptionProvider" | "recordingTranscription"
>;

export function createTranscriptionPipelineSelection(
  config: Pick<
    WorkerConfig,
    | "TRANSCRIPTION_PROVIDER"
    | "TRANSCRIPTION_BASE_URL"
    | "TRANSCRIPTION_API_KEY"
    | "TRANSCRIPTION_MODEL"
    | "FFMPEG_PATH"
  >,
  dependencies: {
    privateKeyPath: string;
    storage: Pick<S3EvidenceStore, "getObjectStream">;
    clock: ProviderClock;
  },
): TranscriptionPipelineSelection {
  if (config.TRANSCRIPTION_PROVIDER === "fake") {
    return {
      transcriptionProvider: new LocalFakeTranscriptionProvider(
        dependencies.clock,
      ),
    };
  }
  if (
    config.TRANSCRIPTION_BASE_URL === undefined ||
    config.TRANSCRIPTION_API_KEY === undefined ||
    config.TRANSCRIPTION_MODEL === undefined
  ) {
    throw new Error("OpenRouter transcription configuration is incomplete");
  }
  const provider = new OpenRouterTranscriptionProvider({
    baseUrl: config.TRANSCRIPTION_BASE_URL,
    apiKey: config.TRANSCRIPTION_API_KEY,
    model: config.TRANSCRIPTION_MODEL,
    // OpenRouter ZDR is account/key dependent. `store=false` is requested by
    // the adapter, but this build does not claim an unverified account policy.
    zeroDataRetention: "not_verified",
  });
  return {
    recordingTranscription: {
      adapter: new EncryptedRecordingAudioTranscriptionAdapter({
        privateKeyPath: dependencies.privateKeyPath,
        ffmpegPath: config.FFMPEG_PATH,
        provider,
        now: dependencies.clock.now,
      }),
      ciphertextAccess: (objectKey) => ({
        openCiphertext: () => dependencies.storage.getObjectStream(objectKey),
      }),
    },
  };
}
