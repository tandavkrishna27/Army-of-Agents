/**
 * Real (production) dependencies for getProviderStatus (Unit A).
 *
 * Wires the pure provider-status.ts to the actual codex-local adapter helpers
 * so the crew runner gets live auth-mode detection instead of test stubs.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveSharedCodexHomeDir, readSharedCodexModel } from "@armyofagents/adapter-codex-local/server";
import type { ProviderStatusDeps } from "./provider-status.js";

/**
 * Read <homeDir>/auth.json and return the parsed object.
 * Returns null on ANY error (missing file, bad JSON) — never throws.
 */
async function readAuthJson(homeDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(homeDir, "auth.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Production ProviderStatusDeps wired to the real codex-local helpers.
 *
 * isInstalled: resolveModel never reads status.installed in the current
 * provider-switching engine (Phase 1). A real probe lands with Unit D.
 */
export const realProviderStatusDeps: ProviderStatusDeps = {
  // Read the shared codex home (the run's auth source) — see ProviderStatusDeps.
  resolveSharedCodexHomeDir,

  readAuthJson,

  readSharedCodexModel,

  // installed not consumed by resolveModel; real detection lands with the Unit D probe.
  isInstalled: async () => true,
};
