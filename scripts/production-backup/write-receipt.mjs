#!/usr/bin/env node

import { createHash, X509Certificate } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertPrivateCanonicalDirectory,
  assertPrivateRegularFile,
  MAX_CMS_BYTES,
  verifyCmsArtifact,
} from "./cms-artifact.mjs";
import {
  DATABASE_COUNT_KEYS,
  parseDatabaseAudit,
} from "./validate-database-audit.mjs";

const SCHEMA = "slopproof.encrypted-backup-receipt.v1";
const TRANSPORT = "ssh-pg-dump-to-local-openssl-cms";
const CIPHER = "CMS-AuthEnvelopedData/RSA-OAEP-SHA256/AES-256-GCM/BER-stream";
const MAX_AUDIT_BYTES = 16 * 1024;

export class BackupReceiptWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupReceiptWriteError";
  }
}

function fail(message) {
  throw new BackupReceiptWriteError(message);
}

function requirePattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
}

function parseUtc(value, label) {
  requirePattern(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u, label);
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== value.replace("Z", ".000Z")
  ) {
    fail(`${label} is not a real UTC timestamp`);
  }
  return time;
}

function assertCertificate(path, timestamp) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("recipient certificate path must be normalized and absolute");
  }
  assertPrivateCanonicalDirectory(dirname(path), "recipient key directory");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let certificate;
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o022) !== 0 ||
      stat.size < 1 ||
      stat.size > 64 * 1024 ||
      realpathSync(path) !== path
    ) {
      fail("recipient certificate metadata is unsafe");
    }
    certificate = new X509Certificate(readFileSync(descriptor));
  } catch (error) {
    if (error instanceof BackupReceiptWriteError) throw error;
    fail("recipient certificate is invalid");
  } finally {
    closeSync(descriptor);
  }
  if (
    certificate.ca ||
    certificate.publicKey.asymmetricKeyType !== "rsa" ||
    certificate.publicKey.asymmetricKeyDetails?.modulusLength !== 3072 ||
    timestamp < Date.parse(certificate.validFrom) ||
    timestamp > Date.parse(certificate.validTo)
  ) {
    fail("recipient certificate is outside the production profile");
  }
  return createHash("sha256").update(certificate.raw).digest("hex");
}

function readAudit(path, expectedName, releaseDirectory) {
  if (path !== join(releaseDirectory, expectedName)) {
    fail("database audit path does not match the release workflow");
  }
  assertPrivateRegularFile(path, "database audit", MAX_AUDIT_BYTES);
  return parseDatabaseAudit(readFileSync(path, "utf8"));
}

function readDropProof(path, releaseDirectory, expectedDatabaseName) {
  if (path !== join(releaseDirectory, ".drop-proof.json")) {
    fail("drop proof path does not match the release workflow");
  }
  assertPrivateRegularFile(path, "drop proof", MAX_AUDIT_BYTES);
  let proof;
  try {
    proof = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("drop proof is not valid JSON");
  }
  if (
    proof === null ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    Object.getPrototypeOf(proof) !== Object.prototype ||
    Object.keys(proof).sort().join(",") !==
      "databaseName,databasePresent,schema" ||
    proof.schema !== "slopproof.database-drop-proof.v1" ||
    proof.databaseName !== expectedDatabaseName ||
    proof.databasePresent !== false
  ) {
    fail("drop proof is not valid for the restore database");
  }
  return proof;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertAbsent(path, label) {
  try {
    lstatSync(path);
    fail(`${label} already exists`);
  } catch (error) {
    if (error instanceof BackupReceiptWriteError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

function writeReceiptExclusive(partialPath, outputPath, receipt) {
  assertAbsent(partialPath, "receipt partial");
  assertAbsent(outputPath, "receipt output");
  const descriptor = openSync(
    partialPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
      fail("receipt partial metadata is unsafe");
    }
  } finally {
    closeSync(descriptor);
  }

  try {
    linkSync(partialPath, outputPath);
    unlinkSync(partialPath);
    const directoryDescriptor = openSync(
      dirname(outputPath),
      constants.O_RDONLY,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    try {
      unlinkSync(outputPath);
    } catch {}
    try {
      unlinkSync(partialPath);
    } catch {}
    throw error;
  }
}

export async function writeBackupReceipt({
  releaseId,
  commit,
  imageDigest,
  timestamp,
  ciphertextPath,
  recipientCertificatePath,
  sourceAuditPath,
  restoreAuditPath,
  dropProofPath,
  restoreDatabaseName,
  restoreStartedAt,
  restoreCompletedAt,
  outputPath,
}) {
  requirePattern(releaseId, /^\d{8}T\d{6}Z$/u, "release ID");
  requirePattern(commit, /^[a-f0-9]{40}$/u, "commit");
  requirePattern(imageDigest, /^sha256:[a-f0-9]{64}$/u, "image digest");
  requirePattern(
    restoreDatabaseName,
    /^slopproof_restore_\d{8}_\d{6}$/u,
    "restore database name",
  );
  const backupTime = parseUtc(timestamp, "backup timestamp");
  const restoreStart = parseUtc(restoreStartedAt, "restore start timestamp");
  const restoreEnd = parseUtc(
    restoreCompletedAt,
    "restore completion timestamp",
  );
  if (restoreStart < backupTime || restoreEnd < restoreStart) {
    fail("backup and restore timestamps are out of order");
  }

  const releaseDirectory = dirname(outputPath);
  const backupRoot = dirname(releaseDirectory);
  if (
    basename(releaseDirectory) !== releaseId ||
    basename(outputPath) !== `${releaseId}.receipt.json` ||
    ciphertextPath !== join(releaseDirectory, `${releaseId}.cms`)
  ) {
    fail("receipt artifacts do not match the release directory");
  }
  assertPrivateCanonicalDirectory(backupRoot, "backup root");
  assertPrivateCanonicalDirectory(releaseDirectory, "backup release directory");
  const ciphertext = assertPrivateRegularFile(
    ciphertextPath,
    "CMS artifact",
    MAX_CMS_BYTES,
  );
  await verifyCmsArtifact(ciphertextPath, releaseId);

  const source = readAudit(
    sourceAuditPath,
    ".source-audit.json",
    releaseDirectory,
  );
  const restored = readAudit(
    restoreAuditPath,
    ".restore-audit.json",
    releaseDirectory,
  );
  readDropProof(dropProofPath, releaseDirectory, restoreDatabaseName);
  if (source.postgresVersion !== restored.postgresVersion) {
    fail("source and restore PostgreSQL versions differ");
  }
  for (const key of DATABASE_COUNT_KEYS) {
    if (source[key] !== restored[key]) {
      fail("source and restore database counts differ");
    }
  }

  const ciphertextSha256 = await sha256File(ciphertextPath);
  const certificateSha256 = assertCertificate(
    recipientCertificatePath,
    backupTime,
  );
  const counts = Object.fromEntries(
    DATABASE_COUNT_KEYS.map((key) => [key, source[key]]),
  );
  const receipt = {
    schema: SCHEMA,
    releaseId,
    commit,
    imageDigest,
    timestamp,
    transport: TRANSPORT,
    cipher: CIPHER,
    ciphertext: {
      absolutePath: ciphertextPath,
      sha256: ciphertextSha256,
      bytes: ciphertext.size,
    },
    recipient: { certificateSha256 },
    source: { postgresVersion: source.postgresVersion, ...counts },
    plaintextOnVm: false,
    plaintextOnMac: false,
    restoreRehearsal: {
      databaseName: restoreDatabaseName,
      startedAt: restoreStartedAt,
      completedAt: restoreCompletedAt,
      ciphertextSha256,
      status: "passed",
      ...counts,
      dropped: true,
    },
  };
  const partialPath = join(
    releaseDirectory,
    `${releaseId}.receipt.json.partial`,
  );
  writeReceiptExclusive(partialPath, outputPath, receipt);
  return Object.freeze({ ciphertextSha256 });
}

function parseArguments(argv) {
  const names = new Set([
    "--release-id",
    "--commit",
    "--image-digest",
    "--timestamp",
    "--ciphertext",
    "--recipient-certificate",
    "--source-audit",
    "--restore-audit",
    "--drop-proof",
    "--restore-database",
    "--restore-started-at",
    "--restore-completed-at",
    "--output",
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
  return Object.fromEntries(
    [...values].map(([key, value]) => [key.slice(2), value]),
  );
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  await writeBackupReceipt({
    releaseId: values["release-id"],
    commit: values.commit,
    imageDigest: values["image-digest"],
    timestamp: values.timestamp,
    ciphertextPath: values.ciphertext,
    recipientCertificatePath: values["recipient-certificate"],
    sourceAuditPath: values["source-audit"],
    restoreAuditPath: values["restore-audit"],
    dropProofPath: values["drop-proof"],
    restoreDatabaseName: values["restore-database"],
    restoreStartedAt: values["restore-started-at"],
    restoreCompletedAt: values["restore-completed-at"],
    outputPath: values.output,
  });
  process.stdout.write("Encrypted backup receipt generated.\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch {
    process.stderr.write("Encrypted backup receipt generation failed.\n");
    process.exitCode = 1;
  }
}
