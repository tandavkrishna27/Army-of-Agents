/**
 * U6.7 — stage the agent's OWN skill bundles into a sandbox execution target,
 * excluding the managed marketplace-skills root.
 *
 * §9/§14 invariant (spec): skill FILES are staged into the VM via the
 * existing remote-dir sync (`syncAdapterExecutionTargetDirectory`,
 * `@armyofagents/adapter-utils`), but the MANAGED marketplace-skills root —
 * with its cross-company siblings on disk (see
 * `../../marketplace-install/managed-skills-root.ts`) — is NEVER mounted or
 * walked wholesale.
 *
 * `claude-local` already satisfies this invariant for its own runs
 * (`buildSkillsDir` + the remote sync at
 * `packages/adapters/claude-local/src/server/execute.ts:~628`): it builds a
 * per-run tmp `.claude/skills/` directory from the agent's OWN resolved
 * `RuntimeSkillEntry[]` — already scoped to the agent's `skillKeys` by
 * `listRuntimeSkillEntries` (`company-skills.ts`), never the shared install
 * root — and syncs ONLY that tmp directory. This module extracts the same
 * shape into a reusable step for any OTHER sandbox-targeted crew run that
 * resolves skills but doesn't go through claude-local's adapter-internal
 * staging (every adapter besides claude-local/cursor-local never even reads
 * `context.skills`).
 *
 * Never throws — mirrors `crew-output-capture.ts`'s best-effort philosophy:
 * skill staging is a courtesy delivery to the sandbox, not a run-blocking
 * precondition. Callers may additionally wrap this in their own try/catch
 * (belt-and-suspenders, matching the codebase's other sandbox call sites).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  syncAdapterExecutionTargetDirectory,
  type AdapterExecutionTarget,
} from "@armyofagents/adapter-utils";
import { logger } from "../../../middleware/logger.js";
import type { RuntimeSkillEntry } from "../../company-skills.js";

const log = logger.child({ svc: "crew-skill-staging" });

export interface StageAgentSkillsIntoSandboxInput {
  runId: string;
  target: AdapterExecutionTarget;
  /** The sandbox's working directory — skills land at `${remoteCwd}/.claude/skills`. */
  remoteCwd: string;
  /**
   * The agent's OWN resolved entries — already scoped to its `skillKeys` by
   * `listRuntimeSkillEntries` (`company-skills.ts`). NEVER pass an unscoped
   * walk of the managed marketplace-skills root here.
   */
  skills: RuntimeSkillEntry[];
  env?: Record<string, string>;
  timeoutSec?: number | null;
  graceSec?: number | null;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

/**
 * Builds a per-run tmp `.claude/skills/<key>/` directory from the agent's own
 * `RuntimeSkillEntry[]` (`entry.markdown` -> `SKILL.md`, `entry.files[]` ->
 * sibling files, ONE subdirectory PER skill key) and syncs ONLY that tmp
 * directory into the sandbox at `<remoteCwd>/.claude/skills` via
 * `syncAdapterExecutionTargetDirectory`.
 *
 * INVARIANT: `localDir` passed to the sync is always the freshly-built tmp
 * directory below — never `managedMarketplaceSkillsRoot()` or any path
 * inside it. Every byte written into the tmp dir comes from the
 * already-resolved, already-scoped `input.skills` array; this module never
 * reads or walks the managed root itself. Locked by
 * `server/src/__tests__/sandbox-skill-staging.test.ts`.
 */
export async function stageAgentSkillsIntoSandbox(
  input: StageAgentSkillsIntoSandboxInput,
): Promise<void> {
  if (input.skills.length === 0) return;

  let tmpRoot: string | null = null;
  try {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-crew-skills-"));
    const skillsLocalDir = path.join(tmpRoot, ".claude", "skills");
    await fs.mkdir(skillsLocalDir, { recursive: true });

    for (const skill of input.skills) {
      // Mirrors claude-local's buildSkillsDir folder-name sanitization
      // (packages/adapters/claude-local/src/server/execute.ts) — a
      // namespaced skill key ("vendor/skill") would otherwise split into
      // unintended subdirectories on write.
      const folderName = skill.key.replace(/\//g, "--");
      const skillDir = path.join(skillsLocalDir, folderName);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skill.markdown, "utf-8");
      for (const file of skill.files ?? []) {
        const fullPath = path.join(skillDir, file.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content, "utf-8");
      }
    }

    await syncAdapterExecutionTargetDirectory({
      runId: `${input.runId}-crew-skills`,
      target: input.target,
      localDir: skillsLocalDir,
      remoteDir: `${input.remoteCwd}/.claude/skills`,
      cwd: input.remoteCwd,
      env: input.env,
      timeoutSec: input.timeoutSec,
      graceSec: input.graceSec,
      onLog: input.onLog,
    });
  } catch (err) {
    log.warn(
      { err, runId: input.runId, skillCount: input.skills.length },
      "sandbox skill staging failed (best-effort, ignored)",
    );
  } finally {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}
