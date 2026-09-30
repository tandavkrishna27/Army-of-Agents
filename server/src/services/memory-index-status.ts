/**
 * Two-axis memory index status (Task W5, Decision D-indexstatus).
 *
 * Axis 1 — per-item `indexStatus`:
 *   Whether THIS item has a stored vector embedding.
 *   Vector presence ALWAYS wins ("indexed") regardless of whether a key is
 *   currently configured. The four states map directly to embedding_queue
 *   row status, with the stored-vector check as the first gate.
 *
 * Axis 2 — company-level `semanticAvailable`:
 *   Whether the company can currently embed new items (a key resolves + pgvector
 *   present). Drives the "semantic search off — add a key" banner in the UI.
 *   INDEPENDENT of per-item status: an item can be "indexed" (has a stored
 *   vector) even when `semanticAvailable` is false (key was removed).
 */

import type { MemoryIndexStatus } from "@armyofagents/shared";
import { getDbCapabilities } from "./db-capabilities.js";
import { hasProviderKey } from "./internal-agent/providers/index.js";
import type { Db } from "@armyofagents/db";

export type { MemoryIndexStatus };

/**
 * Derive the per-item index status from the stored-vector flag and the latest
 * embedding_queue row status for the item.
 *
 * Decision rules (in priority order):
 *   1. `hasVector` true  → "indexed"  (a stored vector ALWAYS wins)
 *   2. queueStatus "failed"           → "failed"
 *   3. queueStatus "pending"|"processing" → "pending"
 *   4. everything else (completed without vector, no queue row) → "not_indexed"
 */
export function deriveIndexStatus(input: {
  hasVector: boolean;
  queueStatus: "pending" | "processing" | "completed" | "failed" | null;
}): MemoryIndexStatus {
  if (input.hasVector) return "indexed";
  if (input.queueStatus === "failed") return "failed";
  if (input.queueStatus === "pending" || input.queueStatus === "processing") return "pending";
  return "not_indexed";
}

/**
 * Determine whether semantic search (embedding) is currently available for a
 * company. Returns true only when BOTH conditions hold:
 *   - pgvector extension is present (getDbCapabilities().hasVectorSupport)
 *   - an OpenAI API key resolves for the company (company secret or env var)
 *
 * Any key-resolution error is caught and returns false so callers never need
 * to handle exceptions from this helper.
 */
export async function resolveSemanticAvailable(
  db: Db,
  companyId: string,
): Promise<boolean> {
  if (!getDbCapabilities().hasVectorSupport) return false;
  // Existence check only — must NOT resolve the secret value here. This runs on
  // every memory-list GET (passive page views), so resolving would write a
  // secretAccessEvents audit row + bump lastResolvedAt on each view (P2, Codex).
  try {
    return await hasProviderKey(db, companyId, "openai");
  } catch {
    return false;
  }
}
