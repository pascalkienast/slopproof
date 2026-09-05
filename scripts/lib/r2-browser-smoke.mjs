import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";

export const R2_BROWSER_SMOKE_ORIGIN = "https://understandproof.paskie.me";
export const R2_BROWSER_SMOKE_OPT_IN = "R2_BROWSER_SMOKE";
export const R2_BROWSER_SMOKE_EXACT_OPT_IN = "production-slopproof-eu";
export const R2_BROWSER_SMOKE_ENDPOINT =
  "https://bf2f734c49e05a3ed1cbad16f0049e6c.eu.r2.cloudflarestorage.com";
export const R2_BROWSER_SMOKE_REGION = "auto";
export const S3_MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
export const MULTIPART_TARGET_PART_BYTES = 8 * 1024 * 1024;

const MAX_FINAL_PART_BYTES = 64 * 1024;
const CONTROL_TIMEOUT_MS = 15_000;
const MAX_ENVIRONMENT_FILE_BYTES = 64 * 1024;
const SAFE_FAILURE_CODES = new Set([
  "browser_put_rejected",
  "ciphertext_length_mismatch",
  "ciphertext_verification_failed",
  "cleanup_failed",
  "control_operation_failed",
  "fixture_collision",
  "invalid_environment",
  "invalid_fixture",
  "invalid_runtime",
  "multipart_create_rejected",
  "negative_browser_put_accepted",
  "negative_browser_put_side_effect",
  "object_body_invalid",
  "production_origin_unavailable",
  "unsafe_environment_file",
]);
const RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "S3_CONTROL_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
]);
const UNSAFE_DIAGNOSTIC_ENVIRONMENT_NAMES = Object.freeze([
  "DEBUG",
  "DEBUG_FILE",
  "NODE_DEBUG",
  "PWDEBUG",
]);

export class R2BrowserSmokeError extends Error {
  constructor(code, fields = []) {
    super(`R2 browser smoke failed (${code}).`);
    this.name = "R2BrowserSmokeError";
    this.code = code;
    this.fields = [...new Set(fields)].sort();
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isR2BrowserSmokeEnabled(environment = process.env) {
  return environment[R2_BROWSER_SMOKE_OPT_IN] === R2_BROWSER_SMOKE_EXACT_OPT_IN;
}

function requireEnvironmentString(environment, name, invalidFields) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\0\r\n]/u.test(value)
  ) {
    invalidFields.push(name);
    return undefined;
  }
  return value;
}

export function requireR2BrowserSmokeEnvironment(environment = process.env) {
  const invalidFields = [];
  if (!isR2BrowserSmokeEnabled(environment)) {
    invalidFields.push(R2_BROWSER_SMOKE_OPT_IN);
  }

  const values = {};
  for (const name of [
    "S3_CONTROL_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ]) {
    values[name] = requireEnvironmentString(environment, name, invalidFields);
  }

  if (values.S3_BUCKET !== "slopproof-eu") invalidFields.push("S3_BUCKET");
  if (values.S3_REGION !== R2_BROWSER_SMOKE_REGION) {
    invalidFields.push("S3_REGION");
  }
  if (values.S3_CONTROL_ENDPOINT !== R2_BROWSER_SMOKE_ENDPOINT) {
    invalidFields.push("S3_CONTROL_ENDPOINT");
  }
  if (values.S3_PUBLIC_ENDPOINT !== R2_BROWSER_SMOKE_ENDPOINT) {
    invalidFields.push("S3_PUBLIC_ENDPOINT");
  }

  if (invalidFields.length > 0) {
    throw new R2BrowserSmokeError("invalid_environment", invalidFields);
  }

  return Object.freeze(values);
}

export function loadR2BrowserSmokeEnvironment(
  environment = process.env,
  effectiveUid = process.geteuid?.(),
) {
  const unsafeDiagnosticFields = UNSAFE_DIAGNOSTIC_ENVIRONMENT_NAMES.filter(
    (name) => environment[name] !== undefined && environment[name] !== "",
  );
  if (unsafeDiagnosticFields.length > 0) {
    throw new R2BrowserSmokeError(
      "invalid_environment",
      unsafeDiagnosticFields,
    );
  }
  const path = environment.R2_BROWSER_SMOKE_ENV_FILE;
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    throw new R2BrowserSmokeError("invalid_environment", [
      "R2_BROWSER_SMOKE_ENV_FILE",
    ]);
  }

  let file;
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_ENVIRONMENT_FILE_BYTES ||
      (metadata.mode & 0o077) !== 0 ||
      (effectiveUid !== undefined && metadata.uid !== effectiveUid)
    ) {
      throw new R2BrowserSmokeError("unsafe_environment_file");
    }
    file = readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof R2BrowserSmokeError) throw error;
    throw new R2BrowserSmokeError("unsafe_environment_file");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        throw new R2BrowserSmokeError("unsafe_environment_file");
      }
    }
  }

  const parsed = {};
  for (const line of file.split("\n")) {
    if (line.length === 0) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)='([^'\0\r\n]*)'$/u);
    if (!match) throw new R2BrowserSmokeError("unsafe_environment_file");
    const [, name, value] = match;
    if (RUNTIME_ENVIRONMENT_NAMES.includes(name)) {
      if (Object.hasOwn(parsed, name)) {
        throw new R2BrowserSmokeError("unsafe_environment_file");
      }
      parsed[name] = value;
    }
  }

  return requireR2BrowserSmokeEnvironment({
    [R2_BROWSER_SMOKE_OPT_IN]: environment[R2_BROWSER_SMOKE_OPT_IN],
    ...parsed,
  });
}

export function createR2BrowserSmokeObjectKey(randomUuid = randomUUID) {
  return `evidence/v1/${randomUuid().replaceAll("-", "")}`;
}

export function createCiphertextFixture(randomBytesImpl = randomBytes) {
  const marker = randomBytesImpl(32);
  const plaintextSentinel = Buffer.concat([
    Buffer.from("SLOPPROOF-R2-PLAINTEXT-MUST-NOT-PERSIST:", "utf8"),
    Buffer.from(marker.toString("hex"), "ascii"),
  ]);
  const plaintext = Buffer.concat([
    plaintextSentinel,
    randomBytesImpl(MULTIPART_TARGET_PART_BYTES + MAX_FINAL_PART_BYTES),
  ]);
  const key = randomBytesImpl(32);
  const nonce = randomBytesImpl(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  key.fill(0);
  plaintext.fill(0);
  if (ciphertext.includes(plaintextSentinel)) {
    throw new R2BrowserSmokeError("fixture_collision");
  }
  const firstPart = ciphertext.subarray(0, MULTIPART_TARGET_PART_BYTES);
  const finalPart = ciphertext.subarray(MULTIPART_TARGET_PART_BYTES);
  return Object.freeze({ firstPart, finalPart, ciphertext, plaintextSentinel });
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertFixtureShape(fixture) {
  if (
    !isRecord(fixture) ||
    !(fixture.firstPart instanceof Uint8Array) ||
    fixture.firstPart.byteLength !== MULTIPART_TARGET_PART_BYTES ||
    fixture.firstPart.byteLength <= S3_MINIMUM_MULTIPART_PART_BYTES ||
    !(fixture.finalPart instanceof Uint8Array) ||
    fixture.finalPart.byteLength < 1 ||
    fixture.finalPart.byteLength > S3_MINIMUM_MULTIPART_PART_BYTES ||
    !(fixture.ciphertext instanceof Uint8Array) ||
    !(fixture.plaintextSentinel instanceof Uint8Array) ||
    fixture.plaintextSentinel.byteLength < 32 ||
    fixture.ciphertext.byteLength !==
      fixture.firstPart.byteLength + fixture.finalPart.byteLength ||
    sha256Hex(fixture.ciphertext) !==
      sha256Hex(Buffer.concat([fixture.firstPart, fixture.finalPart])) ||
    Buffer.from(fixture.ciphertext).includes(fixture.plaintextSentinel)
  ) {
    throw new R2BrowserSmokeError("invalid_fixture");
  }
}

function assertBrowserUploadResult(result, expectedEtags) {
  if (
    !isRecord(result) ||
    result.status !== 200 ||
    typeof result.etag !== "string" ||
    result.etag.length < 3 ||
    result.etag.length > 256 ||
    /[\0\r\n]/u.test(result.etag)
  ) {
    throw new R2BrowserSmokeError("browser_put_rejected");
  }
  expectedEtags.push(result.etag);
}

function isValidOperationDeadline(deadlineMs) {
  return (
    Number.isInteger(deadlineMs) &&
    deadlineMs >= 1 &&
    deadlineMs <= CONTROL_TIMEOUT_MS
  );
}

function startBestEffort(action) {
  try {
    void Promise.resolve(action()).catch(() => {});
  } catch {
    // Best-effort interruption must not delay authoritative failure or cleanup.
  }
}

async function withAbsoluteDeadline(
  action,
  deadlineMs,
  failureCode,
  onTimeout,
) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => {
          if (onTimeout) startBestEffort(onTimeout);
          reject(new R2BrowserSmokeError(failureCode));
        }, deadlineMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof R2BrowserSmokeError) throw error;
    throw new R2BrowserSmokeError(failureCode);
  } finally {
    clearTimeout(timeout);
  }
}

function closePageBestEffort(page) {
  if (typeof page?.close === "function") {
    startBestEffort(() => page.close({ runBeforeUnload: false }));
  }
}

export async function browserPutPart(
  page,
  url,
  bytes,
  deadlineMs = CONTROL_TIMEOUT_MS,
) {
  let result;
  try {
    result = await withAbsoluteDeadline(
      () =>
        page.evaluate(
          async ({ target, bodyBase64, fetchDeadlineMs }) => {
            const controller = new AbortController();
            const timeout = setTimeout(
              () => controller.abort(),
              fetchDeadlineMs,
            );
            try {
              const decoded = atob(bodyBase64);
              const body = new Uint8Array(decoded.length);
              for (let index = 0; index < decoded.length; index += 1) {
                body[index] = decoded.charCodeAt(index);
              }
              const response = await fetch(target, {
                method: "PUT",
                headers: { "content-type": "application/octet-stream" },
                body,
                signal: controller.signal,
              });
              return {
                ok: response.ok,
                status: response.status,
                etag: response.headers.get("etag"),
              };
            } catch {
              return { ok: false, status: 0, etag: null };
            } finally {
              clearTimeout(timeout);
            }
          },
          {
            target: url,
            bodyBase64: Buffer.from(bytes).toString("base64"),
            fetchDeadlineMs: deadlineMs,
          },
        ),
      deadlineMs,
      "browser_put_rejected",
      () => closePageBestEffort(page),
    );
  } catch {
    throw new R2BrowserSmokeError("browser_put_rejected");
  }
  if (!isRecord(result) || result.ok !== true) {
    throw new R2BrowserSmokeError("browser_put_rejected");
  }
  const etags = [];
  assertBrowserUploadResult(result, etags);
  return etags[0];
}

export async function assertBrowserPutRejected(
  page,
  url,
  bytes,
  deadlineMs = CONTROL_TIMEOUT_MS,
) {
  let result;
  try {
    result = await withAbsoluteDeadline(
      () =>
        page.evaluate(
          async ({ target, bodyBase64, fetchDeadlineMs }) => {
            const controller = new AbortController();
            const timeout = setTimeout(
              () => controller.abort(),
              fetchDeadlineMs,
            );
            try {
              const decoded = atob(bodyBase64);
              const body = new Uint8Array(decoded.length);
              for (let index = 0; index < decoded.length; index += 1) {
                body[index] = decoded.charCodeAt(index);
              }
              const response = await fetch(target, {
                method: "PUT",
                headers: { "content-type": "application/octet-stream" },
                body,
                signal: controller.signal,
              });
              return { ok: response.ok, status: response.status };
            } catch {
              return { ok: false, status: 0 };
            } finally {
              clearTimeout(timeout);
            }
          },
          {
            target: url,
            bodyBase64: Buffer.from(bytes).toString("base64"),
            fetchDeadlineMs: deadlineMs,
          },
        ),
      deadlineMs,
      "browser_put_rejected",
      () => closePageBestEffort(page),
    );
  } catch {
    throw new R2BrowserSmokeError("browser_put_rejected");
  }
  if (!isRecord(result) || result.ok !== false) {
    throw new R2BrowserSmokeError("negative_browser_put_accepted");
  }
}

async function withControlDeadline(
  action,
  deadlineMs = CONTROL_TIMEOUT_MS,
  onTimeout,
) {
  return withAbsoluteDeadline(
    action,
    deadlineMs,
    "control_operation_failed",
    onTimeout,
  );
}

async function acquireBrowserResource(action, deadlineMs) {
  const pending = Promise.resolve().then(action);
  return withControlDeadline(
    () => pending,
    deadlineMs,
    () => {
      void pending
        .then((resource) => {
          if (typeof resource?.close === "function") {
            startBestEffort(() => resource.close({ runBeforeUnload: false }));
          }
        })
        .catch(() => {});
    },
  );
}

export async function launchR2BrowserSmokeBrowser(
  launch,
  deadlineMs = CONTROL_TIMEOUT_MS,
) {
  if (typeof launch !== "function" || !isValidOperationDeadline(deadlineMs)) {
    throw new R2BrowserSmokeError("invalid_runtime");
  }
  return acquireBrowserResource(launch, deadlineMs);
}

export async function closeR2BrowserSmokeBrowser(
  browser,
  deadlineMs = CONTROL_TIMEOUT_MS,
) {
  if (!browser) return;
  if (
    typeof browser.close !== "function" ||
    !isValidOperationDeadline(deadlineMs)
  ) {
    throw new R2BrowserSmokeError("invalid_runtime");
  }
  await withAbsoluteDeadline(
    () => browser.close(),
    deadlineMs,
    "cleanup_failed",
  );
}

function cancelReaderBestEffort(reader) {
  try {
    void Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // Cancellation must never delay the authoritative failure or object cleanup.
  }
}

async function readObjectStream(stream, maximumBytes, deadlineMs) {
  if (!stream || typeof stream.getReader !== "function") {
    throw new R2BrowserSmokeError("object_body_invalid");
  }
  const reader = stream.getReader();
  const chunks = [];
  let bytesRead = 0;
  let timeout;
  const deadline = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      cancelReaderBestEffort(reader);
      reject(new R2BrowserSmokeError("control_operation_failed"));
    }, deadlineMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        cancelReaderBestEffort(reader);
        throw new R2BrowserSmokeError("object_body_invalid");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof R2BrowserSmokeError) throw error;
    throw new R2BrowserSmokeError("object_body_invalid");
  } finally {
    clearTimeout(timeout);
  }
  if (bytesRead < 1) {
    throw new R2BrowserSmokeError("object_body_invalid");
  }
  return Buffer.concat(chunks, bytesRead);
}

function assertServerObject({ head, body, fixture }) {
  if (head.byteLength !== fixture.ciphertext.byteLength) {
    throw new R2BrowserSmokeError("ciphertext_length_mismatch");
  }
  if (
    body.byteLength !== fixture.ciphertext.byteLength ||
    sha256Hex(body) !== sha256Hex(fixture.ciphertext) ||
    body.includes(fixture.plaintextSentinel)
  ) {
    throw new R2BrowserSmokeError("ciphertext_verification_failed");
  }
}

export async function runR2BrowserSmoke({
  environment = process.env,
  store,
  browser,
  fixture = createCiphertextFixture(),
  objectKey = createR2BrowserSmokeObjectKey(),
  bodyDeadlineMs = CONTROL_TIMEOUT_MS,
  operationDeadlineMs = CONTROL_TIMEOUT_MS,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  requireR2BrowserSmokeEnvironment(environment);
  assertFixtureShape(fixture);
  if (
    !isValidOperationDeadline(bodyDeadlineMs) ||
    !isValidOperationDeadline(operationDeadlineMs) ||
    !store ||
    [
      "createMultipartUpload",
      "presignUploadPart",
      "completeMultipartUpload",
      "abortMultipartUpload",
      "listParts",
      "headObject",
      "getObjectStream",
      "deleteObject",
    ].some((method) => typeof store[method] !== "function") ||
    !browser ||
    typeof browser.newContext !== "function"
  ) {
    throw new R2BrowserSmokeError("invalid_runtime");
  }

  let uploadId;
  let completed = false;
  let originContext;
  let wrongOriginContext;

  try {
    uploadId = await withControlDeadline(
      () => store.createMultipartUpload(objectKey),
      operationDeadlineMs,
    );
    if (!uploadId) {
      throw new R2BrowserSmokeError("multipart_create_rejected");
    }

    const partInputs = [fixture.firstPart, fixture.finalPart];
    const urls = [];
    for (let index = 0; index < partInputs.length; index += 1) {
      urls.push(
        await withControlDeadline(
          () =>
            store.presignUploadPart({
              objectKey,
              uploadId,
              partNumber: index + 1,
              byteLength: partInputs[index].byteLength,
              sha256: sha256Hex(partInputs[index]),
              expiresInSeconds: 300,
            }),
          operationDeadlineMs,
        ),
      );
    }

    originContext = await acquireBrowserResource(
      () => browser.newContext(),
      operationDeadlineMs,
    );
    const originPage = await acquireBrowserResource(
      () => originContext.newPage(),
      operationDeadlineMs,
    );
    await withControlDeadline(
      () =>
        originPage.goto(R2_BROWSER_SMOKE_ORIGIN, {
          waitUntil: "domcontentloaded",
          timeout: operationDeadlineMs,
        }),
      operationDeadlineMs,
      () => closePageBestEffort(originPage),
    );
    if (new URL(originPage.url()).origin !== R2_BROWSER_SMOKE_ORIGIN) {
      throw new R2BrowserSmokeError("production_origin_unavailable");
    }

    const etags = [];
    for (let index = 0; index < urls.length; index += 1) {
      etags.push(
        await browserPutPart(
          originPage,
          urls[index],
          partInputs[index],
          operationDeadlineMs,
        ),
      );
    }

    await withControlDeadline(
      () =>
        store.completeMultipartUpload({
          objectKey,
          uploadId,
          parts: etags.map((etag, index) => ({
            etag,
            partNumber: index + 1,
          })),
        }),
      operationDeadlineMs,
    );
    completed = true;

    const head = await withControlDeadline(
      () => store.headObject(objectKey),
      operationDeadlineMs,
    );
    const downloaded = await withControlDeadline(
      () => store.getObjectStream(objectKey),
      operationDeadlineMs,
    );
    const body = await readObjectStream(
      downloaded,
      fixture.ciphertext.byteLength,
      bodyDeadlineMs,
    );
    assertServerObject({ head, body, fixture });

    // Wrong-origin proof uses a fresh multipart/upload URL. A rejected request
    // leaves no uploaded part, and the upload is always aborted in this scope.
    const wrongOriginKey = createR2BrowserSmokeObjectKey();
    let wrongOriginUploadId;
    try {
      wrongOriginUploadId = await withControlDeadline(
        () => store.createMultipartUpload(wrongOriginKey),
        operationDeadlineMs,
      );
      if (!wrongOriginUploadId) {
        throw new R2BrowserSmokeError("multipart_create_rejected");
      }
      const wrongOriginUrl = await withControlDeadline(
        () =>
          store.presignUploadPart({
            objectKey: wrongOriginKey,
            uploadId: wrongOriginUploadId,
            partNumber: 1,
            byteLength: fixture.finalPart.byteLength,
            sha256: sha256Hex(fixture.finalPart),
            expiresInSeconds: 300,
          }),
        operationDeadlineMs,
      );
      wrongOriginContext = await acquireBrowserResource(
        () => browser.newContext(),
        operationDeadlineMs,
      );
      const wrongOriginPage = await acquireBrowserResource(
        () => wrongOriginContext.newPage(),
        operationDeadlineMs,
      );
      await withControlDeadline(
        () =>
          wrongOriginPage.goto("data:text/html,slopproof-r2-negative", {
            waitUntil: "domcontentloaded",
            timeout: operationDeadlineMs,
          }),
        operationDeadlineMs,
        () => closePageBestEffort(wrongOriginPage),
      );
      await assertBrowserPutRejected(
        wrongOriginPage,
        wrongOriginUrl,
        fixture.finalPart,
        operationDeadlineMs,
      );
      const wrongOriginParts = await withControlDeadline(
        () => store.listParts(wrongOriginKey, wrongOriginUploadId),
        operationDeadlineMs,
      );
      if (!Array.isArray(wrongOriginParts) || wrongOriginParts.length !== 0) {
        throw new R2BrowserSmokeError("negative_browser_put_side_effect");
      }
    } finally {
      if (wrongOriginUploadId) {
        try {
          await withControlDeadline(
            () =>
              store.abortMultipartUpload(wrongOriginKey, wrongOriginUploadId),
            operationDeadlineMs,
          );
        } catch {
          throw new R2BrowserSmokeError("cleanup_failed");
        }
      }
    }

    // The one-second expiry uses a fresh URL and never attempts before expiry.
    // Its rejected PUT therefore cannot add a valid part or alter the object.
    const expiredKey = createR2BrowserSmokeObjectKey();
    let expiredUploadId;
    try {
      expiredUploadId = await withControlDeadline(
        () => store.createMultipartUpload(expiredKey),
        operationDeadlineMs,
      );
      if (!expiredUploadId) {
        throw new R2BrowserSmokeError("multipart_create_rejected");
      }
      const expiredUrl = await withControlDeadline(
        () =>
          store.presignUploadPart({
            objectKey: expiredKey,
            uploadId: expiredUploadId,
            partNumber: 1,
            byteLength: fixture.finalPart.byteLength,
            sha256: sha256Hex(fixture.finalPart),
            expiresInSeconds: 1,
          }),
        operationDeadlineMs,
      );
      await withControlDeadline(() => wait(5_000), operationDeadlineMs);
      await assertBrowserPutRejected(
        originPage,
        expiredUrl,
        fixture.finalPart,
        operationDeadlineMs,
      );
      const expiredParts = await withControlDeadline(
        () => store.listParts(expiredKey, expiredUploadId),
        operationDeadlineMs,
      );
      if (!Array.isArray(expiredParts) || expiredParts.length !== 0) {
        throw new R2BrowserSmokeError("negative_browser_put_side_effect");
      }
    } finally {
      if (expiredUploadId) {
        try {
          await withControlDeadline(
            () => store.abortMultipartUpload(expiredKey, expiredUploadId),
            operationDeadlineMs,
          );
        } catch {
          throw new R2BrowserSmokeError("cleanup_failed");
        }
      }
    }
  } finally {
    let cleanupFailed = false;
    if (uploadId && !completed) {
      try {
        await withControlDeadline(
          () => store.abortMultipartUpload(objectKey, uploadId),
          operationDeadlineMs,
        );
      } catch {
        cleanupFailed = true;
      }
    }
    if (uploadId) {
      try {
        // Delete even after an indeterminate completion response. Deleting a
        // not-yet-completed key is idempotent, while this also covers the case
        // where completion reached R2 but its response never reached us.
        await withControlDeadline(
          () => store.deleteObject(objectKey),
          operationDeadlineMs,
        );
      } catch {
        cleanupFailed = true;
      }
    }
    // Storage cleanup is authoritative and must run before potentially stalled
    // browser shutdown. Every close is initiated, but awaited only to the same
    // bounded per-operation deadline.
    for (const context of [wrongOriginContext, originContext]) {
      if (!context) continue;
      try {
        await withAbsoluteDeadline(
          () => context.close(),
          operationDeadlineMs,
          "cleanup_failed",
        );
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new R2BrowserSmokeError("cleanup_failed");
  }
}

export async function runGuardedR2BrowserSmoke({
  environment = process.env,
  action,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  if (!isR2BrowserSmokeEnabled(environment)) {
    stderr.write(
      `r2-browser: refused; set ${R2_BROWSER_SMOKE_OPT_IN}=${R2_BROWSER_SMOKE_EXACT_OPT_IN} to authorize a production storage smoke.\n`,
    );
    return 2;
  }

  try {
    await action();
    stdout.write("r2-browser: passed; temporary objects removed.\n");
    return 0;
  } catch (error) {
    const code =
      error instanceof R2BrowserSmokeError && SAFE_FAILURE_CODES.has(error.code)
        ? error.code
        : "unexpected_failure";
    stderr.write(`r2-browser: failed (${code}).\n`);
    return 1;
  }
}
