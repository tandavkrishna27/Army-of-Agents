/**
 * W4 curation metadata real-DB integration. Skipped on Windows to match the
 * existing embedded-postgres integration harness; Linux CI is authoritative.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { hubCurationService } from "../services/hub-curation.js";
import { hubItemsService } from "../services/hub-items.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };

let pg: Pg | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 59400 + Math.floor(Math.random() * 1000);

function firstId(result: unknown): string {
  const id = Array.isArray(result)
    ? (result[0] as { id: string } | undefined)?.id
    : (result as { rows?: { id: string }[] }).rows?.[0]?.id;
  if (!id) throw new Error("firstId: no id returned from INSERT ... RETURNING id");
  return id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-hub-curation-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: new (options: object) => Pg;
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
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    console.error("[hub-curation-integration] setup failed:", err);
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
      sql`INSERT INTO companies (id, name, issue_prefix) VALUES (gen_random_uuid(), 'Hub Curation Co', upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))) RETURNING id`,
    ),
  );
  const founderId = firstId(
    await db.execute(
      sql`INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at) VALUES (gen_random_uuid()::text, ${`f-${PORT}-${Math.random()}@hub-curation.test`}, 'Founder', false, now(), now()) RETURNING id`,
    ),
  );
  await db.execute(
    sql`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at) VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())`,
  );
  await db.execute(sql`INSERT INTO user_roles (id, company_id, user_id, role) VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')`);
  return { companyId, founderId };
}

describe.skipIf(process.platform === "win32")("hub curation service - real DB", () => {
  it("updates display-only curation metadata without changing lifecycle version", async () => {
    if (setupError) throw new Error(String(setupError));
    const { companyId, founderId } = await seedCompanyWithFounder();
    const item = await hubItemsService(db).emit({
      companyId,
      semanticType: "run_failed",
      sourceType: "heartbeat_run",
      sourceId: "curation-real-db",
      title: "failed run",
      ownerUserId: founderId,
    });

    const before = firstId(
      await db.execute(sql`SELECT version::text AS id FROM notifications WHERE id = ${item.id}`),
    );

    await hubCurationService(db, {
      now: () => new Date("2026-07-01T10:00:00.000Z"),
    }).updateSummary({
      companyId,
      hubItemId: item.id,
      expectedCurationRevision: 0,
      curationGroupLabel: "Failed runs",
      curationGroupSummary: "Provider rejected sk-ant-abc123DEF456ghi789.",
      curationReason: "SLA is due in 20 minutes.",
      curatedByAgentId: null,
    });

    const rows = await db.execute(sql`
      SELECT
        version,
        curation_revision,
        curation_group_label,
        curation_group_summary,
        curation_reason
      FROM notifications
      WHERE id = ${item.id}
    `);
    const row = Array.isArray(rows)
      ? (rows[0] as Record<string, unknown>)
      : (rows as { rows: Record<string, unknown>[] }).rows[0];

    expect(String(row.version)).toBe(before);
    expect(row.curation_revision).toBe(1);
    expect(row.curation_group_label).toBe("Failed runs");
    expect(row.curation_group_summary).toBe("Provider rejected ***REDACTED***.");
    expect(row.curation_reason).toBe("SLA is due in 20 minutes.");
  });
});
