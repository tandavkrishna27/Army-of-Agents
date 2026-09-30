import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadDefaultAgentInstructionsBundle } from "../../default-agent-instructions.js";

/**
 * Sidecar that records the SHA-256 of the canonical content we last wrote to
 * each persona file. Lives at `<bundle-root>/.canonical-hashes.json`.
 *
 * QA-BUG-014 refresh discipline (2026-05-29):
 *   - File missing → write canonical, record hash.
 *   - File exists AND its current hash matches the recorded "last canonical
 *     hash" → file is unchanged since we wrote it → safe to refresh from a
 *     newer canonical (overwrite, update hash).
 *   - File exists AND its current hash DIFFERS from the recorded hash → the
 *     founder has edited the file → preserve their edit, do NOT overwrite.
 *
 * This restores the dev-time staleness fix without breaking the "never
 * clobber founder edits" guarantee the original logic was designed around.
 */
const CANONICAL_HASHES_FILE = ".canonical-hashes.json";

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function readCanonicalHashes(
  root: string,
): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(root, CANONICAL_HASHES_FILE), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeCanonicalHashes(
  root: string,
  hashes: Record<string, string>,
): Promise<void> {
  await fs.writeFile(
    path.join(root, CANONICAL_HASHES_FILE),
    JSON.stringify(hashes, null, 2),
    "utf8",
  );
}

// adapterConfig typed as `unknown` to match AgentLike in agent-instructions.ts (contravariance).
type SeedAgentShape = { id: string; companyId: string; name: string; adapterConfig: unknown };

interface SeedRoleArgs {
  /** Bundle role key — must be registered in default-agent-instructions.ts.
   *  Phase D batch 1: `navigator` is the new key for the role formerly known
   *  as `router`. Both are accepted while the rename rolls out. `engineer`
   *  replaces `maker`; `scout` is net-new. */
  role:
    | "commander"
    | "router"
    | "navigator"
    | "planner"
    | "dispatcher"
    | "memory_keeper"
    | "scribe"
    | "adjutant"
    | "maker"
    | "engineer"
    | "scout"
    | "chronicler"
    | "steward"
    | "librarian";
  agent: { id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> | null };
  // Injected for testability. The real implementation passes agentInstructionsService() with
  // ensureWritableBundle aliased from ensureManagedBundle (see ensure-commander.ts).
  service: { ensureWritableBundle: (agent: SeedAgentShape, opts?: { clearLegacyPromptTemplate?: boolean }) => Promise<{ adapterConfig: Record<string, unknown>; state: { rootPath?: string | null; entryFile: string } }> };
}

/**
 * Idempotently seed a role's instruction bundle. Provisions a managed writable
 * bundle root via ensureWritableBundle, then for each canonical persona file:
 *
 *   1. If the per-agent file does not exist → write the canonical content,
 *      record the canonical hash in the sidecar.
 *   2. If it exists and the file's current hash matches the recorded "last
 *      canonical hash" → the founder has NOT edited it → safe to refresh from
 *      the latest canonical (overwrite, update sidecar). This restores the
 *      flow where dev-time persona changes propagate to every agent on the
 *      next ensure() call.
 *   3. If it exists and the hash differs from the recorded value → the
 *      founder has edited the file → preserve their edits, do NOT overwrite.
 *      The sidecar is left unchanged so subsequent calls keep treating the
 *      file as edited until the founder explicitly resets it.
 *
 * This solves QA-BUG-014: pre-fix, the seeder only wrote when the file was
 * missing, so onboarding-assets changes never propagated to existing agents
 * (Adjutant kept its old 5-tool TOOLS.md for months after the code shipped
 * 17 tools). The "never clobber founder edits" guarantee is preserved via the
 * hash sidecar.
 *
 * Returns the adapterConfig to persist on the agents row so the bundle is linked.
 */
export async function seedRoleInstructionBundle(args: SeedRoleArgs): Promise<Record<string, unknown>> {
  const { role, agent, service } = args;
  const { adapterConfig, state } = await service.ensureWritableBundle(agent, { clearLegacyPromptTemplate: true });
  const root = state.rootPath;
  if (!root) return adapterConfig;
  const files = await loadDefaultAgentInstructionsBundle(role);
  await fs.mkdir(root, { recursive: true });

  const hashes = await readCanonicalHashes(root);
  let hashesChanged = false;

  for (const [name, content] of Object.entries(files)) {
    const dest = path.join(root, name);
    const canonicalHash = sha256(content);
    const exists = await fs.stat(dest).then((s) => s.isFile()).catch(() => false);

    if (!exists) {
      // Path 1: file missing — write canonical and remember its hash.
      await fs.writeFile(dest, content, "utf8");
      hashes[name] = canonicalHash;
      hashesChanged = true;
      continue;
    }

    const existing = await fs.readFile(dest, "utf8");
    const existingHash = sha256(existing);
    const lastCanonicalHash = hashes[name];

    if (existingHash === canonicalHash) {
      // File already matches the new canonical exactly — nothing to do.
      // Still record the hash so subsequent runs have a baseline.
      if (lastCanonicalHash !== canonicalHash) {
        hashes[name] = canonicalHash;
        hashesChanged = true;
      }
      continue;
    }

    if (lastCanonicalHash !== undefined && existingHash === lastCanonicalHash) {
      // Path 2: file is at the previously-seeded canonical content (founder
      // never touched it) — safe to refresh from the new canonical.
      await fs.writeFile(dest, content, "utf8");
      hashes[name] = canonicalHash;
      hashesChanged = true;
      continue;
    }

    // Path 3: file differs from what we last wrote — founder edited it.
    // Preserve their edits, leave the sidecar hash alone.
  }

  if (hashesChanged) {
    await writeCanonicalHashes(root, hashes);
  }
  return adapterConfig;
}

/** Back-compat wrapper — delegates to seedRoleInstructionBundle with role='commander'. */
export async function seedCommanderInstructionBundle(args: {
  agent: { id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> | null };
  service: SeedRoleArgs["service"];
}): Promise<Record<string, unknown>> {
  return seedRoleInstructionBundle({ role: "commander", agent: args.agent, service: args.service });
}
