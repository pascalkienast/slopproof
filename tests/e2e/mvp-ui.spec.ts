import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("renders the seeded golden path on desktop", async ({ page }) => {
  await page.goto("/demo");

  await expect(
    page.getByRole("heading", { name: "Three patches. Three proof budgets." }),
  ).toBeVisible();
  for (const number of [184, 185, 186]) {
    await expect(
      page.locator(`.pr-card[href="/demo/pr/${String(number)}"]`),
    ).toBeVisible();
  }
  await expect(
    page.getByText("1 live question", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("2 live questions", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("5 live questions", { exact: true }),
  ).toBeVisible();
});

test("keeps Practice and Proof visible and exchanges a mobile handoff once", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo/pr/184");

  await expect(
    page.getByRole("heading", { name: "Practice your understanding." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Prove you know what you ship." }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Prove your understanding" }).click();
  const openOnDevice = page.getByRole("link", { name: "Open on this device" });
  await expect(openOnDevice).toBeVisible();
  await openOnDevice.click();

  await expect(
    page.getByRole("heading", { name: "Camera and privacy check." }),
  ).toBeVisible();
  await expect(
    page.getByText("Ciphertext only", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/m\/handoff$/);
  expect(new URL(page.url()).search).toBe("");

  await page
    .getByRole("button", { name: "Allow camera and microphone" })
    .click();
  await expect(
    page.getByRole("button", { name: "Start one-take proof" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(async () => ({
      localStorageEntries: window.localStorage.length,
      sessionStorageEntries: window.sessionStorage.length,
      indexedDatabases:
        "databases" in window.indexedDB
          ? (await window.indexedDB.databases()).length
          : 0,
      cacheEntries: await window.caches.keys(),
    })),
  ).toEqual({
    localStorageEntries: 0,
    sessionStorageEntries: 0,
    indexedDatabases: 0,
    cacheEntries: [],
  });

  await page.route("**/api/attempts/*/uploads", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "synthetic_upload_failure" }),
    });
  });
  await page.getByRole("button", { name: "Start one-take proof" }).click();
  await expect(
    page.getByRole("heading", { name: "Recording did not complete." }),
  ).toBeVisible();
  const recover = page.getByRole("button", {
    name: "Clean up and create a fresh attempt",
  });
  await expect(recover).toBeVisible();
  await recover.click();
  await expect(page).toHaveURL(/\/revisions\/[0-9a-f-]+\/contribute$/);
  await expect(
    page.getByRole("heading", { name: "Prove you know what you ship." }),
  ).toBeVisible();
});

test("renders the concept-derived Practice workspace without a fallback badge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    "/revisions/52000000-0000-4000-8000-000000000001/contribute/practice",
  );

  await expect(
    page.getByRole("heading", { name: "Practice your understanding." }),
  ).toBeVisible();
  await expect(page.getByText("// Understanding coach")).toBeVisible();
  await expect(page.getByLabel("Selected patch hunk")).toBeVisible();
  await expect(page.getByText(/safe fallback/iu)).toHaveCount(0);
  await page.getByRole("button", { name: /02\s+Risk/iu }).click();
  await expect(page.getByRole("heading", { name: "Risk" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("requires a repository-bound maintainer session for review", async ({
  page,
}) => {
  await page.goto("/review");

  await expect(
    page.getByRole("heading", { name: "Maintainer authorization required." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Enter as demo maintainer" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Human review, bound to the current SHA.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Nothing waiting." }),
  ).toBeVisible();
});

test("turns a signed fake webhook into a contributor-ready proof", async ({
  page,
  request,
}) => {
  const deliveryId = randomUUID();
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 500001 },
    repository: {
      id: 500003,
      name: "cachekit",
      full_name: "acme/cachekit",
      default_branch: "main",
      owner: { id: 500002, login: "acme" },
    },
    pull_request: {
      id: 510999,
      number: 999,
      state: "open",
      user: { id: 500004, login: "demo-author" },
      head: { sha: "9".repeat(40) },
      base: { sha: "1".repeat(40) },
    },
  });
  const signature = createHmac("sha256", "local-webhook-secret-change-me-0000")
    .update(body, "utf8")
    .digest("hex");
  const first = await request.post("/api/github/webhooks", {
    data: Buffer.from(body, "utf8"),
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${signature}`,
    },
  });
  expect(first.status()).toBe(202);
  expect(await first.json()).toEqual({
    accepted: true,
    duplicate: false,
    ignored: false,
  });

  await expect
    .poll(
      async () => {
        await page.goto("/demo");
        return page.locator(".pr-card", { hasText: "PR #999" }).count();
      },
      { timeout: 20_000 },
    )
    .toBe(1);
  await page.locator(".pr-card", { hasText: "PR #999" }).click();
  await expect(
    page.getByRole("heading", { name: "Practice your understanding." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Prove you know what you ship." }),
  ).toBeVisible();

  const duplicate = await request.post("/api/github/webhooks", {
    data: Buffer.from(body, "utf8"),
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${signature}`,
    },
  });
  expect(duplicate.status()).toBe(202);
  expect(await duplicate.json()).toEqual({
    accepted: true,
    duplicate: true,
    ignored: false,
  });
});
