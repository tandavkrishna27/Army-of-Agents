import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import postgres, { type Sql } from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { applyPendingMigrations, type Db } from "../client.js";
import * as schema from "../schema/index.js";
import { createJobControlRepository } from "../repositories/tenant/job-control.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const ORGANIZATION_ID = "d3300000-0000-4000-8000-000000000001";
const TARGET_ID = "d3300000-0000-4000-8000-000000000002";
const WORKER_ID = "d3300000-0000-4000-8000-000000000003";
const AUTHORITY_KEY = `organization:${ORGANIZATION_ID}`;
const HASH = "3".repeat(64);

let embedded: EmbeddedPostgresInstance | null = null;
let dataDirectory = "";
let databaseUrl = "";
let admin: Sql | null = null;
let pollClient: Sql | null = null;
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

function database(): Sql {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
  if (!admin) throw new Error("database was not initialized");
  return admin;
}

async function waitUntil(label: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  try {
    dataDirectory = await mkdtemp(join(tmpdir(), "aoa-job-lock-order-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocatePort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(dataDirectory, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    databaseUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(databaseUrl);
    admin = postgres(databaseUrl, { max: 4 });
    pollClient = postgres(databaseUrl, { max: 1 });
    await admin`INSERT INTO organizations (id, name, slug)
      VALUES (${ORGANIZATION_ID}, 'JOB-003 lock-order org', 'job-003-lock-order')`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, slug, kind, trust_class, status, capabilities, config, scope,
       target_authority_key, device_generation, registered_profile, registered_profile_hash,
       provider_constraint_profile, last_seen_at)
      VALUES (${TARGET_ID}, ${ORGANIZATION_ID}, 'job-003-lock-order-target', 'dedicated_worker',
        'dedicated_tenant', 'active', '{}', '{}', 'organization', ${AUTHORITY_KEY}, 1,
        ${JSON.stringify({ profile: "registered" })}::jsonb, ${HASH},
        ${JSON.stringify({ profile: "provider" })}::jsonb, clock_timestamp())`;
    await admin`INSERT INTO workers
      (id, scope, organization_id, execution_target_id, target_authority_key, device_public_key,
       device_thumbprint, device_generation, profile_hash, profile_snapshot, enrolled_at,
       last_seen_at, label, status)
      VALUES (${WORKER_ID}, 'organization', ${ORGANIZATION_ID}, ${TARGET_ID}, ${AUTHORITY_KEY},
        'job-003-lock-order-key', ${HASH}, 1, ${HASH},
        ${JSON.stringify({ profile: "worker" })}::jsonb,
        clock_timestamp(), clock_timestamp(), 'JOB-003 lock-order worker', 'enrolled')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await pollClient?.end().catch(() => {});
  await admin?.end().catch(() => {});
  await embedded?.stop().catch(() => {});
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
}, 60_000);

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-003 non-platform lease lock order",
  () => {
    it("locks target before worker so overlapping poll and revoke settle without a deadlock or post-cutoff effect", async () => {
      // Mutation caught: taking the worker lock (or touching worker liveness) before the target
      // closes a target->worker / worker->target cycle with revoke.
      const sql = database();
      await sql`UPDATE execution_targets SET status = 'active' WHERE id = ${TARGET_ID}`;
      await sql`UPDATE workers SET status = 'enrolled', revoked_at = NULL WHERE id = ${WORKER_ID}`;

      let releaseRevokeWorker!: () => void;
      const revokeMayContinue = new Promise<void>((resolve) => { releaseRevokeWorker = resolve; });
      let targetLocked!: () => void;
      const targetLockHeld = new Promise<void>((resolve) => { targetLocked = resolve; });
      let pollBackendPid = 0;

      const revoke = sql.begin(async (transaction) => {
        const query = transaction as unknown as Sql;
        await query.unsafe("SET LOCAL deadlock_timeout = '100ms'");
        await query.unsafe("SET LOCAL lock_timeout = '750ms'");
        await query`SELECT id FROM execution_targets WHERE id = ${TARGET_ID} FOR UPDATE`;
        targetLocked();
        await revokeMayContinue;
        await query`SELECT id FROM workers
          WHERE organization_id = ${ORGANIZATION_ID} AND id = ${WORKER_ID}
            AND execution_target_id = ${TARGET_ID} AND target_authority_key = ${AUTHORITY_KEY}
          FOR UPDATE`;
        await query`UPDATE execution_targets SET status = 'disabled', updated_at = clock_timestamp()
          WHERE id = ${TARGET_ID}`;
        return "revoked" as const;
      });

      await targetLockHeld;
      if (!pollClient) throw new Error("poll database was not initialized");
      const pollDb = drizzlePg(pollClient, { schema });
      const poll = pollDb.transaction(async (transaction) => {
        await transaction.execute(drizzleSql.raw("SET LOCAL deadlock_timeout = '100ms'"));
        await transaction.execute(drizzleSql.raw("SET LOCAL lock_timeout = '750ms'"));
        const [pid] = await transaction.execute<{ pid: number }>(
          drizzleSql`SELECT pg_backend_pid()::int AS pid`,
        );
        pollBackendPid = Number(pid?.pid ?? 0);
        const repository = createJobControlRepository(
          transaction as unknown as Db,
        );
        const lockAuthority = repository.lockWorkerLeaseAuthority as unknown as (input: {
          organizationId: string;
          workerId: string;
          targetId: string;
          targetAuthorityKey: string;
        }) => Promise<unknown>;
        return lockAuthority({
          organizationId: ORGANIZATION_ID,
          workerId: WORKER_ID,
          targetId: TARGET_ID,
          targetAuthorityKey: AUTHORITY_KEY,
        });
      });

      let observationError: unknown;
      try {
        await waitUntil("poll to wait on the target cutoff", async () => {
          if (!pollBackendPid) return false;
          const [row] = await sql<{ waiting: boolean }[]>`
            SELECT wait_event_type = 'Lock' AS waiting
            FROM pg_stat_activity WHERE pid = ${pollBackendPid}`;
          return row?.waiting === true;
        });
      } catch (error) {
        observationError = error;
      }
      const settledStartedAt = performance.now();
      releaseRevokeWorker();
      const settled = await Promise.allSettled([revoke, poll]);
      const elapsedMs = performance.now() - settledStartedAt;
      if (observationError) throw observationError;

      const failures = settled
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => {
          const reason = result.reason as {
            code?: string;
            message?: string;
            cause?: { code?: string; message?: string };
          };
          return {
            code: reason.code ?? reason.cause?.code,
            message: reason.message ?? reason.cause?.message,
          };
        });
      expect(failures.map((failure) => failure.code)).not.toContain("40P01");
      expect(failures).toEqual([]);
      expect(elapsedMs).toBeLessThan(750);
      expect(settled[0]).toEqual({ status: "fulfilled", value: "revoked" });
      // lockWorkerLeaseAuthority is a lock+fetch primitive. Using the SAME
      // target->worker lock order as revoke, the poll serializes safely behind the
      // revoke (no deadlock — asserted above) and, once revoke commits, acquires the
      // target row and observes its committed post-cutoff state. It returns the locked
      // authority (NOT null — the rows still exist), with the target now disabled and
      // the worker untouched. The revocation CUTOFF that refuses a lease/liveness on a
      // disabled target is enforced one layer up by authorityCurrent/ackAuthorityCurrent
      // (server/src/services/job-leasing.ts: target.status==='active' &&
      // worker.revokedAt===null, else JobLeasingError('target_revoked')); demanding null
      // from the primitive here would wrongly push that service-layer cutoff into the
      // lock step. The "no post-cutoff EFFECT" guarantee is proven by the unchanged final
      // state below (the poll leaves the target disabled and the worker enrolled).
      expect(settled[1].status).toBe("fulfilled");
      const polledAuthority = (settled[1] as PromiseFulfilledResult<
        { target: { status: string }; worker: { status: string } } | null
      >).value;
      expect(polledAuthority, "poll must acquire the locked authority, not lose the rows").not.toBeNull();
      expect(polledAuthority?.target.status).toBe("disabled");
      expect(polledAuthority?.worker.status).toBe("enrolled");

      const [state] = await sql<{ targetStatus: string; workerStatus: string }[]>`
        SELECT target.status AS "targetStatus", worker.status AS "workerStatus"
        FROM execution_targets target JOIN workers worker ON worker.execution_target_id = target.id
        WHERE target.id = ${TARGET_ID} AND worker.id = ${WORKER_ID}`;
      expect(state).toEqual({ targetStatus: "disabled", workerStatus: "enrolled" });
    }, 30_000);
  },
);
