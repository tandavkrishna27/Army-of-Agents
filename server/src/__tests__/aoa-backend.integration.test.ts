/**
 * A9.2 — Real-DB end-to-end proof of the AoA backend (Plan A): company
 * create eagerly seeds the Commander Team (Decision #100), and a pending
 * discussion entry is durably picked up by the AoA dispatcher and atomically
 * claimed off 'pending' by the direct-provider extraction consumer.
 *
 * Boots embedded-postgres, applies all migrations, then:
 *   1. seeds a company via companyService.create → createCompanyWithUniquePrefix
 *      (which runs ensureInternalAgentConfig + ensureCommanderAgent —
 *      A9.1 wiring),
 *   2. explicitly calls ensureExtractionAgent(db, companyId) — Phase 1 / Phase
 *      D batch 2 removed the seed from bootstrap (autonomous Scribe drain is
 *      gated off), so this integration test (which pins the legacy autonomous
 *      mechanism) seeds it directly,
 *   3. inserts a discussion + a discussion_entry with extractionStatus='pending',
 *   4. runs runAoaDispatch(db, { limiterMax: 2, staleMs: 600000 }),
 *   5. asserts the durable-outbox contract held.
 *
 * Deterministic-without-LLM note: per Decision #100 (amended 2026-05-25, commit
 * 5755aa5c9 "route discussion extraction through the direct-provider path"), the
 * Phase-2 outbox drain calls runExtractionConsumer →
 * extractionService.extractFromDiscussionEntry — the DIRECT-PROVIDER path, NOT
 * the CLI-adapter agent runner. That path atomically claims the entry
 * (pending→processing) and then, because this CI environment has no LLM key,
 * resolveAvailableProvider throws and the entry is terminalized to 'skipped'
 * with a "No LLM provider configured" extractionError — creating NO
 * internal_agent_runs row. So the two assertions below (entry claimed off
 * 'pending'; NO run row attributed to the Scribe agent) hold deterministically
 * with NO external CLI and NO network. A provider-attributed run row
 * (triggerType='event', triggerSource='discussion_entry', no agentId) is created
 * only when a real key is present; asserting it would require seeding a key + a
 * live call, so it is documented (not faked) at the bottom rather than asserted.
 *
 * Skipped on Windows (embedded-postgres / migration-chain issue — Issue #114);
 * Linux CI is the authoritative gate for this test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { runAoaDispatch } from "../services/internal-agent/aoa-agents/dispatcher.js";
import { ensureExtractionAgent } from "../services/internal-agent/aoa-agents/ensure-extraction-agent.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

const PORT = 58000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-backend-integ-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[aoa-backend-integration] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "AoA backend — real DB: company create seeds Commander Team; pending entry dispatched + claimed",
  () => {
    let companyId: string;
    let entryId: string;

    // Phase 1 (Task C1): the autonomous Scribe outbox drain is OFF by default
    // in production. This integration test pins the legacy autonomous-drain
    // mechanism end-to-end (a pending discussion entry → atomically claimed
    // by the kind='aoa' Discussion Extraction agent), so it explicitly opts
    // INTO the drain via env flag while the test runs.
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

    it("setup: company create eagerly seeds the Commander Team (Decision #100)", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }
      const company = await companyService(db).create({ name: "AoA Backend Co" } as any);
      companyId = company.id;
      expect(companyId).toBeTruthy();

      // Phase 1 / Phase D batch 2: bootstrap no longer auto-seeds the
      // Discussion Extraction ("Scribe") agent. This integration test pins
      // the legacy autonomous-drain mechanism end-to-end, so it seeds the
      // extraction agent explicitly here (same idempotent function the
      // dispatcher uses on the gated autonomous path).
      await ensureExtractionAgent(db, companyId);

      // (1) default internal_agent_config row exists (ensureInternalAgentConfig)
      const cfg = await db.execute<{ agent_id: string | null }>(sql`
        SELECT agent_id FROM internal_agent_config WHERE company_id = ${companyId}
      `);
      const cfgRow = Array.isArray(cfg) ? cfg[0] : (cfg as any).rows?.[0];
      expect(cfgRow).toBeTruthy();

      // (2) Commander kind='aoa' agent exists AND is linked into the config
      const commander = await db.execute<{ id: string }>(sql`
        SELECT id FROM agents
        WHERE company_id = ${companyId} AND kind = 'aoa' AND name = 'Commander'
      `);
      const commanderId = firstId(commander);
      expect(commanderId).toBeTruthy();
      expect(cfgRow.agent_id).toBe(commanderId); // ensureCommanderAgent linked it

      // (3) Discussion Extraction kind='aoa' agent + an ENABLED outbox trigger
      // (seeded above via explicit ensureExtractionAgent call).
      const extraction = await db.execute<{ id: string }>(sql`
        SELECT id FROM agents
        WHERE company_id = ${companyId} AND kind = 'aoa' AND name = 'Scribe'
      `);
      const extractionId = firstId(extraction);
      expect(extractionId).toBeTruthy();
      const trig = await db.execute<{ enabled: boolean; agent_id: string }>(sql`
        SELECT enabled, agent_id FROM aoa_agent_triggers
        WHERE company_id = ${companyId} AND kind = 'outbox'
      `);
      const trigRow = Array.isArray(trig) ? trig[0] : (trig as any).rows?.[0];
      expect(trigRow).toBeTruthy();
      expect(trigRow.enabled).toBe(true);
      expect(trigRow.agent_id).toBe(extractionId);
    });

    it("dispatch: a pending discussion entry is durably claimed off 'pending' by the direct-provider extraction consumer", async () => {
      if (setupError) throw new Error(String(setupError));

      const discussionId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO discussions (id, company_id, status, created_by)
        VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test')
        RETURNING id
      `));
      expect(discussionId).toBeTruthy();

      entryId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO discussion_entries
          (id, discussion_id, input_type, raw_content, extraction_status, created_by)
        VALUES
          (gen_random_uuid(), ${discussionId}, 'paste',
           'We decided to ship the dashboard. Krishna to draft the spec.',
           'pending', 'integration-test')
        RETURNING id
      `));
      expect(entryId).toBeTruthy();

      // The durable-outbox dispatcher: Phase-2 gate passes (enabled outbox
      // trigger from setup + AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED), so the pending
      // entry is drained through runExtractionConsumer →
      // extractionService.extractFromDiscussionEntry. Per Decision #100 (amended
      // 2026-05-25, commit 5755aa5c9), that consumer is the DIRECT-PROVIDER path,
      // NOT runAoaAgent: it atomically claims the entry (pending→processing) and
      // then terminalizes it. With no LLM key in CI, resolveAvailableProvider
      // throws and the entry is terminalized to 'skipped' — no run row created.
      await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

      // Assertion 1 — the entry was atomically claimed off 'pending'. This is the
      // core durable-outbox guarantee: the committed extraction_status='pending'
      // row IS the work item, and the dispatcher + consumer must claim it. In CI
      // (no key) the terminal state is 'skipped'; with a key it is
      // 'completed'/'failed'. In every case it must no longer be 'pending'.
      const entry = await db.execute<{ extraction_status: string }>(sql`
        SELECT extraction_status FROM discussion_entries WHERE id = ${entryId}
      `);
      const entryRow = Array.isArray(entry) ? entry[0] : (entry as any).rows?.[0];
      expect(entryRow).toBeTruthy();
      expect(entryRow.extraction_status).not.toBe("pending");

      // Assertion 2 — Decision #100-amendment contract: extraction runs on the
      // DIRECT-PROVIDER path, so NO internal_agent_runs row is ever attributed to
      // the kind='aoa' "Scribe" agent (runExtractionConsumer's agentId arg is
      // intentionally unused; any run row the provider path creates is
      // triggerType='event' with a NULL agent_id). Pin that: zero run rows carry
      // the Scribe agent_id.
      const scribeId = firstId(await db.execute<{ id: string }>(sql`
        SELECT id FROM agents
        WHERE company_id = ${companyId} AND kind = 'aoa' AND name = 'Scribe'
      `));
      expect(scribeId).toBeTruthy();
      const agentRuns = await db.execute<{ id: string }>(sql`
        SELECT id FROM internal_agent_runs
        WHERE company_id = ${companyId} AND agent_id = ${scribeId}
      `);
      const agentRunRows = Array.isArray(agentRuns) ? agentRuns : (agentRuns as any).rows ?? [];
      expect(agentRunRows.length).toBe(0);

      // Assertion 3 (documented — honest no-key CI note): with a real LLM key,
      // extractFromDiscussionEntry inserts exactly ONE internal_agent_runs row
      // with triggerType='event', triggerSource='discussion_entry' (provider-
      // attributed, NOT agent-attributed, NOT triggerType='sub_agent') and links
      // it via discussion_entries.extraction_run_id. Without a key (CI)
      // resolveAvailableProvider throws before any run row is created and the
      // entry is 'skipped'. Asserting the provider run row would require seeding
      // ANTHROPIC_API_KEY/OPENAI_API_KEY and a live network call, so it is left as
      // documentation rather than a networked/flaky assertion.
    });
  },
);
