import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.AOA_AUTH_E2E_PORT ?? 3206);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const DB_PORT = Number(process.env.AOA_AUTH_E2E_DB_PORT ?? PORT + 52_000);
const AOA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-auth-e2e-home-"));
const DATABASE_URL = process.env.DATABASE_URL?.trim()
  || `postgres://paperclip:paperclip@127.0.0.1:${DB_PORT}/paperclip`;

process.env.AOA_AUTH_E2E_DATABASE_URL = DATABASE_URL;
process.env.AOA_AUTH_E2E_BASE_URL = BASE_URL;

export default defineConfig({
  testDir: ".",
  testMatch: "**/commander-cockpit-authenticated.spec.ts",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "authenticated-chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "corepack pnpm@9.15.4 aoa onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 150_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      AOA_HOME,
      AOA_INSTANCE_ID: "playwright-authenticated-e2e",
      AOA_BIND: "loopback",
      AOA_DEPLOYMENT_MODE: "authenticated",
      AOA_DEPLOYMENT_EXPOSURE: "private",
      AOA_ALLOWED_HOSTNAMES: "127.0.0.1,localhost",
      AOA_AUTH_BASE_URL_MODE: "explicit",
      AOA_AUTH_PUBLIC_BASE_URL: BASE_URL,
      BETTER_AUTH_SECRET: "commander-authenticated-e2e-secret-32-bytes-minimum",
      AOA_ENABLE_COMPANY_DELETION: "true",
      AOA_EMBEDDED_POSTGRES_PORT: String(DB_PORT),
      AOA_EMBEDDED_POSTGRES_STRICT_PORT: "1",
      AOA_VITE_HMR_PORT: String(PORT + 10_000),
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    },
  },
  outputDir: "./test-results/authenticated",
  reporter: [["list"]],
});
