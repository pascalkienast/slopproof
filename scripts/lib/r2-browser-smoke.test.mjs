import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertBrowserPutRejected,
  browserPutPart,
  closeR2BrowserSmokeBrowser,
  createCiphertextFixture,
  isR2BrowserSmokeEnabled,
  loadR2BrowserSmokeEnvironment,
  MULTIPART_TARGET_PART_BYTES,
  R2_BROWSER_SMOKE_ENDPOINT,
  R2_BROWSER_SMOKE_EXACT_OPT_IN,
  R2_BROWSER_SMOKE_ORIGIN,
  R2BrowserSmokeError,
  requireR2BrowserSmokeEnvironment,
  runGuardedR2BrowserSmoke,
  runR2BrowserSmoke,
  S3_MINIMUM_MULTIPART_PART_BYTES,
  sha256Hex,
} from "./r2-browser-smoke.mjs";

const validEnvironment = Object.freeze({
  R2_BROWSER_SMOKE: R2_BROWSER_SMOKE_EXACT_OPT_IN,
  S3_CONTROL_ENDPOINT: R2_BROWSER_SMOKE_ENDPOINT,
  S3_PUBLIC_ENDPOINT: R2_BROWSER_SMOKE_ENDPOINT,
  S3_REGION: "auto",
  S3_BUCKET: "slopproof-eu",
  S3_ACCESS_KEY_ID: "runtime-access-id",
  S3_SECRET_ACCESS_KEY: "runtime-secret-that-must-never-be-printed",
});

function createMockBrowser({ rejectPositive = false } = {}) {
  const navigations = [];
  const contexts = [];
  const browser = {
    async newContext() {
      const mode = contexts.length === 0 ? "production" : "wrong-origin";
      const pages = [];
      const context = {
        closed: false,
        async newPage() {
          let currentUrl = "about:blank";
          const page = {
            async goto(url) {
              currentUrl = url;
              navigations.push(url);
            },
            url() {
              return currentUrl;
            },
            async evaluate(_action, input) {
              if (
                rejectPositive ||
                mode === "wrong-origin" ||
                input.target.includes("expires-1")
              ) {
                return { ok: false, status: 0, etag: null };
              }
              const suffix = input.target.endsWith("part-1") ? "one" : "two";
              return { ok: true, status: 200, etag: `\"etag-${suffix}\"` };
            },
          };
          pages.push(page);
          return page;
        },
        async close() {
          this.closed = true;
        },
        pages,
      };
      contexts.push(context);
      return context;
    },
  };
  return { browser, contexts, navigations };
}

function createMockStore(fixture) {
  const created = [];
  const presigns = [];
  const completed = [];
  const aborted = [];
  const deleted = [];
  const listed = [];
  const store = {
    async createMultipartUpload(objectKey) {
      created.push(objectKey);
      return `upload-${created.length}`;
    },
    async presignUploadPart(input) {
      presigns.push(input);
      return `https://account.r2.cloudflarestorage.com/signed-${presigns.length}-expires-${input.expiresInSeconds}${input.partNumber === 1 ? "-part-1" : "-part-2"}`;
    },
    async completeMultipartUpload(input) {
      completed.push(input);
    },
    async abortMultipartUpload(objectKey, uploadId) {
      aborted.push({ objectKey, uploadId });
    },
    async listParts(objectKey, uploadId) {
      listed.push({ objectKey, uploadId });
      return [];
    },
    async headObject() {
      return { byteLength: fixture.ciphertext.byteLength };
    },
    async getObjectStream() {
      return new Blob([fixture.ciphertext]).stream();
    },
    async deleteObject(objectKey) {
      deleted.push(objectKey);
    },
  };
  return { store, created, presigns, completed, aborted, deleted, listed };
}

test("R2 browser smoke requires one exact production opt-in", () => {
  assert.equal(isR2BrowserSmokeEnabled(validEnvironment), true);
  for (const value of [undefined, "", "1", "true", " production-slopproof-eu"])
    assert.equal(isR2BrowserSmokeEnabled({ R2_BROWSER_SMOKE: value }), false);
});

test("environment validation requires exact bucket and server runtime credentials without leakage", () => {
  const values = requireR2BrowserSmokeEnvironment(validEnvironment);
  assert.equal(values.S3_BUCKET, "slopproof-eu");
  assert.equal(
    values.S3_SECRET_ACCESS_KEY,
    validEnvironment.S3_SECRET_ACCESS_KEY,
  );

  for (const endpoint of [
    "https://127.0.0.1/",
    "https://attacker.example/",
    "https://00000000000000000000000000000000.eu.r2.cloudflarestorage.com",
  ]) {
    assert.throws(
      () =>
        requireR2BrowserSmokeEnvironment({
          ...validEnvironment,
          S3_CONTROL_ENDPOINT: endpoint,
        }),
      R2BrowserSmokeError,
    );
  }
  assert.throws(
    () =>
      requireR2BrowserSmokeEnvironment({
        ...validEnvironment,
        S3_REGION: "eu",
      }),
    R2BrowserSmokeError,
  );

  assert.throws(
    () =>
      requireR2BrowserSmokeEnvironment({
        ...validEnvironment,
        S3_BUCKET: "wrong-bucket",
        S3_SECRET_ACCESS_KEY: "do-not-print-this-secret",
      }),
    (error) => {
      assert.ok(error instanceof R2BrowserSmokeError);
      assert.equal(error.code, "invalid_environment");
      assert.deepEqual(error.fields, ["S3_BUCKET"]);
      assert.equal(String(error).includes("do-not-print-this-secret"), false);
      return true;
    },
  );
});

test("runtime loader reads only six credentials from a private owner-only file", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopproof-r2-smoke-"));
  const path = join(directory, "web.env");
  const secret = "runtime-secret-that-must-never-be-printed";
  try {
    writeFileSync(
      path,
      [
        "GITHUB_CLIENT_SECRET='must-not-be-loaded'",
        `S3_CONTROL_ENDPOINT='${R2_BROWSER_SMOKE_ENDPOINT}'`,
        `S3_PUBLIC_ENDPOINT='${R2_BROWSER_SMOKE_ENDPOINT}'`,
        "S3_REGION='auto'",
        "S3_BUCKET='slopproof-eu'",
        "S3_ACCESS_KEY_ID='runtime-access-id'",
        `S3_SECRET_ACCESS_KEY='${secret}'`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const values = loadR2BrowserSmokeEnvironment({
      R2_BROWSER_SMOKE: R2_BROWSER_SMOKE_EXACT_OPT_IN,
      R2_BROWSER_SMOKE_ENV_FILE: path,
    });
    assert.equal(values.S3_SECRET_ACCESS_KEY, secret);
    assert.equal(Object.hasOwn(values, "GITHUB_CLIENT_SECRET"), false);

    assert.throws(
      () =>
        loadR2BrowserSmokeEnvironment({
          R2_BROWSER_SMOKE: R2_BROWSER_SMOKE_EXACT_OPT_IN,
          R2_BROWSER_SMOKE_ENV_FILE: path,
          DEBUG: "pw:api",
        }),
      (error) => {
        assert.ok(error instanceof R2BrowserSmokeError);
        assert.deepEqual(error.fields, ["DEBUG"]);
        return true;
      },
    );

    chmodSync(path, 0o644);
    assert.throws(
      () =>
        loadR2BrowserSmokeEnvironment({
          R2_BROWSER_SMOKE: R2_BROWSER_SMOKE_EXACT_OPT_IN,
          R2_BROWSER_SMOKE_ENV_FILE: path,
        }),
      (error) => {
        assert.ok(error instanceof R2BrowserSmokeError);
        assert.equal(error.code, "unsafe_environment_file");
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("fixture encrypts a plaintext sentinel and yields a valid non-final plus final part", () => {
  const fixture = createCiphertextFixture();
  assert.equal(fixture.firstPart.byteLength, MULTIPART_TARGET_PART_BYTES);
  assert.equal(
    fixture.firstPart.byteLength > S3_MINIMUM_MULTIPART_PART_BYTES,
    true,
  );
  assert.ok(fixture.finalPart.byteLength > 0);
  assert.equal(fixture.ciphertext.includes(fixture.plaintextSentinel), false);
  assert.equal(
    sha256Hex(Buffer.concat([fixture.firstPart, fixture.finalPart])),
    sha256Hex(fixture.ciphertext),
  );
});

test("workflow rejects an exactly-5-MiB non-final fixture before storage access", async () => {
  const fixture = createCiphertextFixture();
  const exactMinimum = fixture.ciphertext.subarray(
    0,
    S3_MINIMUM_MULTIPART_PART_BYTES,
  );
  const invalidFixture = {
    ...fixture,
    firstPart: exactMinimum,
    finalPart: fixture.ciphertext.subarray(S3_MINIMUM_MULTIPART_PART_BYTES),
  };
  const storage = createMockStore(fixture);
  await assert.rejects(
    runR2BrowserSmoke({
      environment: validEnvironment,
      store: storage.store,
      browser: createMockBrowser().browser,
      fixture: invalidFixture,
    }),
    (error) =>
      error instanceof R2BrowserSmokeError && error.code === "invalid_fixture",
  );
  assert.deepEqual(storage.created, []);
});

test("workflow uses the exact origin, completes only the positive upload, verifies and cleans every object", async () => {
  const fixture = createCiphertextFixture();
  const storage = createMockStore(fixture);
  const controlledBrowser = createMockBrowser();
  const waits = [];

  await runR2BrowserSmoke({
    environment: validEnvironment,
    store: storage.store,
    browser: controlledBrowser.browser,
    fixture,
    objectKey: "evidence/v1/positive",
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.equal(controlledBrowser.navigations[0], R2_BROWSER_SMOKE_ORIGIN);
  assert.equal(
    controlledBrowser.navigations[1],
    "data:text/html,slopproof-r2-negative",
  );
  assert.deepEqual(
    storage.presigns.map((input) => input.expiresInSeconds),
    [300, 300, 300, 1],
  );
  assert.equal(storage.presigns[0].byteLength >= 5 * 1024 * 1024, true);
  assert.equal(storage.presigns[1].byteLength > 0, true);
  assert.equal(storage.completed.length, 1);
  assert.deepEqual(
    storage.completed[0].parts.map((part) => part.etag),
    ['"etag-one"', '"etag-two"'],
  );
  assert.equal(storage.aborted.length, 2);
  assert.equal(storage.listed.length, 2);
  assert.deepEqual(waits, [5_000]);
  assert.deepEqual(storage.deleted, ["evidence/v1/positive"]);
  assert.equal(
    controlledBrowser.contexts.every((context) => context.closed),
    true,
  );
});

test("a failed positive browser PUT aborts its multipart and never completes an object", async () => {
  const fixture = createCiphertextFixture();
  const storage = createMockStore(fixture);
  const controlledBrowser = createMockBrowser({ rejectPositive: true });

  await assert.rejects(
    runR2BrowserSmoke({
      environment: validEnvironment,
      store: storage.store,
      browser: controlledBrowser.browser,
      fixture,
      objectKey: "evidence/v1/failure",
      wait: async () => {},
    }),
    (error) =>
      error instanceof R2BrowserSmokeError &&
      error.code === "browser_put_rejected",
  );
  assert.equal(storage.completed.length, 0);
  assert.deepEqual(storage.deleted, ["evidence/v1/failure"]);
  assert.deepEqual(storage.aborted, [
    { objectKey: "evidence/v1/failure", uploadId: "upload-1" },
  ]);
});

test("positive and negative stalled browser evaluations hit their fixed deadline and initiate page close", async () => {
  const bytes = Buffer.from("ciphertext");
  for (const action of [browserPutPart, assertBrowserPutRejected]) {
    let closeInitiated = false;
    const page = {
      evaluate: async () => new Promise(() => {}),
      close: async () => {
        closeInitiated = true;
        return new Promise(() => {});
      },
    };
    await assert.rejects(
      action(page, "https://signed.invalid/private", bytes, 5),
      (error) =>
        error instanceof R2BrowserSmokeError &&
        error.code === "browser_put_rejected" &&
        !String(error).includes("signed.invalid"),
    );
    assert.equal(closeInitiated, true);
  }
});

test("a stalled positive evaluate still aborts and deletes its temporary object", async () => {
  const fixture = createCiphertextFixture();
  const storage = createMockStore(fixture);
  const controlledBrowser = createMockBrowser();
  controlledBrowser.browser.newContext = async () => ({
    newPage: async () => ({
      goto: async () => {},
      url: () => R2_BROWSER_SMOKE_ORIGIN,
      evaluate: async () => new Promise(() => {}),
      close: async () => new Promise(() => {}),
    }),
    close: async () => new Promise(() => {}),
  });

  await assert.rejects(
    runR2BrowserSmoke({
      environment: validEnvironment,
      store: storage.store,
      browser: controlledBrowser.browser,
      fixture,
      objectKey: "evidence/v1/stalled-positive-put",
      operationDeadlineMs: 5,
      wait: async () => {},
    }),
    (error) =>
      error instanceof R2BrowserSmokeError && error.code === "cleanup_failed",
  );
  assert.deepEqual(storage.aborted, [
    {
      objectKey: "evidence/v1/stalled-positive-put",
      uploadId: "upload-1",
    },
  ]);
  assert.deepEqual(storage.deleted, ["evidence/v1/stalled-positive-put"]);
});

test("stalled wrong-origin evaluate and context close cannot block multipart abort or object deletion", async () => {
  const fixture = createCiphertextFixture();
  const storage = createMockStore(fixture);
  const controlledBrowser = createMockBrowser();
  const originalNewContext = controlledBrowser.browser.newContext;
  let contextNumber = 0;
  controlledBrowser.browser.newContext = async () => {
    contextNumber += 1;
    const context = await originalNewContext();
    if (contextNumber === 2) {
      context.pages.length = 0;
      context.newPage = async () => ({
        goto: async () => {},
        url: () => "data:text/html,slopproof-r2-negative",
        evaluate: async () => new Promise(() => {}),
        close: async () => new Promise(() => {}),
      });
      context.close = async () => new Promise(() => {});
    }
    return context;
  };

  await assert.rejects(
    runR2BrowserSmoke({
      environment: validEnvironment,
      store: storage.store,
      browser: controlledBrowser.browser,
      fixture,
      objectKey: "evidence/v1/stalled-negative-put",
      operationDeadlineMs: 5,
      wait: async () => {},
    }),
    (error) =>
      error instanceof R2BrowserSmokeError && error.code === "cleanup_failed",
  );
  assert.deepEqual(storage.aborted, [
    {
      objectKey: storage.created[1],
      uploadId: "upload-2",
    },
  ]);
  assert.deepEqual(storage.deleted, ["evidence/v1/stalled-negative-put"]);
});

test("stalled presign and expiry wait are bounded and preserve storage cleanup", async () => {
  const fixture = createCiphertextFixture();

  const presignStorage = createMockStore(fixture);
  presignStorage.store.presignUploadPart = async () => new Promise(() => {});
  await assert.rejects(
    runR2BrowserSmoke({
      environment: validEnvironment,
      store: presignStorage.store,
      browser: createMockBrowser().browser,
      fixture,
      objectKey: "evidence/v1/stalled-presign",
      operationDeadlineMs: 5,
      wait: async () => {},
    }),
    (error) =>
      error instanceof R2BrowserSmokeError &&
      error.code === "control_operation_failed",
  );
  assert.equal(presignStorage.aborted.length, 1);
  assert.deepEqual(presignStorage.deleted, ["evidence/v1/stalled-presign"]);

  const waitStorage = createMockStore(fixture);
  await assert.rejects(
    runR2BrowserSmoke({
      environment: validEnvironment,
      store: waitStorage.store,
      browser: createMockBrowser().browser,
      fixture,
      objectKey: "evidence/v1/stalled-wait",
      operationDeadlineMs: 5,
      wait: async () => new Promise(() => {}),
    }),
    (error) =>
      error instanceof R2BrowserSmokeError &&
      error.code === "control_operation_failed",
  );
  assert.deepEqual(
    waitStorage.aborted.map(({ uploadId }) => uploadId),
    ["upload-2", "upload-3"],
  );
  assert.deepEqual(waitStorage.deleted, ["evidence/v1/stalled-wait"]);
});

test("outer browser close has a fixed cleanup deadline", async () => {
  await assert.rejects(
    closeR2BrowserSmokeBrowser({ close: async () => new Promise(() => {}) }, 5),
    (error) =>
      error instanceof R2BrowserSmokeError && error.code === "cleanup_failed",
  );
});

test("a stalled body and never-settling cancel cannot block the deadline or object deletion", async () => {
  const fixture = createCiphertextFixture();
  const storage = createMockStore(fixture);
  let cancelled = false;
  storage.store.getObjectStream = async () => ({
    getReader: () => ({
      read: async () => new Promise(() => {}),
      cancel: async () => {
        cancelled = true;
        return new Promise(() => {});
      },
    }),
  });

  let watchdog;
  try {
    await assert.rejects(
      Promise.race([
        runR2BrowserSmoke({
          environment: validEnvironment,
          store: storage.store,
          browser: createMockBrowser().browser,
          fixture,
          objectKey: "evidence/v1/stalled",
          bodyDeadlineMs: 5,
          wait: async () => {},
        }),
        new Promise((_resolve, reject) => {
          watchdog = setTimeout(
            () => reject(new Error("R2 browser smoke did not settle")),
            250,
          );
        }),
      ]),
      (error) =>
        error instanceof R2BrowserSmokeError &&
        error.code === "control_operation_failed",
    );
  } finally {
    clearTimeout(watchdog);
  }
  assert.equal(cancelled, true);
  assert.deepEqual(storage.deleted, ["evidence/v1/stalled"]);
});

test("guard refuses silently and reports only safe fixed messages", async () => {
  let invoked = false;
  const refusedStderr = [];
  const refused = await runGuardedR2BrowserSmoke({
    environment: {},
    action: async () => {
      invoked = true;
    },
    stdout: { write: () => assert.fail("refusal must not write success") },
    stderr: { write: (value) => refusedStderr.push(value) },
  });
  assert.equal(refused, 2);
  assert.equal(invoked, false);
  assert.deepEqual(refusedStderr, [
    "r2-browser: refused; set R2_BROWSER_SMOKE=production-slopproof-eu to authorize a production storage smoke.\n",
  ]);

  const secret = "signed-url-object-key-etag-secret";
  const failedStderr = [];
  const failed = await runGuardedR2BrowserSmoke({
    environment: validEnvironment,
    action: async () => {
      throw new Error(secret);
    },
    stdout: { write: () => assert.fail("failure must not write success") },
    stderr: { write: (value) => failedStderr.push(value) },
  });
  assert.equal(failed, 1);
  assert.equal(failedStderr.join("").includes(secret), false);
  assert.deepEqual(failedStderr, [
    "r2-browser: failed (unexpected_failure).\n",
  ]);

  const craftedStderr = [];
  await runGuardedR2BrowserSmoke({
    environment: validEnvironment,
    action: async () => {
      throw new R2BrowserSmokeError(secret);
    },
    stdout: { write: () => assert.fail("failure must not write success") },
    stderr: { write: (value) => craftedStderr.push(value) },
  });
  assert.equal(craftedStderr.join("").includes(secret), false);
  assert.deepEqual(craftedStderr, [
    "r2-browser: failed (unexpected_failure).\n",
  ]);
});
