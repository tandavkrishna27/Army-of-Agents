/**
 * H3 (Task 8) — `hubItems.reconcile({sourceType:"company_budget"})` real-DB integration.
 * Embedded-postgres (mirrors the hub sweeper harness). Skipped on Windows (Issue
 * #114); Linux CI is the authoritative gate.
 *
 * Asserts: closes a budget_alert whose company budget was cleared to 0; closes
 * one whose month-to-date utilization dropped below 80%; heals a stale "% used"
 * summary IN PLACE while utilization stays >= 80%; and — the storm-safety
 * invariant — an identical re-reconcile is a no-op that does NOT rewrite the row
 * (xmin stable), because the producer and the reconciler share one formatter.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { hubItemsService } from "../services/hub-items.js";
import { buildBudgetAlertHubEmit } from "../services/hub-source-producers.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 58700 + Math.floor(Math.random() * 1000);

function firstId(r: unknown): string {
  const id = Array.isArray(r) ? (r[0] as { id: string } | undefined)?.id : (r as { rows?: { id: string }[] }).rows?.[0]?.id;
  if (!id) throw new Error("firstId: no id returned from INSERT ... RETURNING id");
  return id;
}
function firstRow<T = Record<string, unknown>>(res: unknown): T {
  const rows = Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? [];
  return rows[0] as T;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-budget-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (o: object) => Pg };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[hub-budget-integration] setup failed:", err);
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

async function seedCompany(budgetMonthlyCents: number): Promise<{ companyId: string; agentId: string }> {
  const companyId = firstId(
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, budget_monthly_cents) VALUES (gen_random_uuid(), 'Budget Co', upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), ${budgetMonthlyCents}) RETURNING id`,
    ),
  );
  // The budget_alert item is board-pool owned → emit() resolves the board pool to
  // the company founder, so a founder must exist (production always has one).
  const founderId = firstId(
    await db.execute(
      sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at) VALUES (gen_random_uuid()::text, ${`f-${PORT}-${Math.random()}@budget.test`}, 'Founder', false, now(), now()) RETURNING id`,
    ),
  );
  await db.execute(
    sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at) VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())`,
  );
  await db.execute(
    sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')`,
  );
  const agentId = firstId(
    await db.execute(sql`INSERT INTO agents (id, company_id, name) VALUES (gen_random_uuid(), ${companyId}, 'Scout') RETURNING id`),
  );
  return { companyId, agentId };
}

/** Insert a cost_events row dated in the CURRENT month (mid-month, mid-day). */
async function seedSpend(companyId: string, agentId: string, costCents: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO cost_events (id, company_id, agent_id, provider, model, cost_cents, occurred_at)
        VALUES (gen_random_uuid(), ${companyId}, ${agentId}, 'test', 'test-model', ${costCents}, date_trunc('month', now()) + interval '5 days')`,
  );
}

/** Emit the budget_alert exactly as the producer does for a given spend/budget. */
async function emitBudgetAlert(companyId: string, spendCents: number, budgetCents: number) {
  const svc = hubItemsService(db);
  const monthUtilizationPercent = Number((((spendCents / budgetCents) * 100)).toFixed(2));
  return svc.emit(
    buildBudgetAlertHubEmit({
      companyId,
      monthSpendCents: spendCents,
      monthBudgetCents: budgetCents,
      monthUtilizationPercent,
      updatedAt: new Date(),
    }),
  );
}

async function statusOf(itemId: string): Promise<string> {
  const res = await db.execute(sql`SELECT status FROM notifications WHERE id = ${itemId}`);
  return firstRow<{ status: string }>(res).status;
}
async function summaryOf(itemId: string): Promise<string> {
  const res = await db.execute(sql`SELECT summary FROM notifications WHERE id = ${itemId}`);
  return firstRow<{ summary: string }>(res).summary;
}
async function xminOf(itemId: string): Promise<string> {
  const res = await db.execute(sql`SELECT xmin::text AS xmin FROM notifications WHERE id = ${itemId}`);
  return firstRow<{ xmin: string }>(res).xmin;
}

describe.skipIf(process.platform === "win32")("hubItems.reconcile company_budget — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("closes the budget_alert when the budget is cleared to 0", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, agentId } = await seedCompany(10000);
    await seedSpend(companyId, agentId, 9000); // 90% at emit time
    const it = await emitBudgetAlert(companyId, 9000, 10000);
    expect(await statusOf(it.id)).toBe("open");

    // Founder clears the monthly budget → utilization undefined → close.
    await db.execute(sql`UPDATE companies SET budget_monthly_cents = 0 WHERE id = ${companyId}`);
    const res = await hubItemsService(db).reconcile(companyId, { sourceType: "company_budget" });

    expect(res.closed).toBe(1);
    expect(await statusOf(it.id)).toBe("archived");
    // Version-guarded system close audit row.
    const audit = await db.execute(
      sql`SELECT actor_type, action FROM hub_audit WHERE company_id = ${companyId} AND hub_item_id = ${it.id}`,
    );
    const arow = firstRow<{ actor_type: string; action: string }>(audit);
    expect(arow.actor_type).toBe("system");
    expect(arow.action).toBe("reconcile_close");
  });

  it("closes when month-to-date utilization drops below 80% (symmetric threshold)", async () => {
    if (setupError) throw new Error(String(setupError));
    // Emit at 90%, then RAISE the budget so utilization falls to 45% → close.
    const { companyId, agentId } = await seedCompany(10000);
    await seedSpend(companyId, agentId, 9000);
    const it = await emitBudgetAlert(companyId, 9000, 10000);

    await db.execute(sql`UPDATE companies SET budget_monthly_cents = 20000 WHERE id = ${companyId}`);
    const res = await hubItemsService(db).reconcile(companyId, { sourceType: "company_budget" });

    expect(res.closed).toBe(1);
    expect(await statusOf(it.id)).toBe("archived");
  });

  it("heals a stale % summary in place while utilization stays >= 80%, then is a no-op (xmin stable)", async () => {
    if (setupError) throw new Error(String(setupError));
    // Emit a STALE summary (85%), but live spend is 9200 → 92% (still >= 80%).
    const { companyId, agentId } = await seedCompany(10000);
    await seedSpend(companyId, agentId, 9200);
    const it = await emitBudgetAlert(companyId, 8500, 10000); // stale 85.00% at emit
    expect(await summaryOf(it.id)).toBe("85.00% used (8500/10000 cents)");

    const res = await hubItemsService(db).reconcile(companyId, { sourceType: "company_budget" });
    expect(res.closed).toBe(0);
    expect(res.refreshed).toBe(1);
    expect(await statusOf(it.id)).toBe("open");
    expect(await summaryOf(it.id)).toBe("92.00% used (9200/10000 cents)"); // healed in place

    // STORM-SAFETY: an identical re-reconcile writes nothing. Because the producer
    // and the reconciler share formatBudgetAlertSummary, the recomputed summary is
    // byte-identical to what we just healed → change-gated → no UPDATE → xmin stable.
    const xminAfterHeal = await xminOf(it.id);
    const res2 = await hubItemsService(db).reconcile(companyId, { sourceType: "company_budget" });
    expect(res2.refreshed).toBe(0);
    expect(res2.closed).toBe(0);
    expect(await xminOf(it.id)).toBe(xminAfterHeal); // no row version churn
    expect(await summaryOf(it.id)).toBe("92.00% used (9200/10000 cents)");
  });
});
