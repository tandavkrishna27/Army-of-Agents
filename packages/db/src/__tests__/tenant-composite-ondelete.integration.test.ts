// packages/db/src/__tests__/tenant-composite-ondelete.integration.test.ts
//
// REAL embedded-postgres proof that the ON DELETE behavior PRESERVED across the
// E2-F013 / E2-D09 fix: migration 0212 dropped the redundant single-column PARENT
// FKs (the cross-tenant existence oracle) and MOVED their `ON DELETE` onto the
// composite tenant FKs. This test proves the delete semantics survived the move:
//   • deleting a `job` CASCADE-deletes its `job_attempts` / `job_artifacts` /
//     `job_secret_handles`, and each attempt CASCADE-deletes its `leases`
//     (the composite FKs now carry ON DELETE CASCADE);
//   • deleting a `service` CASCADE-deletes its `service_instances`;
//   • deleting a `company` that still owns a `job` or a `service` is RESTRICTED
//     (raises 23503 on the composite FK, which now carries ON DELETE RESTRICT).
//
// Without the moved ON DELETE the cascade would fail (rows orphaned / FK error) or
// the restrict would silently allow the delete — so this is the regression guard for
// E2-D09's "ON DELETE preserved on the composite FKs" claim.
//
// Gate: E2-D05 env-hatch. Runs on Linux CI (process.platform !== "win32") and is
// Windows-runnable via AOA_RUN_WIN_INTEGRATION=1. `skipIf` (not the banned ternary).
// initdbFlags UTF8/C; setupError captured in beforeAll, re-thrown in the first `it`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "../client.js";

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
let client: ReturnType<typeof postgres>;
let setupError: unknown = null;
let prefixSeq = 0;

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) return reject(err);
        if (!address || typeof address === "string") return reject(new Error("no port"));
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

type PgError = { code?: string; constraint_name?: string; message?: string };
async function captureReject(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (e) {
    return e as PgError;
  }
  throw new Error("expected the DELETE to be rejected by an ON DELETE RESTRICT FK, but it succeeded");
}

async function seedOrg(slug: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO organizations (id, name, slug, status, plan)
    VALUES (gen_random_uuid(), ${slug}, ${slug}, 'active', 'beta') RETURNING id`;
  return rows[0]!.id;
}
async function seedCompany(orgId: string): Promise<string> {
  prefixSeq += 1;
  const rows = await client<{ id: string }[]>`
    INSERT INTO companies (id, organization_id, name, issue_prefix)
    VALUES (gen_random_uuid(), ${orgId}, 'Co', ${`OD${prefixSeq}`}) RETURNING id`;
  return rows[0]!.id;
}
async function seedJob(orgId: string, companyId: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO jobs (organization_id, company_id) VALUES (${orgId}, ${companyId}) RETURNING id`;
  return rows[0]!.id;
}
async function seedAttempt(orgId: string, companyId: string, jobId: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO job_attempts (organization_id, company_id, job_id) VALUES (${orgId}, ${companyId}, ${jobId}) RETURNING id`;
  return rows[0]!.id;
}
async function seedService(orgId: string, companyId: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO services (organization_id, company_id) VALUES (${orgId}, ${companyId}) RETURNING id`;
  return rows[0]!.id;
}
async function countById(table: string, id: string): Promise<number> {
  const rows = await client<{ c: number }[]>`SELECT count(*)::int AS c FROM ${client(table)} WHERE id = ${id}`;
  return Number(rows[0]!.c);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-tenant-ondelete-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocatePort();
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    // Apply the WHOLE chain incl. 0212 (drops the single-col parent FKs + moves
    // ON DELETE onto the composite FKs).
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[tenant-composite-ondelete] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (client) await client.end();
  } catch {
    /* ignore */
  }
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

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "TEN-004/E2-D09 ON DELETE preserved on the composite FKs (after the single-col FK drop)",
  () => {
    it("deleting a job CASCADE-deletes its attempts / artifacts / secret-handles, and each attempt CASCADEs its leases", async () => {
      guard();
      const org = await seedOrg("od-cascade-job");
      const company = await seedCompany(org);
      const job = await seedJob(org, company);
      const attempt = await seedAttempt(org, company, job);
      const lease = (
        await client<{ id: string }[]>`
          INSERT INTO leases (organization_id, attempt_id, fence) VALUES (${org}, ${attempt}, 'f1') RETURNING id`
      )[0]!.id;
      const artifact = (
        await client<{ id: string }[]>`
          INSERT INTO job_artifacts (organization_id, job_id, identifier) VALUES (${org}, ${job}, 'a1') RETURNING id`
      )[0]!.id;
      const handle = (
        await client<{ id: string }[]>`
          INSERT INTO job_secret_handles (organization_id, job_id, handle) VALUES (${org}, ${job}, 'h1') RETURNING id`
      )[0]!.id;

      // Sanity: everything exists.
      expect(await countById("job_attempts", attempt)).toBe(1);
      expect(await countById("leases", lease)).toBe(1);

      await client`DELETE FROM jobs WHERE id = ${job}`;

      // CASCADE: the job's children are gone, and the lease under the cascaded
      // attempt is gone (attempt → lease cascade), so the composite FKs carry the
      // ON DELETE CASCADE that used to live on the single-column FKs.
      expect(await countById("job_attempts", attempt), "attempt cascaded").toBe(0);
      expect(await countById("leases", lease), "lease cascaded via attempt").toBe(0);
      expect(await countById("job_artifacts", artifact), "artifact cascaded").toBe(0);
      expect(await countById("job_secret_handles", handle), "secret-handle cascaded").toBe(0);
    });

    it("deleting a service CASCADE-deletes its service_instances", async () => {
      guard();
      const org = await seedOrg("od-cascade-service");
      const company = await seedCompany(org);
      const service = await seedService(org, company);
      const instance = (
        await client<{ id: string }[]>`
          INSERT INTO service_instances (organization_id, company_id, service_id) VALUES (${org}, ${company}, ${service}) RETURNING id`
      )[0]!.id;
      expect(await countById("service_instances", instance)).toBe(1);

      await client`DELETE FROM services WHERE id = ${service}`;
      expect(await countById("service_instances", instance), "instance cascaded").toBe(0);
    });

    // ON DELETE RESTRICT raises SQLSTATE 23001 (restrict_violation) — checked
    // immediately — NOT 23503 (foreign_key_violation, which ON DELETE NO ACTION
    // would raise at end-of-statement). Asserting 23001 additionally confirms the
    // composite FK carries RESTRICT (not NO ACTION), and the constraint_name proves
    // the block comes from the COMPOSITE FK (the single-column FK is gone).
    it("deleting a company that still owns a job is RESTRICTED (23001 on the composite FK)", async () => {
      guard();
      const org = await seedOrg("od-restrict-job");
      const company = await seedCompany(org);
      await seedJob(org, company);
      const err = await captureReject(() => client`DELETE FROM companies WHERE id = ${company}`);
      expect(err.code).toBe("23001");
      expect(err.constraint_name).toBe("jobs_org_company_fk");
    });

    it("deleting a company that still owns a service is RESTRICTED (23001 on the composite FK)", async () => {
      guard();
      const org = await seedOrg("od-restrict-service");
      const company = await seedCompany(org);
      await seedService(org, company);
      const err = await captureReject(() => client`DELETE FROM companies WHERE id = ${company}`);
      expect(err.code).toBe("23001");
      expect(err.constraint_name).toBe("services_org_company_fk");
    });
  },
);
