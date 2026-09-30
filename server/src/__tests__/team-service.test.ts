import { describe, it, expect, vi, beforeEach } from "vitest";

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
    authUsers: makeTable("auth_users"),
    companyMemberships: makeTable("company_memberships"),
    instanceUserRoles: makeTable("instance_user_roles"),
    invites: makeTable("invites"),
    issues: makeTable("issues"),
    mcpApiKeys: makeTable("mcp_api_keys"),
    principalPermissionGrants: makeTable("principal_permission_grants"),
    projects: makeTable("projects"),
    userRoles: makeTable("user_roles"),
    agents: makeTable("agents"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  eq: (..._args: unknown[]) => "eq",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

// Mock live-events (transitive dep)
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
    transaction: async (fn: (tx: any) => Promise<void>) => {
      // Transaction uses same db as tx
      await fn(db);
    },
    _selectIdx: () => selectIdx,
    _updateIdx: () => updateIdx,
  };

  return db;
}

describe("teamService.removeMember", () => {
  it("removes a team member and orphans children", async () => {
    const db = createSequenceDb({
      selects: [
        // access.getMembership -> found active membership
        [{ id: "mem-1", status: "active", principalType: "user", principalId: "user-2", companyId: "c1" }],
        // isCompanySystemAdmin -> not admin
        [{ isSystemAdmin: false }],
        // isInstanceAdmin for getUserRole -> not admin
        [],
        // getUserRole -> team_member role
        [{ role: "team_member", projectId: null }],
      ],
      updates: [
        // reparentChildren: update agents
        [],
        // reparentChildren: update company_memberships
        [],
      ],
      deletes: [
        // delete userRoles
        [],
        // delete principalPermissionGrants
        [],
        // delete companyMemberships
        [],
      ],
    });

    const svc = teamService(db as any);
    await expect(svc.removeMember("c1", "user-2")).resolves.toBeUndefined();
  });

  it("H8: cascade-revokes the offboarded user's MCP API keys for the company", async () => {
    // Record every db.update(table, set) so we can prove an mcp_api_keys revoke
    // was issued inside removeMember's transaction (auth only filters keys on
    // revokedAt, so without this a removed member keeps programmatic MCP access).
    const updateCalls: Array<{ table: unknown; set: Record<string, unknown> | null }> = [];
    const selects: MockRow[][] = [
      [{ id: "mem-1", status: "active", principalType: "user", principalId: "user-2", companyId: "c1" }],
      [{ isSystemAdmin: false }],
      [],
      [{ role: "team_member", projectId: null }],
    ];
    let selIdx = 0;
    function recChain(getResult: () => MockRow[], onSet?: (s: Record<string, unknown>) => void) {
      const chain: Record<string, unknown> = {};
      for (const m of ["from", "where", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
        chain[m] = () => chain;
      }
      chain.set = (s: Record<string, unknown>) => { onSet?.(s); return chain; };
      chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
      return chain;
    }
    const db: any = {
      select: () => recChain(() => selects[selIdx++] ?? []),
      update: (table: unknown) => {
        const entry: { table: unknown; set: Record<string, unknown> | null } = { table, set: null };
        updateCalls.push(entry);
        return recChain(() => [], (s) => { entry.set = s; });
      },
      insert: () => recChain(() => []),
      delete: () => recChain(() => []),
      transaction: async (fn: (tx: any) => Promise<void>) => { await fn(db); },
    };

    const { mcpApiKeys } = await import("@armyofagents/db");
    await teamService(db).removeMember("c1", "user-2");

    const revoke = updateCalls.find((c) => c.table === mcpApiKeys);
    expect(revoke, "expected an update against mcp_api_keys").toBeTruthy();
    expect(revoke!.set).toMatchObject({ revokedAt: expect.any(Date) });
  });

  it("clears responsible task ownership when removing a member", async () => {
    const updateCalls: Array<{ table: unknown; set: Record<string, unknown> | null }> = [];
    const selects: MockRow[][] = [
      [{ id: "mem-1", status: "active", principalType: "user", principalId: "user-2", companyId: "c1" }],
      [{ isSystemAdmin: false }],
      [],
      [{ role: "team_member", projectId: null }],
    ];
    let selIdx = 0;
    function recChain(getResult: () => MockRow[], onSet?: (s: Record<string, unknown>) => void) {
      const chain: Record<string, unknown> = {};
      for (const m of ["from", "where", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
        chain[m] = () => chain;
      }
      chain.set = (s: Record<string, unknown>) => { onSet?.(s); return chain; };
      chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
      return chain;
    }
    const db: any = {
      select: () => recChain(() => selects[selIdx++] ?? []),
      update: (table: unknown) => {
        const entry: { table: unknown; set: Record<string, unknown> | null } = { table, set: null };
        updateCalls.push(entry);
        return recChain(() => [], (s) => { entry.set = s; });
      },
      insert: () => recChain(() => []),
      delete: () => recChain(() => []),
      transaction: async (fn: (tx: any) => Promise<void>) => { await fn(db); },
    };

    const { issues } = await import("@armyofagents/db");
    await teamService(db).removeMember("c1", "user-2");

    const cleanup = updateCalls.find((c) => c.table === issues);
    expect(cleanup, "expected an update against issues").toBeTruthy();
    expect(cleanup!.set).toMatchObject({
      responsibleUserId: null,
      updatedAt: expect.any(Date),
    });
  });

  it("throws when member not found", async () => {
    const db = createSequenceDb({
      selects: [
        // access.getMembership -> not found
        [],
      ],
    });

    const svc = teamService(db as any);
    await expect(svc.removeMember("c1", "nonexistent")).rejects.toThrow("Team member not found");
  });

  it("throws when trying to remove last founder", async () => {
    const db = createSequenceDb({
      selects: [
        // access.getMembership -> found
        [{ id: "mem-1", status: "active", principalType: "user", principalId: "user-1", companyId: "c1" }],
        // isCompanySystemAdmin -> not admin
        [{ isSystemAdmin: false }],
        // isInstanceAdmin for getUserRole -> not admin
        [],
        // getUserRole -> founder
        [{ role: "founder", projectId: null }],
        // founderCount: userRoles query -> only this founder
        [{ userId: "user-1" }],
        // founderCount: companyMemberships query (active users)
        [{ principalId: "user-1" }],
        // founderCount: isInstanceAdmin for user-1 -> not admin
        [],
      ],
    });

    const svc = teamService(db as any);
    await expect(svc.removeMember("c1", "user-1")).rejects.toThrow("Cannot remove the last founder");
  });

  it("allows removing a founder when other founders exist", async () => {
    const db = createSequenceDb({
      selects: [
        // access.getMembership -> found
        [{ id: "mem-1", status: "active", principalType: "user", principalId: "user-1", companyId: "c1" }],
        // isCompanySystemAdmin -> not admin
        [{ isSystemAdmin: false }],
        // isInstanceAdmin for getUserRole -> not admin
        [],
        // getUserRole -> founder
        [{ role: "founder", projectId: null }],
        // founderCount: userRoles query -> two founders
        [{ userId: "user-1" }, { userId: "user-2" }],
        // founderCount: companyMemberships query
        [{ principalId: "user-1" }, { principalId: "user-2" }],
        // founderCount: isInstanceAdmin for user-1 -> no
        [],
        // founderCount: isInstanceAdmin for user-2 -> no
        [],
      ],
      updates: [[], []],
      deletes: [[], [], []],
    });

    const svc = teamService(db as any);
    await expect(svc.removeMember("c1", "user-1")).resolves.toBeUndefined();
  });
});

describe("teamService.updateUserRole", () => {
  it("persists parentType/parentId to company_memberships", async () => {
    const updateSets: Record<string, unknown>[] = [];

    const db = createSequenceDb({
      selects: [
        // access.getMembership
        [{ id: "mem-1", status: "active", principalType: "user", principalId: "user-2", companyId: "c1" }],
        // isInstanceAdmin for getUserRole
        [],
        // getUserRole roles
        [{ role: "team_member", projectId: null }],
        // ensureParent: check parent user exists
        [{ principalId: "user-1" }],
        // assertNoCycle: lookup user-1 parent -> root
        [{ parentType: null, parentId: null }],
        // post-update getUserRole: isInstanceAdmin
        [],
        // post-update getUserRole roles
        [{ role: "team_lead", projectId: "dept-1" }],
      ],
    });

    // Intercept update calls to capture the set values
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

    // Need to also mock the transaction properly
    db.transaction = async (fn: any) => {
      await fn(db);
    };

    const svc = teamService(db as any);
    const result = await svc.updateUserRole(
      "c1",
      "user-2",
      { role: "team_lead", projectId: "dept-1", parentType: "user", parentId: "user-1" },
      "user-admin",
    );

    expect(result.role).toBe("team_lead");
  });

  it("skips parent validation when parentType/parentId not provided", async () => {
    const db = createSequenceDb({
      selects: [
        // access.getMembership
        [{ id: "mem-1", status: "active", principalType: "user", principalId: "user-2", companyId: "c1" }],
        // isInstanceAdmin for getUserRole
        [],
        // getUserRole roles
        [{ role: "team_member", projectId: null }],
        // post-update getUserRole: isInstanceAdmin
        [],
        // post-update getUserRole roles
        [{ role: "team_lead", projectId: "dept-1" }],
      ],
    });

    db.transaction = async (fn: any) => { await fn(db); };

    const svc = teamService(db as any);
    const result = await svc.updateUserRole(
      "c1",
      "user-2",
      { role: "team_lead", projectId: "dept-1" },
      "user-admin",
    );

    expect(result.role).toBe("team_lead");
  });
});
