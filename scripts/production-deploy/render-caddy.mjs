#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SITE_TOKEN = "{$SLOPPROOF_SITE}";
const LANDING_TOKEN = "{$LANDING_ROOT}";
const SITE = "understandproof.paskie.me";
const LANDING_ROOT = "/var/www/slopproof/landing";
const RUNTIME_CREDENTIAL =
  "{file./run/credentials/caddy.service/oauth-proxy-authenticator}";
const ADMIN_OPTION = "admin unix//run/caddy/admin.sock";
const PERSIST_OPTION = "persist_config off";
const MANAGED_START = "# BEGIN SLOPPROOF MANAGED SITE v1";
const MANAGED_END = "# END SLOPPROOF MANAGED SITE v1";

export class CaddyRenderError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaddyRenderError";
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function readBoundedFile(path, maximumBytes = 1024 * 1024) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximumBytes) {
      throw new CaddyRenderError(
        `${basename(path)} is not a safe regular file`,
      );
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function ensureAdminBoundary(caddyfile) {
  const uncommented = caddyfile
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/u, ""))
    .join("\n");
  const hasAdmin = count(uncommented, ADMIN_OPTION);
  const hasPersist = count(uncommented, PERSIST_OPTION);
  const anyAdmin = /^\s*admin\b/gmu.test(uncommented);
  const anyPersist = /^\s*persist_config\b/gmu.test(uncommented);

  if (hasAdmin === 1 && hasPersist === 1) return caddyfile;
  if (hasAdmin !== 0 || hasPersist !== 0 || anyAdmin || anyPersist) {
    throw new CaddyRenderError(
      "Existing Caddy admin policy is not the exact managed policy",
    );
  }

  const firstToken = /^(?:\s*#.*\n|\s*\n)*(\S)/u.exec(caddyfile);
  if (firstToken?.[1] === "{") {
    const openingIndex = caddyfile.indexOf("{", firstToken.index);
    return `${caddyfile.slice(0, openingIndex + 1)}\n\t${ADMIN_OPTION}\n\t${PERSIST_OPTION}${caddyfile.slice(openingIndex + 1)}`;
  }
  return `{\n\t${ADMIN_OPTION}\n\t${PERSIST_OPTION}\n}\n\n${caddyfile}`;
}

function renderManagedSite(template) {
  if (
    count(template, SITE_TOKEN) !== 1 ||
    count(template, LANDING_TOKEN) !== 1 ||
    count(template, RUNTIME_CREDENTIAL) !== 1 ||
    template.includes("{$OAUTH_TRUSTED_PROXY_SECRET}") ||
    template.includes("{env.OAUTH_TRUSTED_PROXY_SECRET}")
  ) {
    throw new CaddyRenderError(
      "Caddy template does not have the exact safe placeholders",
    );
  }
  const rendered = template
    .replace(SITE_TOKEN, SITE)
    .replace(LANDING_TOKEN, LANDING_ROOT)
    .trimEnd();
  return `${MANAGED_START}\n${rendered}\n${MANAGED_END}`;
}

export function renderCaddyCandidate({
  liveCaddyfile,
  expectedLiveSha256,
  preservedPrefix,
  expectedPrefixSha256,
  currentManagedBlock,
  expectedManagedBlockSha256,
  productionTemplate,
}) {
  if (
    !SHA256_PATTERN.test(expectedLiveSha256) ||
    sha256(liveCaddyfile) !== expectedLiveSha256
  ) {
    throw new CaddyRenderError("Live Caddyfile SHA-256 precondition failed");
  }
  if (
    !SHA256_PATTERN.test(expectedPrefixSha256) ||
    sha256(preservedPrefix) !== expectedPrefixSha256 ||
    liveCaddyfile !== `${preservedPrefix}${currentManagedBlock}`
  ) {
    throw new CaddyRenderError(
      "Preserved Caddy prefix SHA-256 precondition failed",
    );
  }
  if (
    !SHA256_PATTERN.test(expectedManagedBlockSha256) ||
    sha256(currentManagedBlock) !== expectedManagedBlockSha256 ||
    count(liveCaddyfile, currentManagedBlock) !== 1
  ) {
    throw new CaddyRenderError(
      "Managed site block SHA-256 precondition failed",
    );
  }

  const replacement = renderManagedSite(productionTemplate);
  let candidate = liveCaddyfile.replace(currentManagedBlock, replacement);
  candidate = ensureAdminBoundary(candidate);
  if (
    count(candidate, ADMIN_OPTION) !== 1 ||
    count(candidate, PERSIST_OPTION) !== 1 ||
    count(candidate, RUNTIME_CREDENTIAL) !== 1 ||
    count(candidate, MANAGED_START) !== 1 ||
    count(candidate, MANAGED_END) !== 1 ||
    candidate.includes("{$OAUTH_TRUSTED_PROXY_SECRET}") ||
    candidate.includes("{env.OAUTH_TRUSTED_PROXY_SECRET}")
  ) {
    throw new CaddyRenderError("Rendered Caddy boundary is not exact");
  }
  return candidate;
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || !value || values.has(name)) {
      throw new CaddyRenderError("Invalid renderer arguments");
    }
    values.set(name, value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new CaddyRenderError(`Missing ${name}`);
  return value;
}

function writeAtomicNew(path, contents) {
  const output = resolve(path);
  const temporary = resolve(
    dirname(output),
    `.${basename(output)}.${process.pid}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const outputProbe = openSync(
      output,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(outputProbe);
    unlinkSync(output);
    renameSync(temporary, output);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function main() {
  const values = parseArguments(process.argv.slice(2));
  const livePath = required(values, "--live");
  const blockPath = required(values, "--current-block");
  const prefixPath = required(values, "--preserved-prefix");
  const templatePath = required(values, "--template");
  const outputPath = required(values, "--output");
  for (const path of [
    livePath,
    prefixPath,
    blockPath,
    templatePath,
    outputPath,
  ]) {
    if (!path.startsWith("/"))
      throw new CaddyRenderError("All paths must be absolute");
  }
  const candidate = renderCaddyCandidate({
    liveCaddyfile: readBoundedFile(livePath),
    expectedLiveSha256: required(values, "--expected-live-sha256"),
    preservedPrefix: readBoundedFile(prefixPath),
    expectedPrefixSha256: required(values, "--expected-prefix-sha256"),
    currentManagedBlock: readBoundedFile(blockPath),
    expectedManagedBlockSha256: required(values, "--expected-block-sha256"),
    productionTemplate: readBoundedFile(templatePath),
  });
  writeAtomicNew(outputPath, candidate);
  process.stdout.write(
    `Rendered Caddy candidate SHA-256 ${sha256(candidate)}.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    if (error instanceof CaddyRenderError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write("Caddy candidate rendering failed.\n");
    }
    process.exitCode = 1;
  }
}
