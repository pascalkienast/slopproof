#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const OUTPUT_NAME = "oauth-proxy-authenticator";
const PROXY_LINE = /^OAUTH_TRUSTED_PROXY_SECRET='([A-Za-z0-9_-]{43})'\n$/u;

export class CaddyCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaddyCredentialError";
  }
}

function assertProtectedDirectory(directory) {
  const resolved = resolve(directory);
  const stat = lstatSync(resolved);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(resolved) !== resolved
  ) {
    throw new CaddyCredentialError(
      "Credential directory must be a real, owner-controlled mode-0700 directory",
    );
  }
  return resolved;
}

function readProtectedProxyEnvironment(inputPath) {
  const descriptor = openSync(
    inputPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 40 ||
      stat.size > 128
    ) {
      throw new CaddyCredentialError(
        "proxy.env must be one owner-controlled mode-0600 regular file",
      );
    }
    const match = PROXY_LINE.exec(readFileSync(descriptor, "utf8"));
    if (!match) {
      throw new CaddyCredentialError(
        "proxy.env must contain exactly the compiled proxy field",
      );
    }
    return match[1];
  } finally {
    closeSync(descriptor);
  }
}

export function installCaddyCredential(inputPath, outputPath) {
  const inputDirectory = assertProtectedDirectory(dirname(inputPath));
  const outputDirectory = assertProtectedDirectory(dirname(outputPath));
  if (inputDirectory !== outputDirectory) {
    throw new CaddyCredentialError(
      "The raw credential must be installed atomically beside proxy.env",
    );
  }
  if (resolve(outputPath) !== resolve(outputDirectory, OUTPUT_NAME)) {
    throw new CaddyCredentialError(
      `The output filename must be ${OUTPUT_NAME}`,
    );
  }

  const value = readProtectedProxyEnvironment(resolve(inputPath));
  try {
    lstatSync(outputPath);
    throw new CaddyCredentialError(
      "Credential output already exists; secret release directories are immutable",
    );
  } catch (error) {
    if (error instanceof CaddyCredentialError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = resolve(
    outputDirectory,
    `.${OUTPUT_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, value, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    // The output was proven absent above and the protected directory is not
    // shared with another writer. Never run this against a reused secret set.
    renameSync(temporaryPath, outputPath);

    const directoryDescriptor = openSync(outputDirectory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || process.argv.length !== 4) {
    throw new CaddyCredentialError(
      "Usage: prepare-caddy-credential.mjs /absolute/proxy.env /absolute/oauth-proxy-authenticator",
    );
  }
  if (!inputPath.startsWith("/") || !outputPath.startsWith("/")) {
    throw new CaddyCredentialError("Credential paths must be absolute");
  }
  installCaddyCredential(inputPath, outputPath);
  process.stdout.write("Installed one protected Caddy credential.\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    if (error instanceof CaddyCredentialError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write("Caddy credential installation failed.\n");
      process.exitCode = 1;
    }
  }
}
