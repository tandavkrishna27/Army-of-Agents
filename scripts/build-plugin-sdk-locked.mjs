import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = resolve(root, "node_modules", ".cache");
const lockDir = resolve(cacheDir, "aoa-plugin-sdk-build.lock");
const staleAfterMs = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function acquireLock() {
  mkdirSync(cacheDir, { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleAfterMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      await sleep(250);
    }
  }
}

await acquireLock();

let exitCode = 1;
try {
  const pnpmExecPath = process.env.npm_execpath;
  const usesPnpmExecPath = pnpmExecPath?.toLowerCase().includes("pnpm") ?? false;
  const command = usesPnpmExecPath
    ? process.execPath
    : process.platform === "win32"
      ? "pnpm.cmd"
      : "pnpm";
  const args = usesPnpmExecPath
    ? [pnpmExecPath, "--filter", "@armyofagents/plugin-sdk", "build"]
    : ["--filter", "@armyofagents/plugin-sdk", "build"];
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32" && !usesPnpmExecPath,
  });
  if (result.error) {
    console.error(result.error);
  }
  exitCode = result.status ?? 1;
} finally {
  rmSync(lockDir, { recursive: true, force: true });
}

process.exitCode = exitCode;
