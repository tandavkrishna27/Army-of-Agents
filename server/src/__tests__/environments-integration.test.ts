/**
 * Real-DB integration test for environmentService.
 *
 * Boots an embedded-postgres instance, applies all migrations, seeds companies,
 * then exercises list, get, create, update, and delete — including cross-company
 * isolation checks.
 *
 * Skipped on Windows (embedded-postgres encoding issues — see Issue #114).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";
import { environmentService } from "../services/environments.js";

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
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let svc: ReturnType<typeof environmentService>;
let setupError: unknown = null;

// Helper for normalizing db.execute results
function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as any)?.id;
  return (result as any).rows?.[0]?.id;
}

// Random port between 57000-57999 to avoid collisions with other test runs
const PORT = 57000 + Math.floor(Math.random() * 1000);

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-environments-test-"));
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
    svc = environmentService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error(
      "[environments-integration] embedded-postgres setup failed:",
      err,
    );
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}, 60_000);

// Skipped on Windows due to embedded-postgres encoding issue (Issue #114).
describe.skipIf(process.platform === "win32")(
  "environmentService — real DB integration",
  () => {
    let companyAId: string;
    let companyBId: string;

    it("setup: seeds two companies", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }

      const companyAResult = await db.execute<{ id: string }>(sql`
        INSERT INTO companies (organization_id, id, name, issue_prefix)
        VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Env Test Co A', 'ENA')
        RETURNING id
      `);
      companyAId = firstId(companyAResult);
      expect(companyAId).toBeTruthy();

      const companyBResult = await db.execute<{ id: string }>(sql`
        INSERT INTO companies (organization_id, id, name, issue_prefix)
        VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Env Test Co B', 'ENB')
        RETURNING id
      `);
      companyBId = firstId(companyBResult);
      expect(companyBId).toBeTruthy();
    });

    it("list: returns environments scoped to the correct company", async () => {
      if (setupError) throw new Error(String(setupError));

      // Create 2 environments for company A, 1 for company B
      await svc.create(companyAId, { name: "A-Env-1" });
      await svc.create(companyAId, { name: "A-Env-2" });
      await svc.create(companyBId, { name: "B-Env-1" });

      const listA = await svc.list(companyAId);
      const listB = await svc.list(companyBId);

      expect(listA).toHaveLength(2);
      expect(listB).toHaveLength(1);

      // All returned rows belong to the correct company
      for (const env of listA) {
        expect(env.companyId).toBe(companyAId);
      }
      expect(listB[0].companyId).toBe(companyBId);
    });

    it("create: defaults envVars to {} and sets companyId", async () => {
      if (setupError) throw new Error(String(setupError));

      const env = await svc.create(companyAId, { name: "A-Env-Create-Test" });

      expect(env).not.toBeNull();
      expect(env!.name).toBe("A-Env-Create-Test");
      expect(env!.companyId).toBe(companyAId);
      // envVars should default to an empty object
      expect(env!.envVars).toEqual({});
      expect(env!.id).toBeTruthy();
    });

    it("get: returns correct environment by id+companyId; null for wrong companyId", async () => {
      if (setupError) throw new Error(String(setupError));

      const created = await svc.create(companyAId, { name: "A-Env-Get-Test" });
      expect(created).not.toBeNull();
      const id = created!.id;

      // Correct company returns the row
      const found = await svc.get(companyAId, id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      expect(found!.name).toBe("A-Env-Get-Test");

      // Wrong company returns null (cross-company isolation)
      const notFound = await svc.get(companyBId, id);
      expect(notFound).toBeNull();
    });

    it("update: updates name and envVars; returns null for wrong companyId", async () => {
      if (setupError) throw new Error(String(setupError));

      const created = await svc.create(companyAId, {
        name: "A-Env-Before-Update",
        envVars: { KEY: "original" },
      });
      expect(created).not.toBeNull();
      const id = created!.id;
      const originalUpdatedAt = created!.updatedAt;

      // Small delay to ensure updatedAt will differ
      await new Promise((res) => setTimeout(res, 10));

      const updated = await svc.update(companyAId, id, {
        name: "A-Env-After-Update",
        envVars: { KEY: "updated", NEW_KEY: "value" },
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("A-Env-After-Update");
      expect(updated!.envVars).toEqual({ KEY: "updated", NEW_KEY: "value" });
      // updatedAt should change
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(
        new Date(originalUpdatedAt).getTime(),
      );

      // Wrong companyId returns null
      const wrongCompany = await svc.update(companyBId, id, { name: "should-not-apply" });
      expect(wrongCompany).toBeNull();

      // Row was not modified by the wrong-company attempt
      const after = await svc.get(companyAId, id);
      expect(after!.name).toBe("A-Env-After-Update");
    });

    it("delete: removes the row; subsequent get returns null; wrong companyId returns null", async () => {
      if (setupError) throw new Error(String(setupError));

      const created = await svc.create(companyAId, { name: "A-Env-To-Delete" });
      expect(created).not.toBeNull();
      const id = created!.id;

      // Wrong companyId delete returns null and does NOT delete
      const wrongDelete = await svc.delete(companyBId, id);
      expect(wrongDelete).toBeNull();

      // Row should still exist
      const stillThere = await svc.get(companyAId, id);
      expect(stillThere).not.toBeNull();

      // Correct delete
      const deleted = await svc.delete(companyAId, id);
      expect(deleted).not.toBeNull();
      expect(deleted!.id).toBe(id);

      // Subsequent get returns null
      const gone = await svc.get(companyAId, id);
      expect(gone).toBeNull();
    });

    it("execution-target pins allow same-org/system targets and reject missing/cross-org targets", async () => {
      if (setupError) throw new Error(String(setupError));

      const orgA = randomUUID();
      const orgB = randomUUID();
      const companyA = randomUUID();
      const companyB = randomUUID();
      const targetA = randomUUID();
      const targetB = randomUUID();
      const systemTarget = randomUUID();
      const suffix = randomUUID().slice(0, 8);

      await db.execute(sql`
        INSERT INTO organizations (id, name, slug)
        VALUES
          (${orgA}, 'Pin Org A', ${`pin-org-a-${suffix}`}),
          (${orgB}, 'Pin Org B', ${`pin-org-b-${suffix}`})
      `);
      await db.execute(sql`
        INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES
          (${companyA}, ${orgA}, 'Pin Company A', ${`PA${suffix.slice(0, 4)}`}),
          (${companyB}, ${orgB}, 'Pin Company B', ${`PB${suffix.slice(0, 4)}`})
      `);
      await db.execute(sql`
        INSERT INTO execution_targets (id, organization_id, slug, kind, trust_class, scope, target_authority_key)
        VALUES
          (${targetA}, ${orgA}, ${`pin-target-a-${suffix}`}, 'dedicated_worker', 'dedicated_tenant', 'organization', ${`organization:${orgA}`}),
          (${targetB}, ${orgB}, ${`pin-target-b-${suffix}`}, 'dedicated_worker', 'dedicated_tenant', 'organization', ${`organization:${orgB}`}),
          (${systemTarget}, NULL, ${`pin-system-${suffix}`}, 'pooled_gvisor', 'shared_multitenant', 'platform', 'platform')
      `);

      const mutate = <T>(operation: (txSvc: ReturnType<typeof environmentService>) => Promise<T>) =>
        db.transaction((tx) => operation(environmentService(tx as unknown as Db)));

      const sameOrg = await mutate((txSvc) => txSvc.create(companyA, {
        name: "same-org-pin",
        executionTargetId: targetA,
      }));
      const system = await mutate((txSvc) => txSvc.create(companyA, {
        name: "system-pin",
        executionTargetId: systemTarget,
      }));
      expect(sameOrg?.executionTargetId).toBe(targetA);
      expect(system?.executionTargetId).toBe(systemTarget);

      await expect(mutate((txSvc) => txSvc.create(companyA, {
        name: "cross-org-pin",
        executionTargetId: targetB,
      }))).rejects.toMatchObject({
        status: 422,
        message: "Execution target is unavailable for this company",
      });
      await expect(mutate((txSvc) => txSvc.create(companyA, {
        name: "missing-pin",
        executionTargetId: randomUUID(),
      }))).rejects.toMatchObject({
        status: 422,
        message: "Execution target is unavailable for this company",
      });
      expect((await svc.list(companyA)).map((env) => env.name)).not.toContain("cross-org-pin");
      expect((await svc.list(companyA)).map((env) => env.name)).not.toContain("missing-pin");

      const unpinned = await mutate((txSvc) => txSvc.create(companyA, { name: "update-pin" }));
      await expect(mutate((txSvc) => txSvc.update(companyA, unpinned!.id, {
        name: "must-not-persist",
        executionTargetId: targetB,
      }))).rejects.toMatchObject({ status: 422 });
      expect(await svc.get(companyA, unpinned!.id)).toMatchObject({
        name: "update-pin",
        executionTargetId: null,
      });

      const pinned = await mutate((txSvc) => txSvc.update(companyA, unpinned!.id, { executionTargetId: targetA }));
      const omitted = await mutate((txSvc) => txSvc.update(companyA, unpinned!.id, { name: "pin-preserved" }));
      const cleared = await mutate((txSvc) => txSvc.update(companyA, unpinned!.id, { executionTargetId: null }));
      expect(pinned?.executionTargetId).toBe(targetA);
      expect(omitted?.executionTargetId).toBe(targetA);
      expect(cleared?.executionTargetId).toBeNull();
    });
  },
);
