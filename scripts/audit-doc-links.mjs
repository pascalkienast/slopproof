import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const listed = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.md",
    "**/*.md",
  ],
  { encoding: "utf8" },
);
const files = listed.split("\n").filter(Boolean);
const missing = [];

for (const path of files) {
  const markdown = readFileSync(path, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const rawTarget = match[1]?.trim();
    if (
      !rawTarget ||
      rawTarget.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)
    ) {
      continue;
    }
    const targetWithoutTitle = rawTarget.split(/\s+["']/u, 1)[0] ?? "";
    const fileTarget = decodeURIComponent(
      targetWithoutTitle.split("#", 1)[0] ?? "",
    );
    if (!fileTarget) continue;
    if (!existsSync(resolve(dirname(path), fileTarget))) {
      missing.push(`${path} -> ${fileTarget}`);
    }
  }
}

if (missing.length > 0) {
  console.error(
    `Documentation link audit failed with ${missing.length} finding(s):`,
  );
  for (const finding of missing.sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation link audit passed for ${files.length} Markdown file(s).`,
  );
}
