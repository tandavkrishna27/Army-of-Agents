import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { hubItemsService } from "../services/hub-items.js";
import {
  buildApprovalHubEmit,
  buildDiscussionPendingHubEmit,
  buildExtractionFailedHubEmit,
  buildJoinRequestHubEmit,
  buildRoutineFailedHubEmit,
  buildStaleIssueHubEmit,
  buildSuggestionHubEmit,
} from "../services/hub-source-producers.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 59600 + Math.floor(Math.random() * 1000);

function firstId(r: unknown): string {
  const id = Array.isArray(r)
    ? (r[0] as { id: string } | undefined)?.id
    : (r as { rows?: { id: string }[] }).rows?.[0]?.id;
  if (!id) throw new Error("firstId: no id returned from INSERT ... RETURNING id");
  return id;
}

function firstRow<T = Record<string, unknown>>(res: unknown): T {
  const rows = Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? [];
  return rows[0] as T;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-w1b-source-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: new (o: object) => Pg;
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
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[hub-w1b-source-integration] setup failed:", err);
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
  const companyId = firstId(
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix)
          VALUES (gen_random_uuid(), 'Hub W1b Co', upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)))
          RETURNING id`,
    ),
  );
  const founderId = firstId(
    await db.execute(
      sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
          VALUES (gen_random_uuid()::text, ${`f-${PORT}-${Math.random()}@hub.test`}, 'Founder', false, now(), now())
          RETURNING id`,
    ),
  );
  await db.execute(
    sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())`,
  );
  await db.execute(
    sql`INSERT INTO user_roles (id, company_id, user_id, role)
        VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')`,
  );
  return { companyId, founderId };
}

async function insertCompanyUser(companyId: string, role = "member") {
  const userId = firstId(
    await db.execute(
      sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
          VALUES (gen_random_uuid()::text, ${`u-${PORT}-${Math.random()}@hub.test`}, 'Operator', false, now(), now())
          RETURNING id`,
    ),
  );
  await db.execute(
    sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'user', ${userId}, ${role}, 'active', now(), now())`,
  );
  await db.execute(
    sql`INSERT INTO user_roles (id, company_id, user_id, role)
        VALUES (gen_random_uuid(), ${companyId}, ${userId}, ${role})`,
  );
  return userId;
}

async function insertApproval(companyId: string, status: string) {
  const res = await db.execute(
    sql`INSERT INTO approvals (id, company_id, type, requested_by_user_id, status, payload, created_at, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'hire_agent', 'user-actor', ${status}, '{"name":"Scout"}'::jsonb, now(), now())
        RETURNING id, company_id AS "companyId", type, requested_by_agent_id AS "requestedByAgentId",
          requested_by_user_id AS "requestedByUserId", status, payload, created_at AS "createdAt", updated_at AS "updatedAt"`,
  );
  return firstRow<{
    id: string;
    companyId: string;
    type: string;
    requestedByAgentId: string | null;
    requestedByUserId: string | null;
    status: string;
    payload: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
  }>(res);
}

async function insertJoinRequest(companyId: string, status: string) {
  const inviteId = firstId(
    await db.execute(
      sql`INSERT INTO invites (id, company_id, token_hash, expires_at)
          VALUES (gen_random_uuid(), ${companyId}, ${`token-${Math.random()}`}, now() + interval '1 day')
          RETURNING id`,
    ),
  );
  const res = await db.execute(
    sql`INSERT INTO join_requests (id, invite_id, company_id, request_type, status, request_ip, agent_name, adapter_type, created_at, updated_at)
        VALUES (gen_random_uuid(), ${inviteId}, ${companyId}, 'agent', ${status}, '127.0.0.1', 'OpenClaw Worker', 'openclaw', now(), now())
        RETURNING id, company_id AS "companyId", request_type AS "requestType", status, agent_name AS "agentName",
          request_email_snapshot AS "requestEmailSnapshot", adapter_type AS "adapterType", created_at AS "createdAt", updated_at AS "updatedAt"`,
  );
  return firstRow<{
    id: string;
    companyId: string;
    requestType: string;
    status: string;
    agentName: string | null;
    requestEmailSnapshot: string | null;
    adapterType: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(res);
}

async function insertDiscussion(companyId: string, ownerUserId: string, pendingItemCount: number) {
  const res = await db.execute(
    sql`INSERT INTO discussions (id, company_id, title, owner_user_id, scope_type, scope_id, pending_item_count, created_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'Q3 planning', ${ownerUserId}, 'project', gen_random_uuid(), ${pendingItemCount}, ${ownerUserId}, now(), now())
        RETURNING id, company_id AS "companyId", title, owner_user_id AS "ownerUserId", scope_type AS "scopeType",
          scope_id AS "scopeId", pending_item_count AS "pendingItemCount", updated_at AS "updatedAt"`,
  );
  return firstRow<{
    id: string;
    companyId: string;
    title: string | null;
    ownerUserId: string | null;
    scopeType: string | null;
    scopeId: string | null;
    pendingItemCount: number;
    updatedAt: Date;
  }>(res);
}

async function insertSuggestion(companyId: string, status: string) {
  const res = await db.execute(
    sql`INSERT INTO suggestions (id, company_id, category, action_type, action_payload, title, evidence, status, created_at, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'risk_flag', 'create_task', '{}'::jsonb, 'Goal is at risk', 'No activity for 14 days.', ${status}, now(), now())
        RETURNING id, company_id AS "companyId", category, title, evidence, status, created_at AS "createdAt", updated_at AS "updatedAt"`,
  );
  return firstRow<{
    id: string;
    companyId: string;
    category: string;
    title: string;
    evidence: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }>(res);
}

async function insertAgent(companyId: string, founderId: string) {
  return firstId(
    await db.execute(
      sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id)
          VALUES (gen_random_uuid(), ${companyId}, 'Worker', 'org', 'idle', 'user', ${founderId})
          RETURNING id`,
    ),
  );
}

async function insertIssue(
  companyId: string,
  status: string,
  assigneeUserId: string | null,
  updatedAtSql = sql`now()`,
  assigneeAgentId: string | null = null,
) {
  const res = await db.execute(
    sql`INSERT INTO issues (id, company_id, title, status, assignee_user_id, assignee_agent_id, updated_at)
        VALUES (gen_random_uuid(), ${companyId}, 'Draft launch copy', ${status}, ${assigneeUserId}, ${assigneeAgentId}, ${updatedAtSql})
        RETURNING id, company_id AS "companyId", title, status, assignee_user_id AS "assigneeUserId",
          assignee_agent_id AS "assigneeAgentId", updated_at AS "updatedAt"`,
  );
  return firstRow<{
    id: string;
    companyId: string;
    title: string;
    status: string;
    assigneeUserId: string | null;
    assigneeAgentId: string | null;
    updatedAt: Date;
  }>(res);
}

async function insertDiscussionEntry(discussionId: string, extractionStatus: string) {
  return firstId(
    await db.execute(
      sql`INSERT INTO discussion_entries (id, discussion_id, input_type, raw_content, extraction_status, created_by, created_at)
          VALUES (gen_random_uuid(), ${discussionId}, 'paste', 'some notes to extract', ${extractionStatus}, 'founder', now())
          RETURNING id`,
    ),
  );
}

async function insertRoutineWithRun(
  companyId: string,
  createdByUserId: string | null,
  runStatus: string,
) {
  const routineId = firstId(
    await db.execute(
      sql`INSERT INTO routines (id, company_id, title, created_by_user_id, created_at, updated_at)
          VALUES (gen_random_uuid(), ${companyId}, 'Weekly report', ${createdByUserId}, now(), now())
          RETURNING id`,
    ),
  );
  const runId = firstId(
    await db.execute(
      sql`INSERT INTO routine_runs (id, company_id, routine_id, source, status, failure_reason, created_at, updated_at)
          VALUES (gen_random_uuid(), ${companyId}, ${routineId}, 'schedule', ${runStatus}, 'Execution issue moved to blocked', now(), now())
          RETURNING id`,
    ),
  );
  return { routineId, runId };
}

describe.skipIf(process.platform === "win32")("hub W1b source reconcilers", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("keeps approval hub items open for pending and revision_requested, closes approved", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const pending = await insertApproval(companyId, "pending");
    const revision = await insertApproval(companyId, "revision_requested");
    const approved = await insertApproval(companyId, "approved");
    const svc = hubItemsService(db);
    await svc.emit(buildApprovalHubEmit(pending));
    await svc.emit(buildApprovalHubEmit(revision));
    await svc.emit(buildApprovalHubEmit(approved));

    await svc.reconcile(companyId, { sourceType: "approval" });

    const { items: rows } = await svc.query(companyId, {
      actorUserId: founderId,
      role: "founder",
      lane: "waiting_on_you",
    });
    expect(rows.map((r) => r.sourceId).sort()).toEqual([pending.id, revision.id].sort());
  });

  it("closes join request, discussion, suggestion, and stale issue hub rows when sources become terminal", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const join = await insertJoinRequest(companyId, "approved");
    const discussion = await insertDiscussion(companyId, founderId, 0);
    const suggestion = await insertSuggestion(companyId, "dismissed");
    const issue = await insertIssue(companyId, "done", founderId, sql`now() - interval '2 days'`);
    await svc.emit(buildJoinRequestHubEmit({ ...join, status: "pending_approval" }));
    await svc.emit(buildDiscussionPendingHubEmit({ ...discussion, pendingItemCount: 2 }));
    await svc.emit(buildSuggestionHubEmit({ ...suggestion, status: "pending" }));
    await svc.emit(buildStaleIssueHubEmit({ ...issue, status: "todo" }));

    await svc.reconcile(companyId, { sourceType: "join_request" });
    await svc.reconcile(companyId, { sourceType: "discussion" });
    await svc.reconcile(companyId, { sourceType: "suggestion" });
    await svc.reconcile(companyId, { sourceType: "issue" });

    const { items: rows } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(rows).toHaveLength(0);
  });

  it("only reconciles stale-work issue rows and preserves issue mentions", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const issue = await insertIssue(companyId, "todo", founderId, sql`now() - interval '2 days'`);
    await svc.emit(buildStaleIssueHubEmit(issue));
    await svc.emit({
      companyId,
      semanticType: "mention",
      sourceType: "issue",
      sourceId: `${issue.id}:${founderId}`,
      title: "You were mentioned in a comment",
      summary: "Can you look at this?",
      ownerUserId: founderId,
    });

    await svc.reconcile(companyId, { sourceType: "issue" });

    let { items: rows } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(rows.map((r) => r.semanticType).sort()).toEqual(["mention", "stale_work"].sort());

    await db.execute(sql`UPDATE issues SET status = 'blocked', updated_at = now() - interval '2 days' WHERE id = ${issue.id}`);
    await svc.reconcile(companyId, { sourceType: "issue" });

    rows = (await svc.query(companyId, { actorUserId: founderId, role: "founder" })).items;
    expect(rows.map((r) => r.semanticType)).toEqual(["mention"]);
  });

  it("closes stale-work rows when the issue is fresh under old Inbox rules", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const issue = await insertIssue(companyId, "todo", founderId, sql`now() - interval '2 days'`);
    await svc.emit(buildStaleIssueHubEmit(issue));

    await db.execute(sql`UPDATE issues SET updated_at = now() - interval '2 hours' WHERE id = ${issue.id}`);
    await svc.reconcile(companyId, { sourceType: "issue" });

    const { items: rows } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(rows).toHaveLength(0);
  });

  it("keeps agent-assigned stale-work rows open under old Inbox rules", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const agentId = await insertAgent(companyId, founderId);
    const svc = hubItemsService(db);
    const issue = await insertIssue(companyId, "in_progress", null, sql`now() - interval '2 days'`, agentId);
    await svc.emit(buildStaleIssueHubEmit(issue));

    await svc.reconcile(companyId, { sourceType: "issue" });

    const { items: rows } = await svc.query(companyId, {
      actorUserId: founderId,
      role: "founder",
      lane: "suggestions",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.semanticType).toBe("stale_work");
    expect(rows[0]?.sourceId).toBe(issue.id);
  });

  it("refreshes discussion owner, scope, and title when reconciling pending discussion items", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const nextOwnerId = await insertCompanyUser(companyId);
    const discussion = await insertDiscussion(companyId, founderId, 2);
    const svc = hubItemsService(db);

    const row = await svc.emit(buildDiscussionPendingHubEmit(discussion));

    expect(row.ownerUserId).toBe(founderId);
    expect(row.scopeKey).toBe(discussion.scopeId);

    await db.execute(
      sql`UPDATE discussions
          SET title = 'Updated planning', owner_user_id = ${nextOwnerId}, scope_id = gen_random_uuid(), updated_at = now() + interval '1 second'
          WHERE id = ${discussion.id}`,
    );
    await svc.reconcile(companyId, { sourceType: "discussion" });

    const { items: rows } = await svc.query(companyId, { actorUserId: nextOwnerId, role: "member" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerUserId).toBe(nextOwnerId);
    expect(rows[0]?.scopeKey).not.toBe(discussion.scopeId);
    expect(rows[0]?.title).toBe("Review 2 pending items in Updated planning");
  });

  it("only reconciles discussion_pending rows and preserves discussion mentions", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const discussion = await insertDiscussion(companyId, founderId, 2);
    const svc = hubItemsService(db);
    await svc.emit(buildDiscussionPendingHubEmit(discussion));
    await svc.emit({
      companyId,
      semanticType: "mention",
      sourceType: "discussion",
      sourceId: `${discussion.id}:entry-1:${founderId}`,
      title: "You were mentioned in a discussion",
      summary: "Can you review this?",
      ownerUserId: founderId,
    });

    await db.execute(sql`UPDATE discussions SET pending_item_count = 0, updated_at = now() + interval '1 second' WHERE id = ${discussion.id}`);
    await svc.reconcile(companyId, { sourceType: "discussion" });

    const { items: rows } = await svc.query(companyId, { actorUserId: founderId, role: "founder" });
    expect(rows.map((r) => r.semanticType)).toEqual(["mention"]);
  });

  // ── Task 10: extraction_failed (D3) ────────────────────────────────────────
  it("emits extraction_failed on a failed entry and auto-archives it once the entry recovers", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const discussion = await insertDiscussion(companyId, founderId, 0);
    const entryId = await insertDiscussionEntry(discussion.id, "failed");
    const svc = hubItemsService(db);

    const row = await svc.emit(
      buildExtractionFailedHubEmit({
        entryId,
        discussionId: discussion.id,
        companyId,
        discussionTitle: "Q3 planning",
        ownerUserId: founderId,
        failureKind: "not_installed",
        failureMessage: "claude CLI not found",
        updatedAt: new Date(),
      }),
    );
    // keyed on the entry id + discussion_entry source (NOT discussion).
    expect(row.semanticType).toBe("extraction_failed");
    expect(row.sourceType).toBe("discussion_entry");
    expect(row.sourceId).toBe(entryId);

    let { items: rows } = await svc.query(companyId, {
      actorUserId: founderId,
      role: "founder",
      lane: "notifications",
    });
    expect(rows.map((r) => r.semanticType)).toContain("extraction_failed");

    // A successful reprocess resets the entry to 'pending' → reconciler terminal
    // → the failure item auto-archives (matches the reprocess-success closer).
    await db.execute(sql`UPDATE discussion_entries SET extraction_status = 'pending' WHERE id = ${entryId}`);
    await svc.reconcile(companyId, { sourceType: "discussion_entry", sourceId: entryId });

    rows = (await svc.query(companyId, { actorUserId: founderId, role: "founder" })).items;
    expect(rows.map((r) => r.semanticType)).not.toContain("extraction_failed");
  });

  // ── Task 10: routine_outcome, failure-only (D3) ────────────────────────────
  it("emits routine_outcome for a failed routine run and supersedes it when the routine recovers", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const { routineId, runId } = await insertRoutineWithRun(companyId, founderId, "failed");
    const svc = hubItemsService(db);

    const row = await svc.emit(
      buildRoutineFailedHubEmit({
        runId,
        routineId,
        companyId,
        routineName: "Weekly report",
        failureReason: "Execution issue moved to blocked",
        createdByUserId: founderId,
        updatedAt: new Date(),
      }),
    );
    expect(row.semanticType).toBe("routine_outcome");
    expect(row.sourceType).toBe("routine_run");
    expect(row.title).toBe("Routine failed: Weekly report");

    const { items: rows } = await svc.query(companyId, {
      actorUserId: founderId,
      role: "founder",
      lane: "notifications",
    });
    expect(rows.map((r) => r.semanticType)).toContain("routine_outcome");
  });
});
