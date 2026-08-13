#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DATABASE_AUDIT_SCHEMA = "slopproof.database-audit.v1";
export const DATABASE_COUNT_KEYS = Object.freeze([
  "constraintCount",
  "migrationCount",
  "retentionInvariantViolations",
  "tableCount",
  "triggerCount",
]);
const AUDIT_KEYS = Object.freeze([
  ...DATABASE_COUNT_KEYS,
  "postgresVersion",
  "schema",
]);
const MAX_INPUT_BYTES = 16 * 1024;

export class DatabaseAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseAuditError";
  }
}

function fail(message) {
  throw new DatabaseAuditError(message);
}

function exactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unexpected field set`);
  }
}

export function validateDatabaseAudit(value) {
  exactKeys(value, AUDIT_KEYS, "database audit");
  if (value.schema !== DATABASE_AUDIT_SCHEMA) {
    fail("database audit schema is unsupported");
  }
  if (
    typeof value.postgresVersion !== "string" ||
    !/^\d+(?:\.\d+){1,2}(?:[-+][A-Za-z0-9.]+)?$/u.test(value.postgresVersion)
  ) {
    fail("PostgreSQL version is invalid");
  }
  for (const key of DATABASE_COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail(`database audit ${key} is invalid`);
    }
  }
  if (value.retentionInvariantViolations !== 0) {
    fail("database audit found a retention invariant violation");
  }
  return Object.freeze({ ...value });
}

export function parseDatabaseAudit(source) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) > MAX_INPUT_BYTES ||
    source.includes("\0")
  ) {
    fail("database audit output is not bounded text");
  }
  try {
    return validateDatabaseAudit(JSON.parse(source.trim()));
  } catch (error) {
    if (error instanceof DatabaseAuditError) throw error;
    fail("database audit output is not valid JSON");
  }
}

function assertPrivateParent(path) {
  const parent = dirname(path);
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("database audit output path must be normalized and absolute");
  }
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    realpathSync(parent) !== parent ||
    (stat.mode & 0o077) !== 0
  ) {
    fail("database audit output parent must be owner-private");
  }
}

function writeExclusive(path, audit) {
  assertPrivateParent(path);
  const descriptor = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(audit)}\n`, "utf8");
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      fail("database audit output metadata is unsafe");
    }
  } finally {
    closeSync(descriptor);
  }
}

async function readStandardInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES)
      fail("database audit output exceeded its bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    fail("invalid arguments");
  }
  return argv[1];
}

async function main() {
  const output = parseArguments(process.argv.slice(2));
  const audit = parseDatabaseAudit(await readStandardInput());
  writeExclusive(output, audit);
  process.stdout.write("Database audit verified.\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch {
    process.stderr.write("Database audit verification failed.\n");
    process.exitCode = 1;
  }
}
