// server/src/services/internal-agent/aoa-agents/ensure-chronicler.ts
//
// Idempotently seeds the Chronicler role for a company.
//
// The Chronicler is a Command-Staff-adjacent infrastructure role (autonomy 0 —
// always active). It keeps each thread's routing card fresh by updating
// discussions.summaryText + routingTerms on every sweep cycle that detects
// new activity. It is SILENT — no thread posts, only thread.updateSummary calls.
//
// Trigger: 'sweep' (kind), picked up by sweep-chronicler.ts every 45s.
// Tool allowlist: two reads + one write (Codex P1 #3 — the agent must be able to
//   READ the thread to summarize it; the spec's "exactly thread.updateSummary"
//   meant the only WRITE/mutation tool). No post_entry, memory, or extraction.
// Bundle role key: 'chronicler' (maps to onboarding-assets/chronicler/).

import type { Db } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

const CHRONICLER_INSTRUCTION =
  "You are the Chronicler. Keep thread routing cards accurate. When woken for a " +
  "thread, call get_thread_summary (existing card) and thread.listEntries (what was " +
  "said), then call thread.updateSummary ONCE with a tight factual summary and an " +
  "array of key entity terms (routingTerms). NEVER post_entry. NEVER call any tool " +
  "outside those three. Silence is correct when in doubt.";

// Read tools (thread.listEntries, get_thread_summary) + the single write
// (thread.updateSummary). All three already exist in tool-registry.ts.
export const CHRONICLER_TOOL_ALLOWLIST: string[] = [
  "thread.listEntries",
  "get_thread_summary",
  "thread.updateSummary",
];

/**
 * Idempotently seed the Chronicler role for a company.
 * Returns the agent id.
 */
export async function ensureChronicler(db: Db, companyId: string): Promise<string> {
  return seedCrewAgent(db, companyId, {
    name: "Chronicler",
    role: "general",
    instruction: CHRONICLER_INSTRUCTION,
    toolAllowlist: CHRONICLER_TOOL_ALLOWLIST,
    triggers: [{ kind: "sweep", config: { role: "chronicler" } }],
    instructionBundleRole: "chronicler",
  });
}
