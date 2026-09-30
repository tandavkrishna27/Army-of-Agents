import base from "../e2e/playwright.authenticated.config";
import {defineConfig} from "@playwright/test";
import {randomBytes} from "node:crypto";

if (process.env.DATABASE_URL?.trim())
  throw new Error("Universe production-entry tests require a disposable embedded database; unset DATABASE_URL");
const mintToken = process.env.AOA_E2E_TEST_SUPPORT_TOKEN || randomBytes(32).toString("hex");
process.env.AOA_E2E_TEST_SUPPORT_TOKEN = mintToken;
const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("Expected the single authenticated test server");

// Fresh authenticated server and disposable Postgres from the canonical auth
// harness. No request interception or simulated layout transport.
export default defineConfig({...base, testDir: ".", testMatch: "**/*.spec.ts",
  webServer: {...server, env: {
    ...server.env,
    // OAuth redirects are outside this test. Non-secret placeholders satisfy
    // authenticated startup; the private test seam supplies the real session.
    GOOGLE_CLIENT_ID: "universe-test-only", GOOGLE_CLIENT_SECRET: "universe-test-only",
    AOA_E2E_TEST_SUPPORT: "1",
    AOA_E2E_TEST_SUPPORT_TOKEN: mintToken,
  }},
  use: {...base.use, launchOptions: process.env.AOA_UNIVERSE_CHROMIUM_PATH
    ? {executablePath: process.env.AOA_UNIVERSE_CHROMIUM_PATH} : undefined},
  outputDir: "./test-results/universe-production",
  reporter: [["list"], ["json", {outputFile: "./test-results/universe-production/report.json"}]],
});
