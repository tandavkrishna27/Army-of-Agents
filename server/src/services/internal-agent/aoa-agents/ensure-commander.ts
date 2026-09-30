import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, internalAgentConfig, companySkills } from "@armyofagents/db";
import { agentInstructionsService } from "../../agent-instructions.js";
import { seedCommanderInstructionBundle } from "./seed-commander-bundle.js";
import {
  resolveCommanderAdapterForCompany,
  shouldRewriteCrewAdapter,
  mergeCrewAdapterConfig,
} from "./resolve-crew-adapter.js";
import { isCodexApiKeyAuth } from "./crew-codex-auth.js";

export const COMMANDER_AGENT_NAME = "Commander";

// D2: Commander (lead) tool allowlist — broad but explicit (least privilege
// still applies to the lead). Includes all tools EXCEPT submit_extracted_items
// which belongs exclusively to the extraction sub-agent.
export const COMMANDER_TOOL_ALLOWLIST = [
  // Delegation (B3)
  "delegate_to_subagent",
  // Query
  "query_tasks",
  "query_goals",
  "query_team_roster",
  "query_humans",
  "find_humans",
  "query_human_context",
  "query_agents",
  "query_departments",
  "query_budget",
  "query_activity",
  // Action
  "create_task",
  "update_task",
  "create_department",
  "create_goal",
  "create_agent",
  "update_agent",
  "assign_task",
  "wakeup_agent",
  // Memory
  "query_memory",
  "suggest_memory",
  "update_memory",
  "find_similar_memory",
  "detect_conflicts",
  // Discussion
  "extract_from_content",
  "search_discussions",
  "link_discussion_to_project",
  // Workflow
  "create_workflow_template",
  "instantiate_workflow",
  "add_task_dependency",
  // File
  "read_file",
  // Coordination
  "query_dependency_chain",
  // Analysis
  "analyze_workload",
  "suggest_improvements",
  // Task C2 batch 1 (T15) — thread + query tools for crew coordination
  "thread.listEntries",
  "thread.setIntent",
  "thread.postScopeProposal",
  "thread.updateSummary",
  "thread.createLink",
  "get_thread_summary",
  "find_similar_threads",
] as const;

function mergeCommanderToolAllowlist(existing: unknown): string[] {
  const current = Array.isArray(existing)
    ? existing.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
    : [];
  const seen = new Set(current);
  const merged = [...current];
  for (const tool of COMMANDER_TOOL_ALLOWLIST) {
    if (!seen.has(tool)) {
      seen.add(tool);
      merged.push(tool);
    }
  }
  return merged;
}

/** Idempotently ensure the per-company Commander kind='aoa' row + link
 *  internal_agent_config.agentId. Chat loop (agent-loop.ts) unaffected.
 *  Discriminator: kind='aoa' + runtimeConfig.aoa.role='lead' (NOT agents.role
 *  — that is special-cased). */
export async function ensureCommanderAgent(db: Db, companyId: string): Promise<string> {
  // Resolve the Commander row's adapter from its OWN cliTool + model — NOT the
  // crew provider (Task 5b). Commander's autonomous (non-chat) runs must use the
  // CLI the founder picked for Commander, independent of the crew provider.
  const commanderAdapter = await resolveCommanderAdapterForCompany(db, companyId);

  // Attempt atomic insert. ON CONFLICT (company_id, name) WHERE kind='aoa'
  // silently no-ops if another process beat us to it.
  const [inserted] = await db
    .insert(agents)
    .values({
      companyId, name: COMMANDER_AGENT_NAME, kind: "aoa", role: "general", status: "idle",
      adapterType: commanderAdapter.adapterType,
      adapterConfig: commanderAdapter.adapterConfig,
      runtimeConfig: {
        aoa: { role: "lead", toolAllowlist: [...COMMANDER_TOOL_ALLOWLIST] },
        heartbeat: { enabled: false, intervalSec: 0 },
      },
    })
    .onConflictDoNothing()
    .returning({ id: agents.id, runtimeConfig: agents.runtimeConfig });

  let agentId: string;
  let existingRc: Record<string, unknown> | undefined;

  if (inserted) {
    agentId = inserted.id;
    existingRc = inserted.runtimeConfig;
  } else {
    // Conflict: another concurrent caller inserted first. Fetch the winner.
    const [existing] = await db
      .select({ id: agents.id, runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, COMMANDER_AGENT_NAME),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error(
        `Commander agent for company ${companyId} disappeared after conflict`
      );
    }
    agentId = existing.id;
    existingRc = existing.runtimeConfig;
  }

  // D2 idempotent backfill: merge toolAllowlist into existing row's runtimeConfig.
  // P1-B backfill: upgrade adapter_type='process' (no command) rows to the
  // resolved CLI adapter — these rows are unrunnable until upgraded.
  if (!inserted) {
    const rc = existingRc ?? {};
    const aoaCfg = (rc.aoa as Record<string, unknown>) ?? {};
    const updates: Record<string, unknown> = {};

    const mergedToolAllowlist = mergeCommanderToolAllowlist(aoaCfg.toolAllowlist);
    const existingToolAllowlist = Array.isArray(aoaCfg.toolAllowlist)
      ? aoaCfg.toolAllowlist.filter((tool): tool is string => typeof tool === "string" && tool.length > 0)
      : [];
    const toolAllowlistChanged =
      mergedToolAllowlist.length !== existingToolAllowlist.length ||
      mergedToolAllowlist.some((tool, index) => tool !== existingToolAllowlist[index]);

    if (toolAllowlistChanged) {
      updates.runtimeConfig = {
        ...rc,
        aoa: { ...aoaCfg, toolAllowlist: mergedToolAllowlist },
      };
    }

    const [current] = await db
      .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (current) {
      const cfg = current.adapterConfig as Record<string, unknown> | null;
      const isApiKeyAuth = current.adapterType === "codex_local" ? await isCodexApiKeyAuth(companyId, cfg) : false;
      if (shouldRewriteCrewAdapter(current.adapterType, cfg, commanderAdapter.adapterType, commanderAdapter.adapterConfig, { isApiKeyAuth })) {
        updates.adapterType = commanderAdapter.adapterType;
        updates.adapterConfig = mergeCrewAdapterConfig(
          cfg,
          commanderAdapter.adapterConfig,
          current.adapterType,
          commanderAdapter.adapterType,
        );
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.update(agents)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    }
  }
  // Seed the editable instruction bundle (idempotent; never clobbers edits).
  // Runs for BOTH the just-created and the pre-existing (back-fill) paths.
  try {
    const row = await db
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r: { id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> | null }[]) => r[0]);
    if (row) {
      const nextAdapterConfig = await seedCommanderInstructionBundle({
        agent: { id: row.id, companyId: row.companyId, name: row.name, adapterConfig: row.adapterConfig },
        service: agentInstructionsService(),
      });
      await db.update(agents).set({ adapterConfig: nextAdapterConfig, updatedAt: new Date() }).where(eq(agents.id, agentId));
    }
  } catch {
    // Seeding failure must not block Commander provisioning (graceful: the
    // chat falls back to the SYSTEM_INSTRUCTIONS constant — M2).
  }
  // Initialize the Commander's curated skill selection (sensible default =
  // all currently-installed company skills). Flag-guarded via metadata so a
  // founder who later clears the selection is respected (we never re-backfill).
  //
  // QA-BUG-007 fix: the original gate only fired when
  // `!metadata.commanderSkillsInitialized`, which meant the FIRST call —
  // during company create, before any skills are installed — would set
  // `skillKeys: []` and flip the flag to `true`, permanently locking the
  // Commander to zero skills. The seeding order in routes/companies.ts runs
  // `svc.create()` (which invokes ensureCommanderAgent) BEFORE
  // `seedAoaNativeSkills`, so installed.length is always 0 on first call.
  //
  // The corrected predicate also re-runs when the founder has not yet
  // curated anything (`skillKeys.length === 0`) AND skills are now
  // available — that's the legitimate "haven't picked yet, defaults to
  // all-installed" state. The flag still prevents clobbering a deliberate
  // "empty selection" choice: if a founder explicitly cleared all skills
  // after the initial backfill, the empty array carries an
  // `commanderSkillsInitialized: true` flag from a prior call, so the
  // second branch (empty + installed > 0) won't fire — only the first
  // call with the flag UNSET re-tries. This is the safe relax-direction:
  // fixes legacy companies + new companies in one shot, doesn't reintroduce
  // backfill on an explicitly-cleared selection.
  try {
    const [row] = await db
      .select({ skillKeys: agents.skillKeys, metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
    const currentSkillKeys = (row?.skillKeys as string[] | null) ?? [];
    if (!meta.commanderSkillsInitialized || currentSkillKeys.length === 0) {
      const installed = await db
        .select({ key: companySkills.key })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId));
      // Only write when there is something to put there. If installed is
      // also empty (truly fresh company, no skills yet), leave the flag
      // unset so the NEXT call (after seedAoaNativeSkills runs) backfills.
      if (installed.length > 0) {
        await db
          .update(agents)
          .set({
            skillKeys: installed.map((s) => s.key),
            metadata: { ...meta, commanderSkillsInitialized: true },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));
      }
    }
  } catch {
    // Non-fatal: a backfill failure must not block Commander provisioning.
  }
  await db.update(internalAgentConfig).set({ agentId, updatedAt: new Date() })
    .where(eq(internalAgentConfig.companyId, companyId));
  return agentId;
}
