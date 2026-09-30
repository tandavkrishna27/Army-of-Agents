import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { resolveCheapFallbackModel } from "../services/cheap-fallback.js";

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
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

const PORT = 57000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-cheap-fallback-test-"));
    const { default: EmbeddedPostgres } = (await import(
      "embedded-postgres"
    )) as { default: EmbeddedPostgresCtor };

    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();

    const connStr = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connStr);
    db = createDb(connStr);

    // Seed: company (only columns that exist in the schema)
    await db.execute(
      `INSERT INTO companies (id, name)
       VALUES ('c1000000-0000-0000-0000-000000000001', 'Test Co')`,
    );

    // Seed: internal_agent_config with cheap_model set
    await db.execute(
      `INSERT INTO internal_agent_config
         (id, company_id, execution_mode, cheap_model)
       VALUES
         ('1a000000-0000-0000-0000-000000000001',
          'c1000000-0000-0000-0000-000000000001',
          'cli',
          'claude-haiku-4-5')`,
    );

    // Seed: agent with budget_monthly_cents = 1000
    await db.execute(
      `INSERT INTO agents (id, company_id, name, adapter_type, budget_monthly_cents)
       VALUES ('a9000000-0000-0000-0000-000000000001',
               'c1000000-0000-0000-0000-000000000001',
               'Test Agent', 'claude_local', 1000)`,
    );
  } catch (err) {
    console.error("[cheap-fallback-integration] embedded-postgres setup failed:", err);
    setupError = err;
  }
}, 120_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

// Skipped on Windows due to embedded-postgres UTF-8 -> WIN1252 encoding
// issue (Issue #113). The embedded-postgres cluster is initialised with the
// OS locale (WIN1252) on Windows, causing migration SQL containing non-ASCII
// characters (→, —) to fail. Linux + macOS coverage remains.
describe.skipIf(process.platform === "win32")(
  "resolveCheapFallbackModel (integration)",
  () => {
  beforeEach(() => {
    if (setupError) throw setupError;
  });

  it("returns null when agent has no cost_events (spend = 0, below 80%)", async () => {
    const result = await resolveCheapFallbackModel(
      db,
      "c1000000-0000-0000-0000-000000000001",
      "a9000000-0000-0000-0000-000000000001",
      1000,
    );
    expect(result).toBeNull();
  });

  it("returns null when spend is 799 cents (79.9%, below threshold)", async () => {
    await db.execute(
      `INSERT INTO cost_events
         (id, company_id, agent_id, cost_cents, occurred_at, provider, model)
       VALUES
         (gen_random_uuid(),
          'c1000000-0000-0000-0000-000000000001',
          'a9000000-0000-0000-0000-000000000001',
          799,
          NOW(),
          'anthropic',
          'claude-haiku-4-5')`,
    );

    const result = await resolveCheapFallbackModel(
      db,
      "c1000000-0000-0000-0000-000000000001",
      "a9000000-0000-0000-0000-000000000001",
      1000,
    );
    expect(result).toBeNull();

    await db.execute(
      `DELETE FROM cost_events WHERE agent_id = 'a9000000-0000-0000-0000-000000000001'`,
    );
  });

  it("returns 'claude-haiku-4-5' when spend is 800 cents (exactly 80%)", async () => {
    await db.execute(
      `INSERT INTO cost_events
         (id, company_id, agent_id, cost_cents, occurred_at, provider, model)
       VALUES
         (gen_random_uuid(),
          'c1000000-0000-0000-0000-000000000001',
          'a9000000-0000-0000-0000-000000000001',
          800,
          NOW(),
          'anthropic',
          'claude-haiku-4-5')`,
    );

    const result = await resolveCheapFallbackModel(
      db,
      "c1000000-0000-0000-0000-000000000001",
      "a9000000-0000-0000-0000-000000000001",
      1000,
    );
    expect(result).toBe("claude-haiku-4-5");

    await db.execute(
      `DELETE FROM cost_events WHERE agent_id = 'a9000000-0000-0000-0000-000000000001'`,
    );
  });

  it("returns null when budget is 0 (unlimited)", async () => {
    const result = await resolveCheapFallbackModel(
      db,
      "c1000000-0000-0000-0000-000000000001",
      "a9000000-0000-0000-0000-000000000001",
      0,
    );
    expect(result).toBeNull();
  });

  it("returns null when company has no cheap_model configured", async () => {
    await db.execute(
      `UPDATE internal_agent_config SET cheap_model = NULL
       WHERE company_id = 'c1000000-0000-0000-0000-000000000001'`,
    );
    await db.execute(
      `INSERT INTO cost_events
         (id, company_id, agent_id, cost_cents, occurred_at, provider, model)
       VALUES
         (gen_random_uuid(),
          'c1000000-0000-0000-0000-000000000001',
          'a9000000-0000-0000-0000-000000000001',
          900,
          NOW(),
          'anthropic',
          'claude-haiku-4-5')`,
    );

    const result = await resolveCheapFallbackModel(
      db,
      "c1000000-0000-0000-0000-000000000001",
      "a9000000-0000-0000-0000-000000000001",
      1000,
    );
    expect(result).toBeNull();

    // Restore
    await db.execute(
      `UPDATE internal_agent_config SET cheap_model = 'claude-haiku-4-5'
       WHERE company_id = 'c1000000-0000-0000-0000-000000000001'`,
    );
    await db.execute(
      `DELETE FROM cost_events WHERE agent_id = 'a9000000-0000-0000-0000-000000000001'`,
    );
  });
},
);
