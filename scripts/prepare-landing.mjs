#!/usr/bin/env node

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LANDING_SOURCE = {
  html: "slopproof-brand-ui-concept-v3.html",
  script: "landing.js",
  assetsDirectory: "docs/assets/product-flow",
};

export const LANDING_PUBLISH = {
  directory: "landing",
  html: "landing/index.html",
  script: "landing/landing.js",
  assetsDirectory: "landing/product-flow",
};

export const LANDING_ASSETS = [
  "contributor-proof.webp",
  "practice.webp",
  "one-take.webp",
  "privacy-check.webp",
  "review-evidence.webp",
];

export function prepareLanding(root = repositoryRoot) {
  mkdirSync(resolve(root, LANDING_PUBLISH.directory), { recursive: true });
  mkdirSync(resolve(root, LANDING_PUBLISH.assetsDirectory), {
    recursive: true,
  });
  copyFileSync(
    resolve(root, LANDING_SOURCE.html),
    resolve(root, LANDING_PUBLISH.html),
  );
  copyFileSync(
    resolve(root, LANDING_SOURCE.script),
    resolve(root, LANDING_PUBLISH.script),
  );
  for (const asset of LANDING_ASSETS) {
    copyFileSync(
      resolve(root, LANDING_SOURCE.assetsDirectory, asset),
      resolve(root, LANDING_PUBLISH.assetsDirectory, asset),
    );
  }
  return {
    html: resolve(root, LANDING_PUBLISH.html),
    script: resolve(root, LANDING_PUBLISH.script),
    assets: LANDING_ASSETS.map((asset) =>
      resolve(root, LANDING_PUBLISH.assetsDirectory, asset),
    ),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  prepareLanding();
  process.stdout.write(
    `Published ${LANDING_PUBLISH.html}, ${LANDING_PUBLISH.script}, and ${LANDING_ASSETS.length} production screenshots.\n`,
  );
}
