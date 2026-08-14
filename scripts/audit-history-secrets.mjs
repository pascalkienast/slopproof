import { execFileSync } from "node:child_process";

const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

const strongSecretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  [
    "github-token",
    /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  ],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["openrouter-key", /\bsk-or-v1-[A-Za-z0-9_-]{24,}\b/u],
];

const sensitiveEnvironmentNames = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GENERATION_API_KEY",
  "JUDGE_API_KEY",
  "TRANSCRIPTION_API_KEY",
  "S3_SECRET_ACCESS_KEY",
  "WORKER_INTERNAL_SECRET",
  "OAUTH_TRUSTED_PROXY_SECRET",
  "PROVIDER_PAYLOAD_KEY_BASE64",
  "HETZNER_API_KEY",
  "HETZNER_SP",
  "OPENROUTER_API_KEY",
  "OPENROUTER_SP",
  "CLOUDFLARE_R2_AK",
  "CLOUDFLARE_R2_API",
  "CLOUDFLARE_R2_SEC_ACCESSKEY",
];

const history = execFileSync(
  "git",
  ["log", "--all", "--format=commit:%H", "-p", "--no-ext-diff", "--text"],
  { encoding: "utf8", maxBuffer: MAX_HISTORY_BYTES },
);
const paths = execFileSync(
  "git",
  ["log", "--all", "--name-only", "--format="],
  { encoding: "utf8", maxBuffer: MAX_HISTORY_BYTES },
)
  .split("\n")
  .map((path) => path.trim())
  .filter(Boolean);

const findings = new Set();
for (const [detector, pattern] of strongSecretPatterns) {
  if (pattern.test(history)) findings.add(detector);
}
for (const name of sensitiveEnvironmentNames) {
  const value = process.env[name];
  if (value && value.length >= 8 && history.includes(value)) {
    findings.add(`loaded-environment:${name}`);
  }
}

for (const path of paths) {
  if (path.endsWith("/.gitkeep")) continue;
  if (
    /(^|\/)(?:\.secrets|secrets?|backups?|node_modules)(\/|$)/u.test(path) ||
    (/\.env(?:\.|$)/u.test(path) && !path.endsWith(".env.example")) ||
    /\.(?:pem|key|p12|pfx|backup|bak)$/u.test(path)
  ) {
    findings.add(`sensitive-path:${path}`);
  }
}

if (findings.size > 0) {
  console.error(
    `History secret audit failed with ${findings.size} finding(s):`,
  );
  for (const finding of [...findings].sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    `History secret audit passed for ${new Set(paths).size} path(s).`,
  );
}
