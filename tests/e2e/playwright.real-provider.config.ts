import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

for (const key of [
  "AOA_E2E_REAL_CREW_PROVIDER",
  "AOA_E2E_REAL_CREW_MODEL",
  "AOA_E2E_REAL_PROVIDER_TEST_MATCH",
]) {
  if (process.env[key]?.trim() === "") {
    delete process.env[key];
  }
}

const PORT = Number(process.env.AOA_E2E_PORT ?? 3299);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AOA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-real-provider-e2e-home-"));

const DEFAULT_REAL_PROVIDER_SPECS = [
  "**/real-crew-discussion-flow.spec.ts",
  "**/full-discussion-to-workspace-cycle.real-provider.spec.ts",
  "**/team-aoa-crew-dispatch-approval.spec.ts",
];

export default defineConfig({
  testDir: ".",
  testMatch: process.env.AOA_E2E_REAL_PROVIDER_TEST_MATCH?.trim()
    ? process.env.AOA_E2E_REAL_PROVIDER_TEST_MATCH.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_REAL_PROVIDER_SPECS,
  timeout: Number(process.env.AOA_E2E_REAL_CREW_TIMEOUT_MS ?? 420_000) + 180_000,
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
  webServer: {
    command: "corepack pnpm@9.15.4 aoa onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      AOA_HOME,
      AOA_INSTANCE_ID: "playwright-real-provider-e2e",
      AOA_BIND: "loopback",
      AOA_DEPLOYMENT_MODE: "local_trusted",
      // Mirror the standard e2e config: local_trusted refuses to boot without
      // Google OAuth unless the dev escape hatch is set. Required when this lane
      // runs standalone via `pnpm test:e2e:real-provider` (outside the research
      // compose wrapper, which otherwise injects this process-wide).
      AOA_DEV_LOCAL_IDENTITY: "1",
      AOA_DEPLOYMENT_EXPOSURE: "private",
      AOA_AUTH_BASE_URL_MODE: "auto",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      SERVE_UI: "true",
      AOA_MIGRATION_AUTO_APPLY: "true",
      AOA_VITE_HMR_PORT: String(PORT + 10_000),
      AOA_MARKETPLACE_CDN_URL: process.env.AOA_MARKETPLACE_CDN_URL ?? "http://127.0.0.1:1/catalog.json",
      AOA_E2E_FAKE_AWS_SECRETS_MANAGER: process.env.AOA_E2E_FAKE_AWS_SECRETS_MANAGER ?? "1",
      AOA_E2E_FAKE_CREW_LLM: "0",
      AOA_E2E_FAKE_EMBEDDER: "0",
    },
  },
  outputDir: "./test-results-real-provider",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report-real-provider" }]],
});
