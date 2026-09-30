import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "../index.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;
type PlatformLockModule = {
  configurePlatformTargetAuthorityLockTimeout(tx: unknown, timeoutMs?: number): Promise<void>;
  acquirePlatformTargetAuthorityShared(tx: unknown, targetId: string): Promise<void>;
  acquirePlatformTargetAuthorityExclusive(tx: unknown, targetId: string): Promise<void>;
};

const TARGET = "e3000000-0000-4000-8000-000000000001";
const PHYSICAL_WORKER = "e3000000-0000-4000-8000-000000000002";
const ORG = "e3000000-0000-4000-8000-000000000003";
const APP_PASSWORD = "job003-app-lock-password";
const OPERATOR_PASSWORD = "job003-operator-lock-password";
const helperPath = "../platform-target-authority-lock.js";
const helperFile = new URL("../platform-target-authority-lock.ts", import.meta.url);

let embedded: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let admin: Sql | null = null;
let app: NonOwnerDbConnection | null = null;
let operator: NonOwnerDbConnection | null = null;
let setupError: unknown = null;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("port allocation failed"));
        else resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

function connections() {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin || !app || !operator) throw new Error("authority-lock test database was not initialized");
  return { admin, app, operator };
}

async function authorityLocks(): Promise<PlatformLockModule> {
  const imported = await import(helperPath).catch(() => null) as PlatformLockModule | null;
  expect(imported, "JOB-003 platform-target authority lock helper is not implemented").not.toBeNull();
  return imported!;
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for lock observation");
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-job003-authority-lock-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 6 });
    await admin.unsafe(`ALTER ROLE aoa_app LOGIN PASSWORD '${APP_PASSWORD}'`);
    await admin.unsafe(`ALTER ROLE aoa_operator LOGIN PASSWORD '${OPERATOR_PASSWORD}'`);
    app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${APP_PASSWORD}`), { max: 4 });
    operator = createOperatorDbConnection(
      adminUrl.replace("test:test", `aoa_operator:${OPERATOR_PASSWORD}`),
      { max: 4 },
    );
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'authority lock org', 'authority-lock-org')`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, scope, target_authority_key,
       device_generation, registered_profile, registered_profile_hash, provider_constraint_profile, last_seen_at)
      VALUES (${TARGET}, NULL, 'authority-lock-platform', 'pooled_gvisor', 'shared_multitenant',
        'active', 'platform', 'platform', 1,
        ${admin.json({ profile: "registered" })}, ${"1".repeat(64)},
        ${admin.json({ profile: "provider" })}, clock_timestamp())`;
    await admin`INSERT INTO workers
      (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
       device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
       last_seen_at, label, status)
      VALUES (${PHYSICAL_WORKER}, 'platform', NULL, ${TARGET}, 'platform', 'platform-public-key',
        ${"2".repeat(64)}, 1, ${"3".repeat(64)}, ${admin.json({ profile: "physical" })}, clock_timestamp(),
        clock_timestamp(), 'platform physical worker', 'active')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  const boundedClose = async (close: (() => Promise<void>) | undefined) => {
    if (!close) return;
    await Promise.race([
      close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  };
  await boundedClose(operator ? () => operator!.close({ timeoutSeconds: 5 }) : undefined);
  await boundedClose(app ? () => app!.close({ timeoutSeconds: 5 }) : undefined);
  await admin?.end().catch(() => {});
  await embedded?.stop().catch(() => {});
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-003 platform-target app-outer advisory authority",
  () => {
    it("defines the exact shared/exclusive AOA3 namespace API without schema or grant DDL", () => {
      expect(existsSync(helperFile), "shared authority helper source must exist").toBe(true);
      if (!existsSync(helperFile)) return;
      const source = readFileSync(helperFile, "utf8");
      expect(source).toContain("acquirePlatformTargetAuthorityShared");
      expect(source).toContain("acquirePlatformTargetAuthorityExclusive");
      expect(source).toContain("1095713075");
      expect(source).toContain("hashtext");
      expect(source).toContain("750");
      expect(source).not.toMatch(/\b(?:GRANT|CREATE POLICY|ALTER TABLE)\b/);
    });

    it("serializes shared tenant guards against exclusive cutoffs and rejects malformed target IDs", async () => {
      const locks = await authorityLocks();
      const { app, operator } = connections();
      await expect(app.db.transaction((tx) =>
        locks.acquirePlatformTargetAuthorityShared(tx, "not-a-canonical-uuid"),
      )).rejects.toThrow();

      let sharedAcquired = false;
      let releaseShared!: () => void;
      const sharedRelease = new Promise<void>((resolve) => { releaseShared = resolve; });
      const shared = app.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx);
        await locks.acquirePlatformTargetAuthorityShared(tx, TARGET);
        sharedAcquired = true;
        await sharedRelease;
      });
      await waitUntil(() => sharedAcquired);

      let exclusiveAcquired = false;
      const exclusive = operator.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx, 5_000);
        await locks.acquirePlatformTargetAuthorityExclusive(tx, TARGET);
        exclusiveAcquired = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(exclusiveAcquired).toBe(false);
      releaseShared();
      await shared;
      await exclusive;
      expect(exclusiveAcquired).toBe(true);
    });

    it("bounds lock waits at 750 ms and releases a transaction lock when its app backend dies", async () => {
      const locks = await authorityLocks();
      const { admin, app, operator } = connections();
      let exclusiveAcquired = false;
      let releaseExclusive!: () => void;
      const exclusiveRelease = new Promise<void>((resolve) => { releaseExclusive = resolve; });
      const heldExclusive = operator.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx, 5_000);
        await locks.acquirePlatformTargetAuthorityExclusive(tx, TARGET);
        exclusiveAcquired = true;
        await exclusiveRelease;
      });
      await waitUntil(() => exclusiveAcquired);
      const started = Date.now();
      await expect(app.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx);
        await locks.acquirePlatformTargetAuthorityShared(tx, TARGET);
      })).rejects.toThrow();
      expect(Date.now() - started).toBeGreaterThanOrEqual(650);
      expect(Date.now() - started).toBeLessThan(2_000);
      releaseExclusive();
      await heldExclusive;

      let appPid = 0;
      let appSharedAcquired = false;
      let holdApp!: () => void;
      const appRelease = new Promise<void>((resolve) => { holdApp = resolve; });
      const dyingApp = app.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx, 5_000);
        const rows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
        appPid = Number(rows[0]?.pid ?? 0);
        await locks.acquirePlatformTargetAuthorityShared(tx, TARGET);
        appSharedAcquired = true;
        await appRelease;
      });
      await waitUntil(() => appSharedAcquired && appPid > 0);
      await admin`SELECT pg_terminate_backend(${appPid})`;
      holdApp();
      await expect(dyingApp).rejects.toThrow();
      await expect(operator.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx);
        await locks.acquirePlatformTargetAuthorityExclusive(tx, TARGET);
      })).resolves.toBeUndefined();
    }, 20_000);

    it("implements target-to-worker row handoff with guard-first and cutoff-first ordering", async () => {
      const locks = await authorityLocks();
      const { admin, app, operator } = connections();
      await admin`UPDATE execution_targets SET status = 'active', device_generation = 1 WHERE id = ${TARGET}`;
      await admin`UPDATE workers SET status = 'active', device_generation = 1 WHERE id = ${PHYSICAL_WORKER}`;

      let guardReady = false;
      let releaseGuard!: () => void;
      const guardRelease = new Promise<void>((resolve) => { releaseGuard = resolve; });
      const guardFirst = app.db.transaction(async (appTx) => {
        await appTx.execute(sql`SELECT set_config('aoa.organization_id', ${ORG}, true)`);
        await operator!.db.transaction(async (operatorTx) => {
          await locks.configurePlatformTargetAuthorityLockTimeout(operatorTx, 5_000);
          await operatorTx.execute(sql`SELECT id FROM execution_targets WHERE id = ${TARGET} FOR SHARE`);
          await operatorTx.execute(sql`SELECT id FROM workers WHERE id = ${PHYSICAL_WORKER} FOR SHARE`);
          await locks.acquirePlatformTargetAuthorityShared(appTx, TARGET);
          const current = await appTx.execute<{ status: string }>(
            sql`SELECT status FROM execution_targets WHERE id = ${TARGET}`,
          );
          expect(current[0]?.status).toBe("active");
        });
        guardReady = true;
        await guardRelease;
      });
      await waitUntil(() => guardReady);

      let cutoffCommitted = false;
      const cutoffAfterGuard = operator.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx, 5_000);
        await tx.execute(sql`SELECT id FROM execution_targets WHERE id = ${TARGET} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM workers WHERE id = ${PHYSICAL_WORKER} FOR UPDATE`);
        await locks.acquirePlatformTargetAuthorityExclusive(tx, TARGET);
        await tx.execute(sql`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET}`);
        cutoffCommitted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(cutoffCommitted).toBe(false);
      releaseGuard();
      await guardFirst;
      await cutoffAfterGuard;
      expect(cutoffCommitted).toBe(true);

      await admin`UPDATE execution_targets SET status = 'active' WHERE id = ${TARGET}`;
      let cutoffReady = false;
      let releaseCutoff!: () => void;
      const cutoffRelease = new Promise<void>((resolve) => { releaseCutoff = resolve; });
      const cutoffFirst = operator.db.transaction(async (tx) => {
        await locks.configurePlatformTargetAuthorityLockTimeout(tx, 5_000);
        await tx.execute(sql`SELECT id FROM execution_targets WHERE id = ${TARGET} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM workers WHERE id = ${PHYSICAL_WORKER} FOR UPDATE`);
        await locks.acquirePlatformTargetAuthorityExclusive(tx, TARGET);
        await tx.execute(sql`UPDATE execution_targets SET device_generation = 2 WHERE id = ${TARGET}`);
        cutoffReady = true;
        await cutoffRelease;
      });
      await waitUntil(() => cutoffReady);
      let guardObserved = false;
      const guardAfterCutoff = app.db.transaction(async (appTx) => {
        await appTx.execute(sql`SELECT set_config('aoa.organization_id', ${ORG}, true)`);
        await operator!.db.transaction(async (operatorTx) => {
          await locks.configurePlatformTargetAuthorityLockTimeout(operatorTx, 5_000);
          const targetRows = await operatorTx.execute<{ device_generation: number }>(
            sql`SELECT device_generation FROM execution_targets WHERE id = ${TARGET} FOR SHARE`,
          );
          await operatorTx.execute(sql`SELECT id FROM workers WHERE id = ${PHYSICAL_WORKER} FOR SHARE`);
          await locks.acquirePlatformTargetAuthorityShared(appTx, TARGET);
          guardObserved = targetRows[0]?.device_generation === 2;
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(guardObserved).toBe(false);
      releaseCutoff();
      await cutoffFirst;
      await guardAfterCutoff;
      expect(guardObserved).toBe(true);
    }, 20_000);

    it("does not widen either serving role to tenant jobs or platform target mutation", async () => {
      const { app, operator } = connections();
      await expect(operator.db.execute(sql`SELECT id FROM jobs LIMIT 1`)).rejects.toThrow();
      const updated = await app.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('aoa.organization_id', ${ORG}, true)`);
        return tx.execute(sql`UPDATE execution_targets SET status = 'disabled' WHERE id = ${TARGET} RETURNING id`);
      });
      expect(updated).toHaveLength(0);
    });
  },
);
