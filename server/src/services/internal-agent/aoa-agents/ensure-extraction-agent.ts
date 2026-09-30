import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers } from "@armyofagents/db";
import { seedRoleInstructionBundle } from "./seed-commander-bundle.js";
import { agentInstructionsService } from "../../agent-instructions.js";
import {
  resolveCrewAdapterForCompany,
  shouldRewriteCrewAdapter,
  mergeCrewAdapterConfig,
} from "./resolve-crew-adapter.js";
import { isCodexApiKeyAuth } from "./crew-codex-auth.js";

/** Legacy name — kept for one-time rename migration. New name is "Scribe". */
export const LEGACY_EXTRACTION_AGENT_NAME = "Discussion Extraction";
/** @deprecated Use SCRIBE_AGENT_NAME. Kept for backward-compat with existing test imports. */
export const EXTRACTION_AGENT_NAME = "Discussion Extraction";

/** Plan 3 Task 1: canonical role name. */
export const SCRIBE_AGENT_NAME = "Scribe";

export const EXTRACTION_INSTRUCTION =
  "You are the discussion-extraction agent. Read the discussion entry in your " +
  "context. Identify decisions, tasks, insights, context, references and " +
  "preferences. Call the `submit_extracted_items` tool with the structured " +
  "items. Do not output anything else.";

export const SCRIBE_INSTRUCTION =
  EXTRACTION_INSTRUCTION +
  "\n\nAs Scribe you also: (1) classify whether extracted items should be " +
  "standalone tasks or spin-offs of existing work; (2) tag each item with the " +
  "most relevant department if determinable from context; (3) detect conflicts " +
  "between extracted items and active goals and flag them in the item description; " +
  "(4) apply office-hours interrogation — question ambiguous or vague items by " +
  "adding a clarifying note rather than silently omitting them.";

// D2: explicit allowlist — Scribe may ONLY call submit_extracted_items.
// Decisions #15/#16/#52: no direct memory writes.
export const SCRIBE_TOOL_ALLOWLIST = ["submit_extracted_items"] as const;
/** @deprecated Use SCRIBE_TOOL_ALLOWLIST. */
export const EXTRACTION_AGENT_TOOL_ALLOWLIST = SCRIBE_TOOL_ALLOWLIST;

export async function ensureExtractionAgent(db: Db, companyId: string): Promise<string> {
  let agentId: string;

  // Plan 3 Task 1: look up by SCRIBE_AGENT_NAME first, then fall back to the
  // legacy name for one-time migration. Both are checked so the function works
  // whether or not the rename has run yet.
  const existingByScribe = await db
    .select({ id: agents.id, name: agents.name, runtimeConfig: agents.runtimeConfig })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.kind, "aoa"), eq(agents.name, SCRIBE_AGENT_NAME)))
    .then((r: { id: string; name: string; runtimeConfig: unknown }[]) => r[0] ?? null);

  const existingByLegacy = !existingByScribe
    ? await db
        .select({ id: agents.id, name: agents.name, runtimeConfig: agents.runtimeConfig })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.kind, "aoa"), eq(agents.name, LEGACY_EXTRACTION_AGENT_NAME)))
        .then((r: { id: string; name: string; runtimeConfig: unknown }[]) => r[0] ?? null)
    : null;

  const existing = existingByScribe ?? existingByLegacy;

  // Resolve the right CLI adapter for this company's configured provider
  // (P1-B fix — see ensure-adjutant.ts for context).
  const crewAdapter = await resolveCrewAdapterForCompany(db, companyId);

  if (existing) {
    // D2 idempotent backfill: merge toolAllowlist into existing row's runtimeConfig
    // so pre-D2 rows aren't stranded by default-deny. Use a targeted update that
    // preserves all other runtimeConfig fields (heartbeat, instruction, role).
    // P1-B backfill: upgrade adapter_type='process' (no command) rows to the
    // resolved CLI adapter — these rows are unrunnable until upgraded.
    const rc = (existing.runtimeConfig as Record<string, unknown>) ?? {};
    const aoaCfg = (rc.aoa as Record<string, unknown>) ?? {};
    const needsAllowlist = !Array.isArray(aoaCfg.toolAllowlist);
    // Plan 3 Task 1: one-time rename from legacy to Scribe.
    const needsRename = existing.name === LEGACY_EXTRACTION_AGENT_NAME;

    // P1-B: check if adapter needs upgrade
    const [current] = await db
      .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, existing.id))
      .limit(1);
    const currentCfg = current ? (current.adapterConfig as Record<string, unknown> | null) : null;
    const isApiKeyAuth = current?.adapterType === "codex_local" ? await isCodexApiKeyAuth(companyId, currentCfg) : false;
    const needsAdapter = current ? shouldRewriteCrewAdapter(current.adapterType, currentCfg, crewAdapter.adapterType, crewAdapter.adapterConfig, { isApiKeyAuth }) : false;

    if (needsAllowlist || needsRename || needsAdapter) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (needsAllowlist) {
        const updatedAoa: Record<string, unknown> = { ...aoaCfg, toolAllowlist: [...SCRIBE_TOOL_ALLOWLIST] };
        updates.runtimeConfig = { ...rc, aoa: updatedAoa };
      }
      if (needsRename) {
        // One-time rename: "Discussion Extraction" → "Scribe"
        updates.name = SCRIBE_AGENT_NAME;
      }
      if (needsAdapter && current) {
        updates.adapterType = crewAdapter.adapterType;
        updates.adapterConfig = mergeCrewAdapterConfig(
          current.adapterConfig as Record<string, unknown> | null,
          crewAdapter.adapterConfig,
          current.adapterType,
          crewAdapter.adapterType,
        );
      }
      await db.update(agents).set(updates).where(eq(agents.id, existing.id));
    }
    agentId = existing.id;
  } else {
    const [created] = await db.insert(agents).values({
      companyId, name: SCRIBE_AGENT_NAME, kind: "aoa", role: "general", status: "idle",
      adapterType: crewAdapter.adapterType,
      adapterConfig: crewAdapter.adapterConfig,
      runtimeConfig: {
        aoa: { role: "member", instruction: SCRIBE_INSTRUCTION, toolAllowlist: [...SCRIBE_TOOL_ALLOWLIST] },
        heartbeat: { enabled: false, intervalSec: 0 },
      },
    }).returning();
    await db.insert(aoaAgentTriggers).values({
      companyId, agentId: created.id, kind: "outbox", enabled: true,
      config: { source: "discussion_entry_pending" },
    });
    agentId = created.id;
  }

  // P1.6: seed the Scribe's editable instruction bundle (idempotent; never clobbers
  // founder edits). Non-fatal: seeding failure must not block role provisioning.
  try {
    const row = await db
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r: { id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> | null }[]) => r[0]);
    if (row) {
      const nextAdapterConfig = await seedRoleInstructionBundle({
        role: "scribe",
        agent: { id: row.id, companyId: row.companyId, name: row.name, adapterConfig: row.adapterConfig },
        service: agentInstructionsService(),
      });
      await db.update(agents).set({ adapterConfig: nextAdapterConfig, updatedAt: new Date() }).where(eq(agents.id, agentId));
    }
  } catch {
    /* non-fatal — runner falls back to the instruction string */
  }

  return agentId;
}
