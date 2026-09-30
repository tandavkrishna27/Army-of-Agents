/**
 * W1a Task 11 — `hubItems.counts` RBAC-scoped open/unread badge counters,
 * real-DB integration. Embedded-postgres (mirrors hub-items-query.integration).
 * Skipped on Windows (Issue #114); Linux CI is the authoritative gate.
 *
 * Asserts: open == unread == N after emitting N open items for a member; marking
 * one item read drops `unread` by 1 while `open` stays N; RBAC scoping (founder
 * counts all company items, member counts only owned); resolved/archived items
 * are excluded from BOTH open and unread.
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
const PORT = 59400 + Math.floor(Math.random() * 1000);

function firstId(r: unknown): string {
  const id = Array.isArray(r) ? (r[0] as { id: string } | undefined)?.id : (r as { rows?: { id: string }[] }).rows?.[0]?.id;
  if (!id) throw new Error("firstId: no id returned from INSERT ... RETURNING id");
  return id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-counts-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (o: object) => Pg };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[hub-counts-integration] setup failed:", err);
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

/**
 * Insert a "user" + active company membership + a user_roles row. Mirrors the
 * query integration harness so the RBAC scoping under test matches production.
 */
async function seedMember(
  companyId: string,
  role: "team_lead" | "team_member",
  departmentId?: string,
): Promise<string> {
  const userId = firstId(await db.execute(sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at) VALUES (gen_random_uuid()::text, ${`m-${PORT}-${Math.random()}@hub.test`}, 'Member', false, now(), now()) RETURNING id`));
  await db.execute(sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at) VALUES (gen_random_uuid(), ${companyId}, 'user', ${userId}, 'member', 'active', now(), now())`);
  if (departmentId) {
    await db.execute(sql`INSERT INTO user_roles (id, company_id, user_id, role, project_id) VALUES (gen_random_uuid(), ${companyId}, ${userId}, ${role}, ${departmentId})`);
  } else {
    await db.execute(sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${userId}, ${role})`);
  }
  return userId;
}

describe.skipIf(process.platform === "win32")("hubItems.counts — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("open == unread == N after emitting N open items for a member", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId } = await seedCompanyWithFounder();
    const memberId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    const N = 3;
    for (let i = 0; i < N; i += 1) {
      await svc.emit({
        companyId,
        semanticType: "mention",
        sourceType: "thread",
        sourceId: `m-${i}`,
        title: `owned-${i}`,
        ownerUserId: memberId,
      });
    }
    const c = await svc.counts(companyId, memberId, "team_member");
    expect(c).toEqual({ open: N, unread: N });
  });

  it("marking one item read drops unread by 1 while open stays N", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId } = await seedCompanyWithFounder();
    const memberId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    const N = 3;
    let firstHubItemId = "";
    for (let i = 0; i < N; i += 1) {
      const item = await svc.emit({
        companyId,
        semanticType: "mention",
        sourceType: "thread",
        sourceId: `r-${i}`,
        title: `owned-${i}`,
        ownerUserId: memberId,
      });
      if (i === 0) firstHubItemId = item.id;
    }
    // Upsert a sparse per-principal state row with readAt for ONE item.
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, read_at) VALUES (gen_random_uuid(), ${companyId}, ${firstHubItemId}, 'user', ${memberId}, now())`);
    const c = await svc.counts(companyId, memberId, "team_member");
    expect(c.open).toBe(N); // read does not remove the item from the open hot set
    expect(c.unread).toBe(N - 1); // exactly one read row drops unread
  });

  it("RBAC scoping: founder counts all company items; member counts only owned", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const memberId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    // One item owned by the member, one owned by the founder.
    await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "a1", title: "owned", ownerUserId: memberId });
    await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "a2", title: "founder-only", ownerUserId: founderId });

    const asFounder = await svc.counts(companyId, founderId, "founder");
    const asMember = await svc.counts(companyId, memberId, "team_member");
    expect(asFounder).toEqual({ open: 2, unread: 2 }); // founder sees the whole company
    expect(asMember).toEqual({ open: 1, unread: 1 }); // member sees only their owned item
  });

  it("resolved/archived items are excluded from both open and unread", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const open = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "c-open", title: "open-one", ownerUserId: founderId });
    const resolved = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "c-resolved", title: "resolved-one", ownerUserId: founderId });
    const archived = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "c-archived", title: "archived-one", ownerUserId: founderId });
    await db.execute(sql`UPDATE notifications SET status = 'resolved' WHERE id = ${resolved.id}`);
    await db.execute(sql`UPDATE notifications SET status = 'archived' WHERE id = ${archived.id}`);

    const c = await svc.counts(companyId, founderId, "founder");
    expect(c).toEqual({ open: 1, unread: 1 }); // only the still-open item counts
    // Sanity: the lone open item is the one we left open.
    const { items: rows } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(rows.map((i) => i.id)).toEqual([open.id]);
  });

  it("future-snoozed and dismissed items are excluded from both open and unread counts", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const active = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "count-active", title: "active", ownerUserId: founderId });
    const future = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "count-future", title: "future", ownerUserId: founderId });
    const past = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "count-past", title: "past", ownerUserId: founderId });
    const dismissed = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "count-dismissed", title: "dismissed", ownerUserId: founderId });
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, read_at) VALUES (gen_random_uuid(), ${companyId}, ${active.id}, 'user', ${founderId}, now())`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${future.id}, 'user', ${founderId}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${past.id}, 'user', ${founderId}, now() - interval '1 day')`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${dismissed.id}, 'user', ${founderId}, now())`);

    const c = await svc.counts(companyId, founderId, "founder");
    expect(c).toEqual({ open: 2, unread: 1 });
  });

  it("snooze and dismiss count filters are isolated per user", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const memberId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    const snoozedByFounder = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "count-iso-snoozed", title: "snoozed", ownerUserId: memberId });
    const dismissedByFounder = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "count-iso-dismissed", title: "dismissed", ownerUserId: memberId });
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${snoozedByFounder.id}, 'user', ${founderId}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${dismissedByFounder.id}, 'user', ${founderId}, now())`);

    const asFounder = await svc.counts(companyId, founderId, "founder");
    const asMember = await svc.counts(companyId, memberId, "team_member");
    expect(asFounder).toEqual({ open: 0, unread: 0 });
    expect(asMember).toEqual({ open: 2, unread: 2 });
  });

  // ── hiddenCount (Task 2 — the dismiss-hole safety net) ─────────────────────

  it("hiddenCount returns the actor's dismissed + actively-snoozed OPEN items for the lane", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    // approval_request + join_request live in the waiting lane; mention too.
    const dismissed = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-dismissed", title: "dismissed", ownerUserId: founderId });
    const snoozedFuture = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-snoozed-future", title: "future", ownerUserId: founderId });
    const snoozedPast = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-snoozed-past", title: "past", ownerUserId: founderId });
    // Still visible → NOT hidden.
    await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-visible", title: "visible", ownerUserId: founderId });
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${dismissed.id}, 'user', ${founderId}, now())`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${snoozedFuture.id}, 'user', ${founderId}, now() + interval '1 day')`);
    // A past-snooze row is no longer hidden (the item is visible again).
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${snoozedPast.id}, 'user', ${founderId}, now() - interval '1 day')`);

    const hidden = await svc.hiddenCount(companyId, founderId, "waiting_on_you", "founder");
    expect(hidden).toBe(2); // the dismissed + the future-snoozed; past-snooze is visible again
  });

  it("hiddenCount is per-actor: another user's dismiss does not surface for me", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const memberId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    const item = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-other-actor", title: "member-owned", ownerUserId: memberId });
    // The FOUNDER dismisses it; the member (owner) must not see a hidden row.
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${item.id}, 'user', ${founderId}, now())`);

    const founderHidden = await svc.hiddenCount(companyId, founderId, "waiting_on_you", "founder");
    const memberHidden = await svc.hiddenCount(companyId, memberId, "waiting_on_you", "team_member");
    expect(founderHidden).toBe(1); // the founder hid it → the founder sees it as hidden
    expect(memberHidden).toBe(0); // the owner never dismissed it → nothing hidden for them
  });

  it("hiddenCount is lane-scoped and excludes resolved/archived items", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    // A dismissed WAITING item, a dismissed NOTIFICATIONS item, and a dismissed
    // but ARCHIVED waiting item.
    const waiting = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-lane-waiting", title: "waiting", ownerUserId: founderId });
    const notif = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "hc-lane-notif", title: "notif", ownerUserId: founderId });
    const archived = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-lane-archived", title: "archived", ownerUserId: founderId });
    for (const id of [waiting.id, notif.id, archived.id]) {
      await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${id}, 'user', ${founderId}, now())`);
    }
    await db.execute(sql`UPDATE notifications SET status = 'archived' WHERE id = ${archived.id}`);

    const waitingHidden = await svc.hiddenCount(companyId, founderId, "waiting_on_you", "founder");
    const notifHidden = await svc.hiddenCount(companyId, founderId, "notifications", "founder");
    expect(waitingHidden).toBe(1); // only the still-open waiting item; archived excluded
    expect(notifHidden).toBe(1); // the notifications-lane dismissed item counts for its lane
  });

  it("hiddenCount respects RBAC scope: a member counts only owned hidden items", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const memberId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    const ownedByMember = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-rbac-member", title: "member", ownerUserId: memberId });
    const ownedByFounder = await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "hc-rbac-founder", title: "founder", ownerUserId: founderId });
    // The member dismisses BOTH — but RBAC hides the founder-owned one from them.
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${ownedByMember.id}, 'user', ${memberId}, now())`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${ownedByFounder.id}, 'user', ${memberId}, now())`);

    const memberHidden = await svc.hiddenCount(companyId, memberId, "waiting_on_you", "team_member");
    expect(memberHidden).toBe(1); // only the member-owned hidden item is in RBAC scope
  });
});
