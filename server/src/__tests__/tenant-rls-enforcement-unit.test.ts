// Windows-visible (cross-platform) unit coverage for the TEN-002 RLS enforcement
// building blocks. The pure SQL builders in server/src/db/rls-tenant.ts author the
// 0211 delta-free migration and are asserted here without touching Postgres; the
// forced-RLS ENFORCEMENT proof (real embedded-postgres) lives in
// tenant-rls-enforcement.integration.test.ts (E2-D05 env-hatch, Linux-CI + Windows
// via AOA_RUN_WIN_INTEGRATION=1).
//
// These assertions pin the security-critical shape of the DDL: the serving role is
// NOLOGIN NOSUPERUSER NOBYPASSRLS (non-owner, non-superuser — the DB-enforcement
// guarantee, E2-D01/E2-F004), FORCE ROW LEVEL SECURITY is emitted per table
// (defense-in-depth against a non-superuser-owner mistake), the tenant policy reads
// the shipped GUC current_setting('aoa.organization_id', true)::uuid in BOTH USING
// and WITH CHECK (E2-D02), role/table names are validated before interpolation
// (roles/identifiers cannot be query-bound), and createTenantAppDb fails CLOSED on
// a blank URL (never silently falling back to the owner pool — E2-F007). The login
// password is provisioned at runtime and NEVER interpolated into the committed
// migration string.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TENANT_APP_ROLE,
  TENANT_RLS_TABLES,
  TENANT_GUC,
  createNonOwnerRoleSql,
  grantDmlSql,
  enableForceRlsSql,
  tenantPolicySql,
  provisionTenantAppRoleLoginSql,
  buildTenantRlsMigrationSql,
  buildServingRoleCorrectionMigrationSql,
  buildServingRoleHardeningMigrationSql,
} from "../db/rls-tenant.js";
import { createTenantAppDb } from "@armyofagents/db";
import * as tenantRlsBuilders from "../db/rls-tenant.js";

describe("rls-tenant builders — constants", () => {
  it("names the non-owner serving role and the 8 new-path tables (frozen)", () => {
    expect(TENANT_APP_ROLE).toBe("aoa_app");
    expect(TENANT_GUC).toBe("aoa.organization_id");
    expect([...TENANT_RLS_TABLES]).toEqual([
      "jobs",
      "job_attempts",
      "leases",
      "workers",
      "services",
      "service_instances",
      "job_artifacts",
      "job_secret_handles",
    ]);
    // Frozen so a caller cannot silently widen the enforced surface.
    expect(Object.isFrozen(TENANT_RLS_TABLES)).toBe(true);
    expect(() => {
      // @ts-expect-error — runtime mutation must throw / be a no-op on a frozen array
      TENANT_RLS_TABLES.push("companies");
    }).toThrow();
  });
});

describe("createNonOwnerRoleSql", () => {
  it("creates a NOLOGIN NOSUPERUSER NOBYPASSRLS role behind an idempotent DO $$ guard", () => {
    const sql = createNonOwnerRoleSql(TENANT_APP_ROLE);
    expect(sql).toContain("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app')");
    expect(sql).toContain('CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;');
    expect(sql).toContain("END IF; END $$;");
    // No committed login credential (E2-D01): the migration role is NOLOGIN.
    expect(sql).not.toMatch(/LOGIN\s+PASSWORD/i);
    expect(sql).not.toContain("SUPERUSER;"); // never a bare SUPERUSER grant
    expect(sql).not.toContain("BYPASSRLS;"); // never a bare BYPASSRLS grant
  });

  it("rejects an unsafe role name before interpolation", () => {
    expect(() => createNonOwnerRoleSql("aoa_app; DROP ROLE postgres")).toThrow(/unsafe role/i);
    expect(() => createNonOwnerRoleSql('"admin"')).toThrow(/unsafe role/i);
  });
});

describe("grantDmlSql", () => {
  it("grants only SELECT/INSERT/UPDATE/DELETE on every quoted table to the role", () => {
    const sql = grantDmlSql(TENANT_APP_ROLE, TENANT_RLS_TABLES);
    expect(sql.startsWith("GRANT SELECT, INSERT, UPDATE, DELETE ON ")).toBe(true);
    for (const t of TENANT_RLS_TABLES) expect(sql).toContain(`"${t}"`);
    expect(sql).toContain('TO "aoa_app";');
    // No DDL/ownership escalation in a DML grant.
    expect(sql).not.toMatch(/\bALL\b/);
    expect(sql).not.toMatch(/\bTRUNCATE\b/);
  });

  it("rejects an unsafe role or table name", () => {
    expect(() => grantDmlSql("bad;role", TENANT_RLS_TABLES)).toThrow(/unsafe role/i);
    expect(() => grantDmlSql(TENANT_APP_ROLE, ["jobs", "jobs; DROP TABLE jobs"])).toThrow(/unsafe table/i);
  });
});

describe("enableForceRlsSql", () => {
  it("emits ENABLE then FORCE ROW LEVEL SECURITY, separated by a statement breakpoint", () => {
    const sql = enableForceRlsSql("jobs");
    expect(sql).toContain('ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain("--> statement-breakpoint");
    // ENABLE precedes FORCE.
    expect(sql.indexOf("ENABLE ROW LEVEL SECURITY")).toBeLessThan(sql.indexOf("FORCE ROW LEVEL SECURITY"));
  });

  it("rejects an unsafe table name", () => {
    expect(() => enableForceRlsSql("jobs; DROP TABLE jobs")).toThrow(/unsafe table/i);
  });
});

describe("tenantPolicySql", () => {
  it("drops-then-creates a per-table policy bound TO the role, gating reads AND writes on the tenant GUC", () => {
    const sql = tenantPolicySql("workers", TENANT_APP_ROLE);
    expect(sql).toContain('DROP POLICY IF EXISTS "workers_tenant_isolation" ON "workers";');
    expect(sql).toContain('CREATE POLICY "workers_tenant_isolation" ON "workers" TO "aoa_app"');
    const guc = "organization_id = current_setting('aoa.organization_id', true)::uuid";
    expect(sql).toContain(`USING (${guc})`);
    expect(sql).toContain(`WITH CHECK (${guc})`);
  });

  it("rejects an unsafe table or role name", () => {
    expect(() => tenantPolicySql("workers; DROP POLICY x", TENANT_APP_ROLE)).toThrow(/unsafe table/i);
    expect(() => tenantPolicySql("workers", "role; DROP")).toThrow(/unsafe role/i);
  });
});

describe("provisionTenantAppRoleLoginSql (runtime-only, never committed)", () => {
  it("builds an idempotent ALTER ROLE ... WITH LOGIN PASSWORD with the secret escaped, not interpolated raw", () => {
    const sql = provisionTenantAppRoleLoginSql(TENANT_APP_ROLE, "pa'ss");
    expect(sql).toBe(`ALTER ROLE "aoa_app" WITH LOGIN PASSWORD 'pa''ss';`);
    // A quote in the secret is doubled (no injection break-out).
    expect(sql).toContain("'pa''ss'");
  });

  it("rejects an unsafe role name", () => {
    expect(() => provisionTenantAppRoleLoginSql("x; DROP", "pw")).toThrow(/unsafe role/i);
  });
});

describe("buildTenantRlsMigrationSql (assembled 0211 body)", () => {
  const sql = buildTenantRlsMigrationSql();

  it("creates the non-owner role once and grants DML on all 8 tables", () => {
    expect(sql).toContain('CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;');
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ");
    expect((sql.match(/CREATE ROLE /g) ?? []).length).toBe(1);
  });

  it("ENABLE+FORCE ROW LEVEL SECURITY and a GUC-gated policy for EACH of the 8 tables", () => {
    for (const t of TENANT_RLS_TABLES) {
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`CREATE POLICY "${t}_tenant_isolation" ON "${t}" TO "aoa_app"`);
    }
    // FORCE emitted exactly 8 times as real ALTER statements (one per table);
    // the header comment references the phrase too, so match the statement shape.
    expect((sql.match(/ALTER TABLE "\w+" FORCE ROW LEVEL SECURITY;/g) ?? []).length).toBe(8);
  });

  it("is statement-breakpoint separated, C14-idempotent, and carries NO committed credential", () => {
    expect(sql).toContain("--> statement-breakpoint");
    expect(sql).toContain("DROP POLICY IF EXISTS");
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM pg_roles");
    // The committed migration must never contain a LOGIN password (E2-D01).
    expect(sql).not.toMatch(/LOGIN\s+PASSWORD/i);
    // No CREATE TABLE/INDEX (delta-free custom migration) so it does not trip
    // migration-idempotency.test.ts's CREATE-without-IF-NOT-EXISTS scan.
    expect(sql).not.toMatch(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)/i);
  });
});

describe("createTenantAppDb — fail-closed on a blank URL (E2-F007)", () => {
  it("throws (never falling back to the owner pool) on empty/blank/undefined URL, before any connection", () => {
    expect(() => createTenantAppDb("")).toThrow();
    expect(() => createTenantAppDb("   ")).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createTenantAppDb(undefined as any)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createTenantAppDb(null as any)).toThrow();
  });
});

describe("buildServingRoleCorrectionMigrationSql (assembled 0213 body)", () => {
  it("stays byte-aligned with the Decision #122 custom migration", () => {
    const committed = readFileSync(
      new URL("../../../packages/db/src/migrations/0213_e2_serving_role_correction.sql", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n").trim();
    expect(committed).toBe(buildServingRoleCorrectionMigrationSql().trim());
  });
});

describe("buildServingRoleHardeningMigrationSql (assembled 0214 body)", () => {
  it("stays byte-aligned with the additive Decision #122 custom migration", () => {
    const committed = readFileSync(
      new URL("../../../packages/db/src/migrations/0214_e2_serving_role_hardening.sql", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n").trim();
    expect(committed).toBe(buildServingRoleHardeningMigrationSql().trim());
  });
});

describe("buildJobControlSubmissionRlsMigrationSql (assembled 0218 body)", () => {
  it("versions JOB-001 grants without changing the applied 0213/0214 builders", () => {
    const builder = (tenantRlsBuilders as typeof tenantRlsBuilders & {
      buildJobControlSubmissionRlsMigrationSql?: () => string;
    }).buildJobControlSubmissionRlsMigrationSql;
    expect(builder).toBeTypeOf("function");
    if (!builder) return;
    const committed = readFileSync(
      new URL("../../../packages/db/src/migrations/0218_job_control_submission_rls.sql", import.meta.url),
      "utf8",
    ).replaceAll("\r\n", "\n").trim();
    expect(committed).toBe(builder().trim());
  });
});
