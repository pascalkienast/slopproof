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

const MAX_INPUT_BYTES = 4096;

function fail() {
  throw new Error("invalid drop proof");
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES) fail();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validate(value, expectedDatabase) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !==
      "databaseName,databasePresent,schema" ||
    value.schema !== "slopproof.database-drop-proof.v1" ||
    value.databaseName !== expectedDatabase ||
    value.databasePresent !== false ||
    !/^slopproof_restore_\d{8}_\d{6}$/u.test(expectedDatabase)
  ) {
    fail();
  }
  return value;
}

function writeExclusive(path, value) {
  if (!isAbsolute(path) || resolve(path) !== path) fail();
  const parent = dirname(path);
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    realpathSync(parent) !== parent ||
    (stat.mode & 0o777) !== 0o700
  ) {
    fail();
  }
  const descriptor = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    const output = fstatSync(descriptor);
    if ((output.mode & 0o777) !== 0o600 || output.nlink !== 1) fail();
  } finally {
    closeSync(descriptor);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (
    argv.length !== 4 ||
    argv[0] !== "--expected-database" ||
    argv[2] !== "--output"
  ) {
    fail();
  }
  const value = validate(JSON.parse((await readInput()).trim()), argv[1]);
  writeExclusive(argv[3], value);
  process.stdout.write("Restore database absence verified.\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch {
    process.stderr.write("Restore database absence verification failed.\n");
    process.exitCode = 1;
  }
}
