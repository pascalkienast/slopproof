import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(relativePath) {
  return readFileSync(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

const pinnedNodeImage =
  "node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f";

test("the production image has an artifact-only hardened runtime stage", () => {
  const dockerfile = read("Dockerfile");
  const fromInstructions = [
    ...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)$/gmu),
  ].map((match) => ({ image: match[1], stage: match[2] }));

  assert.deepEqual(fromInstructions, [
    { image: pinnedNodeImage, stage: "builder" },
    { image: pinnedNodeImage, stage: "runtime" },
  ]);

  const runtime = dockerfile.split(/^FROM\s+\S+\s+AS\s+runtime$/mu)[1];
  assert.ok(runtime);
  assert.match(runtime, /apt-get upgrade -y/u);
  assert.match(runtime, /apt-get install -y --no-install-recommends/u);
  assert.doesNotMatch(runtime, /(?:^|\n)COPY(?:\s+--\S+)*\s+\.\s+\./u);
  assert.doesNotMatch(runtime, /pnpm (?:install|build)|next build|tsup/u);

  for (const artifact of [
    "/build/apps/web/.next/standalone/",
    "/build/apps/web/.next/static/",
    "/build/apps/worker/dist/index.cjs",
    "/build/apps/github-control/dist/index.cjs",
    "/build/scripts/dist/migrate-db.mjs",
    "/build/packages/db/migrations/",
  ]) {
    assert.ok(runtime.includes(artifact), artifact);
  }

  for (const command of ["corepack", "npm", "npx", "pnpm", "pnpx"]) {
    assert.ok(runtime.includes(`/usr/local/bin/${command}`), command);
  }
  assert.match(runtime, /find \/app -type f -name '\*\.map' -delete/u);
  assert.match(runtime, /-name test -o -name tests -o -name __tests__/u);
  assert.match(runtime, /next\/dist\/compiled\/tar/u);
  assert.match(runtime, /^USER 1000:1000$/mu);
  assert.match(runtime, /^CMD \["node", "apps\/web\/server\.js"\]$/mu);
});

test("production artifacts are standalone or fully bundled", () => {
  const nextConfig = read("apps/web/next.config.ts");
  assert.match(nextConfig, /output: "standalone"/u);
  assert.match(nextConfig, /images: \{ unoptimized: true \}/u);
  assert.match(nextConfig, /outputFileTracingRoot:/u);

  for (const configPath of [
    "apps/worker/tsup.config.ts",
    "apps/github-control/tsup.config.ts",
    "scripts/tsup.config.ts",
  ]) {
    const config = read(configPath);
    assert.match(config, /noExternal: \[\/\.\*\/\]/u, configPath);
    assert.match(config, /sourcemap: false/u, configPath);
  }
});

test("production service commands address only runtime artifacts", () => {
  const compose = read("compose.production.yaml");

  for (const command of [
    'command: ["node", "scripts/migrate-db.mjs"]',
    'command: ["node", "apps/worker/dist/index.cjs"]',
    'command: ["node", "apps/github-control/dist/index.cjs"]',
    'command: ["node", "apps/web/server.js"]',
  ]) {
    assert.ok(compose.includes(command), command);
  }
  assert.doesNotMatch(compose, /--import["\s,]+tsx|next\/dist\/bin\/next/u);
});

const runtimeImage = process.env.SLOPPROOF_IMAGE;
test(
  "the built runtime contains no package manager, build tooling, source, or tests",
  {
    skip: runtimeImage ? false : "set SLOPPROOF_IMAGE to inspect a built image",
  },
  () => {
    const [inspection] = JSON.parse(
      execFileSync("docker", ["image", "inspect", runtimeImage], {
        encoding: "utf8",
      }),
    );
    assert.equal(inspection.Config.User, "1000:1000");
    assert.deepEqual(inspection.Config.Cmd, ["node", "apps/web/server.js"]);

    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        runtimeImage,
        "-ec",
        String.raw`
          test "$(id -u):$(id -g)" = "1000:1000"
          for command in corepack npm npx pnpm pnpx tsx tsup tsc esbuild make gcc g++ cc; do
            ! command -v "$command" >/dev/null 2>&1
          done
          for artifact in \
            /app/apps/web/server.js \
            /app/apps/worker/dist/index.cjs \
            /app/apps/github-control/dist/index.cjs \
            /app/scripts/migrate-db.mjs; do
            test -f "$artifact"
            node --check "$artifact" >/dev/null
          done
          test -x /usr/bin/ffmpeg
          test -n "$(find /app/packages/db/migrations -type f -name '*.sql' -print -quit)"
          test ! -e /app/package.json
          test ! -e /app/pnpm-lock.yaml
          test ! -e /app/apps/web/app
          test ! -e /app/apps/worker/src
          test ! -e /app/apps/github-control/src
          test -z "$(find /app -type f \
            \( -name '.env' -o -name '.env.*' -o -name '*.pem' \
               -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \
               -o -name '*.backup' -o -name '*.bak' \) -print -quit)"
          test -z "$(find /app -type f \
            \( -name '*.ts' -o -name '*.tsx' -o -name '*.map' \) -print -quit)"
          test -z "$(find /app -type d \
            \( -name test -o -name tests -o -name __tests__ \) -print -quit)"
          test -z "$(find /app -type d \
            \( -name esbuild -o -name tar -o -name glob \) -print -quit)"
          test -z "$(find /app/node_modules/.pnpm -maxdepth 1 -type d \
            \( -name 'esbuild@*' -o -name 'tsup@*' -o -name 'tsx@*' \
               -o -name 'typescript@*' -o -name 'pnpm@*' -o -name 'glob@*' \
               -o -name 'tar@*' \) -print -quit)"
        `,
      ],
      { stdio: "pipe" },
    );
  },
);

test(
  "every runtime entrypoint loads and the standalone web server answers liveness",
  {
    skip: runtimeImage ? false : "set SLOPPROOF_IMAGE to inspect a built image",
  },
  () => {
    for (const command of [
      ["node", "apps/worker/dist/index.cjs"],
      ["node", "apps/github-control/dist/index.cjs"],
      ["node", "scripts/migrate-db.mjs"],
    ]) {
      assert.throws(
        () =>
          execFileSync("docker", ["run", "--rm", runtimeImage, ...command], {
            encoding: "utf8",
            stdio: "pipe",
          }),
        (error) => {
          const diagnostic = String(error.stderr);
          assert.match(
            diagnostic,
            /ConfigurationError: Invalid configuration/u,
          );
          assert.doesNotMatch(diagnostic, /MODULE_NOT_FOUND/u);
          return true;
        },
      );
    }

    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        runtimeImage,
        "-ec",
        String.raw`
          node apps/web/server.js >/tmp/web.log 2>&1 &
          web_pid=$!
          trap 'kill "$web_pid" 2>/dev/null || true' EXIT
          node --input-type=module -e '
            const deadline = Date.now() + 15_000;
            while (true) {
              try {
                const response = await fetch("http://127.0.0.1:3000/api/health/live");
                if (response.ok) {
                  const body = await response.json();
                  if (body.status === "ok") process.exit(0);
                }
              } catch {}
              if (Date.now() > deadline) process.exit(1);
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          '
        `,
      ],
      { stdio: "pipe" },
    );
  },
);
