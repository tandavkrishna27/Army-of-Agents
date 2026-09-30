/**
 * D18 integration — the crew and Commander autonomy dials move independently.
 *
 * THE DISCRIMINATOR (T2.10 step 4). Real Postgres, real reader. Each behavioural
 * case sets the two dials to OPPOSITE ends and asserts the crew flow followed
 * the CREW dial:
 *
 *   Case A  Commander = Drive(2), crew = Manual(0)  → Manual behaviour (no tasks)
 *   Case B  Commander = Manual(0), crew = Drive(2)  → Drive behaviour (task + wakeup)
 *
 * Either case alone could pass by accident; together they can only both pass if
 * the reader genuinely reads `crew_autonomy_level`. Concretely:
 *   - pre-split code (reader on `autonomy_level`) → A creates a task (FAIL)
 *   - a column ALIAS (both keys → `autonomy_level`) → the two UPDATEs clobber
 *     each other, so A and B cannot both be set up (FAIL, loudly)
 *   - mirrored writes in the settings route → same clobber (FAIL)
 *
 * The reader under test is the W1b scope auto-accept gate
 * (`thread-agent-actions.ts` → `resolveScopeAutoAcceptGate`) driven through the
 * COMPANY dial: `discussions.autonomy_level` is deliberately left NULL so the
 * company fallback is what decides. Modeled on w1b-auto-accept.integration.test.ts.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { threadAgentActionService } from "../services/thread-agent-actions.js";
import { captureFreshnessSnapshot } from "../services/thread-agent-action-freshness.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

/**
 * Fail LOUDLY and ONCE when embedded-postgres never came up.
 *
 * `setupError = err` alone is not a guard: embedded-postgres can reject with
 * `undefined`, which is falsy, so the old `if (setupError) throw` silently
 * no-oped and every case then ran against an unassigned `db` — a wall of
 * `Cannot read properties of undefined (reading 'insert')` pointing into
 * product code, which reads as a product bug rather than a setup failure.
 * A boolean cannot be falsy-by-accident, and the `db` check covers a throw
 * that happens to leave `setupError` null.
 */
function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

// Offset from the W1a (59100) / W1b (59600) ranges to avoid port collisions.
const PORT = 60100 + Math.floor(Math.random() * 300);

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

async function seedCompanyAndAgent(label: string): Promise<{
  companyId: string;
  agentId: string;
}> {
  const company = await companyService(db).create({ name: `D18 ${label} Co` } as never);
  const companyId = company.id;
  // create() auto-seeds the AoA crew (incl. 'Engineer') and the
  // internal_agent_config row. Reuse the seeded Engineer — a second INSERT would
  // violate agents_aoa_name_per_company_idx.
  let engRows = rowsOf(
    await db.execute(sql`
      SELECT id FROM agents
      WHERE company_id = ${companyId} AND kind = 'aoa' AND name = 'Engineer' AND status <> 'terminated'
      LIMIT 1
    `),
  );
  if (engRows.length === 0) {
    engRows = rowsOf(
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name, kind, status)
        VALUES (gen_random_uuid(), ${companyId}, 'Engineer', 'aoa', 'idle')
        RETURNING id
      `),
    );
  }
  return { companyId, agentId: String(engRows[0].id) };
}

/** Seed a thread with one entry. `autonomy_level` is left NULL on purpose. */
async function seedThread(companyId: string): Promise<string> {
  const [thread] = rowsOf(
    await db.execute(sql`
      INSERT INTO discussions (id, company_id, status, created_by, entry_seq)
      VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test', 1)
      RETURNING id
    `),
  );
  const threadId = String(thread.id);
  await db.execute(sql`
    INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, created_by, seq)
    VALUES (gen_random_uuid(), ${threadId}, 'write', 'scope the billing work', 'human-user', 1)
  `);
  return threadId;
}

async function seedRun(companyId: string): Promise<string> {
  const [run] = rowsOf(
    await db.execute(sql`
      INSERT INTO internal_agent_runs (id, company_id, trigger_type, trigger_source)
      VALUES (gen_random_uuid(), ${companyId}, 'event', 'integration-test')
      RETURNING id
    `),
  );
  return String(run.id);
}

/** Set the two company dials INDEPENDENTLY, then read both back. */
async function setDials(
  companyId: string,
  commander: number,
  crew: number,
): Promise<{ commander: number; crew: number }> {
  // Two separate statements on purpose: under a column alias the second would
  // silently overwrite the first and the read-back below would catch it.
  await db.execute(sql`
    UPDATE internal_agent_config SET autonomy_level = ${commander} WHERE company_id = ${companyId}
  `);
  await db.execute(sql`
    UPDATE internal_agent_config SET crew_autonomy_level = ${crew} WHERE company_id = ${companyId}
  `);
  const [row] = rowsOf(
    await db.execute(sql`
      SELECT autonomy_level, crew_autonomy_level FROM internal_agent_config
      WHERE company_id = ${companyId}
    `),
  );
  return {
    commander: Number(row.autonomy_level),
    crew: Number(row.crew_autonomy_level),
  };
}

async function queueScopeDraft(
  companyId: string,
  threadId: string,
  agentId: string,
  key: string,
): Promise<{ runId: string; actionId: string }> {
  const snap = await captureFreshnessSnapshot(db as never, threadId);
  const runId = await seedRun(companyId);
  const actionId = randomUUID();
  await db.execute(sql`
    INSERT INTO thread_agent_actions
      (id, company_id, thread_id, run_id, agent_id, action_type, status, payload, idempotency_key, freshness)
    VALUES
      (${actionId}, ${companyId}, ${threadId}, ${runId}, ${agentId}, 'create_scope_draft', 'ready',
       ${JSON.stringify({
         summary: "Billing scope",
         proposedTasks: [{ title: "Build invoice endpoint", assigneeRole: "engineer" }],
       })}::jsonb,
       ${`k:d18:${key}:${actionId}`},
       ${JSON.stringify(snap)}::jsonb)
  `);
  return { runId, actionId };
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-d18-dial-split-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Force UTF-8 so migration SQL containing non-Latin1 chars applies on a
      // Windows dev box (initdb would otherwise inherit WIN1252).
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[d18-dial-split] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
)("D18 integration — crew and Commander autonomy are independently dialable", () => {
  it("migration 0183 created a SECOND physical column (not an alias)", async () => {
    assertSetupOk();

    const cols = rowsOf(
      await db.execute(sql`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'internal_agent_config'
          AND column_name IN ('autonomy_level', 'crew_autonomy_level')
        ORDER BY column_name
      `),
    );
    // An alias (`crewAutonomyLevel: integer("autonomy_level")`) would produce a
    // single row here.
    expect(cols.map((c) => String(c.column_name))).toEqual([
      "autonomy_level",
      "crew_autonomy_level",
    ]);
    const crew = cols[1];
    expect(String(crew.data_type)).toBe("integer");
    expect(String(crew.is_nullable)).toBe("NO");
    expect(String(crew.column_default)).toContain("1");
  });

  it("a fresh company gets Assist (1) on BOTH dials — Phase 1's default flip preserved", async () => {
    assertSetupOk();

    const { companyId } = await seedCompanyAndAgent("Defaults");
    const [row] = rowsOf(
      await db.execute(sql`
        SELECT autonomy_level, crew_autonomy_level FROM internal_agent_config
        WHERE company_id = ${companyId}
      `),
    );
    // Decision #109 §8: at Manual the crew completion guard ping-ponged every
    // task. The split must not have reverted the crew dial to 0.
    expect(Number(row.crew_autonomy_level)).toBe(1);
    expect(Number(row.autonomy_level)).toBe(1);
  });

  it("writing one dial does not move the other (both directions)", async () => {
    assertSetupOk();

    const { companyId } = await seedCompanyAndAgent("Storage");

    const raised = await setDials(companyId, 0, 2);
    expect(raised).toEqual({ commander: 0, crew: 2 });

    // Now move ONLY Commander's dial and prove crew stayed at Drive.
    await db.execute(sql`
      UPDATE internal_agent_config SET autonomy_level = 2 WHERE company_id = ${companyId}
    `);
    const [afterCommander] = rowsOf(
      await db.execute(sql`
        SELECT autonomy_level, crew_autonomy_level FROM internal_agent_config
        WHERE company_id = ${companyId}
      `),
    );
    expect(Number(afterCommander.autonomy_level)).toBe(2);
    expect(Number(afterCommander.crew_autonomy_level)).toBe(2);

    // And move ONLY the crew dial down; Commander must stay at Drive.
    await db.execute(sql`
      UPDATE internal_agent_config SET crew_autonomy_level = 0 WHERE company_id = ${companyId}
    `);
    const [afterCrew] = rowsOf(
      await db.execute(sql`
        SELECT autonomy_level, crew_autonomy_level FROM internal_agent_config
        WHERE company_id = ${companyId}
      `),
    );
    expect(Number(afterCrew.crew_autonomy_level)).toBe(0);
    expect(Number(afterCrew.autonomy_level)).toBe(2);
  });

  // ── Case A — Commander Drive, crew Manual → the crew flow must stay Manual ──

  it("Commander=Drive + crew=Manual: the scope gate stays Manual (no tasks created)", async () => {
    assertSetupOk();

    const { companyId, agentId } = await seedCompanyAndAgent("CaseA");
    const threadId = await seedThread(companyId);
    const dials = await setDials(companyId, 2, 0);
    expect(dials).toEqual({ commander: 2, crew: 0 });

    const { runId, actionId } = await queueScopeDraft(companyId, threadId, agentId, "a");
    const result = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(result.committed).toBe(1);
    expect(result.failed).toBe(0);

    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status, committed_scope_version_id FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");
    const scopeVersionId = String(actionRow.committed_scope_version_id);

    // Manual = draft_only: the draft exists but nothing was created or dispatched.
    // A reader still on `autonomy_level` would see Drive(2) here and create one.
    const issueRows = rowsOf(
      await db.execute(sql`SELECT id FROM issues WHERE source_discussion_id = ${threadId}`),
    );
    expect(issueRows).toHaveLength(0);

    const [versionRow] = rowsOf(
      await db.execute(sql`
        SELECT status FROM thread_scope_versions WHERE id = ${scopeVersionId}
      `),
    );
    expect(String(versionRow.status)).toBe("draft");
  });

  // ── Case B — Commander Manual, crew Drive → the crew flow must run at Drive ──

  it("Commander=Manual + crew=Drive: the scope gate runs at Drive (task + wakeup)", async () => {
    assertSetupOk();

    const { companyId, agentId } = await seedCompanyAndAgent("CaseB");
    const threadId = await seedThread(companyId);
    const dials = await setDials(companyId, 0, 2);
    expect(dials).toEqual({ commander: 0, crew: 2 });

    const { runId, actionId } = await queueScopeDraft(companyId, threadId, agentId, "b");
    const result = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(result.committed).toBe(1);
    expect(result.failed).toBe(0);

    const [actionRow] = rowsOf(
      await db.execute(sql`
        SELECT status FROM thread_agent_actions WHERE id = ${actionId}
      `),
    );
    expect(String(actionRow.status)).toBe("committed");

    // Drive = accept_apply_dispatch: a standard (dispatchable) task, assigned,
    // plus a wakeup row. A reader still on `autonomy_level` would see Manual(0)
    // here and create nothing.
    const issueRows = rowsOf(
      await db.execute(sql`
        SELECT id, assignee_agent_id, work_mode FROM issues WHERE source_discussion_id = ${threadId}
      `),
    );
    expect(issueRows).toHaveLength(1);
    expect(String(issueRows[0].assignee_agent_id)).toBe(agentId);
    expect(String(issueRows[0].work_mode)).toBe("standard");

    const wakeupRows = rowsOf(
      await db.execute(sql`
        SELECT id FROM agent_wakeup_requests
        WHERE agent_id = ${agentId} AND payload->>'issueId' = ${String(issueRows[0].id)}
      `),
    );
    expect(wakeupRows.length).toBeGreaterThanOrEqual(1);
  });

  // ── The per-thread override still outranks the company crew dial ────────────

  it("a per-thread override still wins over the company crew dial", async () => {
    assertSetupOk();

    const { companyId, agentId } = await seedCompanyAndAgent("Override");
    const threadId = await seedThread(companyId);
    await setDials(companyId, 0, 0); // company: Manual on BOTH dials
    await db.execute(sql`
      UPDATE discussions SET autonomy_level = 2 WHERE id = ${threadId}
    `);

    const { runId } = await queueScopeDraft(companyId, threadId, agentId, "override");
    const result = await threadAgentActionService(db).commitThreadAgentActions({
      companyId,
      threadId,
      runId,
    });
    expect(result.committed).toBe(1);

    // Thread Drive beats company Manual — the split must not have collapsed the
    // `thread.autonomyLevel ?? company.crewAutonomyLevel` resolution order.
    const issueRows = rowsOf(
      await db.execute(sql`
        SELECT id, work_mode FROM issues WHERE source_discussion_id = ${threadId}
      `),
    );
    expect(issueRows).toHaveLength(1);
    expect(String(issueRows[0].work_mode)).toBe("standard");
  });
});
