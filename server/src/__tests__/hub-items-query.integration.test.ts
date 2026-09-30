/**
 * W1a Task 6 — `hubItems.query` RBAC-filtered, hot-set, per-user-state real-DB
 * integration. Embedded-postgres (mirrors w6-org-reporting.integration.test.ts).
 * Skipped on Windows (Issue #114); Linux CI is the authoritative gate.
 *
 * Asserts: founder sees all; team_member sees only owned; team_lead sees owned
 * OR department-scoped; resolved/archived excluded from the default open query;
 * per-principal read/snooze/dismiss joined in; dismissed excluded by default;
 * cross-department negative (a dept-A member does NOT see a dept-B-scoped item).
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
const PORT = 58400 + Math.floor(Math.random() * 1000);

function firstId(r: unknown): string {
  const id = Array.isArray(r) ? (r[0] as { id: string } | undefined)?.id : (r as { rows?: { id: string }[] }).rows?.[0]?.id;
  if (!id) throw new Error("firstId: no id returned from INSERT ... RETURNING id");
  return id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-query-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (o: object) => Pg };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[hub-query-integration] setup failed:", err);
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

/** Insert a department (projects row, type='department') and return its id. */
async function seedDepartment(companyId: string, name: string): Promise<string> {
  return firstId(await db.execute(sql`INSERT INTO projects (id, company_id, name, type) VALUES (gen_random_uuid(), ${companyId}, ${name}, 'department') RETURNING id`));
}

/**
 * Insert a "user" + active company membership + a user_roles row. When
 * departmentId is supplied, the role is department-scoped (projectId set) — used
 * for the team_lead department-scope and the cross-department RBAC negative test.
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

describe.skipIf(process.platform === "win32")("hubItems.query — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("RBAC-scoped: founder sees all, member sees only owned", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const memberId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "a1", title: "owned", ownerUserId: memberId });
    await svc.emit({ companyId, semanticType: "approval_request", sourceType: "approval", sourceId: "a2", title: "founder-only", ownerUserId: founderId });
    const { items: asFounder } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    const { items: asMember } = await svc.query(companyId, { actorUserId: memberId, role: "team_member" });
    expect(asFounder.map((i) => i.title).sort()).toEqual(["founder-only", "owned"]);
    expect(asMember.map((i) => i.title)).toEqual(["owned"]);
  });

  it("excludes resolved/archived from the default open query", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const open = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "r-open", title: "open-one", ownerUserId: founderId });
    const resolved = await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "r-done", title: "resolved-one", ownerUserId: founderId });
    await db.execute(sql`UPDATE notifications SET status = 'resolved' WHERE id = ${resolved.id}`);
    const { items: rows } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(rows.map((i) => i.id)).toEqual([open.id]);
  });

  it("joins per-principal read/snooze state and excludes dismissed by default", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const read = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "t-read", title: "read-item", ownerUserId: founderId });
    const dismissed = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "t-dismissed", title: "dismissed-item", ownerUserId: founderId });
    // Founder marked one read, one dismissed (sparse per-principal state rows).
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, read_at) VALUES (gen_random_uuid(), ${companyId}, ${read.id}, 'user', ${founderId}, now())`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${dismissed.id}, 'user', ${founderId}, now())`);

    const { items: def } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(def.map((i) => i.id)).toEqual([read.id]); // dismissed excluded
    expect(def.find((i) => i.id === read.id)?.readAt).toBeTruthy(); // per-user read joined

    const { items: withDismissed } = await svc.query(companyId, { actorUserId: founderId, role: "founder", includeDismissed: true });
    expect(withDismissed.map((i) => i.id).sort()).toEqual([read.id, dismissed.id].sort());
  });

  it("hides future-snoozed rows by default and returns past-snoozed rows", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const active = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "s-active", title: "active", ownerUserId: founderId });
    const future = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "s-future", title: "future", ownerUserId: founderId });
    const past = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "s-past", title: "past", ownerUserId: founderId });
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${future.id}, 'user', ${founderId}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${past.id}, 'user', ${founderId}, now() - interval '1 day')`);

    const { items: def } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(def.map((i) => i.id).sort()).toEqual([active.id, past.id].sort());

    const { items: withSnoozed } = await svc.query(companyId, { actorUserId: founderId, role: "founder", includeSnoozed: true });
    expect(withSnoozed.map((i) => i.id).sort()).toEqual([active.id, future.id, past.id].sort());
  });

  it("snooze and dismiss filters are isolated per user", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const bobId = await seedMember(companyId, "team_member");
    const svc = hubItemsService(db);
    const snoozedByFounder = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "iso-snoozed", title: "snoozed", ownerUserId: bobId });
    const dismissedByFounder = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "iso-dismissed", title: "dismissed", ownerUserId: bobId });
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, snoozed_until) VALUES (gen_random_uuid(), ${companyId}, ${snoozedByFounder.id}, 'user', ${founderId}, now() + interval '1 day')`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${dismissedByFounder.id}, 'user', ${founderId}, now())`);

    const { items: asFounder } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(asFounder.map((i) => i.id)).toEqual([]);

    const { items: asBob } = await svc.query(companyId, { actorUserId: bobId, role: "team_member" });
    expect(asBob.map((i) => i.id).sort()).toEqual([dismissedByFounder.id, snoozedByFounder.id].sort());
  });

  it("applies dismissed filtering before limit so visible work is not hidden", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const visible = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "t-visible", title: "visible-item", ownerUserId: founderId });
    const dismissed = await svc.emit({ companyId, semanticType: "mention", sourceType: "thread", sourceId: "t-new-dismissed", title: "newer-dismissed-item", ownerUserId: founderId });
    await db.execute(sql`UPDATE notifications SET created_at = now() - interval '1 minute' WHERE id = ${visible.id}`);
    await db.execute(sql`UPDATE notifications SET created_at = now() WHERE id = ${dismissed.id}`);
    await db.execute(sql`INSERT INTO hub_item_user_state (id, company_id, hub_item_id, principal_type, principal_id, dismissed_at) VALUES (gen_random_uuid(), ${companyId}, ${dismissed.id}, 'user', ${founderId}, now())`);

    const { items: rows } = await svc.query(companyId, { actorUserId: founderId, role: "founder", limit: 1 });

    expect(rows.map((i) => i.id)).toEqual([visible.id]);
  });

  it("team_lead sees department-scoped items; cross-department negative: dept-A member does NOT see a dept-B item", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const deptA = await seedDepartment(companyId, "Dept A");
    const deptB = await seedDepartment(companyId, "Dept B");
    const leadA = await seedMember(companyId, "team_lead", deptA);
    const svc = hubItemsService(db);
    // A dept-A-scoped item owned by the founder (not leadA) — leadA sees it via scope.
    await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "ra", title: "deptA-item", ownerUserId: founderId, scopeKey: deptA });
    // A dept-B-scoped item owned by the founder — leadA must NOT see it.
    await svc.emit({ companyId, semanticType: "run_failed", sourceType: "heartbeat_run", sourceId: "rb", title: "deptB-item", ownerUserId: founderId, scopeKey: deptB });

    const { items: asLeadA } = await svc.query(companyId, { actorUserId: leadA, role: "team_lead" });
    expect(asLeadA.map((i) => i.title)).toEqual(["deptA-item"]); // sees A, not B
  });

  it("returns W4 curation metadata and prefers curated group labels", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({
      companyId,
      semanticType: "run_failed",
      sourceType: "heartbeat_run",
      sourceId: "curated-run",
      title: "curated",
      ownerUserId: founderId,
      scopeKey: "engineering",
    });
    await db.execute(sql`
      UPDATE notifications
      SET
        curation_group_label = 'Failed runs',
        curation_group_summary = '3 failed runs need review.',
        curation_reason = 'SLA is due in 20 minutes.',
        curation_priority_reason = 'Urgent priority is set on this hub item.',
        curation_revision = 2,
        curated_at = now()
      WHERE id = ${item.id}
    `);

    const { items } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(items[0]).toMatchObject({
      id: item.id,
      groupLabel: "Failed runs",
      curationGroupSummary: "3 failed runs need review.",
      curationReason: "SLA is due in 20 minutes.",
      curationPriorityReason: "Urgent priority is set on this hub item.",
      curationRevision: 2,
    });
  });

  it("maps pruned stored semantic types to the legacy notifications lane in list rows", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const item = await svc.emit({
      companyId,
      semanticType: "run_failed",
      sourceType: "heartbeat_run",
      sourceId: "run-pruned-type",
      title: "pruned type row",
      ownerUserId: founderId,
    });
    await db.execute(sql`
      UPDATE notifications
      SET semantic_type = 'human_input_needed'
      WHERE id = ${item.id}
    `);

    const { items } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });

    expect(items[0].id).toBe(item.id);
    expect(items[0].lane).toBe("notifications");
    expect(items[0].lane).not.toBeUndefined();
  });
});
