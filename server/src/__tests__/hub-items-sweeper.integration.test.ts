/**
 * W1a Task 8 — `hubItems.reconcile` sweeper real-DB integration.
 * Embedded-postgres (mirrors w6). Skipped on Windows (Issue #114); Linux CI is
 * the authoritative gate.
 *
 * Asserts: closes a hub item whose source approval is terminal (approved); closes
 * one whose source approval was deleted; LEAVES one whose source approval is still
 * pending; heals permission-drift (refreshes redacted summary + sourcePermission-
 * Revision) on a live-source item; the close transition goes through the version-
 * guarded path (writes a system audit row).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { hubItemsService } from "../services/hub-items.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 58600 + Math.floor(Math.random() * 1000);

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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-sweeper-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (o: object) => Pg };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[hub-sweeper-integration] setup failed:", err);
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

async function seedCompanyWithFounder(): Promise<{ companyId: string; founderId: string }> {
  const companyId = firstId(await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Hub Co', upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))) RETURNING id`));
  const founderId = firstId(await db.execute(sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at) VALUES (gen_random_uuid()::text, ${`f-${PORT}-${Math.random()}@hub.test`}, 'Founder', false, now(), now()) RETURNING id`));
  await db.execute(sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at) VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())`);
  await db.execute(sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')`);
  return { companyId, founderId };
}

/** Insert an approvals row and return its id. status defaults to 'pending'. */
async function seedApproval(companyId: string, status: string, decisionNote?: string): Promise<string> {
  return firstId(
    await db.execute(
      sql`INSERT INTO approvals (id, company_id, type, status, payload, decision_note) VALUES (gen_random_uuid(), ${companyId}, 'hire', ${status}, '{}'::jsonb, ${decisionNote ?? null}) RETURNING id`,
    ),
  );
}

async function statusOf(itemId: string): Promise<string> {
  const res = await db.execute(sql`SELECT status FROM notifications WHERE id = ${itemId}`);
  return firstRow<{ status: string }>(res).status;
}

describe.skipIf(process.platform === "win32")("hubItems.reconcile — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("closes terminal/deleted-source items, leaves pending ones, heals permission drift", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);

    // (1) Terminal source (approved) but hub item left open = missed-emit case.
    const apprTerminal = await seedApproval(companyId, "approved");
    const itTerminal = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: apprTerminal, title: "terminal", ownerUserId: founderId });

    // (2) Source approval was deleted entirely.
    const apprDeleted = await seedApproval(companyId, "pending");
    const itDeleted = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: apprDeleted, title: "deleted-src", ownerUserId: founderId });
    await db.execute(sql`DELETE FROM approvals WHERE id = ${apprDeleted}`);

    // (3) Source still pending → hub item must be LEFT open. Pre-stamp its
    // revision to the source's current updatedAt so it does NOT count as drift
    // (isolating the deliberate drift case (4) below).
    const apprPending = await seedApproval(companyId, "pending");
    const apprPendingRev = firstRow<{ rev: string }>(
      await db.execute(sql`SELECT updated_at::text AS rev FROM approvals WHERE id = ${apprPending}`),
    ).rev;
    const itPending = await svc.emit({
      companyId,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: apprPending,
      title: "pending",
      ownerUserId: founderId,
      sourcePermissionRevision: new Date(apprPendingRev).toISOString(),
    });

    // (4) Permission/summary drift: live (pending) source whose decisionNote and
    // updatedAt revision are strictly NEWER than what the hub item stored at emit.
    // The stored revision is an OLD ISO baseline so the source's real updatedAt
    // (a 2026 ISO) compares strictly newer — exercising the revision-newer heal.
    const apprDrift = await seedApproval(companyId, "pending", "sk-LIVE9876543210SECRET now noted");
    const itDrift = await svc.emit({
      companyId,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: apprDrift,
      title: "drift",
      ownerUserId: founderId,
      summary: "stale summary",
      sourcePermissionRevision: "2000-01-01T00:00:00.000Z",
    });

    const res = await svc.reconcile(companyId, { sourceType: "approval" });

    // (1) + (2) closed (archived); (3) left open; (4) refreshed (not closed).
    expect(await statusOf(itTerminal.id)).toBe("archived");
    expect(await statusOf(itDeleted.id)).toBe("archived");
    expect(await statusOf(itPending.id)).toBe("open");
    expect(await statusOf(itDrift.id)).toBe("open");

    expect(res.closed).toBe(2);
    expect(res.refreshed).toBe(1);
    expect(res.healed).toBe(3);

    // Drift heal: summary refreshed from the source AND redacted-before-persist;
    // revision advanced off the stale baseline to the source's newer revision.
    const drifted = await db.execute(sql`SELECT summary, source_permission_revision FROM notifications WHERE id = ${itDrift.id}`);
    const drow = firstRow<{ summary: string; source_permission_revision: string }>(drifted);
    expect(drow.summary).not.toContain("sk-LIVE9876543210SECRET"); // redacted
    expect(drow.summary).not.toBe("stale summary"); // refreshed from source
    expect(drow.source_permission_revision).not.toBe("2000-01-01T00:00:00.000Z");

    // Closes went through the version-guarded path → a system audit row exists.
    const audit = await db.execute(
      sql`SELECT actor_type, action, prior_state FROM hub_audit WHERE company_id = ${companyId} AND hub_item_id = ${itTerminal.id}`,
    );
    const arow = firstRow<{ actor_type: string; action: string; prior_state: { status: string } }>(audit);
    expect(arow.actor_type).toBe("system");
    expect(arow.action).toBe("reconcile_close");
    expect(arow.prior_state.status).toBe("open");

    // Steady-state idempotency (P1-2): a SECOND sweep must heal nothing (no churn)
    // and must NOT null-out the summary it just set on the drift item.
    const healedSummary = drow.summary;
    const res2 = await svc.reconcile(companyId, { sourceType: "approval" });
    expect(res2.refreshed).toBe(0);
    expect(res2.closed).toBe(0);
    const after2 = await db.execute(sql`SELECT summary, source_permission_revision FROM notifications WHERE id = ${itDrift.id}`);
    const arow2 = firstRow<{ summary: string; source_permission_revision: string }>(after2);
    expect(arow2.summary).toBe(healedSummary); // unchanged, not nulled
  });

  it("does NOT churn an item emitted with a domain summary and no source revision", async () => {
    if (setupError) throw new Error(String(setupError));
    // Production shape: an emit site passes a meaningful `summary` and does NOT
    // pre-compute the source's updatedAt-ISO (sourcePermissionRevision stays
    // null). The sweeper must leave this item completely untouched — neither
    // force-refreshing the null revision nor clobbering the domain summary.
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const appr = await seedApproval(companyId, "pending"); // no decisionNote → source summary null
    const it = await svc.emit({
      companyId,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: appr,
      title: "domain",
      ownerUserId: founderId,
      summary: "Approve the Q3 hire for the platform team", // meaningful domain summary
      // sourcePermissionRevision intentionally omitted → null baseline
    });

    const res = await svc.reconcile(companyId, { sourceType: "approval" });
    expect(res.refreshed).toBe(0); // null baseline + null source summary → no heal
    expect(await statusOf(it.id)).toBe("open");
    const row = firstRow<{ summary: string }>(
      await db.execute(sql`SELECT summary FROM notifications WHERE id = ${it.id}`),
    );
    expect(row.summary).toBe("Approve the Q3 hire for the platform team"); // not clobbered
  });

  it("reconciles heartbeat_run: keeps latest failed/run-live alerts and closes superseded runs", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const agentWithSupersededFailure = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Superseded', 'org', 'idle', 'user', ${founderId}) RETURNING id`));
    const agentWithLatestFailure = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Failed', 'org', 'idle', 'user', ${founderId}) RETURNING id`));
    const agentWithLiveRun = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Running', 'org', 'idle', 'user', ${founderId}) RETURNING id`));

    const oldFailedRun = firstId(await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at) VALUES (gen_random_uuid(), ${companyId}, ${agentWithSupersededFailure}, 'failed', now() - interval '2 hours') RETURNING id`));
    await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at) VALUES (gen_random_uuid(), ${companyId}, ${agentWithSupersededFailure}, 'succeeded', now() - interval '1 hour')`);
    const latestFailedRun = firstId(await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at) VALUES (gen_random_uuid(), ${companyId}, ${agentWithLatestFailure}, 'failed', now()) RETURNING id`));
    const liveRun = firstId(await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at) VALUES (gen_random_uuid(), ${companyId}, ${agentWithLiveRun}, 'running', now()) RETURNING id`));

    const itOldFailed = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: oldFailedRun, title: "old failed", ownerUserId: founderId });
    const itLatestFailed = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: latestFailedRun, title: "latest failed", ownerUserId: founderId });
    const itLive = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: liveRun, title: "live", ownerUserId: founderId });

    const res = await svc.reconcile(companyId, { sourceType: "heartbeat_run" });
    expect(await statusOf(itOldFailed.id)).toBe("archived");
    expect(await statusOf(itLatestFailed.id)).toBe("open");
    expect(await statusOf(itLive.id)).toBe("open");
    expect(res.closed).toBe(1);
  });

  it("archives succeeded run_complete history instead of keeping it in attention", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const agentId = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Completer', 'org', 'idle', 'user', ${founderId}) RETURNING id`));
    const succeededRun = firstId(await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at) VALUES (gen_random_uuid(), ${companyId}, ${agentId}, 'succeeded', now() - interval '1 hour') RETURNING id`));

    const item = await svc.emit({
      companyId,
      semanticType: "run_complete",
      sourceType: "heartbeat_run",
      sourceId: succeededRun,
      title: "Completer run complete",
      summary: "Run finished successfully",
      ownerUserId: founderId,
    });

    // A successful process exit is history, not an open attention item. The
    // task/result surface owns completion; Inbox should stay focused on work
    // that still needs a human or an exception to resolve.
    const res1 = await svc.reconcile(companyId, { sourceType: "heartbeat_run" });
    expect(res1.closed).toBe(1);
    expect(await statusOf(item.id)).toBe("archived");

    // A newer run cannot close the item a second time.
    await db.execute(sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, created_at) VALUES (gen_random_uuid(), ${companyId}, ${agentId}, 'running', now())`);
    const res2 = await svc.reconcile(companyId, { sourceType: "heartbeat_run" });
    expect(res2.closed).toBe(0);
    expect(await statusOf(item.id)).toBe("archived");

    const audit = await db.execute(
      sql`SELECT actor_type, action, prior_state FROM hub_audit WHERE company_id = ${companyId} AND hub_item_id = ${item.id}`,
    );
    const arow = firstRow<{ actor_type: string; action: string; prior_state: { status: string } }>(audit);
    expect(arow.actor_type).toBe("system");
    expect(arow.action).toBe("reconcile_close");
    expect(arow.prior_state.status).toBe("open");
  });
});
