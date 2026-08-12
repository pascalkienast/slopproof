const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_ATTEMPTS = 3;

export class LiveSmokeError extends Error {
  constructor(code, fields = []) {
    super(`Live smoke failed (${code}).`);
    this.name = "LiveSmokeError";
    this.code = code;
    this.fields = [...new Set(fields)].sort();
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isLiveSmokeEnabled(environment = process.env) {
  return environment.LIVE_SMOKE === "1";
}

export function requireSmokeEnvironment(environment, specification) {
  const invalidFields = [];
  const values = {};

  for (const [name, expectedValue] of Object.entries(specification)) {
    const value = environment[name];
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      /[\0\r\n]/u.test(value) ||
      (typeof expectedValue === "string" && value !== expectedValue)
    ) {
      invalidFields.push(name);
      continue;
    }
    values[name] = value;
  }

  if (invalidFields.length > 0) {
    throw new LiveSmokeError("invalid_environment", invalidFields);
  }

  return Object.freeze(values);
}

export function buildApiUrl(baseUrl, endpoint) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LiveSmokeError("invalid_environment", ["baseUrl"]);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new LiveSmokeError("invalid_environment", ["baseUrl"]);
  }
  if (!/^\/[a-z0-9/_-]+$/iu.test(endpoint)) {
    throw new LiveSmokeError("invalid_request");
  }

  const basePath = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = `${basePath}${endpoint}`;
  return parsed.toString();
}

async function readBoundedJsonResponse(
  response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already being rejected; cancellation is best effort.
    }
    throw new LiveSmokeError("response_too_large");
  }
  if (!response.body) {
    throw new LiveSmokeError("malformed_response");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new LiveSmokeError("response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof LiveSmokeError) throw error;
    throw new LiveSmokeError("response_stream_failed");
  }

  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    throw new LiveSmokeError("malformed_response");
  }
}

function backoffMilliseconds(attempt, random) {
  const base = Math.min(120 * 2 ** (attempt - 1), 600);
  return Math.round(base * (0.75 + random() * 0.5));
}

function retryAfterMilliseconds(response) {
  const value = response?.headers.get("retry-after");
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), 1_500);
  }

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return 0;
  return Math.min(Math.max(date - Date.now(), 0), 1_500);
}

function validateRetryOptions({
  maxAttempts,
  deadlineMs,
  attemptTimeoutMs,
  maxResponseBytes,
}) {
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs < 1 ||
    !Number.isFinite(attemptTimeoutMs) ||
    attemptTimeoutMs < 1 ||
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > 1024 * 1024
  ) {
    throw new LiveSmokeError("invalid_request");
  }
}

export async function requestJsonWithRetry({
  url,
  makeInit,
  fetchImpl = globalThis.fetch,
  maxAttempts = MAX_ATTEMPTS,
  deadlineMs = 25_000,
  attemptTimeoutMs = 10_000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  now = Date.now,
  random = Math.random,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  validateRetryOptions({
    maxAttempts,
    deadlineMs,
    attemptTimeoutMs,
    maxResponseBytes,
  });
  if (
    typeof fetchImpl !== "function" ||
    typeof makeInit !== "function" ||
    typeof now !== "function" ||
    typeof random !== "function" ||
    typeof sleep !== "function"
  ) {
    throw new LiveSmokeError("invalid_request");
  }

  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw new LiveSmokeError("provider_timeout");

    const init = makeInit(attempt);
    if (!isRecord(init) || "signal" in init) {
      throw new LiveSmokeError("invalid_request");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(attemptTimeoutMs, remaining)),
    );
    let response;
    let failureCode;
    let retryable = false;

    try {
      try {
        response = await fetchImpl(url, { ...init, signal: controller.signal });
      } catch {
        failureCode = controller.signal.aborted
          ? "provider_timeout"
          : "provider_network";
        retryable = true;
      }

      if (response) {
        if (response.ok) {
          try {
            return await readBoundedJsonResponse(response, maxResponseBytes);
          } catch (error) {
            if (controller.signal.aborted) {
              failureCode = "provider_timeout";
              retryable = true;
            } else if (
              error instanceof LiveSmokeError &&
              error.code === "response_stream_failed"
            ) {
              failureCode = "provider_network";
              retryable = true;
            } else {
              throw error;
            }
          }
        } else {
          try {
            await response.body?.cancel();
          } catch {
            // Error bodies are deliberately not consumed or logged.
          }
          if (response.status === 429) {
            failureCode = "provider_rate_limited";
            retryable = true;
          } else if (response.status >= 500 && response.status <= 599) {
            failureCode = "provider_unavailable";
            retryable = true;
          } else {
            throw new LiveSmokeError("provider_rejected");
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!retryable || !failureCode) {
      throw new LiveSmokeError("unexpected_failure");
    }
    if (attempt === maxAttempts) {
      throw new LiveSmokeError(failureCode);
    }

    const remainingBeforeSleep = deadlineAt - now();
    const delay = Math.max(
      backoffMilliseconds(attempt, random),
      retryAfterMilliseconds(response),
    );
    if (remainingBeforeSleep <= delay) {
      throw new LiveSmokeError("provider_timeout");
    }
    await sleep(delay);
  }

  throw new LiveSmokeError("unexpected_failure");
}

function parseObject(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function extractJsonObject(modelText) {
  if (typeof modelText !== "string" || modelText.length > 64 * 1024) {
    throw new LiveSmokeError("malformed_response");
  }

  const trimmed = modelText.trim();
  const direct = parseObject(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const fencedObject = fenced ? parseObject(fenced[1]) : undefined;
  if (fencedObject) return fencedObject;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const parsed = parseObject(trimmed.slice(start, index + 1));
        if (parsed) return parsed;
        start = -1;
      }
    }
  }

  throw new LiveSmokeError("malformed_response");
}

export function assertExactObject(actual, expected) {
  if (!isRecord(actual)) throw new LiveSmokeError("schema_mismatch");

  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => actual[key] !== expected[key])
  ) {
    throw new LiveSmokeError("schema_mismatch");
  }
  return actual;
}

export function getChatMessageContent(payload) {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.choices) ||
    !isRecord(payload.choices[0]) ||
    !isRecord(payload.choices[0].message) ||
    typeof payload.choices[0].message.content !== "string" ||
    payload.choices[0].message.content.length > 64 * 1024
  ) {
    throw new LiveSmokeError("malformed_response");
  }
  return payload.choices[0].message.content;
}

export function assertTranscriptionPayload(payload) {
  if (
    !isRecord(payload) ||
    typeof payload.text !== "string" ||
    payload.text.length > 64 * 1024
  ) {
    throw new LiveSmokeError("schema_mismatch");
  }
  return payload;
}

export function createTinyWavFixture() {
  const sampleRate = 16_000;
  const sampleCount = sampleRate;
  const bytesPerSample = 2;
  const dataBytes = sampleCount * bytesPerSample;
  const wav = Buffer.alloc(44 + dataBytes);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const edge = Math.min(index, sampleCount - index - 1);
    const envelope = Math.min(edge / 320, 1);
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 1_000 * envelope,
    );
    wav.writeInt16LE(sample, 44 + index * bytesPerSample);
  }

  return wav;
}

export async function runGuardedLiveSmoke({
  name,
  environment = process.env,
  action,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const safeName = /^[a-z0-9-]+$/u.test(name) ? name : "live-smoke";
  if (!isLiveSmokeEnabled(environment)) {
    stderr.write(
      `${safeName}: refused; set LIVE_SMOKE=1 to authorize provider calls.\n`,
    );
    return 2;
  }

  try {
    await action();
    stdout.write(`${safeName}: passed.\n`);
    return 0;
  } catch (error) {
    const code =
      error instanceof LiveSmokeError ? error.code : "unexpected_failure";
    stderr.write(`${safeName}: failed (${code}).\n`);
    return 1;
  }
}
