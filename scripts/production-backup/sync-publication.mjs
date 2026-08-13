#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPrivateCanonicalDirectory,
  assertPrivateRegularFile,
  MAX_CMS_BYTES,
} from "./cms-artifact.mjs";

const MAX_RECEIPT_BYTES = 64 * 1024;

export class BackupPublicationSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupPublicationSyncError";
  }
}

function fail(message) {
  throw new BackupPublicationSyncError(message);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertHeldDirectory(descriptor, expected, label) {
  const actual = fstatSync(descriptor);
  if (
    !actual.isDirectory() ||
    actual.uid !== process.getuid() ||
    (actual.mode & 0o777) !== 0o700 ||
    !sameFile(actual, expected)
  ) {
    fail(`${label} identity changed`);
  }
}

function assertPathIdentity(path, expected, label) {
  const actual = lstatSync(path);
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.uid !== process.getuid() ||
    (actual.mode & 0o777) !== 0o700 ||
    !sameFile(actual, expected) ||
    realpathSync(path) !== path
  ) {
    fail(`${label} identity changed`);
  }
}

function assertArtifactSet(releaseDirectory, releaseId) {
  const expected = [`${releaseId}.cms`, `${releaseId}.receipt.json`];
  const actual = readdirSync(releaseDirectory).sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    fail("backup release artifact set is not final");
  }
  assertPrivateRegularFile(
    join(releaseDirectory, expected[0]),
    "CMS artifact",
    MAX_CMS_BYTES,
  );
  assertPrivateRegularFile(
    join(releaseDirectory, expected[1]),
    "backup receipt",
    MAX_RECEIPT_BYTES,
  );
}

export function syncBackupPublication({
  backupRoot,
  releaseDirectory,
  releaseId,
}) {
  if (
    !/^\d{8}T\d{6}Z$/u.test(releaseId) ||
    !isAbsolute(backupRoot) ||
    resolve(backupRoot) !== backupRoot ||
    releaseDirectory !== join(backupRoot, releaseId)
  ) {
    fail("backup publication path is invalid");
  }

  const backupRootBefore = assertPrivateCanonicalDirectory(
    backupRoot,
    "backup root",
  );
  const releaseBefore = assertPrivateCanonicalDirectory(
    releaseDirectory,
    "backup release directory",
  );
  assertArtifactSet(releaseDirectory, releaseId);

  const backupRootDescriptor = openSync(
    backupRoot,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const releaseDescriptor = openSync(
    releaseDirectory,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    assertHeldDirectory(backupRootDescriptor, backupRootBefore, "backup root");
    assertHeldDirectory(
      releaseDescriptor,
      releaseBefore,
      "backup release directory",
    );

    fsyncSync(releaseDescriptor);
    assertPathIdentity(
      releaseDirectory,
      releaseBefore,
      "backup release directory",
    );
    assertArtifactSet(releaseDirectory, releaseId);

    fsyncSync(backupRootDescriptor);
    assertPathIdentity(backupRoot, backupRootBefore, "backup root");
    assertPathIdentity(
      releaseDirectory,
      releaseBefore,
      "backup release directory",
    );
    assertArtifactSet(releaseDirectory, releaseId);
  } finally {
    closeSync(releaseDescriptor);
    closeSync(backupRootDescriptor);
  }
}

function parseArguments(argv) {
  if (
    argv.length !== 6 ||
    argv[0] !== "--backup-root" ||
    argv[2] !== "--release-directory" ||
    argv[4] !== "--release-id"
  ) {
    fail("invalid arguments");
  }
  return {
    backupRoot: argv[1],
    releaseDirectory: argv[3],
    releaseId: argv[5],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    syncBackupPublication(parseArguments(process.argv.slice(2)));
    process.stdout.write("Backup publication is durable.\n");
  } catch {
    process.stderr.write("Backup publication durability check failed.\n");
    process.exitCode = 1;
  }
}
