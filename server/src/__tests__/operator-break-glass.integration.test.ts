// Real-Postgres integration test for the operator break-glass service (Phase 3, B3).
//
// Boots embedded-postgres, applies all migrations (incl. 0189), and proves the
// end-to-end tenant behavior against real SQL:
//   - grant() materializes a real organization_membership (so the operator would
//     pass assertTenantMembership on re-derive);
//   - hasActiveBreakGlass() is authoritative via the live TTL (true, then false
//     once expires_at is in the past — BEFORE any sweep);
//   - sweepExpired() deletes the materialized membership;
//   - revoke() matches an org-wide grant (company_id NULL) and denies afterwards.
//
// Linux-only (skipIf): Windows has a known embedded-postgres initdb encoding
// issue and macOS runners flake on embedded-pg setup/teardown. The Windows-visible
// unit coverage is in operator-break-glass.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { operatorBreakGlassService, hasActiveBreakGlass, realBreakGlassDeps } from "../services/operator-break-glass.js";

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

const ORG = "00000000-0000-0000-0000-0000000000a1";
const CO = "00000000-0000-0000-0000-0000000000c1";
const ORG_B = "00000000-0000-0000-0000-0000000000a2";
const CO_B = "00000000-0000-0000-0000-0000000000c2";
const PORT = 55000 + Math.floor(Math.random() * 1000);

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

function count(res: unknown): number {
  const row = Array.isArray(res) ? (res[0] as any) : (res as any).rows[0];
  return Number(row.c);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-bg-"));
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
    const url = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
    // organization_memberships.user_id FKs to "user"; seed the operators.
    await db.execute(
      sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('op', 'Op', 'op@x.invalid', now(), now()), ('op2', 'Op2', 'op2@x.invalid', now(), now())`,
    );
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org A', 'org-a')`);
    await db.execute(
      sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO}, 'Co A', 'PPA', ${ORG})`,
    );
  } catch (e) {
    setupError = e;
    // eslint-disable-next-line no-console
    console.error("[operator-break-glass] embedded-postgres setup failed:", e);
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

// Real deps against organization_memberships. `role` is the org-membership role
// the service passes (a valid org role), NOT the grant's company role.
const deps = () => ({
  materializeMembership: async ({ organizationId, userId, role }: any) => {
    await db.execute(
      sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${organizationId}, ${userId}, ${role}, 'active') ON CONFLICT (organization_id, user_id) DO NOTHING`,
    );
  },
  revokeMembership: async ({ organizationId, userId }: any) => {
    await db.execute(
      sql`DELETE FROM organization_memberships WHERE organization_id = ${organizationId} AND user_id = ${userId}`,
    );
  },
  audit: async () => {},
});

describe.skipIf(process.platform !== "linux")("operator break-glass (real DB)", () => {
  it("grant materializes org membership AND is live-checkable; expiry denies; sweeper cleans", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = operatorBreakGlassService(db, deps());

    await svc.grant({
      operatorUserId: "op",
      organizationId: ORG,
      companyId: CO,
      role: "founder",
      reason: "SEV-1",
      grantedByUserId: "op",
      ttlMinutes: 60,
    });

    const mem = await db.execute(
      sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op'`,
    );
    expect(count(mem)).toBe(1); // operator now passes assertTenantMembership on re-derive

    expect(await hasActiveBreakGlass(db, "op", CO, ORG)).toBe(true);

    await db.execute(
      sql`UPDATE operator_break_glass_grants SET expires_at = now() - interval '1 minute' WHERE operator_user_id = 'op'`,
    );
    expect(await hasActiveBreakGlass(db, "op", CO, ORG)).toBe(false); // TTL authoritative BEFORE any sweep

    const swept = await svc.sweepExpired();
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await db.execute(
      sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op'`,
    );
    expect(count(after)).toBe(0);
  }, 90_000);

  it("revoke removes an org-wide grant (companyId null) and its membership", async () => {
    if (setupError) throw new Error(String(setupError));
    const svc = operatorBreakGlassService(db, deps());
    await svc.grant({
      operatorUserId: "op2",
      organizationId: ORG,
      companyId: null,
      role: "founder",
      reason: "x",
      grantedByUserId: "op2",
      ttlMinutes: 60,
    });
    expect(await hasActiveBreakGlass(db, "op2", CO, ORG)).toBe(true); // null companyId => org-wide
    await svc.revoke("op2", ORG);
    expect(await hasActiveBreakGlass(db, "op2", CO, ORG)).toBe(false);
  }, 90_000);

  it("an org-wide grant for org A does NOT authorize a company in org B (Finding #1, real DB)", async () => {
    if (setupError) throw new Error(String(setupError));
    await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('opX','OpX','opx@x.invalid',now(),now()) ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO organizations (id, name, slug) VALUES (${ORG_B}, 'Org B', 'org-b') ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix, organization_id) VALUES (${CO_B}, 'Co B', 'PPB', ${ORG_B}) ON CONFLICT DO NOTHING`);
    const svc = operatorBreakGlassService(db, deps());
    await svc.grant({ operatorUserId: "opX", organizationId: ORG, companyId: null, role: "founder", reason: "x", grantedByUserId: "opX", ttlMinutes: 60 });
    expect(await hasActiveBreakGlass(db, "opX", CO, ORG)).toBe(true); // company in org A
    expect(await hasActiveBreakGlass(db, "opX", CO_B, ORG_B)).toBe(false); // company in org B — denied
  }, 90_000);

  it("a PRE-EXISTING org membership survives break-glass revoke (Finding #2)", async () => {
    if (setupError) throw new Error(String(setupError));
    await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('op3','Op3','op3@x.invalid',now(),now()) ON CONFLICT DO NOTHING`);
    // Real standing owner membership — created_by_break_glass defaults false.
    await db.execute(sql`INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES (${ORG}, 'op3', 'owner', 'active') ON CONFLICT (organization_id, user_id) DO NOTHING`);
    const svc = operatorBreakGlassService(db, realBreakGlassDeps(db)); // exercise the REAL deps
    await svc.grant({ operatorUserId: "op3", organizationId: ORG, companyId: null, role: "founder", reason: "SEV-1", grantedByUserId: "op3", ttlMinutes: 60 });
    await svc.revoke("op3", ORG);
    const rows = await db.execute(sql`SELECT role FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op3'`);
    const arr = Array.isArray(rows) ? rows : (rows as any).rows;
    expect(arr.length).toBe(1); // pre-existing membership REMAINS
    expect(arr[0].role).toBe("owner"); // and is untouched
  }, 90_000);

  it("two overlapping grants: the first to expire keeps the shared row; the second removes it (Finding #2)", async () => {
    if (setupError) throw new Error(String(setupError));
    await db.execute(sql`INSERT INTO "user" (id, name, email, created_at, updated_at) VALUES ('op4','Op4','op4@x.invalid',now(),now()) ON CONFLICT DO NOTHING`);
    const svc = operatorBreakGlassService(db, realBreakGlassDeps(db));
    const g1 = await svc.grant({ operatorUserId: "op4", organizationId: ORG, companyId: null, role: "founder", reason: "a", grantedByUserId: "op4", ttlMinutes: 60 });
    await svc.grant({ operatorUserId: "op4", organizationId: ORG, companyId: null, role: "founder", reason: "b", grantedByUserId: "op4", ttlMinutes: 60 });
    // Expire ONLY grant #1, then sweep — grant #2 still active.
    await db.execute(sql`UPDATE operator_break_glass_grants SET expires_at = now() - interval '1 minute' WHERE id = ${(g1 as any).id}`);
    await svc.sweepExpired();
    let rows = await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op4'`);
    expect(count(rows)).toBe(1); // shared row survives while a grant is still active
    // Expire the rest, sweep again — now nobody needs the row.
    await db.execute(sql`UPDATE operator_break_glass_grants SET expires_at = now() - interval '1 minute' WHERE operator_user_id = 'op4'`);
    await svc.sweepExpired();
    rows = await db.execute(sql`SELECT count(*)::int AS c FROM organization_memberships WHERE organization_id = ${ORG} AND user_id = 'op4'`);
    expect(count(rows)).toBe(0); // reclaimed once no active grant remains
  }, 90_000);
});
