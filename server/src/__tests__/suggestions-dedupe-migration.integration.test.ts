import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";

// H4 / P1-1 — the suggestions partial-unique index migration (0164) must apply
// cleanly against a DB that already carries a pending duplicate pair. drizzle-kit
// emits a bare CREATE UNIQUE INDEX; Postgres aborts index creation on existing
// violations, so migration 0164 hand-adds a pre-index collapse DML step. This
// test reconstructs a live-dup scenario (two identical pending "No identity
// memory" rows with a NULL dedupe_key) and replays the migration's collapse +
// backfill + index sequence, asserting the index creates without error and
// exactly one pending row survives.
//
// Collects + skips on Windows (embedded-postgres can't start on the CI Windows
// runner, Issue #114); the controller runs it on Linux CI.

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

const PORT = 58000 + Math.floor(Math.random() * 1000);
const companyId = "22222222-2222-4222-8222-222222222222";

const IDENTITY_PAYLOAD = {
  title: "Company identity guidelines",
  content: "Capture the core company identity guidance that every agent should receive.",
  category: "reference",
  layer: "identity",
  tags: ["identity"],
  sourceContext: "Generated from suggestion engine due to missing identity memory.",
};

// The exact collapse + backfill + index statements from migration
// 0164_abnormal_ogun.sql, replayed here after re-introducing a violating pair.
const COLLAPSE_SQL = sql`
  WITH ranked AS (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY
          "company_id",
          COALESCE(
            CASE
              WHEN "category" = 'goal_gap'
                AND "action_type" = 'create_task'
                AND "action_payload"->>'goalId' IS NOT NULL
                AND coalesce("title", '') ILIKE '%has no tasks yet%'
                THEN 'goal_gap:no_tasks:' || ("action_payload"->>'goalId')
              WHEN "category" = 'goal_gap'
                AND "action_type" = 'create_task'
                AND "action_payload"->>'goalId' IS NOT NULL
                AND coalesce("title", '') ILIKE '%looks stalled%'
                THEN 'goal_gap:stalled:' || ("action_payload"->>'goalId')
              WHEN "category" = 'memory_gap'
                AND "action_type" = 'suggest_memory'
                AND "action_payload"->>'layer' = 'identity'
                THEN 'memory_gap:identity'
              WHEN "category" = 'memory_gap'
                AND "action_type" = 'suggest_memory'
                AND "action_payload"->>'departmentId' IS NOT NULL
                THEN 'memory_gap:domain:' || ("action_payload"->>'departmentId')
              WHEN "category" = 'memory_gap'
                AND "action_type" = 'archive_memory'
                AND "action_payload"->>'memoryItemId' IS NOT NULL
                THEN 'memory_gap:stale:' || ("action_payload"->>'memoryItemId')
              WHEN "category" = 'pattern_detected'
                AND "action_payload"->>'patternId' IS NOT NULL
                THEN 'pattern_detected:' || ("action_payload"->>'patternId')
              WHEN "category" = 'budget_optimization'
                AND coalesce("title", '') ILIKE '%company budget%'
                THEN 'budget_optimization:company'
              ELSE NULL
            END,
            "category" || ':payload:' || coalesce("action_payload"::text, 'null')
          )
        ORDER BY "created_at" DESC, "id" DESC
      ) AS rn
    FROM "suggestions"
    WHERE "status" = 'pending'
  )
  UPDATE "suggestions" AS s
  SET "status" = 'dismissed', "updated_at" = now()
  FROM ranked r
  WHERE s."id" = r."id" AND r.rn > 1
`;
const ARCHIVE_DISMISSED_HUB_SQL = sql`
  UPDATE "notifications" AS h
  SET "status" = 'archived', "archived_at" = COALESCE("archived_at", now())
  WHERE h."source_type" = 'suggestion'
    AND h."status" = 'open'
    AND EXISTS (
      SELECT 1 FROM "suggestions" AS s
      WHERE s."id"::text = h."source_id"
        AND s."status" = 'dismissed'
    )
`;
const BACKFILL_SQL = sql`
  UPDATE "suggestions"
  SET "dedupe_key" = CASE
    WHEN "category" = 'goal_gap'
      AND "action_type" = 'create_task'
      AND "action_payload"->>'goalId' IS NOT NULL
      AND coalesce("title", '') ILIKE '%has no tasks yet%'
      THEN 'goal_gap:no_tasks:' || ("action_payload"->>'goalId')
    WHEN "category" = 'goal_gap'
      AND "action_type" = 'create_task'
      AND "action_payload"->>'goalId' IS NOT NULL
      AND coalesce("title", '') ILIKE '%looks stalled%'
      THEN 'goal_gap:stalled:' || ("action_payload"->>'goalId')
    WHEN "category" = 'memory_gap'
      AND "action_type" = 'suggest_memory'
      AND "action_payload"->>'layer' = 'identity'
      THEN 'memory_gap:identity'
    WHEN "category" = 'memory_gap'
      AND "action_type" = 'suggest_memory'
      AND "action_payload"->>'departmentId' IS NOT NULL
      THEN 'memory_gap:domain:' || ("action_payload"->>'departmentId')
    WHEN "category" = 'memory_gap'
      AND "action_type" = 'archive_memory'
      AND "action_payload"->>'memoryItemId' IS NOT NULL
      THEN 'memory_gap:stale:' || ("action_payload"->>'memoryItemId')
    WHEN "category" = 'pattern_detected'
      AND "action_payload"->>'patternId' IS NOT NULL
      THEN 'pattern_detected:' || ("action_payload"->>'patternId')
    WHEN "category" = 'budget_optimization'
      AND coalesce("title", '') ILIKE '%company budget%'
      THEN 'budget_optimization:company'
    ELSE "dedupe_key"
  END
  WHERE "status" = 'pending' AND "dedupe_key" IS NULL
`;
const CREATE_INDEX_SQL = sql`
  CREATE UNIQUE INDEX "suggestions_pending_dedupe_idx"
  ON "suggestions" USING btree ("company_id","dedupe_key")
  WHERE status = 'pending' AND dedupe_key IS NOT NULL
`;

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-sugg-dedupe-mig-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
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

    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Suggestion Dedupe Co', 'SDC')
    `);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
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
  "H4 — suggestions dedupe migration collapse applies cleanly against a live dup pair",
  () => {
    it("collapses the pending duplicate, backfills the survivor, and the unique index creates without error", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      // Reproduce the live-dup state the migration must survive: drop the index
      // the migration already created, blank dedupe_key, and insert TWO identical
      // pending identity-gap rows (the ed6c6c41/32e9fd59 QA pair shape).
      await db.execute(sql`DROP INDEX IF EXISTS "suggestions_pending_dedupe_idx"`);

      const payloadJson = JSON.stringify(IDENTITY_PAYLOAD);
      const older = "aaaaaaaa-0000-4000-8000-000000000001";
      const newer = "aaaaaaaa-0000-4000-8000-000000000002";
      await db.execute(sql`
        INSERT INTO suggestions (id, company_id, category, action_type, action_payload, title, status, dedupe_key, created_at)
        VALUES
          (${older}, ${companyId}, 'memory_gap', 'suggest_memory', ${payloadJson}::jsonb,
           'No identity memory exists yet', 'pending', NULL, now() - interval '2 days'),
          (${newer}, ${companyId}, 'memory_gap', 'suggest_memory', ${payloadJson}::jsonb,
           'No identity memory exists yet', 'pending', NULL, now())
      `);
      await db.execute(sql`
        INSERT INTO notifications (company_id, user_id, type, title, source_type, source_id, semantic_type, status)
        VALUES
          (${companyId}, 'founder-1', 'suggestion', 'older hub row', 'suggestion', ${older}, 'suggestion', 'open'),
          (${companyId}, 'founder-1', 'suggestion', 'newer hub row', 'suggestion', ${newer}, 'suggestion', 'open')
      `);

      // A bare CREATE UNIQUE INDEX here would ABORT (two violating pending rows).
      // Replay the migration's ordered steps: collapse → backfill → index.
      await db.execute(COLLAPSE_SQL);
      await db.execute(ARCHIVE_DISMISSED_HUB_SQL);
      await db.execute(BACKFILL_SQL);
      // Must NOT throw — the collapse eliminated the violation.
      await expect(db.execute(CREATE_INDEX_SQL)).resolves.toBeDefined();

      // Exactly one pending identity-gap row survives; the older is dismissed.
      const pendingRows = await db.execute(sql`
        SELECT id, dedupe_key FROM suggestions
        WHERE company_id = ${companyId} AND category = 'memory_gap' AND status = 'pending'
      `);
      const pending = pendingRows as unknown as Array<{ id: string; dedupe_key: string | null }>;
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(newer); // newest kept
      expect(pending[0].dedupe_key).not.toBeNull(); // backfilled → index guards it

      const dismissedRows = await db.execute(sql`
        SELECT id FROM suggestions
        WHERE company_id = ${companyId} AND id = ${older} AND status = 'dismissed'
      `);
      expect((dismissedRows as unknown as unknown[]).length).toBe(1);
      const archivedRows = await db.execute(sql`
        SELECT id FROM notifications
        WHERE company_id = ${companyId}
          AND source_type = 'suggestion'
          AND source_id = ${older}
          AND status = 'archived'
      `);
      expect((archivedRows as unknown as unknown[]).length).toBe(1);

      // The index now blocks a third identical pending insert.
      const third = "aaaaaaaa-0000-4000-8000-000000000003";
      const survivorKey = pending[0].dedupe_key!;
      await expect(
        db.execute(sql`
          INSERT INTO suggestions (id, company_id, category, action_type, action_payload, title, status, dedupe_key)
          VALUES (${third}, ${companyId}, 'memory_gap', 'suggest_memory', ${payloadJson}::jsonb,
                  'No identity memory exists yet', 'pending', ${survivorKey})
        `),
      ).rejects.toThrow();
    });
  },
);
