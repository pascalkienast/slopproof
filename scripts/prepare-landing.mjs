#!/usr/bin/env node

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LANDING_SOURCE = {
  html: "slopproof-brand-ui-concept-v3.html",
  script: "landing.js",
};

export const LANDING_PUBLISH = {
  directory: "landing",
  html: "landing/index.html",
  script: "landing/landing.js",
};

export function prepareLanding(root = repositoryRoot) {
  mkdirSync(resolve(root, LANDING_PUBLISH.directory), { recursive: true });
  copyFileSync(
    resolve(root, LANDING_SOURCE.html),
    resolve(root, LANDING_PUBLISH.html),
  );
  copyFileSync(
    resolve(root, LANDING_SOURCE.script),
    resolve(root, LANDING_PUBLISH.script),
  );
  return {
    html: resolve(root, LANDING_PUBLISH.html),
    script: resolve(root, LANDING_PUBLISH.script),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  prepareLanding();
  process.stdout.write(
    `Published ${LANDING_PUBLISH.html} and ${LANDING_PUBLISH.script} from ${LANDING_SOURCE.html} and ${LANDING_SOURCE.script}.\n`,
  );
}
