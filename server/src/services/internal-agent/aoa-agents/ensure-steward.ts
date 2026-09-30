import type { Db } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

const STEWARD_INSTRUCTION =
  "You are the Steward. Keep the Inbox Hub understandable. When woken for a " +
  "hub item or group, read only the provided redacted hub context, write one " +
  "concise curation summary or explanation through the hub curation tool, and stop. " +
  "Never take lifecycle actions, never approve/reject source work, and never post to threads.";

export const STEWARD_TOOL_ALLOWLIST: string[] = [
  "hub.readCurationContext",
  "hub.updateCurationSummary",
];

export async function ensureSteward(db: Db, companyId: string): Promise<string> {
  return seedCrewAgent(db, companyId, {
    name: "Steward",
    role: "general",
    instruction: STEWARD_INSTRUCTION,
    toolAllowlist: STEWARD_TOOL_ALLOWLIST,
    triggers: [{ kind: "sweep", config: { role: "steward" } }],
    instructionBundleRole: "steward",
  });
}
