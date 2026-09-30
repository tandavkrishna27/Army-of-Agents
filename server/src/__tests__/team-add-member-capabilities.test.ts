import { describe, expect, it, vi } from "vitest";

const ensureStandardDocumentsMock = vi.hoisted(() => vi.fn());
const getUserProfileMock = vi.hoisted(() => vi.fn());

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
    assets: makeTable("assets"),
    authUsers: makeTable("auth_users"),
    companyMemberships: makeTable("company_memberships"),
    companyUserProfiles: makeTable("company_user_profiles"),
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

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: vi.fn(),
    getMembership: vi.fn().mockResolvedValue({ id: "membership-1", status: "active" }),
    setPrincipalGrants: vi.fn(),
  }),
}));

vi.mock("../services/org-hierarchy.js", () => ({
  orgHierarchyService: () => ({
    ensureParent: vi.fn(),
    assertNoCycle: vi.fn(),
    reparentChildren: vi.fn(),
  }),
}));

vi.mock("../services/human-capabilities.js", () => ({
  humanCapabilitiesService: () => ({
    ensureStandardDocuments: ensureStandardDocumentsMock,
  }),
}));

vi.mock("../services/user-profiles.js", () => ({
  getUserProfile: getUserProfileMock,
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import { teamService } from "../services/team.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: { selects?: MockRow[][]; inserts?: MockRow[][] } = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  const inserts = config.inserts ?? [];
  const insertValues: unknown[] = [];
  const conflictUpdates: Record<string, unknown>[] = [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.values = (value: unknown) => {
      insertValues.push(value);
      return chain;
    };
    chain.set = (..._args: unknown[]) => chain;
    chain.onConflictDoUpdate = (value: { set?: Record<string, unknown> }) => {
      if (value?.set) conflictUpdates.push(value.set);
      return chain;
    };
    chain.returning = () => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => []),
    delete: (..._args: unknown[]) => makeChain(() => []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn(db);
    },
    _insertValues: insertValues,
    _conflictUpdates: conflictUpdates,
  };
  return db;
}

describe("teamService addMember capability seeding", () => {
  it("seeds standard human capability documents for newly added members", async () => {
    ensureStandardDocumentsMock.mockReset();
    getUserProfileMock.mockReset();
    const db = createSequenceDb({
      selects: [
        [], // assertFounder: instance admin lookup
        [{ role: "founder", projectId: null }], // assertFounder: actor role lookup
        [], // duplicate member lookup
        [], // existing auth user lookup
        [], // updateUserRole current role: instance admin lookup
        [], // updateUserRole current role: existing role lookup
      ],
    });

    const result = await teamService(db as any).addMember(
      "company-1",
      { name: "Ada", email: "ada@example.com", role: "team_member" },
      "founder-1",
    );

    expect(result.userId).toMatch(/[0-9a-f-]{36}/);
    expect(ensureStandardDocumentsMock).toHaveBeenCalledWith("company-1", result.userId, "founder-1");
  });
});

describe("teamService addMember profile convergence", () => {
  it("materializes a company profile from the global profile, parse-filtering social links", async () => {
    ensureStandardDocumentsMock.mockReset();
    getUserProfileMock.mockReset();
    getUserProfileMock.mockResolvedValue({
      userId: "existing-user-1",
      displayName: "Ada Lovelace",
      title: "Engineer",
      bio: "Builds computers",
      timezone: "Europe/London",
      socialLinks: [
        { type: "github", label: null, url: "https://github.com/ada" },
        { type: "not-a-real-type", url: "https://example.com/bad" },
      ],
    });

    const db = createSequenceDb({
      selects: [
        [], // assertFounder: instance admin lookup
        [{ role: "founder", projectId: null }], // assertFounder: actor role lookup
        [], // duplicate member lookup
        [{ id: "existing-user-1" }], // existing auth user lookup — reuse account, skip authUsers insert
        [], // updateUserRole current role: instance admin lookup
        [], // updateUserRole current role: existing role lookup
      ],
      inserts: [
        [], // updateUserRole transaction: userRoles insert (result unused)
        [
          {
            id: "profile-1",
            companyId: "company-1",
            userId: "existing-user-1",
            displayName: "Ada Lovelace",
            title: "Engineer",
            bio: "Builds computers",
            location: null,
            timezone: "Europe/London",
            socialLinks: [{ type: "github", label: null, url: "https://github.com/ada" }],
            avatarAssetId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            updatedByUserId: "founder-1",
          },
        ], // companyUserProfiles insert — our convergence write
      ],
    });

    const result = await teamService(db as any).addMember(
      "company-1",
      { name: "Ada", email: "ada@example.com", role: "team_member" },
      "founder-1",
    );

    expect(result.userId).toBe("existing-user-1");
    expect(getUserProfileMock).toHaveBeenCalledWith(db, "existing-user-1");

    const profileInsertValues = db._insertValues[1] as Record<string, unknown>;
    expect(profileInsertValues).toMatchObject({
      companyId: "company-1",
      userId: "existing-user-1",
      displayName: "Ada Lovelace",
      title: "Engineer",
      bio: "Builds computers",
      timezone: "Europe/London",
      updatedByUserId: "founder-1",
    });
    // The invalid social-link entry (unknown type) is dropped by the
    // humanSocialLinkSchema parse-filter, same as the invited path.
    expect(profileInsertValues.socialLinks).toEqual([{ type: "github", label: null, url: "https://github.com/ada" }]);
  });

  it("never fails addMember when profile materialization throws (best-effort)", async () => {
    ensureStandardDocumentsMock.mockReset();
    getUserProfileMock.mockReset();
    getUserProfileMock.mockRejectedValue(new Error("boom"));

    const db = createSequenceDb({
      selects: [
        [], // assertFounder: instance admin lookup
        [{ role: "founder", projectId: null }], // assertFounder: actor role lookup
        [], // duplicate member lookup
        [], // existing auth user lookup (creates a new auth user)
        [], // updateUserRole current role: instance admin lookup
        [], // updateUserRole current role: existing role lookup
      ],
    });

    const result = await teamService(db as any).addMember(
      "company-1",
      { name: "Grace", email: "grace@example.com", role: "team_member" },
      "founder-1",
    );

    expect(result.userId).toMatch(/[0-9a-f-]{36}/);
    expect(ensureStandardDocumentsMock).toHaveBeenCalledWith("company-1", result.userId, "founder-1");
  });
});
