import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const webServers = [
  ...(process.env.PLAYWRIGHT_WORKER_SMOKE === "true"
    ? [
        {
          command: "pnpm --filter @slopproof/worker start",
          url: "http://127.0.0.1:4001/healthz",
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: "pnpm --filter @slopproof/github-control start",
          url: "http://127.0.0.1:4002/healthz",
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ]
    : []),
  {
    command:
      "env -u KEY_WRAPPING_PRIVATE_KEY_PATH -u PROVIDER_PAYLOAD_KEY_BASE64 pnpm --filter @slopproof/web start",
    url: `${baseURL}/demo`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
];

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    permissions: ["camera", "microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: webServers,
});
