import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  commanderManifestRequirements,
  runCommanderGateSteps,
  validateCommanderExecutionManifest,
  type CommanderGateStep,
  type CommanderTestExecutionManifest,
} from "../../../packages/shared/src/testing/commander-execution.js";

type Gate = "targeted" | "authenticated" | "merge";

function gateArg(): Gate {
  const raw = process.argv.find((arg) => arg.startsWith("--gate="))?.slice("--gate=".length);
  if (raw === "targeted" || raw === "authenticated" || raw === "merge") return raw;
  throw new Error("Expected --gate=targeted|authenticated|merge");
}

function run(command: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const windows = process.platform === "win32";
    const executable = windows ? (process.env.ComSpec ?? "cmd.exe") : command;
    const childArgs = windows ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(executable, childArgs, {
      cwd: process.cwd(),
      env: { ...process.env, ...envOverrides },
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

const targeted: CommanderGateStep[] = [
  { id: "W0-SHARED-TYPECHECK", layer: "static", run: () => run("pnpm", ["--filter", "@armyofagents/shared", "typecheck"]) },
  { id: "W0-UI-TYPECHECK", layer: "static", run: () => run("pnpm", ["--filter", "@armyofagents/ui", "typecheck"]) },
  { id: "W1-DB-TYPECHECK", layer: "static", run: () => run("pnpm", ["--filter", "@armyofagents/db", "typecheck"]) },
  {
    id: "W0-CONTRACT-UNIT",
    layer: "unit",
    run: () => run("pnpm", [
      "exec",
      "vitest",
      "run",
      "packages/shared/src/__tests__/cockpit-presentation.test.ts",
      "packages/shared/src/__tests__/commander-execution.test.ts",
      "ui/src/components/commander/cockpitPrefsV3.test.ts",
      "ui/src/components/commander/commanderPaneCoordinator.test.ts",
      "server/src/__tests__/cockpit-work-classification.test.ts",
      "server/src/__tests__/cockpit-service.test.ts",
    ]),
  },
  {
    id: "W1-CONTRACT-UNIT",
    layer: "unit",
    run: () => run("pnpm", [
      "exec",
      "vitest",
      "run",
      "packages/shared/src/__tests__/work-questions.test.ts",
      "packages/shared/src/__tests__/user-entity-follows.test.ts",
      "packages/db/src/__tests__/commander-wave1-schema.test.ts",
      "packages/db/src/__tests__/migration-idempotency.test.ts",
      "server/src/__tests__/work-question-capabilities.test.ts",
    ]),
  },
];

const authenticated: CommanderGateStep[] = ["A01", "A02", "A03", "A04", "A05", "A06", "A07"].map((id, index) => ({
  id,
  layer: "authenticated_e2e",
  run: () => run("pnpm", [
    "exec",
    "playwright",
    "test",
    "--config=tests/e2e/playwright.authenticated.config.ts",
    "--grep",
    `\\[${id}\\]`,
  ], {
    AOA_AUTH_E2E_PORT: String(3220 + index),
    AOA_AUTH_E2E_DB_PORT: String(55300 + index),
  }),
}));

const merge: CommanderGateStep[] = [
  { id: "MERGE-DB-GENERATE", layer: "schema", run: () => run("pnpm", ["db:generate"]) },
  { id: "MERGE-TYPECHECK", layer: "static", run: () => run("pnpm", ["-r", "typecheck"]) },
  { id: "MERGE-UNIT-INTEGRATION", layer: "test", run: () => run("pnpm", ["test:run"]) },
  { id: "MERGE-BUILD", layer: "build", run: () => run("pnpm", ["build"]) },
  { id: "MERGE-E2E", layer: "e2e", run: () => run("pnpm", ["test:e2e"]) },
];

const gate = gateArg();
const campaignId = process.env.AOA_COMMANDER_CAMPAIGN_ID ?? `commander-${gate}`;
const startedAt = new Date().toISOString();
const steps = gate === "targeted" ? targeted : gate === "authenticated" ? authenticated : merge;
const result = await runCommanderGateSteps(steps);
const finishedAt = new Date().toISOString();
const outputDir = resolve(".aoa-qa", "commander", campaignId, "results");
await mkdir(outputDir, { recursive: true });
const manifest: CommanderTestExecutionManifest = {
  version: 1,
  campaignId,
  mode: gate,
  startedAt,
  finishedAt,
  entries: result.entries,
};
await writeFile(resolve(outputDir, "test-execution-manifest.json"), JSON.stringify(manifest, null, 2));
const manifestErrors = validateCommanderExecutionManifest(manifest, commanderManifestRequirements(gate));
if (manifestErrors.length > 0) {
  console.error(manifestErrors.join("\n"));
}

process.exitCode = result.exitCode || (manifestErrors.length > 0 ? 1 : 0);
