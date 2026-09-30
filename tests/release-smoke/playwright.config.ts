import { defineConfig } from "@playwright/test";

// Release-smoke tests run against an already-running AoA Docker container
// (started by CI via `docker run`, or locally via `pnpm docker:smoke`).
// Unlike tests/e2e/playwright.config.ts, this config has no `webServer`
// directive — the container is the server.
//
// Default port 3232 matches AoA's Dockerfile EXPOSE. AOA_RELEASE_SMOKE_BASE_URL
// is the primary env var; AOA_RELEASE_SMOKE_BASE_URL is retained as a
// fallback so Docker images still using the old env name keep working
// through the rename window.
const BASE_URL =
  process.env.AOA_RELEASE_SMOKE_BASE_URL ??
  process.env.AOA_RELEASE_SMOKE_BASE_URL ??
  "http://127.0.0.1:3232";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
