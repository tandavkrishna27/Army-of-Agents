import { describe, expect, it, vi } from "vitest";

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

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import { teamService } from "../services/team.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];
  const updateSets: Record<string, unknown>[] = [];
  const insertValues: Record<string, unknown>[] = [];
  const conflictUpdates: Record<string, unknown>[] = [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.onConflictDoUpdate = (value: { set?: Record<string, unknown> }) => {
      if (value.set) conflictUpdates.push(value.set);
      return chain;
    };
    chain.set = (value: Record<string, unknown>) => {
      updateSets.push(value);
      return chain;
    };
    chain.values = (value: Record<string, unknown>) => {
      insertValues.push(value);
      return chain;
    };
    chain.returning = () => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn(this);
    },
    _selectIdx: () => selectIdx,
    _updateSets: updateSets,
    _insertValues: insertValues,
    _conflictUpdates: conflictUpdates,
  };
}

describe("teamService human profile summaries", () => {
  it("uses company profile identity before auth identity and resolves avatar assets", async () => {
    const db = createSequenceDb({
      selects: [
        [{ principalId: "user-1", status: "active", parentType: null, parentId: null, isSystemAdmin: false }],
        [{ id: "user-1", email: "user@example.com", displayName: "Auth Name", avatarUrl: "https://auth/avatar.png", image: "https://auth/image.png", name: "Fallback Name" }],
        [{ userId: "user-1", displayName: "Profile Name", title: "CEO", bio: "Builds the thing", location: "Bengaluru", timezone: "Asia/Kolkata", socialLinks: [{ type: "github", label: null, url: "https://github.com/example" }], avatarAssetId: "11111111-1111-4111-8111-111111111111" }],
        [{ userId: "user-1", role: "founder", projectId: null }],
        [],
        [],
        [],
        [],
        [],
        [{ role: "founder", projectId: null }],
      ],
    });

    const summary = await teamService(db as any).listTeam("company-1", "user-1");

    expect(summary.members[0]).toMatchObject({
      userId: "user-1",
      displayName: "Profile Name",
      avatarUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
      title: "CEO",
      bio: "Builds the thing",
      location: "Bengaluru",
      timezone: "Asia/Kolkata",
      avatarAssetId: "11111111-1111-4111-8111-111111111111",
      socialLinks: [{ type: "github", label: null, url: "https://github.com/example" }],
    });
  });

  it("falls back to auth identity when no company profile exists", async () => {
    const db = createSequenceDb({
      selects: [
        [{ principalId: "user-1", status: "active", parentType: null, parentId: null, isSystemAdmin: false }],
        [{ id: "user-1", email: "user@example.com", displayName: null, avatarUrl: null, image: "https://auth/image.png", name: "Auth Fallback" }],
        [],
        [{ userId: "user-1", role: "team_member", projectId: null }],
        [],
        [],
        [],
        [],
        [],
        [{ role: "team_member", projectId: null }],
      ],
    });

    const summary = await teamService(db as any).listTeam("company-1", "user-1");

    expect(summary.members[0]).toMatchObject({
      displayName: "Auth Fallback",
      avatarUrl: "https://auth/image.png",
      title: null,
      bio: null,
      location: null,
      timezone: null,
      socialLinks: [],
      avatarAssetId: null,
    });
  });
});

describe("teamService profile updates", () => {
  it("rejects avatar assets from another company", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "mem-1", status: "active" }],
        [],
      ],
    });

    await expect(
      teamService(db as any).updateCompanyUserProfile("company-1", "user-1", {
        avatarAssetId: "22222222-2222-4222-8222-222222222222",
      }, "actor-1"),
    ).rejects.toThrow("Avatar asset not found");
  });

  it("rejects non-image avatar assets", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "mem-1", status: "active" }],
        [{ id: "asset-1", companyId: "company-1", contentType: "application/pdf" }],
      ],
    });

    await expect(
      teamService(db as any).updateCompanyUserProfile("company-1", "user-1", {
        avatarAssetId: "33333333-3333-4333-8333-333333333333",
      }, "actor-1"),
    ).rejects.toThrow("Avatar asset must be an image");
  });

  it("accepts same-company image avatar assets", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "mem-1", status: "active" }],
        [{ id: "44444444-4444-4444-8444-444444444444", companyId: "company-1", contentType: "image/png" }],
      ],
      inserts: [
        [{
          id: "profile-1",
          companyId: "company-1",
          userId: "user-1",
          displayName: null,
          title: null,
          bio: null,
          location: null,
          timezone: null,
          socialLinks: [],
          avatarAssetId: "44444444-4444-4444-8444-444444444444",
          createdAt: new Date("2026-07-07T00:00:00.000Z"),
          updatedAt: new Date("2026-07-07T00:00:00.000Z"),
          updatedByUserId: "actor-1",
        }],
      ],
    });

    await expect(
      teamService(db as any).updateCompanyUserProfile("company-1", "user-1", {
        avatarAssetId: "44444444-4444-4444-8444-444444444444",
      }, "actor-1"),
    ).resolves.toMatchObject({
      avatarAssetId: "44444444-4444-4444-8444-444444444444",
      updatedByUserId: "actor-1",
    });
  });

  it("sets updatedByUserId and updatedAt on profile upsert insert and update payloads", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "mem-1", status: "active" }],
      ],
      inserts: [
        [{
          id: "profile-1",
          companyId: "company-1",
          userId: "user-1",
          displayName: "Profile Name",
          title: "Operator",
          bio: null,
          location: null,
          timezone: null,
          socialLinks: [],
          avatarAssetId: null,
          createdAt: new Date("2026-07-07T00:00:00.000Z"),
          updatedAt: new Date("2026-07-07T00:00:00.000Z"),
          updatedByUserId: "actor-1",
        }],
      ],
    });

    await teamService(db as any).updateCompanyUserProfile("company-1", "user-1", {
      displayName: "Profile Name",
      title: "Operator",
    }, "actor-1");

    expect(db._insertValues[0]).toMatchObject({
      companyId: "company-1",
      userId: "user-1",
      displayName: "Profile Name",
      title: "Operator",
      updatedByUserId: "actor-1",
    });
    expect(db._insertValues[0].updatedAt).toBeInstanceOf(Date);
    expect(db._conflictUpdates[0]).toMatchObject({
      displayName: "Profile Name",
      title: "Operator",
      updatedByUserId: "actor-1",
    });
    expect(db._conflictUpdates[0].updatedAt).toBeInstanceOf(Date);
  });
});

describe("teamService dependencies", () => {
  it("returns root and sub-agent ids for each direct agent tree", async () => {
    const db = createSequenceDb({
      selects: [
        [],
        [{ id: "agent-1", name: "Agent Alpha" }],
        [{ id: "sub-1" }, { id: "sub-2" }],
        [],
        [],
      ],
    });

    const reports = await teamService(db as any).getReportsFor("company-1", "user-1");

    expect(reports.agentTrees[0]).toMatchObject({
      rootAgentId: "agent-1",
      rootAgentName: "Agent Alpha",
      subAgentCount: 2,
      agentIds: ["agent-1", "sub-1", "sub-2"],
    });
  });
});
