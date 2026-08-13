#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_CMS_BYTES = 1024 * 1024 * 1024;
const MAX_ASN1_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ASN1_LINE_BYTES = 16 * 1024;
const OPENSSL_TIMEOUT_MS = 120_000;
const EXPECTED_OBJECT_COUNTS = Object.freeze({
  "aes-256-gcm": 1,
  commonName: 1,
  "id-smime-ct-authEnvelopedData": 1,
  mgf1: 1,
  "pkcs7-data": 1,
  rsaesOaep: 1,
  sha256: 2,
});

export class CmsArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsArtifactError";
  }
}

function fail(message) {
  throw new CmsArtifactError(message);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function assertPrivateCanonicalDirectory(path, label) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail(`${label} must be one normalized absolute path`);
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o700
  ) {
    fail(`${label} must be an owner-controlled mode-0700 directory`);
  }
  return stat;
}

export function assertPrivateRegularFile(path, label, maximumBytes) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail(`${label} must be one normalized absolute path`);
  }
  assertPrivateCanonicalDirectory(dirname(path), `${label} parent`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 ||
      stat.size > maximumBytes ||
      realpathSync(path) !== path
    ) {
      fail(`${label} metadata is unsafe`);
    }
    return stat;
  } finally {
    closeSync(descriptor);
  }
}

function runOpenSsl(argumentsList) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("openssl", argumentsList, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CmsArtifactError("OpenSSL CMS inspection timed out"));
    }, OPENSSL_TIMEOUT_MS);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    }

    child.on("error", () =>
      finish(new CmsArtifactError("OpenSSL CMS inspection could not start")),
    );
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0 || signal) {
        finish(new CmsArtifactError("OpenSSL rejected the CMS artifact"));
      } else {
        finish();
      }
    });
  });
}

function inspectCmsStructure(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "openssl",
      ["asn1parse", "-inform", "DER", "-in", path, "-dlimit", "1"],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const objects = new Map();
    const keyEncryptionAlgorithms = [];
    let outputBytes = 0;
    let pending = "";
    let settled = false;
    let inRecipientSet = false;
    let recipientInfoCount = 0;
    let recipientSetCount = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CmsArtifactError("OpenSSL CMS inspection timed out"));
    }, OPENSSL_TIMEOUT_MS);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else
        resolvePromise({
          objects,
          keyEncryptionAlgorithms,
          recipientInfoCount,
          recipientSetCount,
        });
    }

    function inspectLine(line) {
      if (Buffer.byteLength(line) > MAX_ASN1_LINE_BYTES) {
        child.kill("SIGKILL");
        finish(new CmsArtifactError("OpenSSL ASN.1 output line was unbounded"));
        return;
      }
      const structure =
        /^\s*\d+:d=(\d+)\s+hl=\d+\s+l=\s*(?:inf|\d+)\s+(?:cons|prim):\s+(.+?)\s*$/u.exec(
          line,
        );
      if (structure?.[1] === "3") {
        inRecipientSet = structure[2] === "SET";
        if (inRecipientSet) recipientSetCount += 1;
      } else if (
        inRecipientSet &&
        structure?.[1] === "4" &&
        structure[2] === "SEQUENCE"
      ) {
        recipientInfoCount += 1;
      }
      const match = /d=(\d+)\s+.*prim:\s+OBJECT\s+:([^\r\n]+)\s*$/u.exec(line);
      if (!match) return;
      const name = match[2].trim();
      objects.set(name, (objects.get(name) ?? 0) + 1);
      if (match[1] === "6") keyEncryptionAlgorithms.push(name);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_ASN1_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new CmsArtifactError("OpenSSL ASN.1 output exceeded its bound"));
        return;
      }
      pending += chunk;
      let newline;
      while (!settled && (newline = pending.indexOf("\n")) !== -1) {
        inspectLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (!settled && Buffer.byteLength(pending) > MAX_ASN1_LINE_BYTES) {
        child.kill("SIGKILL");
        finish(new CmsArtifactError("OpenSSL ASN.1 output line was unbounded"));
      }
    });
    child.stdout.on("error", () => {
      child.kill("SIGKILL");
      finish(new CmsArtifactError("OpenSSL CMS inspection output failed"));
    });
    child.on("error", () =>
      finish(new CmsArtifactError("OpenSSL CMS inspection could not start")),
    );
    child.on("close", (code, signal) => {
      if (settled) return;
      if (pending) inspectLine(pending);
      if (settled) return;
      if (code !== 0 || signal) {
        finish(new CmsArtifactError("OpenSSL rejected the CMS artifact"));
      } else {
        finish();
      }
    });
  });
}

export async function verifyCmsArtifact(
  path,
  releaseId,
  expectedSuffix = ".cms",
) {
  if (!/^\d{8}T\d{6}Z$/u.test(releaseId)) fail("release ID is invalid");
  if (basename(path) !== `${releaseId}${expectedSuffix}`) {
    fail("CMS artifact filename does not match the release");
  }
  const stat = assertPrivateRegularFile(path, "CMS artifact", MAX_CMS_BYTES);
  await runOpenSsl(["cms", "-cmsout", "-inform", "DER", "-in", path, "-noout"]);
  const inspection = await inspectCmsStructure(path);
  const objectCounts = inspection.objects;
  if (
    inspection.recipientSetCount !== 1 ||
    inspection.recipientInfoCount !== 1 ||
    inspection.keyEncryptionAlgorithms.length !== 1 ||
    inspection.keyEncryptionAlgorithms[0] !== "rsaesOaep" ||
    objectCounts.size !== Object.keys(EXPECTED_OBJECT_COUNTS).length
  ) {
    fail("CMS artifact recipient structure is not the production profile");
  }
  for (const [name, count] of Object.entries(EXPECTED_OBJECT_COUNTS)) {
    if (objectCounts.get(name) !== count) {
      fail("CMS artifact algorithm structure is not the production profile");
    }
  }
  return Object.freeze({ bytes: stat.size });
}

export async function finalizeCmsArtifact({
  partialPath,
  finalPath,
  releaseId,
}) {
  if (
    dirname(partialPath) !== dirname(finalPath) ||
    basename(partialPath) !== `${releaseId}.cms.partial` ||
    basename(finalPath) !== `${releaseId}.cms`
  ) {
    fail("CMS finalization paths do not match the release");
  }
  const verifiedPartial = await verifyCmsArtifact(
    partialPath,
    releaseId,
    ".cms.partial",
  );
  try {
    lstatSync(finalPath);
    fail("final CMS artifact already exists");
  } catch (error) {
    if (error instanceof CmsArtifactError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const partialDescriptor = openSync(
    partialPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let linkedFinal = false;
  try {
    const heldBeforeSync = fstatSync(partialDescriptor);
    const pathBeforeSync = lstatSync(partialPath);
    if (
      !heldBeforeSync.isFile() ||
      !sameFile(heldBeforeSync, pathBeforeSync) ||
      heldBeforeSync.nlink !== 1 ||
      heldBeforeSync.uid !== process.getuid() ||
      (heldBeforeSync.mode & 0o777) !== 0o600 ||
      heldBeforeSync.size !== verifiedPartial.bytes
    ) {
      fail("CMS partial changed before durable finalization");
    }
    fsyncSync(partialDescriptor);
    const heldAfterSync = fstatSync(partialDescriptor);
    const pathAfterSync = lstatSync(partialPath);
    if (
      !sameFile(heldBeforeSync, heldAfterSync) ||
      !sameFile(heldAfterSync, pathAfterSync) ||
      heldAfterSync.nlink !== 1 ||
      heldAfterSync.size !== verifiedPartial.bytes
    ) {
      fail("CMS partial changed during durable finalization");
    }

    linkSync(partialPath, finalPath);
    linkedFinal = true;
    const linkedStat = lstatSync(finalPath);
    const heldAfterLink = fstatSync(partialDescriptor);
    if (
      !sameFile(heldAfterLink, linkedStat) ||
      heldAfterLink.nlink !== 2 ||
      linkedStat.nlink !== 2
    ) {
      fail("CMS final link does not match the durable partial");
    }

    unlinkSync(partialPath);
    const finalStat = lstatSync(finalPath);
    const heldFinal = fstatSync(partialDescriptor);
    if (
      !sameFile(heldFinal, finalStat) ||
      heldFinal.nlink !== 1 ||
      finalStat.nlink !== 1
    ) {
      fail("CMS final artifact metadata is unsafe");
    }
    const directoryDescriptor = openSync(
      dirname(finalPath),
      constants.O_RDONLY,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    linkedFinal = false;
  } catch (error) {
    if (linkedFinal) {
      try {
        const held = fstatSync(partialDescriptor);
        const final = lstatSync(finalPath);
        if (sameFile(held, final)) unlinkSync(finalPath);
      } catch {}
    }
    throw error;
  } finally {
    closeSync(partialDescriptor);
  }
  return verifyCmsArtifact(finalPath, releaseId);
}

function parseArguments(argv) {
  const operation = argv.shift();
  const values = new Map();
  if (!operation || argv.length % 2 !== 0) fail("invalid arguments");
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || values.has(name)) {
      fail("invalid arguments");
    }
    values.set(name, value);
  }
  return { operation, values };
}

async function main() {
  const { operation, values } = parseArguments(process.argv.slice(2));
  const releaseId = values.get("--release-id");
  if (operation === "verify" && values.size === 2) {
    await verifyCmsArtifact(values.get("--path"), releaseId);
    process.stdout.write("Authenticated CMS artifact verified.\n");
    return;
  }
  if (operation === "finalize" && values.size === 3) {
    await finalizeCmsArtifact({
      partialPath: values.get("--partial"),
      finalPath: values.get("--final"),
      releaseId,
    });
    process.stdout.write("Authenticated CMS artifact finalized.\n");
    return;
  }
  fail("invalid arguments");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch {
    process.stderr.write("Authenticated CMS artifact verification failed.\n");
    process.exitCode = 1;
  }
}
