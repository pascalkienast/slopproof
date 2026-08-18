import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactObject,
  assertTranscriptionPayload,
  buildApiUrl,
  buildOpenRouterMimoCapabilityBody,
  createTinyWavFixture,
  extractJsonObject,
  getChatMessageContent,
  isLiveSmokeEnabled,
  LiveSmokeError,
  readBoundedSseChatContent,
  requestJsonWithRetry,
  requestSseChatWithRetry,
  requireSmokeEnvironment,
  runGuardedLiveSmoke,
} from "./live-smoke.mjs";

test("live smoke requires the exact opt-in value", () => {
  assert.equal(isLiveSmokeEnabled({ LIVE_SMOKE: "1" }), true);
  for (const value of [undefined, "", "true", "yes", " 1", "1 "]) {
    assert.equal(isLiveSmokeEnabled({ LIVE_SMOKE: value }), false);
  }
});

test("environment validation returns canonical values without leaking them", () => {
  const secret = "do-not-print-this-secret";
  const values = requireSmokeEnvironment(
    { GENERATION_PROVIDER: "hetzner", GENERATION_API_KEY: secret },
    { GENERATION_PROVIDER: "hetzner", GENERATION_API_KEY: undefined },
  );
  assert.equal(values.GENERATION_API_KEY, secret);

  assert.throws(
    () =>
      requireSmokeEnvironment(
        { GENERATION_PROVIDER: "wrong", GENERATION_API_KEY: secret },
        { GENERATION_PROVIDER: "hetzner", GENERATION_API_KEY: undefined },
      ),
    (error) => {
      assert.ok(error instanceof LiveSmokeError);
      assert.equal(error.code, "invalid_environment");
      assert.deepEqual(error.fields, ["GENERATION_PROVIDER"]);
      assert.equal(String(error).includes(secret), false);
      return true;
    },
  );

  const openrouter = requireSmokeEnvironment(
    {
      GENERATION_PROVIDER: "openrouter",
      GENERATION_BASE_URL: "https://openrouter.example/api/v1",
      GENERATION_API_KEY: secret,
      LEARNING_MODEL: "configured-generation-model",
    },
    {
      GENERATION_PROVIDER: "openrouter",
      GENERATION_BASE_URL: undefined,
      GENERATION_API_KEY: undefined,
      LEARNING_MODEL: undefined,
    },
  );
  assert.equal(openrouter.LEARNING_MODEL, "configured-generation-model");
  assert.throws(
    () =>
      requireSmokeEnvironment(
        { GENERATION_PROVIDER: "hetzner", GENERATION_API_KEY: secret },
        { GENERATION_PROVIDER: "openrouter", GENERATION_API_KEY: undefined },
      ),
    (error) =>
      error instanceof LiveSmokeError &&
      error.code === "invalid_environment" &&
      error.fields.join() === "GENERATION_PROVIDER" &&
      String(error).includes(secret) === false,
  );
});

test("API URLs are HTTPS-only and retain the configured base path", () => {
  assert.equal(
    buildApiUrl("https://provider.example/api/v1/", "/chat/completions"),
    "https://provider.example/api/v1/chat/completions",
  );
  assert.throws(
    () => buildApiUrl("http://provider.example/api/v1", "/models"),
    LiveSmokeError,
  );
  assert.throws(
    () => buildApiUrl("https://user@provider.example/api/v1", "/models"),
    LiveSmokeError,
  );
});

test("model JSON extraction is defensive and exact validation rejects extras", () => {
  assert.deepEqual(extractJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), {
    ok: true,
  });
  assert.deepEqual(
    extractJsonObject('Result: {"ok":true,"note":"a } brace"} done'),
    { ok: true, note: "a } brace" },
  );
  assert.deepEqual(assertExactObject({ ok: true }, { ok: true }), { ok: true });
  assert.throws(
    () => assertExactObject({ ok: true, extra: true }, { ok: true }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "schema_mismatch",
  );
  assert.throws(
    () => extractJsonObject("no object"),
    (error) =>
      error instanceof LiveSmokeError && error.code === "malformed_response",
  );
});

test("provider payload boundary accepts only bounded expected shapes", () => {
  assert.equal(
    getChatMessageContent({ choices: [{ message: { content: "ok" } }] }),
    "ok",
  );
  assert.equal(assertTranscriptionPayload({ text: "" }).text, "");
  assert.throws(() => getChatMessageContent({ choices: [] }), LiveSmokeError);
  assert.throws(
    () => assertTranscriptionPayload({ text: null }),
    LiveSmokeError,
  );
});

test("request helper retries only retryable statuses and rebuilds the request", async () => {
  const statuses = [429, 503, 200];
  const delays = [];
  let initCount = 0;
  let fetchCount = 0;

  const result = await requestJsonWithRetry({
    url: "https://provider.example/api/v1/capability",
    makeInit: () => {
      initCount += 1;
      return { method: "POST" };
    },
    fetchImpl: async () => {
      const status = statuses[fetchCount];
      fetchCount += 1;
      return new Response(status === 200 ? '{"ok":true}' : "discarded", {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    random: () => 0,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(fetchCount, 3);
  assert.equal(initCount, 3);
  assert.deepEqual(delays, [90, 180]);
});

test("request helper does not retry non-429 client failures", async () => {
  let fetchCount = 0;
  await assert.rejects(
    requestJsonWithRetry({
      url: "https://provider.example/api/v1/capability",
      makeInit: () => ({ method: "POST" }),
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response("not logged", { status: 400 });
      },
      sleep: async () => assert.fail("must not sleep for a 400 response"),
    }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "provider_rejected",
  );
  assert.equal(fetchCount, 1);
});

test("request helper bounds network retries", async () => {
  let fetchCount = 0;
  await assert.rejects(
    requestJsonWithRetry({
      url: "https://provider.example/api/v1/capability",
      makeInit: () => ({ method: "POST" }),
      fetchImpl: async () => {
        fetchCount += 1;
        throw new TypeError("sensitive network detail must not escape");
      },
      maxAttempts: 2,
      random: () => 0,
      sleep: async () => {},
    }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "provider_network",
  );
  assert.equal(fetchCount, 2);
});

test("request helper aborts a hung request", async () => {
  await assert.rejects(
    requestJsonWithRetry({
      url: "https://provider.example/api/v1/capability",
      makeInit: () => ({ method: "POST" }),
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
      maxAttempts: 1,
      deadlineMs: 100,
      attemptTimeoutMs: 5,
    }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "provider_timeout",
  );
});

test("request helper rejects an oversized response before parsing it", async () => {
  await assert.rejects(
    requestJsonWithRetry({
      url: "https://provider.example/api/v1/capability",
      makeInit: () => ({ method: "POST" }),
      fetchImpl: async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-length": "999" },
        }),
      maxAttempts: 1,
      maxResponseBytes: 16,
    }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "response_too_large",
  );
});

test("OpenRouter MiMo capability body matches the streamed json_schema wire", () => {
  const body = buildOpenRouterMimoCapabilityBody("configured-generation-model");
  assert.deepEqual(body, {
    model: "configured-generation-model",
    store: false,
    temperature: 0,
    stream: true,
    max_tokens: 64,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "slopproof_openrouter_mimo_capability",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean", const: true } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "This is a fixed capability check. Do not call tools. Return only the requested JSON object.",
      },
      {
        role: "user",
        content: 'Return the JSON object {"ok":true}. Do not use Markdown.',
      },
    ],
  });
  assert.equal(Object.hasOwn(body, "chat_template_kwargs"), false);
  assert.equal(Object.hasOwn(body, "tools"), false);
  assert.throws(
    () => buildOpenRouterMimoCapabilityBody("model\nname"),
    (error) =>
      error instanceof LiveSmokeError &&
      error.code === "invalid_environment" &&
      error.fields.join() === "LEARNING_MODEL",
  );
});

function sseChatResponse(events, headers = {}) {
  return new Response(
    `${events
      .map((event) =>
        typeof event === "string"
          ? `data: ${event}\n\n`
          : `data: ${JSON.stringify(event)}\n\n`,
      )
      .join("")}`,
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        ...headers,
      },
    },
  );
}

function mimoOkEvents() {
  return [
    { choices: [{ delta: { content: '{"ok":' }, finish_reason: null }] },
    { choices: [{ delta: { content: "true}" }, finish_reason: "stop" }] },
    "[DONE]",
  ];
}

test("SSE reader reconstructs streamed chat JSON and rejects non-event-stream", async () => {
  assert.equal(
    await readBoundedSseChatContent(sseChatResponse(mimoOkEvents())),
    '{"ok":true}',
  );

  await assert.rejects(
    readBoundedSseChatContent(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
    (error) =>
      error instanceof LiveSmokeError && error.code === "malformed_response",
  );
  await assert.rejects(
    readBoundedSseChatContent(sseChatResponse(mimoOkEvents().slice(0, 2))),
    (error) =>
      error instanceof LiveSmokeError && error.code === "malformed_response",
  );
  await assert.rejects(
    readBoundedSseChatContent(
      sseChatResponse([
        {
          choices: [
            { delta: { content: '{"ok":true}' }, finish_reason: "length" },
          ],
        },
        "[DONE]",
      ]),
    ),
    (error) =>
      error instanceof LiveSmokeError && error.code === "malformed_response",
  );
  await assert.rejects(
    readBoundedSseChatContent(sseChatResponse(["not-json", "[DONE]"])),
    (error) =>
      error instanceof LiveSmokeError && error.code === "malformed_response",
  );
});

test("SSE reader enforces byte and event caps", async () => {
  await assert.rejects(
    readBoundedSseChatContent(sseChatResponse(mimoOkEvents()), {
      maxEvents: 1,
    }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "malformed_response",
  );
  await assert.rejects(
    readBoundedSseChatContent(
      sseChatResponse(mimoOkEvents(), { "content-length": "999" }),
      { maxBytes: 16 },
    ),
    (error) =>
      error instanceof LiveSmokeError && error.code === "response_too_large",
  );
});

test("SSE request helper retries only retryable statuses and rebuilds the request", async () => {
  const statuses = [429, 503, 200];
  const delays = [];
  let initCount = 0;
  let fetchCount = 0;

  const result = await requestSseChatWithRetry({
    url: "https://provider.example/api/v1/chat/completions",
    makeInit: () => {
      initCount += 1;
      return { method: "POST" };
    },
    fetchImpl: async () => {
      const status = statuses[fetchCount];
      fetchCount += 1;
      if (status !== 200) {
        return new Response("discarded", { status });
      }
      return sseChatResponse(mimoOkEvents());
    },
    random: () => 0,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(result, '{"ok":true}');
  assert.equal(fetchCount, 3);
  assert.equal(initCount, 3);
  assert.deepEqual(delays, [90, 180]);
});

test("SSE request helper does not retry non-429 client failures or JSON content", async () => {
  let rejectedCount = 0;
  await assert.rejects(
    requestSseChatWithRetry({
      url: "https://provider.example/api/v1/chat/completions",
      makeInit: () => ({ method: "POST" }),
      fetchImpl: async () => {
        rejectedCount += 1;
        return new Response("not logged", { status: 400 });
      },
      sleep: async () => assert.fail("must not sleep for a 400 response"),
    }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "provider_rejected",
  );
  assert.equal(rejectedCount, 1);

  let jsonCount = 0;
  await assert.rejects(
    requestSseChatWithRetry({
      url: "https://provider.example/api/v1/chat/completions",
      makeInit: () => ({ method: "POST" }),
      fetchImpl: async () => {
        jsonCount += 1;
        return new Response(
          '{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}',
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
      maxAttempts: 2,
      sleep: async () => assert.fail("must not hop or retry a JSON response"),
    }),
    (error) =>
      error instanceof LiveSmokeError && error.code === "malformed_response",
  );
  assert.equal(jsonCount, 1);
});

test("tiny WAV fixture is one second of bounded PCM16 mono audio", () => {
  const wav = createTinyWavFixture();
  assert.equal(wav.length, 32_044);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 32_000);
});

test("guard refuses silently-safe without invoking the live action", async () => {
  const stdout = [];
  const stderr = [];
  let invoked = false;
  const status = await runGuardedLiveSmoke({
    name: "provider-test",
    environment: {},
    action: async () => {
      invoked = true;
    },
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });

  assert.equal(status, 2);
  assert.equal(invoked, false);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, [
    "provider-test: refused; set LIVE_SMOKE=1 to authorize provider calls.\n",
  ]);
});

test("guard reports only a safe failure code", async () => {
  const secret = "never-print-this";
  const stderr = [];
  const status = await runGuardedLiveSmoke({
    name: "provider-test",
    environment: { LIVE_SMOKE: "1" },
    action: async () => {
      throw new Error(secret);
    },
    stdout: { write: () => assert.fail("failure must not write success") },
    stderr: { write: (value) => stderr.push(value) },
  });

  assert.equal(status, 1);
  assert.equal(stderr.join("").includes(secret), false);
  assert.deepEqual(stderr, ["provider-test: failed (unexpected_failure).\n"]);
});
