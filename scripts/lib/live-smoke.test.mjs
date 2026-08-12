import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactObject,
  assertTranscriptionPayload,
  buildApiUrl,
  createTinyWavFixture,
  extractJsonObject,
  getChatMessageContent,
  isLiveSmokeEnabled,
  LiveSmokeError,
  requestJsonWithRetry,
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
