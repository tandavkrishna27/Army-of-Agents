import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  executionTargets,
  organizations,
  type Db,
} from "@armyofagents/db";
import { registerWorkerHeartbeat } from "../services/execution-targets.js";

// Proves M6: a heartbeat scoped to one execution target's ID never touches a
// sibling row, even one seeded right alongside it (the class of bug a
// slug-scoped update would introduce across tenants). Runs on embedded-pg
// (Linux CI); Windows collects + skips this suite — embedded-postgres can't
// start on the CI Windows runner (see docs/aoa/plans note + sibling
// add-dependency-race.integration.test.ts, which established this pattern).
// NOTE: the plan referenced a shared `makeEmbeddedTestDb()` test helper that
// does not exist in this repo — every *.integration.test.ts declares its own
// inline embedded-pg bootstrap. Adapted to that established local pattern.

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

const PORT = 57000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  if (process.platform === "win32") return; // skipped suite — don't boot pg
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-exectarget-hb-test-"));
    const { default: EmbeddedPostgres } = (await import(
      "embedded-postgres"
    )) as { default: EmbeddedPostgresCtor };

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
  "execution-target heartbeat cross-row isolation (M6)",
  () => {
    it("a heartbeat scoped to one target id leaves an identically-scoped sibling untouched", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }
      // registerWorkerHeartbeat is the TENANT-worker path: it updates the target by
      // id but security-scopes to a real organization — null-Org system/shared rows
      // are deliberately excluded (execution-targets.ts) so a tenant can never flip a
      // platform pool. The M6 id-isolation property therefore belongs to ORG-scoped
      // dedicated targets, which is what this test exercises.
      const ORG = "00000000-0000-0000-0000-00000000e6a1";
      await db.insert(organizations).values({ id: ORG, name: "M6 heartbeat isolation", slug: "m6-heartbeat-isolation" });
      const orgScope = {
        organizationId: ORG,
        scope: "organization" as const,
        targetAuthorityKey: `organization:${ORG}`,
      };
      const [a] = await db
        .insert(executionTargets)
        .values({ ...orgScope, slug: "hb-1", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "offline" })
        .returning();
      const [b] = await db
        .insert(executionTargets)
        .values({ ...orgScope, slug: "hb-2", kind: "dedicated_worker", trustClass: "dedicated_tenant", status: "offline" })
        .returning();

      await registerWorkerHeartbeat(db, { targetId: a!.id, organizationId: ORG, status: "active" });

      const rowA = await db.select().from(executionTargets).where(eq(executionTargets.id, a!.id)).then((r) => r[0]!);
      const rowB = await db.select().from(executionTargets).where(eq(executionTargets.id, b!.id)).then((r) => r[0]!);
      expect(rowA.status).toBe("active");
      expect(rowA.lastSeenAt).not.toBeNull();
      expect(rowB.status).toBe("offline"); // sibling untouched
      expect(rowB.lastSeenAt).toBeNull();
    });
  },
);
