/**
 * W1a Task 5 — `hubItems.emit` real-DB integration.
 *
 * Embedded-postgres harness (mirrors w6-org-reporting.integration.test.ts).
 * Skipped on Windows (embedded-postgres / migration-chain — Issue #114); Linux
 * CI is the authoritative gate.
 *
 * Asserts: idempotent upsert on source_unique_key (same source → one open row),
 * redact-before-persist of the denormalized summary, and agent-sourced emit
 * resolving the owner to the first human ancestor (W6).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { agents, applyPendingMigrations, createDb, heartbeatRuns, type Db } from "@armyofagents/db";
import { hubItemsService } from "../services/hub-items.js";
import { buildCompletedRunHubEmit, buildTerminalRunHubEmit } from "../services/hub-source-producers.js";
import { emitLegacyAlertHubItems } from "../services/hub-legacy-alerts.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 58300 + Math.floor(Math.random() * 1000);

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
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-emit-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: new (o: object) => Pg };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    console.error("[hub-emit-integration] setup failed:", err);
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

async function setNotificationRule(
  companyId: string,
  userId: string,
  deliveryMode: "realtime" | "digest" | "silent",
) {
  await db.execute(sql`
    INSERT INTO notification_preferences (id, user_id, company_id, rules, quiet_hours, digest, created_at, updated_at)
    VALUES (
      gen_random_uuid(),
      ${userId},
      ${companyId},
      ${JSON.stringify([{ semanticType: "approval_request", deliveryMode, toastEnabled: true }])}::jsonb,
      ${JSON.stringify({ enabled: false, start: "18:00", end: "09:00", timezone: "UTC" })}::jsonb,
      ${JSON.stringify({ enabled: true, cadence: "daily" })}::jsonb,
      now(),
      now()
    )
    ON CONFLICT (user_id, company_id) DO UPDATE SET
      rules = excluded.rules,
      quiet_hours = excluded.quiet_hours,
      digest = excluded.digest,
      updated_at = now()
  `);
}

describe.skipIf(process.platform === "win32")("hubItems.emit — real DB", () => {
  it("setup harness boots", () => {
    if (setupError) throw new Error(String(setupError));
    expect(db).toBeTruthy();
  });

  it("emit upserts on source_unique_key (idempotent), redacts the summary, keeps one open row", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const args = {
      companyId,
      semanticType: "approval_request" as const,
      sourceType: "approval",
      sourceId: "appr-1",
      title: "Approve hire",
      summary: "token sk-ABC123SECRETVALUEXYZ in the payload",
      ownerUserId: founderId,
    };
    const a = await svc.emit(args);
    const b = await svc.emit(args); // same source → same row, not a duplicate
    expect(b.id).toBe(a.id);
    expect(a.summary).not.toContain("sk-ABC123SECRETVALUEXYZ"); // redact-before-persist
    expect(a.lane).toBe("waiting_on_you");
    const open = await db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE company_id = ${companyId} AND status = 'open'`,
    );
    expect(firstRow<{ n: number }>(open).n).toBe(1);
  });

  it("an identical re-emit is a true no-op: the row is not rewritten (storm guard)", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const svc = hubItemsService(db);
    const args = {
      companyId,
      semanticType: "run_failed" as const,
      sourceType: "heartbeat_run",
      sourceId: "hbr-noop-1",
      title: "Scout run failed",
      summary: "exit 1",
      priority: "high" as const,
      ownerUserId: founderId,
    };
    const first = await svc.emit(args);
    // xmin changes on ANY row rewrite — capture it, re-emit identical content,
    // and assert the tuple was NOT touched (change-detection setWhere skipped
    // the UPDATE; without it, `deliveredAt = now()` rewrote the row every time
    // and fed the sidebar-badges scan-on-read feedback storm).
    const before = firstRow<{ x: string }>(
      await db.execute(sql`SELECT xmin::text AS x FROM notifications WHERE id = ${first.id}`),
    );
    const second = await svc.emit(args);
    expect(second.id).toBe(first.id);
    const after = firstRow<{ x: string }>(
      await db.execute(sql`SELECT xmin::text AS x FROM notifications WHERE id = ${first.id}`),
    );
    expect(after.x).toBe(before.x); // tuple untouched
    // A REAL change still updates the row.
    const third = await svc.emit({ ...args, summary: "exit 1 (retried, still failing)" });
    expect(third.id).toBe(first.id);
    const changed = firstRow<{ x: string; summary: string }>(
      await db.execute(sql`SELECT xmin::text AS x, summary FROM notifications WHERE id = ${first.id}`),
    );
    expect(changed.x).not.toBe(before.x);
    expect(changed.summary).toContain("retried");
  });

  it("an agent-sourced emit resolves the owner to the first human ancestor (W6)", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    // founder ← lead (agent) ← worker (agent): worker's first human ancestor = founder.
    const leadId = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Lead', 'org', 'idle', 'user', ${founderId}) RETURNING id`));
    const workerId = firstId(await db.execute(sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, 'Worker', 'org', 'idle', 'agent', ${leadId}) RETURNING id`));
    const svc = hubItemsService(db);
    const item = await svc.emit({
      companyId,
      semanticType: "run_failed",
      sourceType: "heartbeat_run",
      sourceId: "hbr-agent-1",
      title: "Run failed",
      summary: "the worker crashed",
      sourceActorType: "agent",
      sourceActorId: workerId,
    });
    expect(item.ownerUserId).toBe(founderId);
    expect(item.userId).toBe(founderId); // legacy NOT NULL column carries the resolved human
    expect(item.lane).toBe("notifications");
  });

  it("emit writes legacy notification compatibility columns", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const relatedEntityId = "11111111-1111-4111-8111-111111111111";
    const item = await hubItemsService(db).emit({
      companyId,
      semanticType: "mention",
      sourceType: "discussion",
      sourceId: relatedEntityId,
      title: "Mentioned",
      summary: "Body with token sk-ABC123SECRETVALUEXYZ",
      legacyType: "thread.mention",
      ownerUserId: founderId,
      relatedEntityType: "discussion",
      relatedEntityId,
      deliveryAttempts: 0,
      deliveredAt: new Date("2026-06-30T00:00:00.000Z"),
      deliveryError: null,
    });

    const row = firstRow<{
      message: string | null;
      related_entity_type: string | null;
      related_entity_id: string | null;
      delivery_attempts: number;
      delivered_at: Date | string | null;
      delivery_error: string | null;
      type: string;
    }>(
      await db.execute(sql`
        SELECT type, message, related_entity_type, related_entity_id, delivery_attempts, delivered_at, delivery_error
        FROM notifications
        WHERE id = ${item.id}
      `),
    );

    expect(row.type).toBe("thread.mention");
    expect(row.message).toBe(item.summary);
    expect(row.message).not.toContain("sk-ABC123SECRETVALUEXYZ");
    expect(row.related_entity_type).toBe("discussion");
    expect(row.related_entity_id).toBe(relatedEntityId);
    expect(row.delivery_attempts).toBe(0);
    expect(row.delivered_at).toBeTruthy();
    expect(row.delivery_error).toBeNull();
  });

  it("queues digest delivery for a digest-preferring visible user when emitting a hub item", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    await setNotificationRule(companyId, founderId, "digest");

    const item = await hubItemsService(db).emit({
      companyId,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "digest-visible",
      title: "Needs digest",
      ownerUserId: founderId,
    });

    const rows = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM notification_digest_items
      WHERE company_id = ${companyId}
        AND user_id = ${founderId}
        AND hub_item_id = ${item.id}
        AND acked_at IS NULL
    `);
    expect(firstRow<{ n: number }>(rows).n).toBe(1);
  });

  it("does not queue digest delivery for silent preferences", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    await setNotificationRule(companyId, founderId, "silent");

    const item = await hubItemsService(db).emit({
      companyId,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "digest-silent",
      title: "Silent item",
      ownerUserId: founderId,
    });

    const rows = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM notification_digest_items
      WHERE company_id = ${companyId}
        AND user_id = ${founderId}
        AND hub_item_id = ${item.id}
    `);
    expect(firstRow<{ n: number }>(rows).n).toBe(0);
  });

  // ── BUG-5: event-driven run_complete / run_failed at the terminal chokepoint ──

  async function seedAgent(companyId: string, founderId: string, name: string): Promise<string> {
    return firstId(
      await db.execute(
        sql`INSERT INTO agents (id, company_id, name, kind, status, parent_type, parent_id) VALUES (gen_random_uuid(), ${companyId}, ${name}, 'org', 'idle', 'user', ${founderId}) RETURNING id`,
      ),
    );
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    status: string,
    error: string | null = null,
  ): Promise<string> {
    return firstId(
      await db.execute(
        sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, error, created_at, updated_at) VALUES (gen_random_uuid(), ${companyId}, ${agentId}, ${status}, ${error}, now(), now()) RETURNING id`,
      ),
    );
  }

  // Load the run in the SAME shape (and through the same drizzle/pg Date
  // parsing) as both the setRunStatus chokepoint and the legacy sidebar-badges
  // scan, so builder inputs are byte-comparable across producers.
  async function loadRunLike(runId: string) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.id, runId));
    const row = rows[0];
    if (!row) throw new Error(`loadRunLike: run ${runId} not found`);
    return row;
  }

  async function xminOf(itemId: string): Promise<string> {
    return firstRow<{ x: string }>(
      await db.execute(sql`SELECT xmin::text AS x FROM notifications WHERE id = ${itemId}`),
    ).x;
  }

  it("keeps a succeeded process exit out of the attention lane", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const agentId = await seedAgent(companyId, founderId, "Scout");
    const runId = await seedRun(companyId, agentId, "succeeded");
    const emitArgs = buildTerminalRunHubEmit(await loadRunLike(runId));
    expect(emitArgs).toBeNull();

    const open = await db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE company_id = ${companyId} AND source_type = 'heartbeat_run' AND status = 'open'`,
    );
    expect(firstRow<{ n: number }>(open).n).toBe(0);
  });

  it("archives historical run_complete rows during heartbeat reconciliation", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const agentId = await seedAgent(companyId, founderId, "Scout");
    const runId = await seedRun(companyId, agentId, "succeeded");
    const svc = hubItemsService(db);
    const historical = await svc.emit(buildCompletedRunHubEmit(await loadRunLike(runId)));

    const result = await svc.reconcile(companyId, { sourceType: "heartbeat_run" });
    expect(result.closed).toBe(1);
    const archived = await db.execute(
      sql`SELECT status FROM notifications WHERE id = ${historical.id}`,
    );
    expect(firstRow<{ status: string }>(archived).status).toBe("archived");
  });

  it("BUG-5 parity: event-emit(failed run) then emitLegacyAlertHubItems → exactly ONE row, untouched by the legacy pass", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const agentId = await seedAgent(companyId, founderId, "Builder");
    const runId = await seedRun(companyId, agentId, "failed", "exit 1");
    const svc = hubItemsService(db);

    const emitArgs = buildTerminalRunHubEmit(await loadRunLike(runId));
    expect(emitArgs?.semanticType).toBe("run_failed");
    const item = await svc.emit(emitArgs!);
    const before = await xminOf(item.id);

    // The legacy sidebar-badges scan sees the same run. sourceUniqueKey dedupe
    // + byte-identical builder output (buildTerminalRunHubEmit routes failures
    // through buildFailedRunHubEmit) → no second row AND no tuple rewrite.
    const legacy = await emitLegacyAlertHubItems(db, companyId);
    expect(legacy.failedRuns).toBe(1);

    const rows = await db.execute(
      sql`SELECT count(*)::int AS n FROM notifications WHERE company_id = ${companyId} AND source_type = 'heartbeat_run'`,
    );
    expect(firstRow<{ n: number }>(rows).n).toBe(1);
    expect(await xminOf(item.id)).toBe(before);
  });
});
