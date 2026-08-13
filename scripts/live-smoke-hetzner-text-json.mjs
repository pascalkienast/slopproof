#!/usr/bin/env node

import {
  assertExactObject,
  buildApiUrl,
  extractJsonObject,
  getChatMessageContent,
  LiveSmokeError,
  requestJsonWithRetry,
  requireSmokeEnvironment,
  runGuardedLiveSmoke,
} from "./lib/live-smoke.mjs";

const EXPECTED_TEXT = "SLOPPROOF_TEXT_OK";
const EXPECTED_JSON = Object.freeze({ ok: true });

function chatRequest(endpoint, apiKey, body) {
  return requestJsonWithRetry({
    url: endpoint,
    makeInit: () => ({
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    deadlineMs: 30_000,
    attemptTimeoutMs: 12_000,
  });
}

async function assertTextCapability(configuration, endpoint) {
  const payload = await chatRequest(
    endpoint,
    configuration.GENERATION_API_KEY,
    {
      model: configuration.LEARNING_MODEL,
      store: false,
      temperature: 0,
      // Kimi's reasoning tokens count against this limit. A tiny limit can
      // truncate even the fixed capability marker and create a false-negative
      // smoke result while the endpoint itself is healthy.
      max_tokens: 256,
      messages: [
        {
          role: "system",
          content:
            "This is a fixed capability check. Do not call tools. Follow the exact output contract.",
        },
        {
          role: "user",
          content: `Reply with exactly ${EXPECTED_TEXT} and no other characters.`,
        },
      ],
    },
  );

  if (getChatMessageContent(payload).trim() !== EXPECTED_TEXT) {
    throw new LiveSmokeError("schema_mismatch");
  }
}

function strictJsonBody(configuration, repair) {
  return {
    model: configuration.PROOF_QUESTION_MODEL,
    store: false,
    temperature: 0,
    max_tokens: 256,
    messages: [
      {
        role: "system",
        content:
          "This is a fixed capability check. Never call tools. Return only the requested JSON object.",
      },
      {
        role: "user",
        content: repair
          ? 'Repair attempt: return only the JSON object {"ok":true}. Do not use Markdown.'
          : 'Return the JSON object {"ok":true}. Do not use Markdown.',
      },
    ],
  };
}

async function assertStrictJsonCapability(configuration, endpoint) {
  for (let repair = 0; repair <= 1; repair += 1) {
    const payload = await chatRequest(
      endpoint,
      configuration.GENERATION_API_KEY,
      strictJsonBody(configuration, repair === 1),
    );

    try {
      const content = getChatMessageContent(payload);
      assertExactObject(extractJsonObject(content), EXPECTED_JSON);
      return;
    } catch (error) {
      const repairable =
        error instanceof LiveSmokeError &&
        ["malformed_response", "schema_mismatch"].includes(error.code);
      if (!repairable || repair === 1) throw error;
    }
  }
}

async function main() {
  const configuration = requireSmokeEnvironment(process.env, {
    GENERATION_PROVIDER: "hetzner",
    GENERATION_BASE_URL: undefined,
    GENERATION_API_KEY: undefined,
    LEARNING_MODEL: undefined,
    PROOF_QUESTION_MODEL: undefined,
  });
  const endpoint = buildApiUrl(
    configuration.GENERATION_BASE_URL,
    "/chat/completions",
  );

  await assertTextCapability(configuration, endpoint);
  await assertStrictJsonCapability(configuration, endpoint);
}

process.exitCode = await runGuardedLiveSmoke({
  name: "hetzner-text-json",
  action: main,
});
