import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  homeBoardLayouts,
  userRoles,
  type Db,
  type HomeBoardLayoutItem,
} from "@armyofagents/db";
import { insertTestCompany } from "./helpers/insert-test-company.js";
import { HOME_BOARD_LAYOUT_SCHEMA_VERSION } from "@armyofagents/shared";
import { homeBoardLayoutService } from "../services/home-board-layout.js";

/**
 * Task D5 (Plan 3 — Home widget board): a real-Postgres round-trip for
 * `home_board_layouts` that the mocked service unit tests
 * (home-board-layout-service.test.ts) explicitly defer here — see that
 * file's "a real DB round-trip is covered separately by the migration
 * integration test (Phase D)" comments. This proves three things a Drizzle
 * mock can't: the migration actually creates the table + both cascading FKs
 * + the unique index, the unique(userId, companyId) constraint makes a
 * second write UPDATE the same row instead of inserting a duplicate, and
 * deleting a company cascades to its layout row.
 *
 * Embedded-postgres harness (matches the other *.integration.test.ts files —
 * see work-questions.integration.test.ts). The beforeAll below boots its own
 * throwaway cluster, so this suite runs in the required Linux `verify` gate
 * with NO external DATABASE_URL. The beforeAll is inside the win32-skipped
 * describe, so on Windows the whole suite (boot included) skips per Issue
 * #114 (embedded-postgres can't start on the runneradmin CI runner, and this
 * deep OneDrive worktree hits a MAX_PATH initdb failure locally); on Linux a
 * boot failure throws and reddens the suite (fail-closed), it never silently
 * skips there.
 */
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

// To run locally on Windows, temporarily flip this to `describe.skipIf(false)`.
describe.skipIf(process.platform === "win32")("home_board_layouts migration + constraints (real PostgreSQL)", () => {
  let db: Db;
  const companyId = randomUUID();
  const userId = `home-board-layout-${randomUUID()}`;

  async function seedCompanyWithOwner(id: string, ownerId: string, issuePrefix: string) {
    const now = new Date();
    await insertTestCompany(db, {
      id,
      name: `Home Board Layout ${issuePrefix}`,
      issuePrefix,
    });
    await db.insert(authUsers).values({
      id: ownerId,
      name: "Layout Owner",
      email: `${ownerId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId: id,
      principalType: "user",
      principalId: ownerId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(userRoles).values({ companyId: id, userId: ownerId, role: "founder" });
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-home-board-layout-integ-"));
    // Probe for a genuinely-free port (vitest runs these files in parallel and
    // sibling suites use overlapping fixed random ranges — see the helper).
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
      // Force UTF-8 so migration SQL with non-Latin1 chars applies regardless
      // of the host locale (matches work-questions.integration.test.ts).
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    await seedCompanyWithOwner(companyId, userId, `HBL${Math.floor(Math.random() * 9000 + 1000)}`);
  }, 180_000);

  afterAll(async () => {
    // Throwaway cluster — stop it and drop its data dir; no per-row cleanup needed.
    await pg?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("upserts a layout through the service and reads back the exact stored value", async () => {
    const service = homeBoardLayoutService(db);
    const layout: HomeBoardLayoutItem[] = [
      { i: "action-queue", x: 0, y: 0, w: 2, h: 1 },
      { i: "budget", x: 2, y: 0, w: 1, h: 1 },
    ];

    const written = await service.upsert(userId, companyId, layout);
    expect(written).toEqual({ layout, schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION });

    const read = await service.get(userId, companyId);
    expect(read).toEqual({ layout, schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION });
  });

  it("enforces unique(userId, companyId): repeated writes for the same pair update one row, never duplicate", async () => {
    const service = homeBoardLayoutService(db);
    const firstLayout: HomeBoardLayoutItem[] = [{ i: "suggestions", x: 0, y: 0, w: 2, h: 1 }];
    const secondLayout: HomeBoardLayoutItem[] = [
      { i: "objectives", x: 0, y: 0, w: 2, h: 2 },
      { i: "my-tasks", x: 2, y: 0, w: 2, h: 1 },
    ];

    await service.upsert(userId, companyId, firstLayout);
    await service.upsert(userId, companyId, secondLayout);

    const rowsAfterServiceUpserts = await db
      .select()
      .from(homeBoardLayouts)
      .where(and(eq(homeBoardLayouts.userId, userId), eq(homeBoardLayouts.companyId, companyId)));
    expect(rowsAfterServiceUpserts).toHaveLength(1);
    expect(rowsAfterServiceUpserts[0]?.layout).toEqual(secondLayout);

    // Same invariant proven at the raw-SQL layer, independent of the
    // service's own onConflictDoUpdate wiring: a second INSERT that
    // conflicts on the (userId, companyId) unique index updates the
    // existing row rather than raising a duplicate-key error (which is what
    // would happen without the unique index — or the ON CONFLICT clause
    // itself would fail to plan without a matching unique constraint).
    const rawLayout: HomeBoardLayoutItem[] = [{ i: "agents-now", x: 3, y: 0, w: 1, h: 1 }];
    await db
      .insert(homeBoardLayouts)
      .values({ userId, companyId, layout: rawLayout, schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION })
      .onConflictDoUpdate({
        target: [homeBoardLayouts.userId, homeBoardLayouts.companyId],
        set: { layout: rawLayout, updatedAt: new Date() },
      });

    const rowsAfterRawInsert = await db
      .select()
      .from(homeBoardLayouts)
      .where(and(eq(homeBoardLayouts.userId, userId), eq(homeBoardLayouts.companyId, companyId)));
    expect(rowsAfterRawInsert).toHaveLength(1);
    expect(rowsAfterRawInsert[0]?.layout).toEqual(rawLayout);
  });

  it("reset deletes the row so a later get returns null (contract: delete, not soft-clear)", async () => {
    const service = homeBoardLayoutService(db);
    await service.upsert(userId, companyId, [{ i: "approvals", x: 0, y: 0, w: 1, h: 1 }]);
    expect(await service.get(userId, companyId)).not.toBeNull();

    await service.reset(userId, companyId);
    expect(await service.get(userId, companyId)).toBeNull();

    const rows = await db
      .select()
      .from(homeBoardLayouts)
      .where(and(eq(homeBoardLayouts.userId, userId), eq(homeBoardLayouts.companyId, companyId)));
    expect(rows).toHaveLength(0);
  });

  it("cascades on company delete: deleting the company removes its home board layout row", async () => {
    // A dedicated company + user (rather than the shared beforeAll fixture)
    // so this destructive step can't affect the other tests in this file
    // regardless of execution order.
    const cascadeCompanyId = randomUUID();
    const cascadeUserId = `home-board-layout-cascade-${randomUUID()}`;
    await seedCompanyWithOwner(cascadeCompanyId, cascadeUserId, `HBLC${Math.floor(Math.random() * 9000 + 1000)}`);

    const service = homeBoardLayoutService(db);
    await service.upsert(cascadeUserId, cascadeCompanyId, [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }]);
    expect(await service.get(cascadeUserId, cascadeCompanyId)).not.toBeNull();

    await db.delete(companies).where(eq(companies.id, cascadeCompanyId));

    const rows = await db
      .select()
      .from(homeBoardLayouts)
      .where(and(eq(homeBoardLayouts.userId, cascadeUserId), eq(homeBoardLayouts.companyId, cascadeCompanyId)));
    expect(rows).toHaveLength(0);
    expect(await service.get(cascadeUserId, cascadeCompanyId)).toBeNull();
  });

  it("cascades on user delete: deleting the auth user removes its home board layout row", async () => {
    // FK cascade is declared on BOTH columns (userId and companyId) — the
    // company-delete case above proves one side; this proves the other
    // (deleting the referenced auth user, company left intact).
    const otherUserId = `home-board-layout-user-cascade-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: otherUserId,
      name: "Layout Owner (user-cascade target)",
      email: `${otherUserId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: otherUserId,
      status: "active",
      membershipRole: "member",
    });

    const service = homeBoardLayoutService(db);
    await service.upsert(otherUserId, companyId, [{ i: "activity-feed", x: 0, y: 0, w: 2, h: 2 }]);
    expect(await service.get(otherUserId, companyId)).not.toBeNull();

    await db.delete(authUsers).where(eq(authUsers.id, otherUserId));

    const rows = await db
      .select()
      .from(homeBoardLayouts)
      .where(and(eq(homeBoardLayouts.userId, otherUserId), eq(homeBoardLayouts.companyId, companyId)));
    expect(rows).toHaveLength(0);
    // The shared company + its owner's own layout row (from earlier tests)
    // must survive an unrelated user's deletion.
    const companyStillThere = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(companyStillThere).toHaveLength(1);
  });
});
