// Windows-visible UNIT test: canOrg() must be break-glass-aware.
//
// A break-glass materialized membership writes a plain org `owner` row
// (role:"owner", createdByBreakGlass:true) so the operator passes the tenant
// gate. The org CAPABILITY plane (canOrg) must NOT confer owner caps straight
// from that row. Instead:
//   - a COMPANY-scoped break-glass grant confers ZERO org-wide capabilities;
//   - only a LIVE, ORG-WIDE break-glass grant (companyId NULL, revokedAt NULL,
//     expiresAt > now()) confers org-wide caps — and still bounded by
//     orgRoleCan(m.role, cap);
//   - a normal (non-break-glass) member is unchanged.
//
// drizzle-orm operators are mocked into plain descriptors so the in-memory fake
// DB can interpret the service's real WHERE clauses (and/eq/isNull/gt), mirroring
// operator-break-glass.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...clauses: unknown[]) => ({ op: "and", clauses }),
  or: (...clauses: unknown[]) => ({ op: "or", clauses }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
}));

// Distinct, self-identifying table stubs. Column access yields the JS field-name
// string; `__table` routes select().from(table) to the right in-memory array.
function makeTable(name: string) {
  return new Proxy(
    { __table: name },
    {
      get(_t, prop) {
        if (prop === "__table") return name;
        return typeof prop === "string" ? prop : undefined;
      },
    },
  );
}

vi.mock("@armyofagents/db", () => ({
  organizationMemberships: makeTable("memberships"),
  operatorBreakGlassGrants: makeTable("grants"),
}));

import { organizationAccessService } from "../services/organization-access.js";

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
    case "isNull":
      return row[clause.col] == null;
    case "isNotNull":
      return row[clause.col] != null;
    default:
      return true;
  }
}

// In-memory fake DB backing organization_memberships + operator_break_glass_grants.
function makeFakeDb() {
  const memberships: Record<string, unknown>[] = [];
  const grants: Record<string, unknown>[] = [];
  const rowsFor = (tbl: any) => (tbl?.__table === "grants" ? grants : memberships);
  const db: any = {
    _memberships: memberships,
    _grants: grants,
    select: (_proj?: unknown) => ({
      from: (tbl: any) => ({
        where: (clause: Clause) =>
          Promise.resolve(rowsFor(tbl).filter((r) => evalClause(r, clause))),
      }),
    }),
  };
  return db;
}

const ORG = "org-1";
const CO = "co-1";
const CAP = "execution_target:manage" as const;

describe("canOrg() is break-glass-aware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a COMPANY-scoped break-glass grant confers NO org-wide owner caps", async () => {
    const db = makeFakeDb();
    // Break-glass materialized an org `owner` row.
    db._memberships.push({
      organizationId: ORG,
      userId: "op",
      role: "owner",
      status: "active",
      createdByBreakGlass: true,
    });
    // ...but the underlying live grant is COMPANY-scoped (companyId set).
    db._grants.push({
      organizationId: ORG,
      operatorUserId: "op",
      companyId: CO, // company-scoped => ZERO org-wide caps
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const svc = organizationAccessService(db);
    expect(await svc.canOrg(ORG, "op", CAP)).toBe(false);
  });

  it("a LIVE org-wide break-glass grant confers org-wide caps", async () => {
    const db = makeFakeDb();
    db._memberships.push({
      organizationId: ORG,
      userId: "op2",
      role: "owner",
      status: "active",
      createdByBreakGlass: true,
    });
    db._grants.push({
      organizationId: ORG,
      operatorUserId: "op2",
      companyId: null, // org-wide
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const svc = organizationAccessService(db);
    expect(await svc.canOrg(ORG, "op2", CAP)).toBe(true);
  });

  it("an EXPIRED org-wide break-glass grant confers nothing (live TTL)", async () => {
    const db = makeFakeDb();
    db._memberships.push({
      organizationId: ORG,
      userId: "op3",
      role: "owner",
      status: "active",
      createdByBreakGlass: true,
    });
    db._grants.push({
      organizationId: ORG,
      operatorUserId: "op3",
      companyId: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 60_000), // expired
    });

    const svc = organizationAccessService(db);
    expect(await svc.canOrg(ORG, "op3", CAP)).toBe(false);
  });

  it("a REVOKED org-wide break-glass grant confers nothing", async () => {
    const db = makeFakeDb();
    db._memberships.push({
      organizationId: ORG,
      userId: "op4",
      role: "owner",
      status: "active",
      createdByBreakGlass: true,
    });
    db._grants.push({
      organizationId: ORG,
      operatorUserId: "op4",
      companyId: null,
      revokedAt: new Date(), // revoked
      expiresAt: new Date(Date.now() + 60_000),
    });

    const svc = organizationAccessService(db);
    expect(await svc.canOrg(ORG, "op4", CAP)).toBe(false);
  });

  it("a normal (non-break-glass) owner is UNCHANGED (still authorized)", async () => {
    const db = makeFakeDb();
    db._memberships.push({
      organizationId: ORG,
      userId: "u",
      role: "owner",
      status: "active",
      createdByBreakGlass: false,
    });
    // No grant rows at all.

    const svc = organizationAccessService(db);
    expect(await svc.canOrg(ORG, "u", CAP)).toBe(true);
    expect(await svc.canOrg(ORG, "u", "org:dissolve")).toBe(true);
  });

  it("a normal member is still denied owner caps", async () => {
    const db = makeFakeDb();
    db._memberships.push({
      organizationId: ORG,
      userId: "m",
      role: "member",
      status: "active",
      createdByBreakGlass: false,
    });

    const svc = organizationAccessService(db);
    expect(await svc.canOrg(ORG, "m", CAP)).toBe(false);
  });
});
