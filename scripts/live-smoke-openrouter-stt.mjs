#!/usr/bin/env node

import {
  assertTranscriptionPayload,
  buildApiUrl,
  createTinyWavFixture,
  requestJsonWithRetry,
  requireSmokeEnvironment,
  runGuardedLiveSmoke,
} from "./lib/live-smoke.mjs";

async function main() {
  const configuration = requireSmokeEnvironment(process.env, {
    TRANSCRIPTION_PROVIDER: "openrouter",
    TRANSCRIPTION_BASE_URL: undefined,
    TRANSCRIPTION_API_KEY: undefined,
    TRANSCRIPTION_MODEL: undefined,
  });
  const endpoint = buildApiUrl(
    configuration.TRANSCRIPTION_BASE_URL,
    "/audio/transcriptions",
  );
  const wav = createTinyWavFixture();

  const payload = await requestJsonWithRetry({
    url: endpoint,
    makeInit: () => {
      const form = new FormData();
      form.append(
        "file",
        new Blob([wav], { type: "audio/wav" }),
        "slopproof-capability-tone.wav",
      );
      form.append("model", configuration.TRANSCRIPTION_MODEL);
      form.append("response_format", "json");
      form.append("language", "en");
      form.append("store", "false");
      return {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${configuration.TRANSCRIPTION_API_KEY}`,
        },
        body: form,
      };
    },
    deadlineMs: 30_000,
    attemptTimeoutMs: 12_000,
  });

  assertTranscriptionPayload(payload);
}

process.exitCode = await runGuardedLiveSmoke({
  name: "openrouter-stt",
  action: main,
});
