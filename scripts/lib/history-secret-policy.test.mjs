import assert from "node:assert/strict";
import test from "node:test";

import { isSensitiveHistoryPath } from "./history-secret-policy.mjs";

test("history policy allows only the documented environment examples", () => {
  for (const path of [
    ".env.example",
    "docs/local.env.example",
    ".env.production.example",
  ]) {
    assert.equal(isSensitiveHistoryPath(path), false, path);
  }

  for (const path of [
    ".env",
    ".env.production",
    "docs/.env.local",
    "docs/.env.production.example",
  ]) {
    assert.equal(isSensitiveHistoryPath(path), true, path);
  }
});

test("history policy still rejects secret containers, keys and backups", () => {
  for (const path of [
    ".secrets/service.env",
    "secrets/token",
    "node_modules/package/index.js",
    "backup/database.dump",
    "key.pem",
    "identity.key",
    "database.backup",
  ]) {
    assert.equal(isSensitiveHistoryPath(path), true, path);
  }

  assert.equal(isSensitiveHistoryPath("infra/docker/secrets/.gitkeep"), false);
  assert.equal(isSensitiveHistoryPath("apps/web/app/page.tsx"), false);
});
