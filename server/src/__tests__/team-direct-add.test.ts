import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

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
    companyUserCapabilityDocuments: makeTable("company_user_capability_documents"),
    instanceUserRoles: makeTable("instance_user_roles"),
    invites: makeTable("invites"),
    issues: makeTable("issues"),
    mcpApiKeys: makeTable("mcp_api_keys"),
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

// Mock access service to avoid deep call chain complexity
const mockAccessService = {
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
};
vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

// Mock org-hierarchy service
const mockOrgHierarchy = {
  ensureParent: vi.fn(),
  assertNoCycle: vi.fn(),
};
vi.mock("../services/org-hierarchy.js", () => ({
  orgHierarchyService: () => mockOrgHierarchy,
}));

import { teamService } from "../services/team.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

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
    for (const m of [
      "from",
      "where",
      "set",
      "values",
      "returning",
      "innerJoin",
      "leftJoin",
      "orderBy",
      "limit",
      "onConflictDoNothing",
    ]) {
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

function resetMocks() {
  mockAccessService.getMembership.mockReset();
  mockAccessService.ensureMembership.mockReset();
  mockAccessService.setPrincipalGrants.mockReset();
  mockOrgHierarchy.ensureParent.mockReset();
  mockOrgHierarchy.assertNoCycle.mockReset();
}

describe("teamService.addMember", () => {
  it("adds a team member when caller is founder", async () => {
    resetMocks();
    mockAccessService.getMembership.mockResolvedValue({ id: "m1", status: "active" });
    mockAccessService.ensureMembership.mockResolvedValue({ id: "m2" });
    mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);

    const db = createSequenceDb({
      selects: [
        // assertFounder -> isInstanceAdmin (instanceUserRoles)
        [],
        // assertFounder -> userRoles -> founder
        [{ role: "founder", projectId: null }],
        // email uniqueness check -> no existing
        [],
        // find authUser by email -> not found
        [],
        // updateUserRole -> getUserRole -> isInstanceAdmin
        [],
        // updateUserRole -> getUserRole -> userRoles
        [{ role: "team_member", projectId: "dept-1" }],
        // updateUserRole final getUserRole -> isInstanceAdmin
        [],
        // updateUserRole final getUserRole -> userRoles
        [{ role: "team_member", projectId: "dept-1" }],
      ],
      inserts: [
        // insert authUser
        [],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.addMember(
      "c1",
      { name: "New User", email: "new@test.com", role: "team_member" },
      "founder-user",
    );
    expect(result).toHaveProperty("userId");
    expect(typeof result.userId).toBe("string");
  });

  it("reuses existing authUser when email exists globally", async () => {
    resetMocks();
    mockAccessService.getMembership.mockResolvedValue({ id: "m1", status: "active" });
    mockAccessService.ensureMembership.mockResolvedValue({ id: "m2" });
    mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);

    const db = createSequenceDb({
      selects: [
        // assertFounder -> isInstanceAdmin
        [],
        // assertFounder -> userRoles -> founder
        [{ role: "founder", projectId: null }],
        // email uniqueness in company -> no match
        [],
        // find authUser by email -> found
        [{ id: "existing-user-id" }],
        // updateUserRole -> getUserRole -> isInstanceAdmin
        [],
        // updateUserRole -> getUserRole -> userRoles
        [{ role: "team_member", projectId: null }],
        // updateUserRole final getUserRole -> isInstanceAdmin
        [],
        // updateUserRole final getUserRole -> userRoles
        [{ role: "team_member", projectId: null }],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.addMember(
      "c1",
      { name: "Existing User", email: "exists@test.com", role: "team_member" },
      "founder-user",
    );
    expect(result.userId).toBe("existing-user-id");
  });

  it("throws when email already exists in company", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // assertFounder -> isInstanceAdmin
        [],
        // assertFounder -> userRoles -> founder
        [{ role: "founder", projectId: null }],
        // email uniqueness check -> exists!
        [{ principalId: "dup-user" }],
      ],
    });
    const svc = teamService(db as any);
    await expect(
      svc.addMember("c1", { name: "Dup", email: "dup@test.com", role: "team_member" }, "founder-user"),
    ).rejects.toThrow("A team member with this email already exists in this company");
  });

  it("throws when non-founder tries to add member", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // assertFounder -> isInstanceAdmin
        [],
        // assertFounder -> userRoles -> team_lead (not founder)
        [{ role: "team_lead", projectId: "dept-1" }],
      ],
    });
    const svc = teamService(db as any);
    await expect(
      svc.addMember("c1", { name: "X", email: "x@test.com", role: "team_member" }, "lead-user"),
    ).rejects.toThrow("Only founders can manage team roles");
  });

  it("throws when non-admin tries to add founder", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // assertFounder -> isInstanceAdmin
        [],
        // assertFounder -> userRoles -> founder (passes assertFounder)
        [{ role: "founder", projectId: null }],
        // assertSystemAdmin -> isCompanySystemAdmin -> not admin
        [{ isSystemAdmin: false }],
      ],
    });
    const svc = teamService(db as any);
    await expect(
      svc.addMember("c1", { name: "New Founder", email: "f@test.com", role: "founder" }, "non-admin-founder"),
    ).rejects.toThrow("Only the system admin can perform this action");
  });

  it("sets parent when parentId is provided", async () => {
    resetMocks();
    mockAccessService.getMembership.mockResolvedValue({ id: "m1", status: "active" });
    mockAccessService.ensureMembership.mockResolvedValue({ id: "m2" });
    mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);
    mockOrgHierarchy.ensureParent.mockResolvedValue(undefined);
    mockOrgHierarchy.assertNoCycle.mockResolvedValue(undefined);

    const updateSets: Record<string, unknown>[] = [];
    const db = createSequenceDb({
      selects: [
        // assertFounder -> isInstanceAdmin
        [],
        // assertFounder -> userRoles -> founder
        [{ role: "founder", projectId: null }],
        // email uniqueness -> clean
        [],
        // find authUser -> exists
        [{ id: "new-user-id" }],
        // updateUserRole -> getUserRole -> isInstanceAdmin
        [],
        // updateUserRole -> getUserRole -> userRoles
        [{ role: "team_member", projectId: null }],
        // updateUserRole final getUserRole -> isInstanceAdmin
        [],
        // updateUserRole final getUserRole -> userRoles
        [{ role: "team_member", projectId: null }],
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
    await svc.addMember(
      "c1",
      { name: "Sub", email: "sub@test.com", role: "team_member", parentType: "user", parentId: "parent-user" },
      "founder-user",
    );

    // At least one update should set the parentId
    const parentUpdate = updateSets.find((s) => s.parentId === "parent-user");
    expect(parentUpdate).toBeDefined();
  });
});

describe("teamService.addMember — cloud_auth invite-only guard (Fix 1)", () => {
  // cloud_auth admits humans ONLY through the invite chokepoint
  // (approveHumanJoinRequestTx), which writes BOTH org + company memberships.
  // Direct-add writes only the company membership -> assertCompanyAccess
  // (authz.ts:71) 403s the added user on every request. Reject it here.
  beforeEach(() => {
    resetMocks();
    setDeploymentMode("cloud_auth");
  });
  afterEach(() => {
    // Never leak cloud_auth into the other describes in this file.
    setDeploymentMode("local_trusted");
  });

  it("rejects direct-add in cloud with an actionable invite message", async () => {
    // The guard fires FIRST — no DB access, so no select sequences needed.
    const db = createSequenceDb({});
    const svc = teamService(db as any);
    await expect(
      svc.addMember(
        "c1",
        { name: "New User", email: "new@test.com", role: "team_member" },
        "founder-user",
      ),
    ).rejects.toThrow(/Send an email invite instead/);
  });

  it("still one-click direct-adds in self-hosted (guard does NOT fire when not enforced)", async () => {
    // Divergence lock: self-hosted has no tenant boundary and is unchanged.
    setDeploymentMode("local_trusted");
    mockAccessService.getMembership.mockResolvedValue({ id: "m1", status: "active" });
    mockAccessService.ensureMembership.mockResolvedValue({ id: "m2" });
    mockAccessService.setPrincipalGrants.mockResolvedValue(undefined);

    const db = createSequenceDb({
      selects: [
        // assertFounder -> isInstanceAdmin
        [],
        // assertFounder -> userRoles -> founder
        [{ role: "founder", projectId: null }],
        // email uniqueness -> clean
        [],
        // find authUser by email -> not found (create new)
        [],
        // updateUserRole -> getUserRole -> isInstanceAdmin
        [],
        // updateUserRole -> getUserRole -> userRoles
        [{ role: "team_member", projectId: null }],
        // updateUserRole final getUserRole -> isInstanceAdmin
        [],
        // updateUserRole final getUserRole -> userRoles
        [{ role: "team_member", projectId: null }],
      ],
      inserts: [
        // insert authUser
        [],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.addMember(
      "c1",
      { name: "New User", email: "new@test.com", role: "team_member" },
      "founder-user",
    );
    expect(typeof result.userId).toBe("string");
  });
});

describe("teamService.getReportsFor", () => {
  it("returns empty when no reports exist", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // human reports -> none
        [],
        // direct agents -> none
        [],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.getReportsFor("c1", "user-1");
    expect(result.teamMembers).toEqual([]);
    expect(result.agentTrees).toEqual([]);
  });

  it("returns human reports only", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // human reports
        [
          { userId: "u2", displayName: "Alice", email: "alice@test.com", role: "team_member" },
          { userId: "u3", displayName: "Bob", email: "bob@test.com", role: "team_lead" },
        ],
        // direct agents -> none
        [],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.getReportsFor("c1", "user-1");
    expect(result.teamMembers).toHaveLength(2);
    expect(result.teamMembers[0].userId).toBe("u2");
    expect(result.teamMembers[1].userId).toBe("u3");
    expect(result.agentTrees).toEqual([]);
  });

  it("returns agent trees with sub-agent counts", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // human reports -> none
        [],
        // direct agents
        [{ id: "agent-1", name: "Agent Alpha" }],
        // BFS children of agent-1
        [{ id: "sub-1" }, { id: "sub-2" }],
        // BFS children of sub-1
        [],
        // BFS children of sub-2
        [],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.getReportsFor("c1", "user-1");
    expect(result.teamMembers).toEqual([]);
    expect(result.agentTrees).toHaveLength(1);
    expect(result.agentTrees[0].rootAgentId).toBe("agent-1");
    expect(result.agentTrees[0].rootAgentName).toBe("Agent Alpha");
    expect(result.agentTrees[0].subAgentCount).toBe(2);
  });
});

describe("teamService.getDependencies", () => {
  it("returns full dependencies including task counts", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // getReportsFor -> human reports
        [{ userId: "u2", displayName: "Alice", email: "alice@test.com", role: "team_member" }],
        // getReportsFor -> direct agents
        [{ id: "agent-1", name: "Agent A" }],
        // BFS children of agent-1
        [],
        // assignedTaskCount
        [{ cnt: 5 }],
        // createdTaskCount
        [{ cnt: 3 }],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.getDependencies("c1", "user-1");
    expect(result.teamMembers).toHaveLength(1);
    expect(result.teamMembers[0].userId).toBe("u2");
    expect(result.agentTrees).toHaveLength(1);
    expect(result.agentTrees[0].rootAgentId).toBe("agent-1");
    expect(result.assignedTaskCount).toBe(5);
    expect(result.createdTaskCount).toBe(3);
  });

  it("returns zero counts when no tasks exist", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // getReportsFor -> no humans
        [],
        // getReportsFor -> no agents
        [],
        // assignedTaskCount -> 0
        [{ cnt: 0 }],
        // createdTaskCount -> 0
        [{ cnt: 0 }],
      ],
    });
    const svc = teamService(db as any);
    const result = await svc.getDependencies("c1", "user-1");
    expect(result.teamMembers).toEqual([]);
    expect(result.agentTrees).toEqual([]);
    expect(result.assignedTaskCount).toBe(0);
    expect(result.createdTaskCount).toBe(0);
  });
});

describe("teamService.reassignAndRemove", () => {
  it("throws when trying to remove system admin", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> true
        [{ isSystemAdmin: true }],
      ],
    });
    const svc = teamService(db as any);
    await expect(
      svc.reassignAndRemove("c1", "admin-user", {
        humanReassignments: [],
        agentReassignments: [],
      }),
    ).rejects.toThrow("Cannot remove the system admin. Transfer admin rights first.");
  });

  it("throws when trying to remove last founder", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> false
        [{ isSystemAdmin: false }],
        // getUserRole -> isInstanceAdmin
        [],
        // getUserRole -> userRoles -> founder
        [{ role: "founder", projectId: null }],
        // founderCount -> userRoles query (founder role rows)
        [{ userId: "last-founder" }],
        // founderCount -> memberships
        [{ principalId: "last-founder" }],
        // founderCount -> isInstanceAdmin for that membership
        [],
      ],
    });
    const svc = teamService(db as any);
    await expect(
      svc.reassignAndRemove("c1", "last-founder", {
        humanReassignments: [],
        agentReassignments: [],
      }),
    ).rejects.toThrow("Cannot remove the last founder");
  });

  it("reassigns and removes a non-admin member", async () => {
    resetMocks();
    const updateSets: Record<string, unknown>[] = [];
    const updateCalls: Array<{ table: unknown; set: Record<string, unknown> | null }> = [];
    const deleteCalls: number[] = [];
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> false
        [{ isSystemAdmin: false }],
        // getUserRole -> isInstanceAdmin
        [],
        // getUserRole -> userRoles -> team_member
        [{ role: "team_member", projectId: "dept-1" }],
      ],
    });

    const origUpdate = db.update;
    db.update = (...args: unknown[]) => {
      const entry: { table: unknown; set: Record<string, unknown> | null } = { table: args[0], set: null };
      updateCalls.push(entry);
      const chain = origUpdate.call(db, ...args);
      const origSet = (chain as any).set;
      (chain as any).set = (val: Record<string, unknown>) => {
        updateSets.push(val);
        entry.set = val;
        return origSet.call(chain, val);
      };
      return chain;
    };

    const origDelete = db.delete;
    db.delete = (...args: unknown[]) => {
      deleteCalls.push(1);
      return origDelete.call(db, ...args);
    };

    const svc = teamService(db as any);
    await svc.reassignAndRemove("c1", "member-user", {
      humanReassignments: [{ userId: "report-1", newParentId: "other-user" }],
      agentReassignments: [{ agentId: "agent-1", newParentId: "other-user", newParentType: "user" }],
    });

    // Should have updates for human reassignment + agent reassignment
    expect(updateSets.length).toBeGreaterThanOrEqual(3);

    const { issues } = await import("@armyofagents/db");
    const responsibilityCleanup = updateCalls.find((call) => call.table === issues);
    expect(responsibilityCleanup, "expected removed human's responsible tasks to be cleared").toBeTruthy();
    expect(responsibilityCleanup!.set).toMatchObject({
      responsibleUserId: null,
      updatedAt: expect.any(Date),
    });

    // Should have 3 deletes: userRoles, principalPermissionGrants, companyMemberships
    expect(deleteCalls.length).toBe(3);
  });

  it("reassigns and removes a founder when multiple founders exist", async () => {
    resetMocks();
    const db = createSequenceDb({
      selects: [
        // isCompanySystemAdmin -> false
        [{ isSystemAdmin: false }],
        // getUserRole -> isInstanceAdmin
        [],
        // getUserRole -> userRoles -> founder
        [{ role: "founder", projectId: null }],
        // founderCount -> userRoles query (2 founder rows)
        [{ userId: "founder-to-remove" }, { userId: "other-founder" }],
        // founderCount -> memberships
        [{ principalId: "founder-to-remove" }, { principalId: "other-founder" }],
        // founderCount -> isInstanceAdmin for founder-to-remove
        [],
        // founderCount -> isInstanceAdmin for other-founder
        [],
      ],
    });

    const svc = teamService(db as any);
    await expect(
      svc.reassignAndRemove("c1", "founder-to-remove", {
        humanReassignments: [],
        agentReassignments: [],
      }),
    ).resolves.toBeUndefined();
  });
});
