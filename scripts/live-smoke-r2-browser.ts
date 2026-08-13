#!/usr/bin/env -S node --import tsx

import { chromium } from "@playwright/test";
import { S3EvidenceStore } from "../packages/storage/src/index.ts";
import {
  closeR2BrowserSmokeBrowser,
  launchR2BrowserSmokeBrowser,
  loadR2BrowserSmokeEnvironment,
  runGuardedR2BrowserSmoke,
  runR2BrowserSmoke,
} from "./lib/r2-browser-smoke.mjs";

async function main(): Promise<void> {
  const configuration = loadR2BrowserSmokeEnvironment(process.env);
  const store = new S3EvidenceStore({
    region: configuration.S3_REGION,
    bucket: configuration.S3_BUCKET,
    controlEndpoint: configuration.S3_CONTROL_ENDPOINT,
    publicEndpoint: configuration.S3_PUBLIC_ENDPOINT,
    accessKeyId: configuration.S3_ACCESS_KEY_ID,
    secretAccessKey: configuration.S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  });
  let browser: { close(): Promise<void> } | undefined;

  try {
    browser = await launchR2BrowserSmokeBrowser(() =>
      chromium.launch({ headless: true, env: {} }),
    );
    await runR2BrowserSmoke({
      environment: {
        R2_BROWSER_SMOKE: process.env.R2_BROWSER_SMOKE,
        ...configuration,
      },
      store,
      browser,
    });
  } finally {
    try {
      await closeR2BrowserSmokeBrowser(browser);
    } finally {
      store.destroy();
    }
  }
}

process.exitCode = await runGuardedR2BrowserSmoke({
  action: main,
});
