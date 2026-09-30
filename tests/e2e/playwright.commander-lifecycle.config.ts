import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const baseURL = process.env.AOA_COMMANDER_LIFECYCLE_BASE_URL ?? "http://127.0.0.1:3224";
const lifecycleDir = process.env.AOA_COMMANDER_LIFECYCLE_DIR
  ? resolve(process.env.AOA_COMMANDER_LIFECYCLE_DIR)
  : resolve(".aoa-qa", "commander", "commander-review", "lifecycle");

export default defineConfig({
  testDir: ".",
  testMatch: "**/commander-lifecycle/*.live.spec.ts",
  timeout: 12 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  fullyParallel: false,
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  outputDir: resolve(lifecycleDir, "playwright"),
  reporter: [["list"], ["json", { outputFile: resolve(lifecycleDir, "playwright-results.json") }]],
  projects: [
    { name: "lifecycle-setup", testMatch: "**/commander-cockpit-live-setup.live.spec.ts" },
    {
      name: "provider-preflight",
      testMatch: "**/commander-cockpit-provider-preflight.live.spec.ts",
      dependencies: ["lifecycle-setup"],
    },
    {
      name: "claude-questions",
      testMatch: "**/commander-cockpit-claude-questions.live.spec.ts",
      dependencies: ["provider-preflight"],
    },
    {
      name: "codex-questions",
      testMatch: "**/commander-cockpit-codex-questions.live.spec.ts",
      dependencies: ["provider-preflight"],
    },
    {
      name: "review-loop",
      testMatch: "**/commander-cockpit-review-loop.live.spec.ts",
      dependencies: ["claude-questions", "codex-questions"],
    },
    {
      name: "business-approval",
      testMatch: "**/commander-cockpit-approval.live.spec.ts",
      dependencies: ["claude-questions", "codex-questions"],
    },
    {
      name: "pane-coordination",
      testMatch: "**/commander-cockpit-panes.live.spec.ts",
      dependencies: ["review-loop", "business-approval"],
    },
    {
      name: "lifecycle-synthesis",
      testMatch: "**/commander-cockpit-synthesis.live.spec.ts",
      dependencies: ["pane-coordination"],
    },
  ],
});
