import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";
import { quotaWindowsService } from "../services/quota-windows.js";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/registry.js";
import type { ServerAdapterModule } from "../adapters/types.js";

/**
 * A-H12 — provider_quota_windows unique index must be NULLS NOT DISTINCT.
 *
 * The primary writer (quota-windows.ts refreshWithAdapter) ALWAYS upserts with
 * `model = null` and an `onConflictDoUpdate` targeting
 * (company_id, provider, model, window_kind). Postgres treats NULL as DISTINCT
 * in a standard unique index, so the ON CONFLICT clause never matches an
 * existing NULL-model row → every refresh INSERTs a duplicate instead of
 * updating. NULLS NOT DISTINCT on the unique index makes the NULL-model rows
 * collide so the upsert finally UPDATEs.
 *
 * These behaviors require a real Postgres (NULL-distinct semantics + the
 * generated migration's pre-index dedup), so this suite uses embedded-postgres
 * and is skipped on Windows (embedded-postgres can't start on the CI runner).
 */

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

const PORT = 56500 + Math.floor(Math.random() * 1000);

// Fake adapter whose getQuotaWindows() returns a fixed window set. Mirrors the
// AdapterQuotaResult shape consumed by refreshWithAdapter — the service maps
// each window to a snapshot row with model = null.
const FAKE_ADAPTER_TYPE = "fake_quota_adapter";

function makeFakeAdapter(usedPercent: number): ServerAdapterModule {
  return {
    type: FAKE_ADAPTER_TYPE,
    // Minimal execute stub — never invoked by the quota refresh path.
    execute: (async () => ({})) as unknown as ServerAdapterModule["execute"],
    getQuotaWindows: async () => ({
      provider: "fake_provider",
      ok: true,
      windows: [
        {
          label: "5h",
          usedPercent,
          resetsAt: null,
          valueLabel: null,
        },
      ],
    }),
  } as unknown as ServerAdapterModule;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-quota-dedup-test-"));
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

    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try {
    unregisterServerAdapter(FAKE_ADAPTER_TYPE);
  } catch {
    // ignore — adapter may not have been registered
  }
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore cleanup failures
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "provider_quota_windows model-less upsert dedup — real DB",
  () => {
    it("unique index is NULLS NOT DISTINCT", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      const rows = (await db.execute(sql`
        SELECT i.indnullsnotdistinct AS nulls_not_distinct
        FROM pg_class c
        JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'provider_quota_windows_company_window_unique_idx'
      `)) as unknown as { rows: Array<{ nulls_not_distinct: boolean }> };
      const result = rows.rows ?? (rows as unknown as Array<{ nulls_not_distinct: boolean }>);
      expect(result.length).toBe(1);
      expect(result[0]!.nulls_not_distinct).toBe(true);
    });

    it("two refreshes against the seeded DB leave exactly one row per window", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      const companyId = "77777777-7777-4777-8777-777777777777";
      await db.execute(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Quota Dedup Co', 'QDC')
      `);

      registerServerAdapter(makeFakeAdapter(10));
      const service = quotaWindowsService(db);

      // First refresh → inserts one model=null row for the "5h" window.
      const first = await service.refresh(companyId, FAKE_ADAPTER_TYPE);
      expect(first.length).toBe(1);

      // Re-register with a different usedPercent so the second refresh is a
      // genuine value change — proves the upsert UPDATEs in place.
      registerServerAdapter(makeFakeAdapter(42));
      const second = await service.refresh(companyId, FAKE_ADAPTER_TYPE);
      expect(second.length).toBe(1);

      const all = await service.list(companyId);
      // Before the fix (NULL-distinct index) this would be 2 — the second
      // refresh inserts a duplicate model=null row instead of updating.
      expect(all.length).toBe(1);
      expect(all[0]!.model).toBeNull();
      expect(all[0]!.windowKind).toBe("5h");
      expect(all[0]!.usedPercent).toBe(42);
    });

    it("a manual second NULL-model insert with the same key is rejected", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      const companyId = "88888888-8888-4888-8888-888888888888";
      await db.execute(sql`
        INSERT INTO companies (id, name, issue_prefix)
        VALUES (${companyId}, 'Quota Dedup Co 2', 'QD2')
      `);
      await db.execute(sql`
        INSERT INTO provider_quota_windows (company_id, provider, model, window_kind)
        VALUES (${companyId}, 'anthropic', NULL, '5h')
      `);

      await expect(
        db.execute(sql`
          INSERT INTO provider_quota_windows (company_id, provider, model, window_kind)
          VALUES (${companyId}, 'anthropic', NULL, '5h')
        `),
      ).rejects.toSatisfy((error: unknown) => {
        const code =
          (error as { code?: string })?.code ??
          (error as { cause?: { code?: string } })?.cause?.code;
        return code === "23505";
      });
    });
  },
);
