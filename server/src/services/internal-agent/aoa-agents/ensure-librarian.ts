// server/src/services/internal-agent/aoa-agents/ensure-librarian.ts
//
// WS6 — idempotently seeds the Librarian role for a company.
//
// The Librarian is a genuinely separate, general-purpose knowledge-organizing
// crew agent (NOT a trigger on Memory Keeper, which stays discussion-pipeline
// -bound). It turns a founder-submitted braindump into candidate domain
// memory items for a department.
//
// Trigger kind: 'event' (config.role='librarian', config.eventName=
// 'braindump.submitted'). This registers the role's canonical trigger
// identity for future automatic-wakeup wiring, but — like 'routine' and
// 'event' generally (see triggers.ts) — there is currently NO evaluator that
// fires it automatically. v1 dispatch is a DIRECT call from the braindump
// service (server/src/services/braindump.ts) straight into runAoaAgent with
// payload.source='braindump.ingest', bypassing the sweep/mention/event
// dispatcher entirely (the founder's explicit "submit braindump" action IS
// the trigger). This mirrors how 'outbox'/'sweep' agents are still callable
// directly by other services when a synchronous, targeted run is needed.
//
// Tool allowlist: memory-only. write_memory is the sole write tool (always
// produces status='pending' — see memory-write.ts / memory.ts:297-307);
// find_similar_memory lets the Librarian avoid proposing near-duplicates of
// existing (approved or pending) memory. No thread, task, or artifact tools —
// the Librarian never touches those surfaces.
//
// Bundle role key: 'librarian' (maps to onboarding-assets/librarian/).

import type { Db } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

// Deliberately scope-NEUTRAL. A braindump can be company-wide (identity layer,
// no department) or department (domain layer), and it can carry attached files
// and a list of folders to file into — all of which the per-capture wakeup
// directive supplies (aoa-trigger-prompt.ts, braindump.ingest branch). Naming a
// layer here would contradict that directive on every company-wide capture.
const LIBRARIAN_INSTRUCTION =
  "You are the Librarian. When a braindump is submitted, read its content (included in your " +
  "wakeup prompt, along with any text extracted from attached files) and identify distinct, " +
  "durable pieces of knowledge worth keeping. Call write_memory once per item, using the layer, " +
  "department, and folder instructions given in that wakeup — they describe the scope this " +
  "particular braindump belongs to. Every item you write lands as status=\"pending\" — you may " +
  "only PROPOSE memory; the founder approves. Never invent facts not present in the braindump. " +
  "If there is nothing worth keeping, call no tool and return.";

export const LIBRARIAN_TOOL_ALLOWLIST: string[] = [
  "write_memory",
  "find_similar_memory",
];

/**
 * Idempotently seed the Librarian role for a company. Returns the agent id.
 *
 * Legacy-origin coverage: this seeder alone stamps NO templateOrigin
 * (seedCrewAgent inserts none — see backfill-template-origin.ts, which adds
 * "Librarian" to CREW_NAMES so the startup backfill stamps the synthetic
 * `…librarian@legacy` origin on both new and pre-existing rows).
 *
 * Marketplace-managed coverage: TODO(WS6-marketplace-cdn) — once the
 * Librarian ships in the `aoa-curated/standard-crew` team package on
 * https://github.com/MeteoriteLabs/aoa-marketplace-cdn (catalog.json), fresh
 * team installs pick it up automatically via team-installer.ts. EXISTING
 * marketplace-managed companies additionally need the reconcile pass in
 * server/src/services/marketplace-install/team-reconcile.ts (added for this
 * WS) to detect + install the newly-added roster member.
 */
export async function ensureLibrarian(db: Db, companyId: string): Promise<string> {
  return seedCrewAgent(db, companyId, {
    name: "Librarian",
    role: "general",
    instruction: LIBRARIAN_INSTRUCTION,
    toolAllowlist: LIBRARIAN_TOOL_ALLOWLIST,
    triggers: [{ kind: "event", config: { role: "librarian", eventName: "braindump.submitted" } }],
    instructionBundleRole: "librarian",
  });
}
