import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function json(relativePath) {
  return JSON.parse(
    readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8"),
  );
}

test("production browser CORS is exact and ciphertext-upload only", () => {
  const policy = json("infra/cloudflare/r2-cors.production.json");
  assert.deepEqual(policy, {
    rules: [
      {
        id: "slopproof-browser-ciphertext-put-v1",
        allowed: {
          origins: ["https://slopproof.paskie.me"],
          methods: ["PUT"],
          headers: ["content-type"],
        },
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 300,
      },
    ],
  });
});

test("lifecycle backs up both ciphertext prefixes without extending app retention", () => {
  const policy = json("infra/cloudflare/r2-lifecycle.production.json");
  const [recordings, frames] = policy.rules;

  assert.equal(recordings.conditions.prefix, "evidence/v1/");
  assert.equal(recordings.deleteObjectsTransition.condition.maxAge, 172800);
  assert.equal(
    recordings.abortMultipartUploadsTransition.condition.maxAge,
    86400,
  );
  assert.equal(frames.conditions.prefix, "provider-frame/");
  assert.equal(frames.deleteObjectsTransition.condition.maxAge, 172800);
});

test("local fake CORS mirrors the narrow production browser contract", () => {
  const source = readFileSync(
    new URL("../../infra/docker/init-storage.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /AllowedMethods: \["PUT"\]/u);
  assert.match(source, /AllowedHeaders: \["content-type"\]/u);
  assert.doesNotMatch(source, /x-amz-\*/u);
  assert.match(source, /ExposeHeaders: \["ETag"\]/u);
});
