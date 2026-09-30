/**
 * P2-T5 — Advisory real-agent E2E lane for the thread-v2 (crew) loop.
 *
 * This test proves the orchestration controller path executes end-to-end with
 * a real claude_local adapter: a human entry on a controller-path thread
 * triggers runControllerSweep → runController → Adjutant via runAoaAgent →
 * the Adjutant posts its own entry via MCP tools (post_entry / scope_proposal).
 *
 * CRITICAL PRECONDITIONS (all must hold; test is skipped otherwise):
 *   1. Not running on Windows (embedded-postgres migration issue — Issue #114)
 *   2. THREAD_V2_E2E=1 environment variable is set
 *   3. DATABASE_URL environment variable points to a running database with
 *      migrations already applied
 *   4. The Adjutant agent in the test company is configured with
 *      adapterType='claude_local' and valid credentials. The test configures
 *      this explicitly — if the underlying adapter or CLI is absent, the
 *      runControllerSweep call will fail and the test will surface that failure.
 *
 * The describe.skipIf guard is the entire point — removing it or weakening
 * the preconditions would produce a false green. This is intentional per the
 * advisory lane contract documented in .github/workflows/thread-v2-e2e.yml.
 *
 * See docs/qa/thread-v2-release-checklist.md for the authoritative per-release
 * manual gate.
 *
 * ── Task 5.2 addition ─────────────────────────────────────────────────────────
 * The second describe block below (T5.2 — "work-as-tasks converse→propose") is
 * the gated E2E safety net for the Crew Work-as-Tasks feature (P2-T5.2 plan).
 * It seeds a fresh company + Adjutant (+ Scout/Engineer auto-seeded), posts a
 * converging human entry, drives the controller, and asserts that the Adjutant
 * posts a scope_proposal entry with proposalStatus='pending' via the
 * propose_crew_work chokepoint. The thread uses autonomyLevel=1 (L1 / await_human)
 * so the card stays pending — a reliable, model-budget-bounded assertion.
 * The full L2 auto-approve→task→result cycle is NOT asserted here because it
 * requires a running heartbeat worker and a separate crew worker agent run; that
 * is deferred to a dedicated L2 integration harness.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { runControllerSweep } from "../services/internal-agent/aoa-agents/sweep-controller.js";

const isWin32 = process.platform === "win32";
const hasRealE2E = Boolean(process.env.THREAD_V2_E2E);
const hasDbUrl = Boolean(process.env.DATABASE_URL);

// ── Helpers ───────────────────────────────────────────────────────────────────

function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T;
  return (result as any).rows?.[0] as T | undefined;
}

function firstId(result: unknown): string {
  return (firstRow<{ id: string }>(result) as any)?.id;
}

/** Poll until predicate returns a truthy value or the timeout elapses.
 *  Returns the last predicate result (truthy = success, undefined = timeout). */
async function pollUntil<T>(
  predicate: () => Promise<T | undefined | null>,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(isWin32 || !hasRealE2E || !hasDbUrl)(
  "thread v2 real-agent E2E (advisory)",
  () => {
    let db: Db;
    let companyId: string;
    let adjutantAgentId: string;
    let threadId: string;
    let setupError: unknown = null;

    beforeAll(async () => {
      try {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error(
            "DATABASE_URL is not set. The thread-v2 real-agent E2E test requires a " +
            "running database with migrations applied. See " +
            "docs/qa/thread-v2-release-checklist.md for setup.",
          );
        }
        db = createDb(databaseUrl);

        // Seed a test company. companyService.create seeds the full crew
        // (Adjutant, Engineer, Scout, Commander, Command Staff) idempotently.
        const company = await companyService(db).create({
          name: `Thread v2 E2E Co ${Date.now()}`,
        });
        companyId = company.id;

        // Find the Adjutant agent seeded by company create. The Adjutant is
        // kind='aoa', name='Adjutant', not terminated — exactly one per company.
        const adjutantRow = await db.execute<{ id: string }>(sql`
          SELECT id
          FROM agents
          WHERE company_id = ${companyId}
            AND kind = 'aoa'
            AND name = 'Adjutant'
            AND status != 'terminated'
          LIMIT 1
        `);
        const adjutant = firstRow<{ id: string }>(adjutantRow);
        if (!adjutant) {
          throw new Error(
            "Precondition failed: no Adjutant agent found after company create. " +
            "companyService.create should seed the Adjutant via ensureAdjutant. " +
            "Check ensure-adjutant.ts and the company bootstrap path.",
          );
        }
        adjutantAgentId = adjutant.id;

        // Configure the Adjutant with claude_local so it can actually run. The
        // adapter config is read from ACCEPTANCE_ADAPTER_CONFIG if set (JSON
        // string), otherwise uses a minimal default that assumes `claude` is on
        // PATH (the same pattern as aoa-realoutput.integration.test.ts).
        const adapterConfigRaw = process.env.ACCEPTANCE_ADAPTER_CONFIG;
        const adapterConfig = adapterConfigRaw
          ? JSON.parse(adapterConfigRaw)
          : { cwd: process.cwd() };

        await db.execute(sql`
          UPDATE agents
          SET adapter_type = 'claude_local',
              adapter_config = ${JSON.stringify(adapterConfig)}::jsonb,
              updated_at = now()
          WHERE id = ${adjutantAgentId}
        `);

        // Create a controller-path thread. discussionService.create sets
        // useControllerPath=true by default for all new threads (P1-T11). We
        // use a raw insert here to avoid the side-effect chain in
        // discussionService (live events, activity log) that requires a full
        // server context. The thread needs: a discussion row + a
        // threadOrchestrationState row with pendingRun=true.
        const threadRow = await db.execute<{ id: string }>(sql`
          INSERT INTO discussions
            (id, company_id, status, use_controller_path, crew_paused,
             adjutant_enabled, phase, entry_count, entry_seq, created_by)
          VALUES
            (gen_random_uuid(), ${companyId}, 'active', true, false,
             true, 'discuss', 0, 0, 'thread-v2-e2e-test')
          RETURNING id
        `);
        threadId = firstId(threadRow);
        expect(threadId).toBeTruthy();

        // Ensure a thread orchestration state row exists. The production path
        // calls threadOrchestrationService(db).ensureController(threadId) as
        // a best-effort side effect of discussionService.create; we replicate
        // the intent here with an explicit upsert.
        await db.execute(sql`
          INSERT INTO thread_orchestration_state
            (thread_id, pending_run, hop_count, updated_at)
          VALUES
            (${threadId}, false, 0, now())
          ON CONFLICT (thread_id) DO NOTHING
        `);

        // Seed a human entry — converged-ish content that should prompt the
        // Adjutant to act (post an agent entry or scope proposal) rather than
        // exit silently. The content is deliberately concrete so the Adjutant
        // does not apply the "casual chat" heuristic that causes a silent exit.
        await db.execute(sql`
          INSERT INTO discussion_entries
            (id, discussion_id, input_type, raw_content, extraction_status,
             created_by, seq)
          VALUES (
            gen_random_uuid(),
            ${threadId},
            'write',
            'Let''s add CSV export to the budget page — filtered view, one row per cost event. Let''s build it.',
            'skipped',
            'thread-v2-e2e-test',
            1
          )
        `);

        // Bump the discussion's entry_seq + entry_count so the Adjutant sees
        // new human input (the wait-or-act heuristic checks for human entries
        // since last Adjutant action — seq 0→1 means there is new input).
        await db.execute(sql`
          UPDATE discussions
          SET entry_seq = 1, entry_count = 1, last_entry_at = now()
          WHERE id = ${threadId}
        `);

        // Mark the orchestration state as pendingRun=true so runControllerSweep
        // picks it up. In production this is set by the inline drain in
        // thread-events.ts when a human entry lands; we set it directly here
        // to drive the sweep deterministically (no debounce wait).
        await db.execute(sql`
          UPDATE thread_orchestration_state
          SET pending_run = true, updated_at = now()
          WHERE thread_id = ${threadId}
        `);
      } catch (err) {
        setupError = err;
        // eslint-disable-next-line no-console
        console.error("[thread-v2-real-e2e] setup failed:", err);
      }
    }, 60_000);

    afterAll(async () => {
      // Best-effort cleanup: cascade-delete the test company.
      if (db && companyId) {
        try {
          await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
        } catch {
          /* swallow — test isolation, not critical */
        }
      }
    }, 30_000);

    it(
      "Adjutant posts a real agent entry after runControllerSweep claims the pending run",
      async () => {
        if (setupError) {
          throw new Error(
            `Thread v2 real-agent E2E setup failed — cannot assert real output: ${String(setupError)}`,
          );
        }

        // Record the entry count before the sweep so the assertion can detect
        // NEW entries created by the Adjutant (not the human seed entry above).
        const beforeRows = await db.execute<{ count: string }>(sql`
          SELECT COUNT(*)::text AS count
          FROM discussion_entries
          WHERE discussion_id = ${threadId}
            AND input_type IN ('agent', 'scope_proposal')
        `);
        const countBefore = parseInt(
          firstRow<{ count: string }>(beforeRows)?.count ?? "0",
          10,
        );

        // Drive the controller deterministically: runControllerSweep claims the
        // pendingRun, calls runController, which invokes the Adjutant via
        // makeControllerAdjutantRunner → runAoaAgent (real claude_local).
        // The production adapter spawns the claude CLI subprocess synchronously
        // (runAoaAgent awaits the adapter.execute call), so by the time
        // runControllerSweep returns the agent run is complete or has failed.
        await runControllerSweep(db);

        // Poll for a NEW agent-authored discussion_entries row on the thread.
        // Timeout is 120 seconds: generous enough for a real claude_local run
        // (including model latency) but bounded so a hung subprocess doesn't
        // stall CI indefinitely.
        const agentEntry = await pollUntil<{ id: string; input_type: string }>(
          async () => {
            const result = await db.execute<{
              id: string;
              input_type: string;
            }>(sql`
              SELECT id, input_type
              FROM discussion_entries
              WHERE discussion_id = ${threadId}
                AND input_type IN ('agent', 'scope_proposal')
                AND author_agent_id = ${adjutantAgentId}
              LIMIT 1
            `);
            const row = firstRow<{ id: string; input_type: string }>(result);
            // Only return the row if it's genuinely new (author_agent_id match
            // is sufficient — the human seed entry has a different input_type
            // and no author_agent_id so it cannot match).
            return row ?? null;
          },
          120_000,
          2_000,
        );

        // Hard bar: at least one real Adjutant entry appeared.
        expect(
          agentEntry,
          "No agent-authored discussion_entries row appeared within 120 seconds for " +
          `thread ${threadId} / Adjutant ${adjutantAgentId}. ` +
          "Verify: (1) the Adjutant is configured with claude_local and valid creds; " +
          "(2) the claude CLI is on PATH; (3) runControllerSweep claimed the pending run. " +
          "See docs/qa/thread-v2-release-checklist.md § Preconditions.",
        ).toBeTruthy();

        // Weak content assertion: the entry must be one of the expected types.
        // We do NOT assert specific content — the LLM is non-deterministic.
        // The hard bar is 'a real agent entry appeared', not 'it said X'.
        expect(
          ["agent", "scope_proposal"].includes(agentEntry!.input_type),
          `Expected input_type in ('agent','scope_proposal'), got '${agentEntry!.input_type}'`,
        ).toBe(true);

        // Guard: the count of agent entries must have increased (i.e., the
        // entry was newly created by this test run, not a leftover).
        const afterRows = await db.execute<{ count: string }>(sql`
          SELECT COUNT(*)::text AS count
          FROM discussion_entries
          WHERE discussion_id = ${threadId}
            AND input_type IN ('agent', 'scope_proposal')
        `);
        const countAfter = parseInt(
          firstRow<{ count: string }>(afterRows)?.count ?? "0",
          10,
        );
        expect(
          countAfter,
          `Expected agent entry count to increase from ${countBefore}. Got ${countAfter}. ` +
          "The Adjutant may have applied the silent-exit heuristic — ensure the human seed " +
          "entry is concrete enough to trigger a response.",
        ).toBeGreaterThan(countBefore);
      },
      150_000, // 150-second test timeout (120s poll + 30s overhead)
    );
  },
);

// ── T5.2 — Work-as-Tasks converse→propose cycle (gated, L1 card assertion) ────
//
// Seeds a fresh company + Adjutant (Scout + Engineer auto-seeded by
// companyService.create). Posts a converging human entry into a thread with
// autonomyLevel=1 (L1 / await_human). Drives the orchestration controller via
// runControllerSweep and asserts the Adjutant posted a scope_proposal entry with
// proposalStatus='pending' through the propose_crew_work chokepoint.
//
// Gate: identical to the block above — skips when THREAD_V2_E2E, DATABASE_URL,
// or non-Windows preconditions are absent. This is intentional per the advisory
// lane contract (docs/qa/thread-v2-release-checklist.md).
//
// Limitation: asserts the propose-card path (L0/L1 chokepoint) only. The full
// L2 auto-approve → issues with originKind='crew_thread' → agent run → result
// entry cycle is NOT asserted here. L2 requires a running heartbeat worker and a
// live worker agent run, which is out of scope for the controller-sweep harness.
describe.skipIf(isWin32 || !hasRealE2E || !hasDbUrl)(
  "T5.2 work-as-tasks: converse→propose cycle (advisory)",
  () => {
    let db: Db;
    let companyId: string;
    let adjutantAgentId: string;
    let threadId: string;
    let setupError: unknown = null;

    beforeAll(async () => {
      try {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error(
            "DATABASE_URL is not set. The T5.2 real-agent E2E test requires a " +
            "running database with migrations applied. See " +
            "docs/qa/thread-v2-release-checklist.md for setup.",
          );
        }
        db = createDb(databaseUrl);

        // Seed a test company. companyService.create seeds the full AoA crew:
        // Adjutant, Scout, Engineer, Commander, Command Staff. Idempotent.
        const company = await companyService(db).create({
          name: `T5.2 Crew Work E2E Co ${Date.now()}`,
        });
        companyId = company.id;

        // Locate the seeded Adjutant (kind='aoa', name='Adjutant', not terminated).
        const adjutantRow = await db.execute<{ id: string }>(sql`
          SELECT id
          FROM agents
          WHERE company_id = ${companyId}
            AND kind = 'aoa'
            AND name = 'Adjutant'
            AND status != 'terminated'
          LIMIT 1
        `);
        const adjutant = firstRow<{ id: string }>(adjutantRow);
        if (!adjutant) {
          throw new Error(
            "Precondition failed: Adjutant not found after company create. " +
            "companyService.create should seed it via ensureAdjutant. " +
            "Check ensure-adjutant.ts and the company bootstrap path.",
          );
        }
        adjutantAgentId = adjutant.id;

        // Configure the Adjutant with claude_local so it can run. Same pattern
        // as the first suite above: reads ACCEPTANCE_ADAPTER_CONFIG if set
        // (JSON string with extra flags), otherwise a minimal default that
        // expects `claude` on PATH.
        const adapterConfigRaw = process.env.ACCEPTANCE_ADAPTER_CONFIG;
        const adapterConfig = adapterConfigRaw
          ? JSON.parse(adapterConfigRaw)
          : { cwd: process.cwd() };

        await db.execute(sql`
          UPDATE agents
          SET adapter_type = 'claude_local',
              adapter_config = ${JSON.stringify(adapterConfig)}::jsonb,
              updated_at = now()
          WHERE id = ${adjutantAgentId}
        `);

        // Create a controller-path thread with autonomyLevel=1 (L1 / await_human).
        // L1 means the Adjutant MUST write a scope_proposal card and leave it
        // pending (no auto-approve). The Approve handler stamps pending→approved
        // only when the founder clicks Approve; the sweeper sees proposalStatus='pending'.
        // This is the most reliable assertion because it does NOT require a second
        // live agent run (the heartbeat worker waking up a worker crew agent).
        const threadRow = await db.execute<{ id: string }>(sql`
          INSERT INTO discussions
            (id, company_id, status, use_controller_path, crew_paused,
             adjutant_enabled, autonomy_level, phase, entry_count, entry_seq,
             created_by)
          VALUES
            (gen_random_uuid(), ${companyId}, 'active', true, false,
             true, 1, 'discuss', 0, 0, 't5-2-e2e-test')
          RETURNING id
        `);
        threadId = firstId(threadRow);
        expect(threadId).toBeTruthy();

        // Orchestration state row. The sweep picks up threads with pending_run=true.
        await db.execute(sql`
          INSERT INTO thread_orchestration_state
            (thread_id, pending_run, hop_count, updated_at)
          VALUES
            (${threadId}, false, 0, now())
          ON CONFLICT (thread_id) DO NOTHING
        `);

        // Seed a converging human entry. The content is deliberately concrete and
        // action-oriented so the Adjutant does NOT apply the "casual chat / no
        // new input" silent-exit heuristic but instead calls propose_crew_work.
        await db.execute(sql`
          INSERT INTO discussion_entries
            (id, discussion_id, input_type, raw_content, extraction_status,
             created_by, seq)
          VALUES (
            gen_random_uuid(),
            ${threadId},
            'write',
            'We need a usage analytics dashboard: daily active users, event counts per agent, '
              || 'and a cost-per-run trend chart. The data is already in cost_events + activity_log. '
              || 'Scope it out and let''s build it.',
            'skipped',
            't5-2-e2e-test',
            1
          )
        `);

        // Bump entry_seq + entry_count so the wait-or-act heuristic sees new input.
        await db.execute(sql`
          UPDATE discussions
          SET entry_seq = 1, entry_count = 1, last_entry_at = now()
          WHERE id = ${threadId}
        `);

        // Mark pending_run=true — the production path does this via the inline
        // drain in thread-events.ts when a human entry lands. We set it directly
        // to drive runControllerSweep deterministically (no debounce wait).
        await db.execute(sql`
          UPDATE thread_orchestration_state
          SET pending_run = true, updated_at = now()
          WHERE thread_id = ${threadId}
        `);
      } catch (err) {
        setupError = err;
        // eslint-disable-next-line no-console
        console.error("[t5-2-crew-work-e2e] setup failed:", err);
      }
    }, 60_000);

    afterAll(async () => {
      // Best-effort teardown: cascade-delete the test company (removes thread,
      // entries, issues, agents, etc. via FK cascades).
      if (db && companyId) {
        try {
          await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
        } catch {
          /* swallow — test isolation, not critical */
        }
      }
    }, 30_000);

    it(
      "Adjutant posts a scope_proposal card (proposalStatus='pending') after propose_crew_work",
      async () => {
        if (setupError) {
          throw new Error(
            `T5.2 crew-work E2E setup failed — cannot assert real output: ${String(setupError)}`,
          );
        }

        // Drive the controller: runControllerSweep claims the pending_run, calls
        // runController → makeControllerAdjutantRunner → runAoaAgent (real
        // claude_local). The Adjutant receives the propose_crew_work tool on its
        // allowlist and should call it when it sees a converging human entry.
        // The adapter run is synchronous (awaits the subprocess), so by the time
        // runControllerSweep returns the run is complete or has failed.
        await runControllerSweep(db);

        // Poll for a scope_proposal entry with proposalStatus='pending' on this
        // thread. autonomyLevel=1 (L1) means the card stays pending — the Approve
        // handler is NOT triggered by the sweep. We poll to accommodate any
        // asynchronous commit lag between the agent subprocess and the poll loop.
        // Timeout: 120 seconds (real claude_local run including model latency +
        // subprocess overhead). This mirrors the first suite's poll budget.
        const proposalCard = await pollUntil<{
          id: string;
          input_type: string;
          proposal_status: string;
          author_agent_id: string;
        }>(
          async () => {
            const result = await db.execute<{
              id: string;
              input_type: string;
              proposal_status: string;
              author_agent_id: string;
            }>(sql`
              SELECT id, input_type, proposal_status, author_agent_id
              FROM discussion_entries
              WHERE discussion_id = ${threadId}
                AND input_type = 'scope_proposal'
                AND proposal_status = 'pending'
                AND author_agent_id = ${adjutantAgentId}
              LIMIT 1
            `);
            return firstRow<{
              id: string;
              input_type: string;
              proposal_status: string;
              author_agent_id: string;
            }>(result) ?? null;
          },
          120_000,
          2_000,
        );

        // Hard bar: a real scope_proposal card appeared within the timeout.
        expect(
          proposalCard,
          "No scope_proposal entry with proposalStatus='pending' appeared within 120 s for " +
          `thread ${threadId} / Adjutant ${adjutantAgentId}. ` +
          "Verify: (1) claude_local adapter is configured and claude CLI is on PATH; " +
          "(2) ACCEPTANCE_ADAPTER_CONFIG is set if extra flags are needed; " +
          "(3) the Adjutant's allowlist includes propose_crew_work (ensure-adjutant.ts); " +
          "(4) runControllerSweep claimed the pending_run (check thread_orchestration_state). " +
          "See docs/qa/thread-v2-release-checklist.md § Preconditions.",
        ).toBeTruthy();

        // Shape assertions — non-deterministic content is NOT asserted;
        // only the structural contract is checked.
        expect(proposalCard!.input_type).toBe("scope_proposal");
        expect(proposalCard!.proposal_status).toBe("pending");
        expect(proposalCard!.author_agent_id).toBe(adjutantAgentId);

        // Confirm the proposal card is visible in the one-pending-per-thread
        // partial-unique index window (i.e., it is THE pending proposal for this
        // thread, not a duplicate that slipped past the guard).
        const pendingCount = await db.execute<{ count: string }>(sql`
          SELECT COUNT(*)::text AS count
          FROM discussion_entries
          WHERE discussion_id = ${threadId}
            AND input_type = 'scope_proposal'
            AND proposal_status = 'pending'
        `);
        const pending = parseInt(
          firstRow<{ count: string }>(pendingCount)?.count ?? "0",
          10,
        );
        expect(
          pending,
          "Expected exactly one pending scope_proposal per the one-pending-per-thread " +
          "partial-unique index (discussion_entries_one_pending_scope_proposal_idx). " +
          `Got ${pending}.`,
        ).toBe(1);

        // NOTE: The full L2 cycle (auto-approve → issues with originKind='crew_thread'
        // → heartbeat worker wakeup → worker agent run → result entry posted back)
        // is NOT asserted here. Asserting L2 would require: setting autonomyLevel=2,
        // a running heartbeat worker, and a configured worker agent (Scout/Engineer)
        // with claude_local. That is deferred to a dedicated L2 integration harness.
      },
      150_000, // 150-second test timeout (120s poll + 30s overhead)
    );
  },
);
