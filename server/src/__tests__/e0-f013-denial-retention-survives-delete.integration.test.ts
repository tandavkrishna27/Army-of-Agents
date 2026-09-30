/**
 * E0-F013 Decision 3.3 (Q5) — a `security.denied.*` denial record SURVIVES the
 * deletion of the company it incriminates, and the deletion still succeeds.
 *
 * ★ WHAT THE FOUNDER RULED (2026-09-11, best-practice throughout). Denial history
 * must be tamper-resistant against the suspect: a founder deleting their own
 * company must NOT erase the operator plane's only copy of their own probing.
 * Before slice 3, `companyService.remove` ran
 * `tx.delete(activityLog).where(company_id = id)` — wiping every `security.denied.*`
 * row filed under the tenant — and the `company_id` FK was `ON DELETE cascade`, so
 * a raw company delete destroyed them too. Decision 3.3 moves the FK to
 * `ON DELETE set null` and makes `remove()` NULL the denial rows (they satisfy the
 * partial CHECK `company_id IS NOT NULL OR action LIKE 'security.denied.%'`) while
 * deleting the ordinary rows.
 *
 * ★ THE SUBTLETY THIS TEST PINS. Nulling is admissible ONLY inside the reserved
 * namespace; nulling an ordinary row would violate the CHECK and make the company
 * UNDELETABLE. So the test seeds a company with BOTH a denial row and an ordinary
 * activity row and asserts all four halves at once: (a) the denial row survives
 * with `company_id NULL` and is still returned by the operator reader
 * `activityService.securityDenials`; (b) the ordinary row is gone; (c) the delete
 * SUCCEEDS (no CHECK violation); (d) the company is gone.
 *
 * ★ RED-FIRST. Against the pre-slice-3 tree the blanket
 * `tx.delete(activityLog).where(company_id = id)` deletes the denial row too, so
 * arm (a) fails — the operator's only copy is gone. Observed RED before the fix.
 *
 * ★ THE ROW IS PLANTED THROUGH THE REAL RECORDER. `recordSecurityDenial` composes
 * the reserved `security.denied.` action and files it under the company; asserting
 * against a hand-inserted row would prove only that the delete reads back what a
 * test declared, not what is enforced on the real namespace.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";
import { activityService } from "../services/activity.js";
import { recordSecurityDenial } from "../services/security-denial-audit.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

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
let svc: ReturnType<typeof companyService>;
let setupError: unknown = null;
let setupFailed = false;

function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** The tenant that is deleted — the actor's own tenant, under which the denial is filed. */
let coA = "";
const DENIAL_ACTION = "security.denied.retention_survives_delete";
const NORMAL_ACTION = "goal.created";
let denialId = "";
let ordinaryId = "";

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-e0f013-q5-"));
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    svc = companyService(db);
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[e0f013-q5] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "E0-F013 Decision 3.3 (Q5) — a denial record survives its company's deletion",
  () => {
    it("setup: one company with a real same-tenant denial row AND an ordinary activity row", async () => {
      assertSetupOk();

      coA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (organization_id, id, name, issue_prefix)
          VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Q5 Retention Co', 'Q5C')
          RETURNING id`),
      );
      expect(coA).toBeTruthy();

      // The denial row, filed under the tenant, through the REAL recorder.
      denialId =
        (await recordSecurityDenial(db, {
          companyId: coA,
          crossing: "DE-19",
          surface: "retention_survives_delete",
          reason: "cross_tenant_probe",
          actorType: "user",
          actorId: "prober-human",
          entityType: "memory_item",
          entityId: "mem-probed",
          control: "server/src/__tests__/e0-f013-denial-retention-survives-delete.integration.test.ts",
          details: { requestedCompanyId: "some-other-tenant", keyId: "leaky-key" },
        })) ?? "";
      expect(denialId, "recordSecurityDenial returned null — the denial was never planted").toBeTruthy();

      // An ordinary company-scoped activity row — the one remove() must still delete.
      ordinaryId = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id)
          VALUES (gen_random_uuid(), ${coA}, 'user', 'teammate-user', ${NORMAL_ACTION}, 'goal', gen_random_uuid()::text)
          RETURNING id`),
      );
      expect(ordinaryId).toBeTruthy();

      // POSITIVE CONTROL — both rows really are in the table, filed under tenant A.
      const before = rowsOf<{ action: string; company_id: string | null }>(
        await db.execute(sql`
          SELECT action, company_id FROM activity_log WHERE company_id = ${coA}`),
      );
      const actions = before.map((r) => r.action);
      expect(actions, "the denial row is missing or not filed under tenant A").toContain(DENIAL_ACTION);
      expect(actions, "the ordinary row is missing or not filed under tenant A").toContain(NORMAL_ACTION);
    });

    it("deletes the company, and the denial record survives while the ordinary row does not", async () => {
      assertSetupOk();

      // (c) THE DELETE SUCCEEDS. Pre-slice-3 this also succeeded — but by WIPING the
      // denial row; the surviving-row assertions below are what make this meaningful.
      const removed = await svc.remove(coA);
      expect(removed, "companyService.remove threw or returned null — the CHECK may have rejected a nulled non-denial row").toBeDefined();
      expect(removed?.id).toBe(coA);

      // (d) THE COMPANY IS GONE.
      const companyCount = rowsOf<{ n: string }>(
        await db.execute(sql`SELECT count(*)::text AS n FROM companies WHERE id = ${coA}`),
      );
      expect(companyCount[0]?.n).toBe("0");

      // (b) THE ORDINARY ROW IS GONE.
      const ordinary = rowsOf<{ n: string }>(
        await db.execute(sql`SELECT count(*)::text AS n FROM activity_log WHERE id = ${ordinaryId}`),
      );
      expect(ordinary[0]?.n, "the ordinary activity row outlived the company delete").toBe("0");

      // (a) THE DENIAL ROW SURVIVES, with company_id NULL (the CHECK admits null
      // here), and its attribution is intact. This is the RED-first arm: the
      // pre-slice-3 blanket delete removed it.
      const survivor = rowsOf<{ id: string; company_id: string | null; action: string }>(
        await db.execute(sql`
          SELECT id, company_id, action FROM activity_log WHERE id = ${denialId}`),
      );
      expect(survivor.length, "the denial record was destroyed by the company delete — Q5 is open").toBe(1);
      expect(survivor[0]?.company_id, "the surviving denial row should have a NULL company_id").toBeNull();
      expect(survivor[0]?.action).toBe(DENIAL_ACTION);
    });

    it("the operator reader still returns the orphaned denial record (hidden nowhere — durably retained)", async () => {
      assertSetupOk();
      const rows = await activityService(db).securityDenials({});
      const probe = rows.find((r) => r.id === denialId);

      expect(
        probe,
        "activityService.securityDenials no longer returns the denial row after its company was deleted — the operator's only copy is lost",
      ).toBeTruthy();
      expect(probe?.action).toBe(DENIAL_ACTION);
      expect(probe?.companyId, "the row is now tenant-less (company deleted) but still readable by the operator").toBeNull();
      expect((probe?.details as Record<string, unknown> | null)?.reason, "WHY survives").toBe("cross_tenant_probe");
    });
  },
);
