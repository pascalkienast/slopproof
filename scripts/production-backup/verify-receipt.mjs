#!/usr/bin/env node

import { createHash, X509Certificate } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyCmsArtifact } from "./cms-artifact.mjs";

const RECEIPT_SCHEMA = "slopproof.encrypted-backup-receipt.v1";
const TRANSPORT = "ssh-pg-dump-to-local-openssl-cms";
const CIPHER = "CMS-AuthEnvelopedData/RSA-OAEP-SHA256/AES-256-GCM/BER-stream";
const MAX_CIPHERTEXT_BYTES = 1024 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024;
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SECRET_ROOT = resolve(homedir(), ".secrets");

const TOP_LEVEL_KEYS = Object.freeze([
  "cipher",
  "ciphertext",
  "commit",
  "imageDigest",
  "plaintextOnMac",
  "plaintextOnVm",
  "recipient",
  "releaseId",
  "restoreRehearsal",
  "schema",
  "source",
  "timestamp",
  "transport",
]);
const COUNT_KEYS = Object.freeze([
  "constraintCount",
  "migrationCount",
  "retentionInvariantViolations",
  "tableCount",
  "triggerCount",
]);

export class BackupReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupReceiptError";
  }
}

function fail(message) {
  throw new BackupReceiptError(message);
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unexpected field set`);
  }
}

function isInside(path, directory) {
  return path === directory || path.startsWith(`${directory}/`);
}

function assertOwnerControlledFile(path, label, exactMode) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail(`${label} must be one normalized absolute path`);
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    realpathSync(path) !== path
  ) {
    fail(`${label} must be one owner-controlled regular file`);
  }
  const mode = stat.mode & 0o777;
  if (
    (exactMode !== undefined && mode !== exactMode) ||
    (exactMode === undefined && (mode & 0o022) !== 0)
  ) {
    fail(`${label} has an unsafe mode`);
  }
  return stat;
}

function assertProtectedParentDirectory(path, label) {
  const parent = dirname(path);
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    realpathSync(parent) !== parent ||
    (stat.mode & 0o777) !== 0o700
  ) {
    fail(`${label} parent directory is not owner-private`);
  }
}

function assertAbsent(path, label) {
  try {
    lstatSync(path);
    fail(`${label} must be absent`);
  } catch (error) {
    if (error instanceof BackupReceiptError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

function readReceipt(receiptPath) {
  assertProtectedParentDirectory(receiptPath, "receipt");
  assertOwnerControlledFile(receiptPath, "receipt", 0o600);
  const descriptor = openSync(
    receiptPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    if (stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
      fail("receipt has an invalid size");
    }
    const source = readFileSync(descriptor, "utf8");
    if (source.includes("\0")) fail("receipt is not text JSON");
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof BackupReceiptError) throw error;
    fail("receipt is not valid JSON");
  } finally {
    closeSync(descriptor);
  }
}

function requireString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} has an invalid format`);
  }
}

function parseUtcTimestamp(value, label) {
  requireString(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u, label);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value.replace("Z", ".000Z")
  ) {
    fail(`${label} is not a real UTC timestamp`);
  }
  return milliseconds;
}

function validateCounts(value, label) {
  exactKeys(value, COUNT_KEYS, label);
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail(`${label}.${key} must be a non-negative safe integer`);
    }
  }
  if (value.retentionInvariantViolations !== 0) {
    fail(`${label} reports a retention invariant violation`);
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function certificateFingerprint(certificatePath, timestamp) {
  assertOwnerControlledFile(certificatePath, "recipient certificate");
  let certificate;
  try {
    certificate = new X509Certificate(readFileSync(certificatePath));
  } catch {
    fail("recipient certificate is not a valid X.509 certificate");
  }
  if (
    certificate.ca ||
    certificate.publicKey.asymmetricKeyType !== "rsa" ||
    certificate.publicKey.asymmetricKeyDetails?.modulusLength !== 3072
  ) {
    fail("recipient certificate is not a non-CA RSA-3072 certificate");
  }
  if (
    timestamp < Date.parse(certificate.validFrom) ||
    timestamp > Date.parse(certificate.validTo)
  ) {
    fail("recipient certificate was not valid at the backup timestamp");
  }
  return createHash("sha256").update(certificate.raw).digest("hex");
}

export async function verifyBackupReceipt({
  receiptPath,
  recipientCertificatePath,
  expectedReleaseId,
  expectedCommit,
  expectedImageDigest,
  expectedCiphertextSha256,
}) {
  requireString(expectedReleaseId, /^\d{8}T\d{6}Z$/u, "expected release ID");
  requireString(expectedCommit, /^[a-f0-9]{40}$/u, "expected commit");
  requireString(
    expectedImageDigest,
    /^sha256:[a-f0-9]{64}$/u,
    "expected image digest",
  );
  requireString(
    expectedCiphertextSha256,
    /^[a-f0-9]{64}$/u,
    "expected ciphertext SHA-256",
  );

  const receiptDirectory = dirname(receiptPath);
  const backupRoot = dirname(receiptDirectory);
  if (
    basename(receiptPath) !== `${expectedReleaseId}.receipt.json` ||
    basename(receiptDirectory) !== expectedReleaseId
  ) {
    fail("receipt path does not match the release");
  }
  assertProtectedParentDirectory(receiptDirectory, "release directory");
  assertProtectedParentDirectory(receiptPath, "receipt");
  const backupRootStat = lstatSync(backupRoot);
  if (
    !backupRootStat.isDirectory() ||
    backupRootStat.isSymbolicLink() ||
    backupRootStat.uid !== process.getuid() ||
    realpathSync(backupRoot) !== backupRoot ||
    (backupRootStat.mode & 0o777) !== 0o700
  ) {
    fail("backup root is not an owner-controlled mode-0700 directory");
  }
  assertAbsent(
    join(receiptDirectory, `${expectedReleaseId}.cms.partial`),
    "CMS partial artifact",
  );
  assertAbsent(
    join(receiptDirectory, `${expectedReleaseId}.receipt.json.partial`),
    "receipt partial artifact",
  );

  const receipt = readReceipt(receiptPath);
  exactKeys(receipt, TOP_LEVEL_KEYS, "receipt");
  if (receipt.schema !== RECEIPT_SCHEMA) fail("receipt schema is unsupported");
  if (receipt.releaseId !== expectedReleaseId)
    fail("release ID does not match");
  if (receipt.commit !== expectedCommit) fail("commit does not match");
  if (receipt.imageDigest !== expectedImageDigest) {
    fail("image digest does not match");
  }
  if (receipt.transport !== TRANSPORT) fail("transport is unsupported");
  if (receipt.cipher !== CIPHER) fail("cipher suite is unsupported");
  if (receipt.plaintextOnVm !== false || receipt.plaintextOnMac !== false) {
    fail("plaintext assertions must both be false");
  }

  const timestamp = parseUtcTimestamp(receipt.timestamp, "backup timestamp");

  exactKeys(
    receipt.ciphertext,
    ["absolutePath", "bytes", "sha256"],
    "ciphertext",
  );
  requireString(
    receipt.ciphertext.sha256,
    /^[a-f0-9]{64}$/u,
    "ciphertext SHA-256",
  );
  if (receipt.ciphertext.sha256 !== expectedCiphertextSha256) {
    fail("ciphertext SHA-256 does not match the expected value");
  }
  if (
    typeof receipt.ciphertext.absolutePath !== "string" ||
    receipt.ciphertext.absolutePath !==
      join(receiptDirectory, `${expectedReleaseId}.cms`) ||
    isInside(resolve(receipt.ciphertext.absolutePath), REPOSITORY_ROOT) ||
    isInside(resolve(receipt.ciphertext.absolutePath), SECRET_ROOT)
  ) {
    fail("ciphertext path crosses a protected boundary");
  }
  await verifyCmsArtifact(receipt.ciphertext.absolutePath, expectedReleaseId);
  assertProtectedParentDirectory(receipt.ciphertext.absolutePath, "ciphertext");
  const ciphertextStat = assertOwnerControlledFile(
    receipt.ciphertext.absolutePath,
    "ciphertext",
    0o600,
  );
  if (
    !Number.isSafeInteger(receipt.ciphertext.bytes) ||
    receipt.ciphertext.bytes < 1 ||
    receipt.ciphertext.bytes > MAX_CIPHERTEXT_BYTES ||
    receipt.ciphertext.bytes !== ciphertextStat.size
  ) {
    fail("ciphertext byte count is invalid");
  }
  if (
    (await sha256File(receipt.ciphertext.absolutePath)) !==
    receipt.ciphertext.sha256
  ) {
    fail("ciphertext content does not match its SHA-256");
  }

  exactKeys(receipt.recipient, ["certificateSha256"], "recipient");
  requireString(
    receipt.recipient.certificateSha256,
    /^[a-f0-9]{64}$/u,
    "recipient certificate SHA-256",
  );
  assertProtectedParentDirectory(
    recipientCertificatePath,
    "recipient certificate",
  );
  if (
    certificateFingerprint(recipientCertificatePath, timestamp) !==
    receipt.recipient.certificateSha256
  ) {
    fail("recipient certificate fingerprint does not match");
  }

  exactKeys(receipt.source, ["postgresVersion", ...COUNT_KEYS], "source");
  requireString(
    receipt.source.postgresVersion,
    /^\d+(?:\.\d+){1,2}(?:[-+][A-Za-z0-9.]+)?$/u,
    "PostgreSQL version",
  );
  validateCounts(
    Object.fromEntries(COUNT_KEYS.map((key) => [key, receipt.source[key]])),
    "source counts",
  );

  exactKeys(
    receipt.restoreRehearsal,
    [
      "ciphertextSha256",
      "completedAt",
      "databaseName",
      "dropped",
      "startedAt",
      "status",
      ...COUNT_KEYS,
    ],
    "restore rehearsal",
  );
  requireString(
    receipt.restoreRehearsal.databaseName,
    /^slopproof_restore_\d{8}_\d{6}$/u,
    "restore database name",
  );
  const rehearsalStart = parseUtcTimestamp(
    receipt.restoreRehearsal.startedAt,
    "restore start timestamp",
  );
  const rehearsalEnd = parseUtcTimestamp(
    receipt.restoreRehearsal.completedAt,
    "restore completion timestamp",
  );
  if (rehearsalStart < timestamp || rehearsalEnd < rehearsalStart) {
    fail("restore timestamps are out of order");
  }
  if (
    receipt.restoreRehearsal.status !== "passed" ||
    receipt.restoreRehearsal.dropped !== true ||
    receipt.restoreRehearsal.ciphertextSha256 !== receipt.ciphertext.sha256
  ) {
    fail("restore rehearsal is incomplete");
  }
  validateCounts(
    Object.fromEntries(
      COUNT_KEYS.map((key) => [key, receipt.restoreRehearsal[key]]),
    ),
    "restore counts",
  );
  for (const key of COUNT_KEYS) {
    if (receipt.restoreRehearsal[key] !== receipt.source[key]) {
      fail("source and restored database counts differ");
    }
  }

  return Object.freeze({
    releaseId: receipt.releaseId,
    commit: receipt.commit,
    imageDigest: receipt.imageDigest,
    ciphertextSha256: receipt.ciphertext.sha256,
    backupTimestamp: receipt.timestamp,
    restoreCompletedAt: receipt.restoreRehearsal.completedAt,
  });
}

function parseArguments(argv) {
  const names = new Set([
    "--receipt",
    "--recipient-certificate",
    "--release-id",
    "--commit",
    "--image-digest",
    "--ciphertext-sha256",
  ]);
  if (argv.length !== names.size * 2) fail("invalid arguments");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.has(name) || values.has(name) || !value)
      fail("invalid arguments");
    values.set(name, value);
  }
  return {
    receiptPath: values.get("--receipt"),
    recipientCertificatePath: values.get("--recipient-certificate"),
    expectedReleaseId: values.get("--release-id"),
    expectedCommit: values.get("--commit"),
    expectedImageDigest: values.get("--image-digest"),
    expectedCiphertextSha256: values.get("--ciphertext-sha256"),
  };
}

async function main() {
  await verifyBackupReceipt(parseArguments(process.argv.slice(2)));
  process.stdout.write("Encrypted backup receipt verified.\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch {
    process.stderr.write("Encrypted backup receipt verification failed.\n");
    process.exitCode = 1;
  }
}
