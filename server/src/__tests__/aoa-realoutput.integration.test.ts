/**
 * D5 §17 — "hard bar" real-output acceptance test.
 *
 * This test proves the Discussion Extraction AoA agent can process a real
 * discussion entry via a live claude_local adapter and produce actual
 * discussion_extracted_items rows — the hard bar a no-credentials mock
 * cannot satisfy.
 *
 * CRITICAL PRECONDITIONS (all must hold; test skips otherwise):
 *   1. Not running on Windows (embedded-postgres migration issue — Issue #114)
 *   2. AOA_ACCEPTANCE_CLI=1 environment variable is set
 *   3. DATABASE_URL environment variable points to a running database with
 *      migrations already applied
 *   4. The Discussion Extraction AoA agent in the target company is configured
 *      with adapterType='claude_local' and valid credentials
 *
 * The describe.skipIf guard is the entire point — removing it or weakening
 * the preconditions would produce a false green. This is intentional per §17.
 *
 * See docs/guides/board-operator/aoa-agents-acceptance.md for setup instructions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { runAoaDispatch } from "../services/internal-agent/aoa-agents/dispatcher.js";
import { ensureExtractionAgent } from "../services/internal-agent/aoa-agents/ensure-extraction-agent.js";

const isWin32 = process.platform === "win32";
const hasAcceptanceCli = Boolean(process.env.AOA_ACCEPTANCE_CLI);

// ── Helpers ──────────────────────────────────────────────────────────────────

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

describe.skipIf(isWin32 || !hasAcceptanceCli)(
  "AoA real-output acceptance (§17 hard bar)",
  () => {
    let db: Db;
    let companyId: string;
    let extractionAgentId: string;
    let entryId: string;
    let setupError: unknown = null;

    // Phase 1 (Task C1): autonomous Scribe outbox drain is OFF in production.
    // The §17 hard-bar acceptance test pins the full autonomous extraction path
    // end-to-end (real claude_local adapter producing extracted_items rows), so
    // it opts INTO the drain via env flag while the test runs.
    const ORIGINAL_DRAIN_FLAG = process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED;
    beforeEach(() => {
      process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED = "true";
    });
    afterEach(() => {
      if (ORIGINAL_DRAIN_FLAG === undefined) {
        delete process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED;
      } else {
        process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED = ORIGINAL_DRAIN_FLAG;
      }
    });

    beforeAll(async () => {
      try {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error(
            "DATABASE_URL is not set. The §17 acceptance test requires a real " +
            "running database with migrations applied. See " +
            "docs/guides/board-operator/aoa-agents-acceptance.md for setup.",
          );
        }
        db = createDb(databaseUrl);

        // Create a test company. Phase 1 / Phase D batch 2 removed the
        // automatic Discussion Extraction ("Scribe") seed from
        // companyService.create (autonomous Scribe drain is now gated off);
        // this §17 acceptance test pins the full autonomous extraction path,
        // so we seed it explicitly below via ensureExtractionAgent.
        const company = await companyService(db).create({
          name: `AoA §17 Acceptance Co ${Date.now()}`,
        } as any);
        companyId = company.id;

        // Seed the extraction agent explicitly (idempotent — same function
        // the dispatcher uses on the gated autonomous path).
        extractionAgentId = await ensureExtractionAgent(db, companyId);

        // Configure the extraction agent with claude_local so it can actually
        // run. The adapter config is read from ACCEPTANCE_ADAPTER_CONFIG if set
        // (JSON string), otherwise uses a minimal default that assumes `claude`
        // is on PATH. Board operators must set this per their environment.
        const adapterConfigRaw = process.env.ACCEPTANCE_ADAPTER_CONFIG;
        const adapterConfig = adapterConfigRaw
          ? JSON.parse(adapterConfigRaw)
          : { cwd: process.cwd() };

        await db.execute(sql`
          UPDATE agents
          SET adapter_type = 'claude_local',
              adapter_config = ${JSON.stringify(adapterConfig)}::jsonb,
              updated_at = now()
          WHERE id = ${extractionAgentId}
        `);
      } catch (err) {
        setupError = err;
        // eslint-disable-next-line no-console
        console.error("[aoa-realoutput-acceptance] setup failed:", err);
      }
    }, 60_000);

    afterAll(async () => {
      // Best-effort cleanup: delete the test company (cascade deletes agents,
      // discussions, extracted items, runs, cost_events, etc.)
      if (db && companyId) {
        try {
          await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
        } catch {
          /* swallow — test isolation, not critical */
        }
      }
    }, 30_000);

    it(
      "extraction agent produces real discussion_extracted_items from a seeded entry",
      async () => {
        if (setupError) {
          throw new Error(
            `§17 acceptance test setup failed — cannot assert real output: ${String(setupError)}`,
          );
        }

        // ── Seed: create a discussion and a pending entry ──────────────────

        const discussionId = firstId(await db.execute<{ id: string }>(sql`
          INSERT INTO discussions (id, company_id, status, created_by)
          VALUES (gen_random_uuid(), ${companyId}, 'active', 'acceptance-test')
          RETURNING id
        `));
        expect(discussionId).toBeTruthy();

        // Entry text contains a clear decision AND a clear task — the extraction
        // agent should produce at least two items.
        entryId = firstId(await db.execute<{ id: string }>(sql`
          INSERT INTO discussion_entries
            (id, discussion_id, input_type, raw_content, extraction_status, created_by)
          VALUES (
            gen_random_uuid(),
            ${discussionId},
            'paste',
            'We have decided to use PostgreSQL as our primary database. ' ||
            'We need to set up the database schema migrations before the sprint ends.',
            'pending',
            'acceptance-test'
          )
          RETURNING id
        `));
        expect(entryId).toBeTruthy();

        // ── Dispatch: run the AoA outbox dispatcher once ───────────────────
        // runAoaDispatch will find the enabled outbox trigger, resolve the
        // extraction agent, and call runAoaAgent (which atomically claims the
        // entry and spawns the claude_local adapter process).
        await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

        // ── Poll: wait for extraction to complete (up to 90 seconds) ──────
        // The extraction agent runs asynchronously via the adapter. We poll
        // the database for the entry to reach a terminal extraction_status.
        const completedEntry = await pollUntil<{ extraction_status: string }>(
          async () => {
            const result = await db.execute<{ extraction_status: string }>(sql`
              SELECT extraction_status
              FROM discussion_entries
              WHERE id = ${entryId}
                AND extraction_status IN ('completed', 'failed')
            `);
            return firstRow<{ extraction_status: string }>(result) ?? null;
          },
          90_000,
          2_000,
        );

        // ── Assert 1: entry reached a terminal extraction_status ───────────
        expect(
          completedEntry,
          "Discussion entry did not reach a terminal extraction_status within 90 seconds. " +
          "Verify the claude_local adapter is configured and the outbox trigger is enabled. " +
          "See docs/guides/board-operator/aoa-agents-acceptance.md for troubleshooting.",
        ).toBeTruthy();
        expect(completedEntry!.extraction_status).toBe("completed");

        // ── Assert 2: at least one discussion_extracted_items row ──────────
        const items = await db.execute<{ id: string; type: string; title: string }>(sql`
          SELECT id, type, title
          FROM discussion_extracted_items
          WHERE discussion_entry_id = ${entryId}
        `);
        const itemRows = Array.isArray(items) ? items : (items as any).rows ?? [];
        expect(
          itemRows.length,
          `Expected ≥1 discussion_extracted_items for entry ${entryId}, got 0. ` +
          "The claude_local adapter ran but the extraction agent did not call submit_extracted_items.",
        ).toBeGreaterThanOrEqual(1);

        // ── Assert 3: at least one item is a decision or task ─────────────
        const hasExpectedType = itemRows.some(
          (r: { type: string }) => r.type === "decision" || r.type === "task",
        );
        expect(
          hasExpectedType,
          `Expected at least one item of type 'decision' or 'task'. Got types: ` +
          itemRows.map((r: { type: string }) => r.type).join(", "),
        ).toBe(true);

        // ── Assert 4: an internal_agent_runs row with status='completed' ───
        const runRow = await db.execute<{ status: string; trigger_type: string }>(sql`
          SELECT status, trigger_type
          FROM internal_agent_runs
          WHERE company_id = ${companyId}
            AND agent_id = ${extractionAgentId}
            AND status = 'completed'
          LIMIT 1
        `);
        const run = firstRow<{ status: string; trigger_type: string }>(runRow);
        expect(
          run,
          "Expected an internal_agent_runs row with status='completed' for the extraction agent.",
        ).toBeTruthy();
        expect(run!.status).toBe("completed");
        expect(run!.trigger_type).toBe("sub_agent");

        // ── Assert 5: a cost_events row was recorded ───────────────────────
        // The cost event is emitted on the success path (after adapter.execute
        // returns, before catch). With a real claude_local adapter that succeeds,
        // this row must exist.
        const costRow = await db.execute<{ cost_cents: number }>(sql`
          SELECT cost_cents
          FROM cost_events
          WHERE company_id = ${companyId}
            AND agent_id = ${extractionAgentId}
          LIMIT 1
        `);
        const cost = firstRow<{ cost_cents: number }>(costRow);
        expect(
          cost,
          "Expected a cost_events row for the extraction agent (cost_cents=0 in v1).",
        ).toBeTruthy();
        // v1 bills zero — the row exists but cost is zeroed
        expect(typeof cost!.cost_cents).toBe("number");
      },
      120_000, // 120-second test timeout (90s poll + 30s overhead)
    );
  },
);
