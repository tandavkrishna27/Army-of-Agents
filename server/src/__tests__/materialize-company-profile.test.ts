import { describe, expect, it, vi } from "vitest";

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
    ensureStandardDocuments: vi.fn(),
  }),
}));

vi.mock("../services/user-profiles.js", () => ({
  getUserProfile: getUserProfileMock,
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import {
  ensureCompanyProfileFromGlobal,
  materializeCompanyProfileFromGlobal,
} from "../services/team.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: { inserts?: MockRow[][] } = {}) {
  let insertIdx = 0;
  const inserts = config.inserts ?? [];
  const insertValues: unknown[] = [];
  const conflictUpdates: Record<string, unknown>[] = [];
  let conflictDoNothingCalls = 0;

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
    chain.onConflictDoNothing = () => {
      conflictDoNothingCalls += 1;
      return chain;
    };
    chain.returning = () => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => []),
    delete: (..._args: unknown[]) => makeChain(() => []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn(db);
    },
    _insertValues: insertValues,
    _conflictUpdates: conflictUpdates,
    _conflictDoNothingCalls: () => conflictDoNothingCalls,
  };
  return db;
}

// The onConflictDoUpdate return row is only read back for its shape; a minimal
// row keeps the assertions focused on the write values we control.
function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    companyId: "company-1",
    userId: "user-1",
    displayName: null,
    title: null,
    bio: null,
    location: null,
    timezone: null,
    socialLinks: [],
    avatarAssetId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedByUserId: "attrib-1",
    ...overrides,
  };
}

describe("materializeCompanyProfileFromGlobal", () => {
  it("copies displayName/title/bio/timezone from the global profile and parse-filters socialLinks", async () => {
    getUserProfileMock.mockReset();
    getUserProfileMock.mockResolvedValue({
      userId: "user-1",
      displayName: "Ada Lovelace",
      title: "Engineer",
      bio: "Builds computers",
      timezone: "Europe/London",
      socialLinks: [
        { type: "github", label: null, url: "https://github.com/ada" },
        { type: "not-a-real-type", url: "https://example.com/bad" },
      ],
    });

    const db = createSequenceDb({ inserts: [[profileRow()]] });

    await materializeCompanyProfileFromGlobal(db as any, "company-1", "user-1", "attrib-1");

    // Reads the GLOBAL profile through the passed db handle (savepoint-safe).
    expect(getUserProfileMock).toHaveBeenCalledWith(db, "user-1");

    const inserted = db._insertValues[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      companyId: "company-1",
      userId: "user-1",
      displayName: "Ada Lovelace",
      title: "Engineer",
      bio: "Builds computers",
      timezone: "Europe/London",
      updatedByUserId: "attrib-1",
    });
    // The invalid social-link entry (unknown type) is dropped by the
    // humanSocialLinkSchema parse-filter.
    expect(inserted.socialLinks).toEqual([{ type: "github", label: null, url: "https://github.com/ada" }]);
  });

  it("is null-safe when the global profile is absent — writes explicit nulls + empty socialLinks", async () => {
    getUserProfileMock.mockReset();
    getUserProfileMock.mockResolvedValue(null);

    const db = createSequenceDb({ inserts: [[profileRow()]] });

    await materializeCompanyProfileFromGlobal(db as any, "company-1", "operator-1", "operator-1");

    expect(getUserProfileMock).toHaveBeenCalledWith(db, "operator-1");
    const inserted = db._insertValues[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      companyId: "company-1",
      userId: "operator-1",
      displayName: null,
      title: null,
      bio: null,
      timezone: null,
      updatedByUserId: "operator-1",
    });
    expect(inserted.socialLinks).toEqual([]);
  });

  it("propagates errors so best-effort handling stays with the caller", async () => {
    getUserProfileMock.mockReset();
    getUserProfileMock.mockRejectedValue(new Error("boom"));

    const db = createSequenceDb();

    await expect(
      materializeCompanyProfileFromGlobal(db as any, "company-1", "user-1", "attrib-1"),
    ).rejects.toThrow("boom");
  });
});

describe("ensureCompanyProfileFromGlobal", () => {
  it("uses insert-on-conflict-do-nothing so replay cannot clobber later company edits", async () => {
    getUserProfileMock.mockReset();
    getUserProfileMock.mockResolvedValue({
      userId: "user-1",
      displayName: "Global Name",
      title: "Global Title",
      bio: null,
      timezone: "UTC",
      socialLinks: [],
    });
    const db = createSequenceDb();

    await ensureCompanyProfileFromGlobal(db as any, "company-1", "user-1", "attrib-1");

    expect(db._insertValues[0]).toMatchObject({
      companyId: "company-1",
      userId: "user-1",
      displayName: "Global Name",
      title: "Global Title",
      updatedByUserId: "attrib-1",
    });
    expect(db._conflictUpdates).toEqual([]);
    expect(db._conflictDoNothingCalls()).toBe(1);
  });
});
