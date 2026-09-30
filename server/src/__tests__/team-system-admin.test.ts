import { describe, it, expect, vi } from "vitest";

// Mock @armyofagents/db to avoid drizzle-orm ESM cycle
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    agents: makeTable("agents"),
    authUsers: makeTable("auth_users"),
    companyMemberships: makeTable("company_memberships"),
    instanceUserRoles: makeTable("instance_user_roles"),
    invites: makeTable("invites"),
    issues: makeTable("issues"),
    principalPermissionGrants: makeTable("principal_permission_grants"),
    projects: makeTable("projects"),
    userRoles: makeTable("user_roles"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  count: (..._args: unknown[]) => "count",
  eq: (..._args: unknown[]) => "eq",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
  ne: (..._args: unknown[]) => "ne",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import { teamService } from "../services/team.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  let deleteIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];
  const deletes = config.deletes ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "set", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => deletes[deleteIdx++] ?? []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn(db);
    },
  };

  return db;
}

describe("teamService.isCompanySystemAdmin", () => {
  it("returns true when membership has isSystemAdmin=true", async () => {
    const db = createSequenceDb({
      selects: [[{ isSystemAdmin: true }]],
    });
    const svc = teamService(db as any);
    const result = await svc.isCompanySystemAdmin("c1", "user-1");
    expect(result).toBe(true);
  });

  it("returns false when membership has isSystemAdmin=false", async () => {
    const db = createSequenceDb({
      selects: [[{ isSystemAdmin: false }]],
    });
    const svc = teamService(db as any);
    const result = await svc.isCompanySystemAdmin("c1", "user-1");
    expect(result).toBe(false);
  });

  it("returns false when no membership exists", async () => {
    const db = createSequenceDb({
      selects: [[]],
    });
    const svc = teamService(db as any);
    const result = await svc.isCompanySystemAdmin("c1", "user-1");
    expect(result).toBe(false);
  });

  it("returns false when userId is null", async () => {
    const db = createSequenceDb();
    const svc = teamService(db as any);
    const result = await svc.isCompanySystemAdmin("c1", null);
    expect(result).toBe(false);
  });

  it("returns false when userId is undefined", async () => {
    const db = createSequenceDb();
    const svc = teamService(db as any);
    const result = await svc.isCompanySystemAdmin("c1", undefined);
    expect(result).toBe(false);
  });
});

describe("teamService.assertSystemAdmin", () => {
  it("resolves when user is system admin", async () => {
    const db = createSequenceDb({
      selects: [[{ isSystemAdmin: true }]],
    });
    const svc = teamService(db as any);
    await expect(svc.assertSystemAdmin("c1", "admin-user")).resolves.toBeUndefined();
  });

  it("throws when user is not system admin", async () => {
    const db = createSequenceDb({
      selects: [[{ isSystemAdmin: false }]],
    });
    const svc = teamService(db as any);
    await expect(svc.assertSystemAdmin("c1", "regular-user"))
      .rejects.toThrow("Only the system admin can perform this action");
  });

  it("throws when user has no membership", async () => {
    const db = createSequenceDb({
      selects: [[]],
    });
    const svc = teamService(db as any);
    await expect(svc.assertSystemAdmin("c1", "unknown-user"))
      .rejects.toThrow("Only the system admin can perform this action");
  });
});

describe("teamService.transferAdmin", () => {
  it("throws when current user is not system admin", async () => {
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> not admin
        [{ isSystemAdmin: false }],
      ],
    });
    const svc = teamService(db as any);
    await expect(svc.transferAdmin("c1", "from-user", "to-user"))
      .rejects.toThrow("Only the system admin can perform this action");
  });

  it("throws when transferring to self", async () => {
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> is admin
        [{ isSystemAdmin: true }],
      ],
    });
    const svc = teamService(db as any);
    await expect(svc.transferAdmin("c1", "user-1", "user-1"))
      .rejects.toThrow("Cannot transfer admin to yourself");
  });

  it("throws when target is not a founder", async () => {
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> is admin
        [{ isSystemAdmin: true }],
        // getUserRole for target: isInstanceAdmin
        [],
        // getUserRole for target: userRoles -> team_lead
        [{ role: "team_lead", projectId: "dept-1" }],
      ],
    });
    const svc = teamService(db as any);
    await expect(svc.transferAdmin("c1", "admin-user", "lead-user"))
      .rejects.toThrow("System admin can only be transferred to a founder");
  });

  it("transfers admin successfully when target is founder", async () => {
    const updateSets: Record<string, unknown>[] = [];
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> is admin
        [{ isSystemAdmin: true }],
        // getUserRole for target: isInstanceAdmin
        [],
        // getUserRole for target: userRoles -> founder
        [{ role: "founder", projectId: null }],
      ],
    });

    const origUpdate = db.update;
    db.update = (...args: unknown[]) => {
      const chain = origUpdate.call(db, ...args);
      const origSet = (chain as any).set;
      (chain as any).set = (val: Record<string, unknown>) => {
        updateSets.push(val);
        return origSet.call(chain, val);
      };
      return chain;
    };

    const svc = teamService(db as any);
    await svc.transferAdmin("c1", "admin-user", "other-founder");

    // Should have two updates: one setting false, one setting true
    expect(updateSets.length).toBe(2);
    expect(updateSets[0].isSystemAdmin).toBe(false);
    expect(updateSets[1].isSystemAdmin).toBe(true);
  });
});
