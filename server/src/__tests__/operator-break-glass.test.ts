// Windows-visible UNIT test for the operator break-glass service (Phase 3, B3).
//
// The heavyweight real-Postgres proof lives in
// operator-break-glass.integration.test.ts (Linux-only). This unit test runs
// everywhere and exercises the SERVICE logic against an in-memory fake DB:
//   - grant() materializes an ORGANIZATION membership (with a valid org role);
//   - hasActiveBreakGlass() is live-TTL (true, then false once expires_at passes);
//   - an org-wide grant (companyId null) matches ANY company;
//   - sweepExpired() removes the materialized membership + marks the grant swept;
//   - revoke() matches org-wide grants and never writes an empty organizationId.
//
// drizzle-orm operators are mocked into plain descriptors so the fake DB can
// interpret the service's real WHERE clauses (the same eq/gt/isNull the service
// builds), rather than opaque SQL objects.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...clauses: unknown[]) => ({ op: "and", clauses }),
  or: (...clauses: unknown[]) => ({ op: "or", clauses }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
}));

// Table stubs — each column access yields its JS field-name string, so
// eq(operatorBreakGlassGrants.operatorUserId, "op") => { op:"eq", col:"operatorUserId", val:"op" }.
vi.mock("@armyofagents/db", () => {
  const table = new Proxy(
    {},
    {
      get(_t, prop) {
        return typeof prop === "string" ? prop : undefined;
      },
    },
  );
  return {
    operatorBreakGlassGrants: table,
    organizationMemberships: table,
    activityLog: table,
  };
});

import {
  hasActiveBreakGlass,
  operatorBreakGlassService,
  type BreakGlassDeps,
} from "../services/operator-break-glass.js";

type Clause = any;

function evalClause(row: Record<string, unknown>, clause: Clause): boolean {
  switch (clause.op) {
    case "and":
      return clause.clauses.every((c: Clause) => evalClause(row, c));
    case "or":
      return clause.clauses.some((c: Clause) => evalClause(row, c));
    case "eq":
      return row[clause.col] === clause.val;
    case "gt":
      return row[clause.col] != null && (row[clause.col] as any) > clause.val;
    case "lte":
      return row[clause.col] != null && (row[clause.col] as any) <= clause.val;
    case "isNull":
      return row[clause.col] == null;
    case "isNotNull":
      return row[clause.col] != null;
    default:
      return true;
  }
}

// In-memory fake DB backing the operator_break_glass_grants table. Interprets the
// mocked WHERE descriptors so TTL/revoke filtering behaves like real SQL.
function makeFakeDb() {
  const grants: Record<string, unknown>[] = [];
  const db: any = {
    _grants: grants,
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          const row: Record<string, unknown> = {
            id: `g-${grants.length + 1}`,
            companyId: null,
            role: "founder",
            revokedAt: null,
            sweptAt: null,
            createdAt: new Date(),
            ...v,
          };
          grants.push(row);
          return [row];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (clause: Clause) => Promise.resolve(grants.filter((r) => evalClause(r, clause))),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (clause: Clause) => {
          for (const r of grants) if (evalClause(r, clause)) Object.assign(r, patch);
          return Promise.resolve();
        },
      }),
    }),
  };
  return db;
}

// Deps that track calls + keep an in-memory org-membership set so we can assert
// materialization and sweep cleanup.
function makeDeps() {
  const orgMembers = new Set<string>(); // `${organizationId}:${userId}`
  const audits: { action: string; organizationId: string; companyId: string | null }[] = [];
  const materialize = vi.fn(async (a: { organizationId: string; userId: string; role: string }) => {
    orgMembers.add(`${a.organizationId}:${a.userId}`);
  });
  const revoke = vi.fn(async (a: { organizationId: string; userId: string }) => {
    orgMembers.delete(`${a.organizationId}:${a.userId}`);
  });
  const audit = vi.fn(async (e: { action: string; organizationId: string; companyId: string | null }) => {
    audits.push({ action: e.action, organizationId: e.organizationId, companyId: e.companyId });
  });
  const deps: BreakGlassDeps = { materializeMembership: materialize, revokeMembership: revoke, audit };
  return { deps, orgMembers, audits, materialize, revoke, audit };
}

const ORG = "org-1";
const CO = "co-1";

describe("operator break-glass service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("grant() materializes an ORGANIZATION membership with a valid org role", async () => {
    const db = makeFakeDb();
    const { deps, orgMembers, materialize } = makeDeps();
    const svc = operatorBreakGlassService(db, deps);

    await svc.grant({
      operatorUserId: "op",
      organizationId: ORG,
      companyId: CO,
      role: "founder", // company role stored on the grant
      reason: "SEV-1",
      grantedByUserId: "op",
      ttlMinutes: 60,
    });

    // The org membership was materialized (this is the eng-review MUST).
    expect(orgMembers.has(`${ORG}:op`)).toBe(true);
    // The materialized ORG role must be a valid org role (owner|admin|member|billing),
    // NOT the grant's company role "founder".
    expect(materialize).toHaveBeenCalledTimes(1);
    const arg = materialize.mock.calls[0][0];
    expect(arg.organizationId).toBe(ORG);
    expect(arg.userId).toBe("op");
    expect(["owner", "admin", "member", "billing"]).toContain(arg.role);
    // The grant record kept the company role.
    expect(db._grants[0].role).toBe("founder");
  });

  it("hasActiveBreakGlass() is live-TTL: true, then false once expires_at passes", async () => {
    const db = makeFakeDb();
    const { deps } = makeDeps();
    const svc = operatorBreakGlassService(db, deps);

    await svc.grant({
      operatorUserId: "op",
      organizationId: ORG,
      companyId: CO,
      role: "founder",
      reason: "SEV-1",
      grantedByUserId: "op",
      ttlMinutes: 60,
    });

    expect(await hasActiveBreakGlass(db, "op", CO, ORG)).toBe(true);

    // Move expiry into the past — the live TTL (gt(expires_at, now())) must now deny,
    // BEFORE any sweep runs.
    db._grants[0].expiresAt = new Date(Date.now() - 60_000);
    expect(await hasActiveBreakGlass(db, "op", CO, ORG)).toBe(false);
  });

  it("hasActiveBreakGlass() denies a revoked grant and a different company", async () => {
    const db = makeFakeDb();
    const { deps } = makeDeps();
    const svc = operatorBreakGlassService(db, deps);

    await svc.grant({
      operatorUserId: "op",
      organizationId: ORG,
      companyId: CO, // company-scoped grant
      role: "founder",
      reason: "x",
      grantedByUserId: "op",
      ttlMinutes: 60,
    });

    // Same company => allowed; a different company => denied (company-scoped).
    expect(await hasActiveBreakGlass(db, "op", CO, ORG)).toBe(true);
    expect(await hasActiveBreakGlass(db, "op", "co-other", ORG)).toBe(false);

    db._grants[0].revokedAt = new Date();
    expect(await hasActiveBreakGlass(db, "op", CO, ORG)).toBe(false);
  });

  it("org-wide grant (companyId null) matches any company IN ITS ORG — never another org", async () => {
    const db = makeFakeDb();
    const { deps } = makeDeps();
    const svc = operatorBreakGlassService(db, deps);

    await svc.grant({
      operatorUserId: "op2",
      organizationId: ORG, // org A
      companyId: null, // org-wide within org A
      role: "founder",
      reason: "x",
      grantedByUserId: "op2",
      ttlMinutes: 60,
    });

    // Any company whose owning org is ORG (org A) is authorized...
    expect(await hasActiveBreakGlass(db, "op2", CO, ORG)).toBe(true);
    expect(await hasActiveBreakGlass(db, "op2", "any-company-in-org-a", ORG)).toBe(true);
    // ...but a company in a DIFFERENT org must NOT be (Finding #1: a NULL-company
    // grant for org A used to authorize every company in every org).
    expect(await hasActiveBreakGlass(db, "op2", "co-in-org-b", "org-b")).toBe(false);
  });

  it("sweepExpired() removes the materialized membership and marks the grant swept", async () => {
    const db = makeFakeDb();
    const { deps, orgMembers, revoke } = makeDeps();
    const svc = operatorBreakGlassService(db, deps);

    await svc.grant({
      operatorUserId: "op",
      organizationId: ORG,
      companyId: CO,
      role: "founder",
      reason: "SEV-1",
      grantedByUserId: "op",
      ttlMinutes: 60,
    });
    expect(orgMembers.has(`${ORG}:op`)).toBe(true);

    // Not yet expired => nothing to sweep.
    expect(await svc.sweepExpired()).toBe(0);

    // Expire it, then sweep.
    db._grants[0].expiresAt = new Date(Date.now() - 60_000);
    const swept = await svc.sweepExpired();
    expect(swept).toBe(1);
    expect(revoke).toHaveBeenCalledWith({ organizationId: ORG, userId: "op" });
    expect(orgMembers.has(`${ORG}:op`)).toBe(false);
    expect(db._grants[0].sweptAt).toBeInstanceOf(Date);

    // Idempotent: an already-swept grant is not re-processed.
    expect(await svc.sweepExpired()).toBe(0);
  });

  it("revoke() matches an org-wide grant and never writes an empty organizationId", async () => {
    const db = makeFakeDb();
    const { deps, revoke, audits } = makeDeps();
    const svc = operatorBreakGlassService(db, deps);

    await svc.grant({
      operatorUserId: "op2",
      organizationId: ORG,
      companyId: null, // org-wide — must be matched by revoke (no companyId in filter)
      role: "founder",
      reason: "x",
      grantedByUserId: "op2",
      ttlMinutes: 60,
    });
    expect(await hasActiveBreakGlass(db, "op2", CO, ORG)).toBe(true);

    await svc.revoke("op2", ORG);

    // The org-wide grant is now revoked (revokedAt set) => denied.
    expect(await hasActiveBreakGlass(db, "op2", CO, ORG)).toBe(false);
    // revokeMembership called with the real org id (not "").
    expect(revoke).toHaveBeenCalledWith({ organizationId: ORG, userId: "op2" });
    // No audit row carries an empty organizationId.
    for (const a of audits) expect(a.organizationId).not.toBe("");
    expect(audits.some((a) => a.action === "operator.break_glass.revoked" && a.organizationId === ORG)).toBe(true);
  });
});
