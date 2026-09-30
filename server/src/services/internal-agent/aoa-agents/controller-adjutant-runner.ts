/**
 * Production AdjutantRunner for the orchestration controller.
 *
 * `makeControllerAdjutantRunner(db)` returns an `AdjutantRunner` that:
 *   1. Resolves the thread's company from `discussions`.
 *   2. Finds that company's active Adjutant agent (kind='aoa', name='Adjutant', not terminated).
 *   3. Invokes `runAoaAgent` with source='thread.controller' — no wakeupId is needed because
 *      the controller path has no agentWakeupRequests row. The Adjutant posts its own entries
 *      via MCP tools (post_entry / thread.postScopeProposal) during the run.
 *   4. Returns `{ output: { status }, error? }` for runController's bookkeeping.
 *
 * NOTE on stale-run suppression: runController's epoch check is the cursor-level guard
 * (prevents double-cursor-advance). The approve handler (thread-deliverables.ts) checks
 * `proposalCursorSeq` vs `discussions.entrySeq` for the dangerous task-materializing
 * stale path — so stale tasks never materialize regardless of whether this runner posts a
 * stale reply entry.
 *
 * `deps.runAgent` is injectable for tests.
 */

import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, discussions, internalAgentConfig } from "@armyofagents/db";
// `runner.ts` eagerly builds the full crew tool-registry at module load (embeddings,
// ~40 tool modules). thread-events.ts imports THIS factory, and discussions.ts imports
// thread-events — so a static `import { runAoaAgent }` would drag that heavy subtree onto
// the discussions/thread-events module-load path. Import only the TYPES statically (erased
// by tsc, zero runtime cost) and defer the value to call time via dynamic import.
// Review I1 (opus, 2026-05-30).
import type { AoaTriggerPayload } from "./runner.js";
import type { AoaRunResult } from "./aoa-run-result.js";
import type { AdjutantRunner } from "../../thread-orchestration.js";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "controller-adjutant-runner" });

/** Shape of `runAoaAgent` — declared from its types so the value stays lazily imported. */
type RunAoaAgentFn = (
  db: Db,
  agentId: string,
  payload: AoaTriggerPayload,
) => Promise<AoaRunResult>;

/**
 * Factory returning a production AdjutantRunner. The returned function is
 * safe to call from the inline fire-and-forget drain (thread-events.ts) and
 * from the backstop sweep (sweep-controller.ts). The atomic claim inside
 * runController serializes concurrent callers — only one wins the claim.
 *
 * @param db - Drizzle db instance.
 * @param deps - Dependency injection for tests. Pass `{ runAgent: myFakeRunner }` to
 *               avoid spawning a real CLI process (also bypasses the dynamic import).
 */
export function makeControllerAdjutantRunner(
  db: Db,
  deps: { runAgent?: RunAoaAgentFn } = {},
): AdjutantRunner {
  return async ({ threadId }) => {
    // Step 1: resolve the thread's company + thread-level autonomy.
    const [thread] = await db
      .select({ companyId: discussions.companyId, autonomyLevel: discussions.autonomyLevel })
      .from(discussions)
      .where(eq(discussions.id, threadId))
      .limit(1);

    if (!thread) {
      log.warn({ threadId }, "controller runner: thread not found");
      return { output: null, error: "thread not found" };
    }

    // Step 2: find the active Adjutant for this company.
    // kind='aoa', name='Adjutant', status != 'terminated'.
    // There is exactly one per company by construction (ensure-adjutant bootstrap +
    // agents_aoa_name_per_company_idx unique index).
    const [adjutant] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, thread.companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, "Adjutant"),
          ne(agents.status, "terminated"),
        ),
      )
      .limit(1);

    if (!adjutant) {
      log.warn(
        { threadId, companyId: thread.companyId },
        "controller runner: no Adjutant agent for company",
      );
      return { output: null, error: "no Adjutant agent for company" };
    }

    // Step 3: resolve effectiveAutonomy = thread.autonomyLevel ?? companyLevel.
    // Mirrors dispatcher.ts D10 block: company config is the fallback; thread-level
    // override wins when set. This is required so the L2 auto-create gate fires for
    // controller-driven Adjutant runs.
    const [companyCfg] = await db
      // D18: the Adjutant is a crew agent, so the company-level fallback is the
      // agent-work dial (`crew_autonomy_level`), not Commander's.
      .select({ autonomyLevel: internalAgentConfig.crewAutonomyLevel })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, thread.companyId))
      .limit(1);
    const companyAutonomyLevel: number = companyCfg?.autonomyLevel ?? 0;
    const effectiveAutonomy: number =
      thread.autonomyLevel != null ? thread.autonomyLevel : companyAutonomyLevel;

    // Step 3b: dial-as-experience belt-and-suspenders (Finding #6).
    // The "no PROACTIVE Adjutant at Manual" invariant is primarily enforced in
    // thread-events.ts:fireAdjutantWakeup (it returns BEFORE driving runController
    // when effectiveAutonomy < 1). This is a cheap, independent re-check so the
    // invariant survives even if a future caller drives runController for a Manual
    // thread (e.g. a backstop sweep, or a pendingRun set by a non-gated path):
    // a Manual dial must never produce a proactive Adjutant post. A DIRECT @mention
    // does NOT flow through this runner — it answers via the controller participation
    // path (processMentions → requestParticipation), which is dial-exempt for
    // activation — so suppressing here cannot block a mention reply.
    if (effectiveAutonomy < 1) {
      log.debug(
        { threadId, companyId: thread.companyId, effectiveAutonomy },
        "controller runner: Manual dial — no proactive Adjutant run (belt-and-suspenders)",
      );
      return { output: { status: "no-pending" }, error: undefined };
    }

    // Step 4: run the Adjutant. wakeupId is intentionally omitted — the controller
    // path has no agentWakeupRequests row. runAoaAgent treats wakeupId as an
    // optional payload extra ([k: string]: unknown) and does not reference it
    // anywhere in its function body.
    //
    // Resolve runAoaAgent lazily (see import note above): tests inject deps.runAgent
    // and never hit the dynamic import; production loads runner.ts here, off the
    // module-load path.
    const runAgent = deps.runAgent ?? (await import("./runner.js")).runAoaAgent;
    const result = await runAgent(db, adjutant.id, {
      companyId: thread.companyId,
      source: "thread.controller",
      threadId,
      effectiveAutonomy,
    });

    log.debug(
      { threadId, agentId: adjutant.id, status: result.status },
      "controller runner: runAoaAgent returned",
    );

    return {
      output: { status: result.status },
      error: result.errorMessage,
      runId: result.runId,
    };
  };
}
