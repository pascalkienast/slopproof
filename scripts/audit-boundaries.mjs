import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const violations = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", ".next", "dist"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const rules = [
  {
    directory: join(root, "packages/domain"),
    forbidden: ["next", "@octokit/", "@aws-sdk/", "drizzle-orm", "pg-boss"],
  },
  {
    directory: join(root, "packages/policy"),
    forbidden: ["next", "@octokit/", "@aws-sdk/", "drizzle-orm", "pg-boss"],
  },
];

for (const rule of rules) {
  for (const file of await walk(rule.directory)) {
    const source = await readFile(file, "utf8");
    for (const dependency of rule.forbidden) {
      if (
        source.includes(`from \"${dependency}`) ||
        source.includes(`from '${dependency}`)
      ) {
        violations.push(
          `${relative(root, file)} imports forbidden dependency ${dependency}`,
        );
      }
    }
  }
}

for (const file of await walk(join(root, "apps"))) {
  const source = await readFile(file, "utf8");
  if (/from ["']@understandproof\/(?:web|worker)/.test(source)) {
    violations.push(
      `${relative(root, file)} imports directly from another app`,
    );
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Package boundary audit passed.\n");
}
