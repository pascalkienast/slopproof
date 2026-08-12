import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;

const sensitiveEnvironmentNames = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_SECRET",
  "S3_SECRET_ACCESS_KEY",
  "WORKER_INTERNAL_SECRET",
  "PROVIDER_PAYLOAD_KEY_BASE64",
  "HETZNER_API_KEY",
  "OPENROUTER_API_KEY",
  "CLOUDFLARE_R2_AK",
  "CLOUDFLARE_R2_API",
  "CLOUDFLARE_R2_SEC_ACCESSKEY",
];

const strongSecretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  [
    "github-token",
    /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  ],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["openrouter-key", /\bsk-or-v1-[A-Za-z0-9_-]{24,}\b/u],
];

const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);
const files = listed.split("\0").filter(Boolean);
const findings = [];

const liveValues = sensitiveEnvironmentNames.flatMap((name) => {
  const value = process.env[name];
  return value && value.length >= 8 ? [{ name, value }] : [];
});

for (const path of files) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > MAX_SCANNED_FILE_BYTES) continue;

  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");

  for (const [name, pattern] of strongSecretPatterns) {
    if (pattern.test(text)) findings.push({ path, detector: name });
  }
  for (const { name, value } of liveValues) {
    if (text.includes(value)) {
      findings.push({ path, detector: `loaded-environment:${name}` });
    }
  }
}

if (findings.length > 0) {
  console.error(`Secret audit failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`- ${finding.path} (${finding.detector})`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret audit passed for ${files.length} repository file(s).`);
}
