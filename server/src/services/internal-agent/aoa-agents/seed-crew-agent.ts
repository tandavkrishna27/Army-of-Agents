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

/**
 * Phase D batch 1 (T9): shared crew-agent seeder.
 *
 * Before this helper, every ensure-<role>.ts (adjutant, command-staff, maker)
 * duplicated the same ~120-line boilerplate: atomic insert + conflict fetch +
 * trigger seed + toolAllowlist backfill + adapter backfill + instruction bundle
 * seed. Five copies guaranteed they would drift; the P1-B adapter-backfill fix
 * for instance had to be ported to every file by hand.
 *
 * The helper takes a {@link CrewAgentSpec} describing what makes the role
 * unique (name, role string, instruction, tool allowlist, trigger kind/config,
 * bundle role key) and performs the shared boilerplate idempotently.
 *
 * Returns the agent id. Callers may discard or use it for downstream wiring.
 */
export interface CrewAgentTriggerSpec {
  kind: "sweep" | "mention" | "phase-advance" | "outbox" | "event";
  /** Trigger config blob. Convention: `{ role: <bundleRole> }` so dispatcher
   *  can fan out by role. */
  config: Record<string, unknown>;
}

export interface CrewAgentSpec {
  /** Display name. Used by mention parser + UI. Must be unique per company
   *  (enforced by `agents_aoa_name_per_company_idx`). */
  name: string;
  /** `agents.role` column. Usually "general" for crew. */
  role: string;
  /** `runtimeConfig.aoa.instruction` — short string fallback the runner uses
   *  when the bundle root is unavailable. */
  instruction: string;
  /** `runtimeConfig.aoa.toolAllowlist` — default-deny security gate; the
   *  bridge refuses any tool not in this list. */
  toolAllowlist: string[];
  /**
   * Trigger spec(s). Most roles need exactly one trigger; Maker/Engineer needs
   * two (mention + phase-advance). Pass an array even for the single case so
   * callers don't have to remember which shape applies.
   */
  triggers: CrewAgentTriggerSpec[];
  /** Bundle role key — must be registered in default-agent-instructions.ts.
   *  Used to load AGENTS/HEARTBEAT/SOUL/TOOLS markdown files. */
  instructionBundleRole:
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
}

/**
 * Idempotently seed an AoA crew agent for a company. Returns the agent id.
 *
 * Boilerplate handled here:
 * - Atomic insert via ON CONFLICT DO NOTHING (agents_aoa_name_per_company_idx).
 * - Conflict-fetch fallback for concurrent inserts.
 * - Per-trigger insert on new agents only (skipped on conflict fallback).
 * - `toolAllowlist` backfill on existing rows that lack it (D2 idempotent
 *   backfill).
 * - Adapter backfill from legacy `process` (no command) or `claude_local`
 *   missing `dangerouslySkipPermissions` (P1-B fix).
 * - Instruction bundle seed (non-fatal — runner falls back to
 *   `runtimeConfig.aoa.instruction`).
 */
export async function seedCrewAgent(
  db: Db,
  companyId: string,
  spec: CrewAgentSpec,
): Promise<string> {
  // Resolve the right CLI adapter for this company's configured provider
  // (P1-B fix — see ensure-adjutant.ts history for context).
  const crewAdapter = await resolveCrewAdapterForCompany(db, companyId);

  // Atomic insert with ON CONFLICT DO NOTHING (agents_aoa_name_per_company_idx).
  const [inserted] = await db
    .insert(agents)
    .values({
      companyId,
      name: spec.name,
      kind: "aoa",
      role: spec.role,
      status: "idle",
      adapterType: crewAdapter.adapterType,
      adapterConfig: crewAdapter.adapterConfig,
      runtimeConfig: {
        aoa: {
          role: "member",
          instruction: spec.instruction,
          toolAllowlist: spec.toolAllowlist,
        },
        heartbeat: { enabled: false, intervalSec: 0 },
      },
    })
    .onConflictDoNothing()
    .returning({ id: agents.id, runtimeConfig: agents.runtimeConfig });

  let agentId: string;
  let existingRc: Record<string, unknown> | undefined;

  if (inserted) {
    agentId = inserted.id;
    existingRc = inserted.runtimeConfig as Record<string, unknown> | undefined;

    // Seed triggers for the new agent. Idempotent guard is provided by the
    // ON CONFLICT path above — only the truly-new agent gets here, so we
    // never duplicate triggers on subsequent ensure*() calls.
    if (spec.triggers.length > 0) {
      const triggerRows = spec.triggers.map((t) => ({
        companyId,
        agentId,
        kind: t.kind,
        enabled: true,
        config: t.config,
      }));
      // Drizzle accepts a single object or an array; pass the array shape so
      // single-trigger roles still go through the bulk path.
      await db.insert(aoaAgentTriggers).values(triggerRows);
    }
  } else {
    // Conflict: another concurrent caller inserted first. Fetch the winner.
    const [existing] = await db
      .select({ id: agents.id, runtimeConfig: agents.runtimeConfig })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, spec.name),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error(
        `Crew agent '${spec.name}' for company ${companyId} disappeared after conflict`,
      );
    }
    agentId = existing.id;
    existingRc = existing.runtimeConfig as Record<string, unknown> | undefined;
  }

  // D2 idempotent backfill: merge toolAllowlist into existing row's
  // runtimeConfig so pre-D2 rows aren't stranded by default-deny.
  // P1-B backfill: upgrade adapter_type='process' (no command) rows to the
  // resolved CLI adapter — these rows are unrunnable until upgraded.
  //
  // QA-BUG-013 fix (2026-05-29): the original predicate
  // `!Array.isArray(aoaCfg.toolAllowlist)` only refreshed on the first seed
  // when the row had no allowlist at all. Pre-Phase-D rows got their old
  // 5-tool allowlist baked in and never picked up Phase D batch 1/2 additions
  // (thread.postScopeProposal, extract_memory_candidates, delegate_to_subagent,
  // etc.). Net result: Adjutant could not orchestrate the discuss→scope
  // chain, Planner could not write plan artifacts, Memory Keeper could not
  // extract memory candidates — the visible-chat conversation stayed
  // permanently dead because the orchestration tools were missing from the
  // bridge's default-deny gate.
  //
  // Corrected predicate: detect when the code's spec differs from what's on
  // the row (membership mismatch or count mismatch) and overwrite. Safe
  // because:
  //   1. `roleToolAllowlist()` in code is the single source of truth — there
  //      is no per-company UI/API for founders to customise the crew tool
  //      allowlist, so we cannot clobber a deliberate choice.
  //   2. The startup `ensureCommandStaff` / `ensureAdjutant` / `ensureScout` /
  //      `ensureEngineer` loop in `server/src/index.ts` will trigger this
  //      refresh for every company once on next boot, restoring every
  //      crew row across every legacy install.
  if (!inserted) {
    const rc = existingRc ?? {};
    const aoaCfg = (rc.aoa as Record<string, unknown>) ?? {};
    const updates: Record<string, unknown> = {};

    const currentAllowlist = Array.isArray(aoaCfg.toolAllowlist)
      ? (aoaCfg.toolAllowlist as string[])
      : [];
    const expectedSet = new Set(spec.toolAllowlist);
    const currentSet = new Set(currentAllowlist);
    const allowlistDrifted =
      currentSet.size !== expectedSet.size ||
      !spec.toolAllowlist.every((t) => currentSet.has(t));

    if (allowlistDrifted) {
      updates.runtimeConfig = {
        ...rc,
        aoa: { ...aoaCfg, toolAllowlist: spec.toolAllowlist },
      };
    }

    // Fetch the current adapter so we can upgrade-in-place if needed.
    const [current] = await db
      .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (current) {
      const cfg = current.adapterConfig as Record<string, unknown> | null;
      const isApiKeyAuth = current.adapterType === "codex_local" ? await isCodexApiKeyAuth(companyId, cfg) : false;
      if (shouldRewriteCrewAdapter(current.adapterType, cfg, crewAdapter.adapterType, crewAdapter.adapterConfig, { isApiKeyAuth })) {
        updates.adapterType = crewAdapter.adapterType;
        updates.adapterConfig = mergeCrewAdapterConfig(
          cfg,
          crewAdapter.adapterConfig,
          current.adapterType,
          crewAdapter.adapterType,
        );
      }
    }

    if (Object.keys(updates).length > 0) {
      await db
        .update(agents)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    }
  }

  // Seed the role's editable instruction bundle (idempotent; never clobbers
  // founder edits). Non-fatal: seeding failure must not block role
  // provisioning — the runner falls back to `runtimeConfig.aoa.instruction`.
  try {
    const row = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then(
        (
          r: {
            id: string;
            companyId: string;
            name: string;
            adapterConfig: Record<string, unknown> | null;
          }[],
        ) => r[0],
      );
    if (row) {
      const nextAdapterConfig = await seedRoleInstructionBundle({
        role: spec.instructionBundleRole,
        agent: {
          id: row.id,
          companyId: row.companyId,
          name: row.name,
          adapterConfig: row.adapterConfig,
        },
        service: agentInstructionsService(),
      });
      await db
        .update(agents)
        .set({ adapterConfig: nextAdapterConfig, updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    }
  } catch {
    /* non-fatal — runner falls back to the instruction string */
  }

  return agentId;
}
