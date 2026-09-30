// packages/db/src/__tests__/tenant-composite-integrity.integration.test.ts
//
// REAL embedded-postgres proof of the TEN-004 acceptance criterion: DIRECT SQL
// (bypassing every application-layer check) CANNOT construct a mixed-tenant
// relationship on the new-path kernel tables. Composite (organization_id, …)
// foreign keys — the FIRST use of drizzle `foreignKey()` in the repo — bind each
// child row to a parent that shares its Organization, so an (orgA, orgB-owned-
// parent) row is rejected by the composite FK even when the single-column FKs and
// NOT NULLs are all individually satisfiable.
//
// Every composite relationship (E2-D06) is proven with a NEGATIVE case (mixed
// tenant → rejected, asserting the intended constraint name where practical) AND a
// POSITIVE control (same tenant → succeeds), so the rejection is the constraint
// doing its job — not an unrelated failure. The leases partial-unique
// ("leases_active_per_attempt_idx": at most one live lease per attempt) is proven
// the same way: a second active lease on one attempt is rejected, while a
// released/terminal lease + a fresh active lease on the same attempt is allowed.
//
// Why real embedded-Postgres and not a schema-literal grep: only applying the
// generated migration against a real cluster proves the composite FK / partial
// unique DDL that `db:generate` emitted actually REJECTS the mixed-tenant / dup
// INSERT. A `foreignKey()` / `uniqueIndex().where()` in the .ts source without the
// emitted-and-applied migration would slip past a source assertion but fail here.
//
// RED (before the composite FKs / uniques / partial index exist): the mixed-tenant
// inserts SUCCEED and the second active lease is accepted, so every
// `captureReject` throws "expected … rejected … but it succeeded". GREEN (after
// TEN-004's schema edits + 0209 migration): each mixed-tenant insert is rejected by
// its composite constraint and the duplicate active lease is rejected by the
// partial unique index.
//
// Gate: E2-D05 env-hatch. Runs automatically on Linux CI
// (process.platform !== "win32") and is Windows-runnable in place via
// AOA_RUN_WIN_INTEGRATION=1 — no source edit-and-restore. It is a `skipIf` (not the
// banned `X ? describe : describe.skip` ternary), so it satisfies the
// integration-test-hygiene meta-test. Boot uses initdbFlags UTF8/C so the cluster
// locale is safe; setupError is captured in beforeAll and re-thrown in the first
// `it` (fail closed).
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

// Seeded once (beforeAll): two real Organizations + one real Company in each.
let orgA = "";
let orgB = "";
let companyA = ""; // owned by orgA
let companyB = ""; // owned by orgB

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) return reject(err);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to allocate test port"));
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

// A minimal PostgresError-ish shape (postgres-js surfaces `code` + `constraint_name`).
type PgError = { code?: string; constraint_name?: string; message?: string };

// Runs a statement expected to be REJECTED by a DB constraint and returns the
// error. If the statement SUCCEEDS (the RED state, or a regression), this throws —
// which is exactly the failing signal we want (no silent pass on a bypassed check).
async function captureReject(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (e) {
    return e as PgError;
  }
  throw new Error(
    "expected the direct-SQL statement to be rejected by a DB constraint, but it succeeded",
  );
}

async function seedOrg(slug: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO organizations (id, name, slug, status, plan)
    VALUES (gen_random_uuid(), ${slug}, ${slug}, 'active', 'beta')
    RETURNING id`;
  return rows[0]!.id;
}

async function seedCompany(orgId: string, name: string, prefix: string): Promise<string> {
  // issue_prefix carries a GLOBAL unique index (companies_issue_prefix_idx) — each
  // seeded company must use a distinct prefix or the seed itself would 23505.
  const rows = await client<{ id: string }[]>`
    INSERT INTO companies (id, organization_id, name, issue_prefix)
    VALUES (gen_random_uuid(), ${orgId}, ${name}, ${prefix})
    RETURNING id`;
  return rows[0]!.id;
}

async function seedJob(orgId: string, companyId: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO jobs (organization_id, company_id) VALUES (${orgId}, ${companyId})
    RETURNING id`;
  return rows[0]!.id;
}

async function seedAttempt(orgId: string, companyId: string, jobId: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO job_attempts (organization_id, company_id, job_id) VALUES (${orgId}, ${companyId}, ${jobId})
    RETURNING id`;
  return rows[0]!.id;
}

async function seedService(orgId: string, companyId: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO services (organization_id, company_id) VALUES (${orgId}, ${companyId})
    RETURNING id`;
  return rows[0]!.id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-tenant-composite-integ-"));
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
      // Force UTF-8 so migration SQL with non-Latin1 chars applies; without this
      // initdb inherits the host locale (WIN1252 on Windows) and rejects them.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    // Apply the WHOLE chain (0000..latest) — including the TEN-004 migration that
    // adds the composite FKs / FK-target uniques / leases partial-unique.
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });

    // Two tenants + a company in each (real rows).
    orgA = await seedOrg("tenant-a");
    orgB = await seedOrg("tenant-b");
    companyA = await seedCompany(orgA, "Company A", "CMA");
    companyB = await seedCompany(orgB, "Company B", "CMB");
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[tenant-composite-integrity] embedded-postgres setup failed:", err);
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
  "TEN-004 composite tenant integrity (direct-SQL mixed-tenant rejection)",
  () => {
    it("seeds two organizations and a company in each", () => {
      guard();
      expect(orgA).not.toBe("");
      expect(orgB).not.toBe("");
      expect(companyA).not.toBe("");
      expect(companyB).not.toBe("");
      expect(orgA).not.toBe(orgB);
    });

    // 1. jobs ↔ company ↔ org: (organization_id, company_id) → companies(organization_id, id)
    it("rejects a job whose org (A) does not own its company (B); allows same-tenant", async () => {
      guard();
      const err = await captureReject(() =>
        client`INSERT INTO jobs (organization_id, company_id) VALUES (${orgA}, ${companyB})`,
      );
      expect(err.code).toBe("23503"); // foreign_key_violation
      expect(err.constraint_name).toBe("jobs_org_company_fk");

      // Positive control: org A + A's company inserts cleanly.
      const jobId = await seedJob(orgA, companyA);
      expect(jobId).not.toBe("");
    });

    // 2. job_attempts ↔ job: (organization_id, job_id) → jobs(organization_id, id)
    it("rejects a job_attempt whose org (B) does not match its job's org (A); allows same-tenant", async () => {
      guard();
      const jobId = await seedJob(orgA, companyA);
      const err = await captureReject(() =>
        client`INSERT INTO job_attempts (organization_id, company_id, job_id) VALUES (${orgB}, ${companyA}, ${jobId})`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("job_attempts_org_job_fk");

      const attemptId = await seedAttempt(orgA, companyA, jobId);
      expect(attemptId).not.toBe("");
    });

    // 3. leases ↔ attempt: (organization_id, attempt_id) → job_attempts(organization_id, id)
    it("rejects a lease whose org (B) does not match its attempt's org (A); allows same-tenant", async () => {
      guard();
      const jobId = await seedJob(orgA, companyA);
      const attemptId = await seedAttempt(orgA, companyA, jobId);
      const err = await captureReject(() =>
        client`INSERT INTO leases (organization_id, attempt_id, fence) VALUES (${orgB}, ${attemptId}, 'fence-x')`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("leases_org_attempt_fk");

      const ok = await client<{ id: string }[]>`
        INSERT INTO leases (organization_id, attempt_id, fence) VALUES (${orgA}, ${attemptId}, 'fence-ok')
        RETURNING id`;
      expect(ok[0]!.id).not.toBe("");
    });

    // 4. services ↔ company ↔ org: (organization_id, company_id) → companies(organization_id, id)
    it("rejects a service whose org (A) does not own its company (B); allows same-tenant", async () => {
      guard();
      const err = await captureReject(() =>
        client`INSERT INTO services (organization_id, company_id) VALUES (${orgA}, ${companyB})`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("services_org_company_fk");

      const serviceId = await seedService(orgA, companyA);
      expect(serviceId).not.toBe("");
    });

    // 5. service_instances ↔ service: SVC-002 widened this from the (organization_id,
    //    service_id) PAIR to the (organization_id, company_id, service_id) TRIPLE, targeting
    //    services(organization_id, company_id, id). The pair could not tie an instance's
    //    company to its SERVICE's company, so an instance could carry company B while its
    //    service belonged to company A inside one org with every constraint satisfied —
    //    E2-F013's shape, and the denormalized company_id is the only company predicate any
    //    later reader has. Both mismatch arms are asserted, org and company.
    it("rejects a service_instance whose org (B) or company (B) does not match its service's; allows same-tenant", async () => {
      guard();
      const serviceId = await seedService(orgA, companyA);
      const orgMismatch = await captureReject(() =>
        client`INSERT INTO service_instances (organization_id, company_id, service_id)
          VALUES (${orgB}, ${companyA}, ${serviceId})`,
      );
      expect(orgMismatch.code).toBe("23503");
      expect(orgMismatch.constraint_name).toBe("service_instances_org_company_service_fk");

      // The arm the PAIR could not express: right org, right service, WRONG company.
      const companyMismatch = await captureReject(() =>
        client`INSERT INTO service_instances (organization_id, company_id, service_id)
          VALUES (${orgA}, ${companyB}, ${serviceId})`,
      );
      expect(companyMismatch.code).toBe("23503");
      expect(companyMismatch.constraint_name).toBe("service_instances_org_company_service_fk");

      const ok = await client<{ id: string }[]>`
        INSERT INTO service_instances (organization_id, company_id, service_id)
        VALUES (${orgA}, ${companyA}, ${serviceId})
        RETURNING id`;
      expect(ok[0]!.id).not.toBe("");
    });

    // 6. job_artifacts ↔ job: (organization_id, job_id) → jobs(organization_id, id)
    it("rejects a job_artifact whose org (B) does not match its job's org (A); allows same-tenant", async () => {
      guard();
      const jobId = await seedJob(orgA, companyA);
      const err = await captureReject(() =>
        client`INSERT INTO job_artifacts (organization_id, job_id, identifier) VALUES (${orgB}, ${jobId}, 'artifact-x')`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("job_artifacts_org_job_fk");

      const ok = await client<{ id: string }[]>`
        INSERT INTO job_artifacts (organization_id, job_id, identifier) VALUES (${orgA}, ${jobId}, 'artifact-ok')
        RETURNING id`;
      expect(ok[0]!.id).not.toBe("");
    });

    // 7. job_secret_handles ↔ job: (organization_id, job_id) → jobs(organization_id, id)
    it("rejects a job_secret_handle whose org (B) does not match its job's org (A); allows same-tenant", async () => {
      guard();
      const jobId = await seedJob(orgA, companyA);
      const err = await captureReject(() =>
        client`INSERT INTO job_secret_handles (organization_id, job_id, handle) VALUES (${orgB}, ${jobId}, 'handle-x')`,
      );
      expect(err.code).toBe("23503");
      expect(err.constraint_name).toBe("job_secret_handles_org_job_fk");

      const ok = await client<{ id: string }[]>`
        INSERT INTO job_secret_handles (organization_id, job_id, handle) VALUES (${orgA}, ${jobId}, 'handle-ok')
        RETURNING id`;
      expect(ok[0]!.id).not.toBe("");
    });

    // 8. leases partial-unique: at most one LIVE (offered|active) lease per attempt.
    it("rejects a second active lease on one attempt (partial unique); allows a fresh active lease after a released one", async () => {
      guard();

      // (a) two active leases on the same attempt → second rejected by the index.
      const jobId1 = await seedJob(orgA, companyA);
      const attempt1 = await seedAttempt(orgA, companyA, jobId1);
      await client`INSERT INTO leases (organization_id, attempt_id, status, fence, activated_at) VALUES (${orgA}, ${attempt1}, 'active', 'live-1', now())`;
      const dupErr = await captureReject(() =>
        client`INSERT INTO leases (organization_id, attempt_id, status, fence, activated_at) VALUES (${orgA}, ${attempt1}, 'active', 'live-2', now())`,
      );
      expect(dupErr.code).toBe("23505"); // unique_violation
      expect(dupErr.constraint_name).toBe("leases_active_per_attempt_idx");

      // (b) a released/terminal lease does NOT occupy the partial index, so a fresh
      // active lease on the SAME attempt is allowed.
      const jobId2 = await seedJob(orgA, companyA);
      const attempt2 = await seedAttempt(orgA, companyA, jobId2);
      await client`INSERT INTO leases (organization_id, attempt_id, status, released_at, fence) VALUES (${orgA}, ${attempt2}, 'released', now(), 'done-1')`;
      const ok = await client<{ id: string }[]>`
        INSERT INTO leases (organization_id, attempt_id, status, fence, activated_at) VALUES (${orgA}, ${attempt2}, 'active', 'fresh-active', now())
        RETURNING id`;
      expect(ok[0]!.id).not.toBe("");
    });
  },
);
