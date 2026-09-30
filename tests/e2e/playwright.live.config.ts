import { defineConfig } from "@playwright/test";

const BASE_URL = process.env.AOA_E2E_BASE_URL ?? "http://127.0.0.1:3222";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  testIgnore: ["multi-user.spec.ts", "multi-user-authenticated.spec.ts"],
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  outputDir: "./test-results-live",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report-live" }]],
});
