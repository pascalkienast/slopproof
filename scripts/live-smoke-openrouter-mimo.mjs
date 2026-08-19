#!/usr/bin/env node

import {
  assertExactObject,
  buildApiUrl,
  buildOpenRouterMimoCapabilityBody,
  LiveSmokeError,
  requestSseChatWithRetry,
  requireSmokeEnvironment,
  runGuardedLiveSmoke,
} from "./lib/live-smoke.mjs";

const EXPECTED_JSON = Object.freeze({ ok: true });

async function main() {
  const configuration = requireSmokeEnvironment(process.env, {
    GENERATION_PROVIDER: "openrouter",
    GENERATION_BASE_URL: undefined,
    GENERATION_API_KEY: undefined,
    LEARNING_MODEL: undefined,
  });
  const endpoint = buildApiUrl(
    configuration.GENERATION_BASE_URL,
    "/chat/completions",
  );
  const content = await requestSseChatWithRetry({
    url: endpoint,
    makeInit: () => ({
      method: "POST",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${configuration.GENERATION_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        buildOpenRouterMimoCapabilityBody(configuration.LEARNING_MODEL),
      ),
    }),
    deadlineMs: 30_000,
    attemptTimeoutMs: 12_000,
  });

  let parsed;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    throw new LiveSmokeError("malformed_response");
  }
  assertExactObject(parsed, EXPECTED_JSON);
}

process.exitCode = await runGuardedLiveSmoke({
  name: "openrouter-mimo",
  action: main,
});
