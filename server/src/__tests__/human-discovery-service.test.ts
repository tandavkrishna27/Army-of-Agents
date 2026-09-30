import { describe, expect, it, vi } from "vitest";

const mockTeam = vi.hoisted(() => ({
  listTeam: vi.fn(),
  getDependencies: vi.fn(),
}));

vi.mock("../services/team.js", () => ({
  teamService: () => mockTeam,
}));

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
    companyUserCapabilityDocuments: makeTable("company_user_capability_documents"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  eq: (..._args: unknown[]) => "eq",
  inArray: (..._args: unknown[]) => "inArray",
}));

import { humanDiscoveryService } from "../services/human-discovery.js";

function makeMember(overrides: Record<string, unknown>) {
  return {
    userId: "user-1",
    email: "ada@example.com",
    displayName: "Ada Lovelace",
    avatarUrl: null,
    title: "Product Strategist",
    bio: "Turns messy founder intent into product strategy.",
    location: "London",
    timezone: "Europe/London",
    socialLinks: [],
    avatarAssetId: null,
    role: "team_lead",
    departmentId: "dept-product",
    departmentName: "Product",
    permissions: [],
    isCurrentUser: false,
    isSystemAdmin: false,
    parentType: "user",
    parentId: "founder-1",
    ...overrides,
  };
}

function createDb(documentRows: Array<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (value: Array<Record<string, unknown>>) => unknown) =>
    Promise.resolve(resolve(documentRows));
  return {
    select: () => chain,
  };
}

describe("humanDiscoveryService", () => {
  it("searches active company humans across identity, authority, responsibilities, and capability documents", async () => {
    mockTeam.listTeam.mockResolvedValue({
      currentUser: { userId: "founder-1", role: "founder", departmentId: null, isSystemAdmin: true, permissions: {} },
      members: [
        makeMember({ userId: "founder-1", displayName: "Grace Founder", role: "founder", title: "CEO", parentId: null, parentType: null }),
        makeMember({ userId: "user-1" }),
        makeMember({ userId: "user-2", email: "ops@example.com", displayName: "Ops Lead", title: "Operations", role: "team_member", departmentName: "Ops" }),
      ],
      pendingInvites: [],
    });
    mockTeam.getDependencies.mockImplementation(async (_companyId: string, userId: string) => ({
      teamMembers: userId === "user-1" ? [{ userId: "report-1", displayName: "Report", email: null, role: "team_member" }] : [],
      agentTrees: userId === "user-1" ? [{ rootAgentId: "agent-1", rootAgentName: "Research", subAgentCount: 1, agentIds: ["agent-1"] }] : [],
      assignedTaskCount: userId === "user-1" ? 4 : 0,
      createdTaskCount: userId === "user-1" ? 2 : 0,
    }));
    const db = createDb([
      {
        id: "doc-1",
        companyId: "company-1",
        userId: "user-1",
        filename: "skills.md",
        title: "Skills",
        kind: "skills",
        content: "Strong in enterprise routing alpha and product strategy.",
      },
      {
        id: "doc-2",
        companyId: "other-company",
        userId: "other-user",
        filename: "skills.md",
        title: "Skills",
        kind: "skills",
        content: "enterprise routing alpha should not leak",
      },
    ]);

    const result = await humanDiscoveryService(db as never).search("company-1", {
      q: "enterprise routing alpha",
      role: "team_lead",
      limit: 10,
    });

    expect(mockTeam.listTeam).toHaveBeenCalledWith("company-1", null);
    expect(result.companyId).toBe("company-1");
    expect(result.query).toBe("enterprise routing alpha");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      userId: "user-1",
      displayName: "Ada Lovelace",
      role: "team_lead",
      departmentName: "Product",
      reportsToUserId: "founder-1",
      reportsToName: "Grace Founder",
      matchedFields: ["capability_document"],
      responsibilitySummary: {
        directHumanReportCount: 1,
        directAgentTreeCount: 1,
        assignedTaskCount: 4,
        createdTaskCount: 2,
      },
    });
    expect(result.results[0]?.snippets[0]).toMatchObject({
      field: "capability_document",
      label: "Skills",
      filename: "skills.md",
    });
    expect(result.results[0]?.snippets[0]?.value).toContain("enterprise routing alpha");
  });

  it("matches identity and authority fields, applies department filter, and respects limit", async () => {
    mockTeam.listTeam.mockResolvedValue({
      currentUser: { userId: "founder-1", role: "founder", departmentId: null, isSystemAdmin: true, permissions: {} },
      members: [
        makeMember({ userId: "founder-1", displayName: "Grace Founder", role: "founder", departmentId: null, departmentName: null, parentId: null, parentType: null }),
        makeMember({ userId: "user-1", title: "Security Reviewer", departmentId: "dept-security", departmentName: "Security" }),
        makeMember({ userId: "user-2", email: "secops@example.com", displayName: "Sec Ops", title: "Security Operations", departmentId: "dept-security", departmentName: "Security" }),
        makeMember({ userId: "user-3", displayName: "Product Lead", title: "Security Adjacent", departmentId: "dept-product", departmentName: "Product" }),
      ],
      pendingInvites: [],
    });
    mockTeam.getDependencies.mockResolvedValue({
      teamMembers: [],
      agentTrees: [],
      assignedTaskCount: 0,
      createdTaskCount: 0,
    });
    const db = createDb([]);

    const result = await humanDiscoveryService(db as never).search("company-1", {
      q: "security",
      departmentId: "dept-security",
      limit: 1,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.departmentId).toBe("dept-security");
    expect(result.results[0]?.matchedFields).toContain("identity");
  });
});
