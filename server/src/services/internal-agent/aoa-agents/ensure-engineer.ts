import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

/**
 * Phase D batch 1 (T6) — Engineer role seed (replaces Maker).
 *
 * Engineer is the artifact-creation arm of the thread crew. Adjutant delegates
 * to Engineer when a thread needs a deliverable (document, report, design,
 * code). Engineer creates artifact versions, requests a workspace if the work
 * needs runtime (HTML mockup with dev server), and posts back to the thread.
 *
 * Triggered via:
 *   - mention      (@Engineer in a thread entry)
 *   - phase-advance (entering scope/assign phase if the plan calls for an
 *                    artifact)
 *
 * Maker → Engineer rename: pre-Phase-D rows seeded by ensure-maker.ts have
 * name='Maker'. We UPDATE them to 'Engineer' before seedCrewAgent runs so the
 * agents_aoa_name_per_company_idx unique index doesn't end up with both a
 * Maker and an Engineer row for the same company. Idempotent on subsequent
 * calls (the WHERE clause matches zero rows once the rename has happened).
 *
 * Engineer's allowlist closes the Phase D batch 2 TODO in tool-registry.ts:
 * create_artifact_version, query_artifacts, request_thread_workspace land
 * here.
 */

const ENGINEER_INSTRUCTION = `You are Engineer — artifact creation for threads.

Adjutant delegates artifact work to you. When dispatched:
1. Read the thread context (entries + summary) provided.
2. Determine the artifact type the thread needs (document / report / design / code).
3. Use create_artifact to make the first version, then create_artifact_version for iterations.
4. Post the artifact link as an entry (post_entry with attachToEntryId to link back to the requesting entry).
5. If the work needs an interactive workspace (e.g. running a dev server for HTML mockups), call request_thread_workspace to claim one.
6. Hand back to Adjutant when the artifact is ready for review.`;

export const ENGINEER_TOOL_ALLOWLIST: string[] = [
  "create_artifact",
  "create_artifact_version",
  "query_artifacts",
  "request_thread_workspace",
  "thread.listEntries",
  "post_entry",
  "use_skill",
  // Spec B Task 6 — crew task tools. Engineer executes artifact work on a
  // dispatched task: read it (get_task), comment progress (post_task_comment),
  // hand back the deliverable (attach_task_artifact), and advance it
  // (set_task_status). get_task=query; the rest=coordination — neither category
  // grants system_actions (Engineer already has it via create_artifact), so
  // these add no new capability.
  "get_task",
  "post_task_comment",
  "attach_task_artifact",
  "set_task_status",
  "ask_human",
];

/**
 * Idempotently seed the Engineer role for a company. Migrates any pre-existing
 * Maker row to Engineer (in-place rename — no double-row) before delegating to
 * the shared seeder.
 */
export async function ensureEngineer(db: Db, companyId: string): Promise<void> {
  // Migrate any existing Maker row to Engineer before seeding. Idempotent:
  // the WHERE clause only matches the legacy name.
  //
  // L13 guard: only rename when NO Engineer row already exists for this company.
  // If a company somehow holds BOTH a Maker and an Engineer row (e.g. a partial
  // prior migration, or an Engineer seeded alongside a leftover Maker), an
  // unconditional rename would collide on the agents_aoa_name_per_company_idx
  // unique index (one name per company). When an Engineer already exists we skip
  // the rename — seedCrewAgent below is itself idempotent and keeps the existing
  // Engineer canonical; the stale Maker is simply left as-is rather than crashing
  // the bootstrap. Still idempotent on the common path (no Engineer yet → rename
  // the Maker; second call finds the Engineer and skips).
  const [existingEngineer] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, "Engineer"),
      ),
    )
    .limit(1);

  if (!existingEngineer) {
    await db
      .update(agents)
      .set({ name: "Engineer", updatedAt: new Date() })
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, "Maker"),
        ),
      );
  }

  await seedCrewAgent(db, companyId, {
    name: "Engineer",
    role: "general",
    instruction: ENGINEER_INSTRUCTION,
    toolAllowlist: ENGINEER_TOOL_ALLOWLIST,
    triggers: [
      // Mirror Maker's dual-trigger shape: mention-driven on demand, plus
      // phase-advance for routed plans that assign Engineer an artifact.
      { kind: "mention", config: { role: "engineer" } },
      { kind: "phase-advance", config: { role: "engineer" } },
    ],
    instructionBundleRole: "engineer",
  });
}
