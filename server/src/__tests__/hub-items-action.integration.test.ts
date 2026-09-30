/**
 * W1a Task 7 — `hubItems.recordLifecycleAction` optimistic-concurrency +
 * audit-before-side-effect real-DB integration. Embedded-postgres (mirrors w6).
 * Skipped on Windows (Issue #114); Linux CI is the authoritative gate.
 *
 * (Migrated 2026-07-04 from the deleted `recordAndAct` wrapper to
 * `recordLifecycleAction` — same semantics; the return shape is now
 * {item, auditId, undoDeadline} instead of the bare item.)
 *
 * Asserts: stale expectedVersion → 409 (no transition); an Owner lacking founder
 * authority acting on an approval_request → 403; a fresh version transitions
 * open→resolved, bumps version, writes exactly one audit row with
 * priorState.status='open'; the audit row is written BEFORE the side-effect
 * (call order); idempotency replay = no second audit row, no second side-effect.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { hubItemsService } from "../services/hub-items.js";
import { HttpError } from "../errors.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 58500 + Math.floor(Math.random() * 1000);

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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-action-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (o: object) => Pg };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[hub-action-integration] setup failed:", err);
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

async function auditCount(companyId: string, hubItemId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM hub_audit WHERE company_id = ${companyId} AND hub_item_id = ${hubItemId}`,
  );
  return firstRow<{ n: number }>(res).n;
}

async function seedApproval(companyId: string, requestedByUserId: string, status = "pending"): Promise<string> {
  return firstId(await db.execute(sql`
    INSERT INTO approvals (id, company_id, type, requested_by_user_id, status, payload, created_at, updated_at)
    VALUES (gen_random_uuid(), ${companyId}, 'hire', ${requestedByUserId}, ${status}, '{}'::jsonb, now(), now())
    RETURNING id
  `));
}

async function activityCount(companyId: string, hubItemId: string, action: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM activity_log WHERE company_id = ${companyId} AND entity_type = 'hub_item' AND entity_id = ${hubItemId} AND action = ${action}`,
  );
  return firstRow<{ n: number }>(res).n;
}

describe.skipIf(process.platform === "win32")("hubItems.recordLifecycleAction — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("a stale expectedVersion → 409 and does NOT transition", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "stale-1", title: "x", ownerUserId: founderId });
    let caught: unknown;
    try {
      await svc.recordLifecycleAction({
        companyId,
        hubItemId: item.id,
        action: "archive",
        expectedVersion: item.version + 5, // stale
        actorType: "user",
        actorId: founderId,
        actorIsFounder: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(409);
    const after = await db.execute(sql`SELECT status, version FROM notifications WHERE id = ${item.id}`);
    const row = firstRow<{ status: string; version: number }>(after);
    expect(row.status).toBe("open"); // untouched
    expect(row.version).toBe(item.version);
    expect(await auditCount(companyId, item.id)).toBe(0);
  });

  it("an Owner without founder authority acting on an approval_request → 403", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    // approval_request → authority = founder. Use a terminal source row so this
    // test isolates the authority guard instead of the pending-source mirror guard.
    const approvalId = await seedApproval(companyId, founderId, "approved");
    const item = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: approvalId, title: "Approve", ownerUserId: founderId });
    let caught: unknown;
    try {
      await svc.recordLifecycleAction({
        companyId,
        hubItemId: item.id,
        action: "resolve",
        expectedVersion: item.version,
        actorType: "user",
        actorId: founderId,
        actorIsFounder: false, // owner but NOT founder authority
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(403);
    expect(await auditCount(companyId, item.id)).toBe(0); // no transition, no audit
  });

  it("a fresh version transitions open→resolved, bumps version, writes one audit (priorState.status='open') BEFORE the side-effect", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "ok-1", title: "x", ownerUserId: founderId });

    const order: string[] = [];
    const result = await svc.recordLifecycleAction({
      companyId,
      hubItemId: item.id,
      action: "resolve",
      expectedVersion: item.version,
      actorType: "user",
      actorId: founderId,
      actorIsFounder: true,
      sideEffect: async () => {
        // At side-effect time the audit row must already be committed.
        order.push(`audit=${await auditCount(companyId, item.id)}`);
        order.push("side-effect");
        return {};
      },
    });

    expect(result.item.status).toBe("resolved");
    expect(result.item.version).toBe(item.version + 1);
    // Side-effect saw exactly one durable audit row already present.
    expect(order).toEqual(["audit=1", "side-effect"]);

    const audit = await db.execute(
      sql`SELECT prior_state, action, actor_type FROM hub_audit WHERE company_id = ${companyId} AND hub_item_id = ${item.id}`,
    );
    const arow = firstRow<{ prior_state: { status: string; version: number }; action: string; actor_type: string }>(audit);
    expect(arow.prior_state.status).toBe("open");
    expect(arow.prior_state.version).toBe(item.version);
    expect(arow.action).toBe("resolve");
    expect(arow.actor_type).toBe("user");
    expect(await auditCount(companyId, item.id)).toBe(1);
  });

  it("idempotency replay = no second audit row, no second side-effect", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "idem-1", title: "x", ownerUserId: founderId });
    const key = `idem-key-${Math.random()}`;
    let sideEffects = 0;
    const doAct = (expectedVersion: number) =>
      svc.recordLifecycleAction({
        companyId,
        hubItemId: item.id,
        action: "resolve",
        expectedVersion,
        actorType: "user",
        actorId: founderId,
        actorIsFounder: true,
        idempotencyKey: key,
        sideEffect: async () => {
          sideEffects += 1;
          return {};
        },
      });

    await doAct(item.version);
    // Replay with the SAME idempotency key (and the now-stale original version):
    // the idempotency short-circuit must fire BEFORE the version guard.
    await doAct(item.version);

    expect(sideEffects).toBe(1); // side-effect ran exactly once
    expect(await auditCount(companyId, item.id)).toBe(1); // one audit row only
  });

  it("claim and release mutate claim fields, not owner, and write audit/activity rows", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({
      companyId,
      semanticType: "stale_work",
      sourceType: "issue",
      sourceId: "claim-1",
      title: "claim me",
      ownerUserId: founderId,
      ownerPool: "board",
    });

    const claimed = await svc.recordLifecycleAction({
      companyId,
      hubItemId: item.id,
      action: "claim",
      expectedVersion: item.version,
      actorType: "user",
      actorId: founderId,
      actorIsFounder: true,
    });
    expect(claimed.item.status).toBe("open");
    expect(claimed.item.ownerUserId).toBe(founderId);
    expect(claimed.item.claimedByUserId).toBe(founderId);
    expect(claimed.auditId).toBeTruthy();
    expect(claimed.undoDeadline).toBeTruthy();

    const released = await svc.recordLifecycleAction({
      companyId,
      hubItemId: item.id,
      action: "release",
      expectedVersion: claimed.item.version,
      actorType: "user",
      actorId: founderId,
      actorIsFounder: true,
    });
    expect(released.item.claimedByUserId).toBeNull();
    expect(released.item.claimedAt).toBeNull();
    expect(await auditCount(companyId, item.id)).toBe(2);
    expect(await activityCount(companyId, item.id, "hub_item.claim")).toBe(1);
    expect(await activityCount(companyId, item.id, "hub_item.release")).toBe(1);
  });

  it("undo restores hub-owned fields before the deadline and writes a second audit row", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "undo-1", title: "undo me", ownerUserId: founderId });

    const resolved = await svc.recordLifecycleAction({
      companyId,
      hubItemId: item.id,
      action: "resolve",
      expectedVersion: item.version,
      actorType: "user",
      actorId: founderId,
      actorIsFounder: true,
    });
    expect(resolved.item.status).toBe("resolved");

    const undone = await svc.undoAction({
      companyId,
      hubItemId: item.id,
      auditId: resolved.auditId,
      expectedVersion: resolved.item.version,
      actorType: "user",
      actorId: founderId,
    });
    expect(undone.item.status).toBe("open");
    expect(undone.item.version).toBe(item.version);
    expect(undone.auditId).toBeTruthy();
    expect(await auditCount(companyId, item.id)).toBe(2);
    expect(await activityCount(companyId, item.id, "hub_item.undo")).toBe(1);
  });

  it("undo rejects expired audit deadlines", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "undo-expired", title: "expired", ownerUserId: founderId });
    const archived = await svc.recordLifecycleAction({
      companyId,
      hubItemId: item.id,
      action: "archive",
      expectedVersion: item.version,
      actorType: "user",
      actorId: founderId,
      actorIsFounder: true,
    });
    await db.execute(sql`UPDATE hub_audit SET undo_deadline = now() - interval '1 second' WHERE id = ${archived.auditId}`);

    let caught: unknown;
    try {
      await svc.undoAction({
        companyId,
        hubItemId: item.id,
        auditId: archived.auditId,
        expectedVersion: archived.item.version,
        actorType: "user",
        actorId: founderId,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(409);
  });

  it("bulkAction runs mixed shared and personal actions in request order", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const resolveItem = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "bulk-resolve", title: "resolve", ownerUserId: founderId });
    const dismissItem = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "bulk-dismiss", title: "dismiss", ownerUserId: founderId });
    const snoozeItem = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "bulk-snooze", title: "snooze", ownerUserId: founderId });

    const result = await svc.bulkAction({
      companyId,
      actorUserId: founderId,
      actorIsFounder: true,
      role: "founder",
      actorType: "user",
      bulkId: "bulk-mixed",
      items: [
        { id: resolveItem.id, action: "resolve", expectedVersion: resolveItem.version },
        { id: dismissItem.id, action: "dismiss" },
        { id: snoozeItem.id, action: "snooze", until: "2026-07-01T00:00:00.000Z" },
      ],
    });

    expect(result.bulkId).toBe("bulk-mixed");
    expect(result.summary).toEqual({ succeeded: 3, failed: 0, skipped: 0 });
    expect(result.results.map((r) => r.id)).toEqual([resolveItem.id, dismissItem.id, snoozeItem.id]);
    expect(result.results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(result.results[0]).toMatchObject({ auditId: expect.any(String) });
    expect(result.results[1]).toMatchObject({ state: expect.objectContaining({ dismissedAt: expect.any(Date) }) });
    expect(result.results[2]).toMatchObject({ state: expect.objectContaining({ snoozedUntil: new Date("2026-07-01T00:00:00.000Z") }) });
  });

  it("bulkAction preserves partial failures and keeps processing later items", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const staleItem = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "bulk-stale", title: "stale", ownerUserId: founderId });
    const dismissItem = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "bulk-after-stale", title: "after stale", ownerUserId: founderId });

    const result = await svc.bulkAction({
      companyId,
      actorUserId: founderId,
      actorIsFounder: true,
      role: "founder",
      actorType: "user",
      bulkId: "bulk-partial",
      items: [
        { id: staleItem.id, action: "archive", expectedVersion: staleItem.version + 10 },
        { id: dismissItem.id, action: "dismiss" },
      ],
    });

    expect(result.summary).toEqual({ succeeded: 1, failed: 1, skipped: 0 });
    expect(result.results[0]).toMatchObject({
      id: staleItem.id,
      status: "failed",
      error: { status: 409 },
    });
    expect(result.results[1]).toMatchObject({
      id: dismissItem.id,
      status: "success",
      state: expect.objectContaining({ dismissedAt: expect.any(Date) }),
    });
  });

  it("personal read/dismiss state mirrors legacy notification columns for the recipient", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({
      companyId,
      semanticType: "mention",
      legacyType: "thread.mention",
      sourceType: "discussion",
      sourceId: `state-sync-${Math.random()}`,
      title: "Mention",
      ownerUserId: founderId,
    });

    await svc.applyPersonalState({
      companyId,
      hubItemId: item.id,
      actorUserId: founderId,
      state: { kind: "read" },
    });
    let row = firstRow<{ read_at: Date | null; dismissed_at: Date | null }>(
      await db.execute(sql`
        SELECT read_at, dismissed_at FROM notifications WHERE id = ${item.id}
      `),
    );
    expect(row.read_at).toBeTruthy();
    expect(row.dismissed_at).toBeNull();

    await svc.applyPersonalState({
      companyId,
      hubItemId: item.id,
      actorUserId: founderId,
      state: { kind: "dismiss" },
    });
    row = firstRow<{ read_at: Date | null; dismissed_at: Date | null }>(
      await db.execute(sql`
        SELECT read_at, dismissed_at FROM notifications WHERE id = ${item.id}
      `),
    );
    expect(row.read_at).toBeTruthy();
    expect(row.dismissed_at).toBeTruthy();
  });

  it("personal read state can be applied to a visible resolved history item", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({
      companyId,
      semanticType: "join_request",
      sourceType: "history",
      sourceId: `resolved-state-${Math.random()}`,
      title: "Resolved history item",
      ownerUserId: founderId,
    });

    await svc.recordLifecycleAction({
      companyId,
      hubItemId: item.id,
      action: "resolve",
      expectedVersion: item.version,
      actorType: "user",
      actorId: founderId,
      actorIsFounder: true,
    });

    const row = await svc.applyPersonalState({
      companyId,
      hubItemId: item.id,
      actorUserId: founderId,
      state: { kind: "read" },
    });

    expect(row.readAt).toBeTruthy();
  });
});
