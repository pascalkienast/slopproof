const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_MAX_SSE_EVENTS = 256;
const DEFAULT_MAX_SSE_EVENT_BYTES = 16 * 1024;
const MAX_SSE_EVENTS = 20_000;
const MAX_SSE_EVENT_BYTES = 256 * 1_024;
const MAX_MODEL_CONTENT_BYTES = 64 * 1_024;
const MAX_ATTEMPTS = 3;
const OPENROUTER_MIMO_CAPABILITY_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    ok: Object.freeze({ type: "boolean", const: true }),
  }),
  required: Object.freeze(["ok"]),
  additionalProperties: false,
});

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

export async function readBoundedSseChatContent(
  response,
  {
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxEvents = DEFAULT_MAX_SSE_EVENTS,
    maxEventBytes = DEFAULT_MAX_SSE_EVENT_BYTES,
  } = {},
) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 1024 * 1024 ||
    !Number.isInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > MAX_SSE_EVENTS ||
    !Number.isInteger(maxEventBytes) ||
    maxEventBytes < 1 ||
    maxEventBytes > MAX_SSE_EVENT_BYTES
  ) {
    throw new LiveSmokeError("invalid_request");
  }

  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "text/event-stream") {
    try {
      await response.body?.cancel();
    } catch {
      // Wrong content-type is already a protocol failure.
    }
    throw new LiveSmokeError("malformed_response");
  }

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
  let pending = "";
  let eventData = [];
  let eventBytes = 0;
  let eventCount = 0;
  let doneSeen = false;
  let content = "";
  let contentBytes = 0;
  let finishReason = null;

  const commitEvent = () => {
    if (eventData.length === 0) return;
    const data = eventData.join("\n");
    eventData = [];
    eventBytes = 0;
    if (data === "[DONE]") {
      doneSeen = true;
      return;
    }
    if (doneSeen || (eventCount += 1) > maxEvents) {
      throw new LiveSmokeError("malformed_response");
    }
    let parsed;
    try {
      parsed = JSON.parse(data.replace(/^\uFEFF/u, ""));
    } catch {
      throw new LiveSmokeError("malformed_response");
    }
    const chunk = parseSseChatChunk(parsed);
    if (chunk.content !== undefined) {
      const deltaBytes = Buffer.byteLength(chunk.content, "utf8");
      if (contentBytes + deltaBytes > MAX_MODEL_CONTENT_BYTES) {
        throw new LiveSmokeError("response_too_large");
      }
      content += chunk.content;
      contentBytes += deltaBytes;
    }
    if (chunk.finishReason !== undefined) {
      if (finishReason !== null && finishReason !== chunk.finishReason) {
        throw new LiveSmokeError("malformed_response");
      }
      finishReason = chunk.finishReason;
    }
  };

  const acceptLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      commitEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "data") return;
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (eventBytes + valueBytes > maxEventBytes) {
      throw new LiveSmokeError("response_too_large");
    }
    eventData.push(value);
    eventBytes += valueBytes;
  };

  const acceptText = (value) => {
    pending += value;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      acceptLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > maxEventBytes) {
      throw new LiveSmokeError("response_too_large");
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        throw new LiveSmokeError("response_too_large");
      }
      acceptText(decoder.decode(value, { stream: true }));
    }
    acceptText(decoder.decode());
    if (pending.length > 0) {
      acceptLine(pending);
      pending = "";
    }
    commitEvent();
    if (!doneSeen || finishReason !== "stop" || content.length === 0) {
      throw new LiveSmokeError("malformed_response");
    }
    return content;
  } catch (error) {
    if (error instanceof LiveSmokeError) throw error;
    throw new LiveSmokeError("response_stream_failed");
  }
}

function parseSseChatChunk(parsed) {
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.choices) ||
    parsed.choices.length > 8
  ) {
    throw new LiveSmokeError("malformed_response");
  }
  if (parsed.choices.length === 0) {
    return {};
  }
  const choice = parsed.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    throw new LiveSmokeError("malformed_response");
  }
  const content = choice.delta.content;
  if (
    content !== undefined &&
    content !== null &&
    typeof content !== "string"
  ) {
    throw new LiveSmokeError("malformed_response");
  }
  const finishReason = choice.finish_reason;
  if (
    finishReason !== undefined &&
    finishReason !== null &&
    typeof finishReason !== "string"
  ) {
    throw new LiveSmokeError("malformed_response");
  }
  return {
    ...(typeof content === "string" ? { content } : {}),
    ...(typeof finishReason === "string" ? { finishReason } : {}),
  };
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

export async function requestJsonWithRetry(options) {
  return runRequestWithRetry({
    ...options,
    readOkResponse: (response, maxResponseBytes) =>
      readBoundedJsonResponse(response, maxResponseBytes),
  });
}

export async function requestSseChatWithRetry({
  maxSseEvents = DEFAULT_MAX_SSE_EVENTS,
  maxSseEventBytes = DEFAULT_MAX_SSE_EVENT_BYTES,
  ...options
} = {}) {
  if (
    !Number.isInteger(maxSseEvents) ||
    maxSseEvents < 1 ||
    maxSseEvents > MAX_SSE_EVENTS ||
    !Number.isInteger(maxSseEventBytes) ||
    maxSseEventBytes < 1 ||
    maxSseEventBytes > MAX_SSE_EVENT_BYTES
  ) {
    throw new LiveSmokeError("invalid_request");
  }
  return runRequestWithRetry({
    ...options,
    readOkResponse: (response, maxResponseBytes) =>
      readBoundedSseChatContent(response, {
        maxBytes: maxResponseBytes,
        maxEvents: maxSseEvents,
        maxEventBytes: maxSseEventBytes,
      }),
  });
}

export function buildOpenRouterMimoCapabilityBody(model) {
  if (
    typeof model !== "string" ||
    model.trim().length === 0 ||
    /[\0\r\n]/u.test(model)
  ) {
    throw new LiveSmokeError("invalid_environment", ["LEARNING_MODEL"]);
  }
  return {
    model,
    store: false,
    temperature: 0,
    stream: true,
    max_tokens: 64,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "slopproof_openrouter_mimo_capability",
        strict: true,
        schema: OPENROUTER_MIMO_CAPABILITY_SCHEMA,
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
  };
}

async function runRequestWithRetry({
  url,
  makeInit,
  readOkResponse,
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
    typeof readOkResponse !== "function" ||
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
            return await readOkResponse(response, maxResponseBytes);
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
