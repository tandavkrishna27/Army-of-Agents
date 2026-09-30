import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const port = 5183;

// Generic UI qualification deliberately starts Vite only. Real authenticated
// task/browser routes are separate E2.4/E1.0 acceptance, not fixture evidence.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  outputDir: path.join(root, "test-results/universe-canvas/traces"),
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: path.join(root, "test-results/universe-canvas/report.json"),
      },
    ],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1365, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `pnpm --filter @armyofagents/ui exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    url: `http://127.0.0.1:${port}/universe-harness.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
