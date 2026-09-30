import { describe, expect, it, vi } from "vitest";

const mockTeam = vi.hoisted(() => ({
  listTeam: vi.fn(),
  getDependencies: vi.fn(),
}));

const mockCapabilities = vi.hoisted(() => ({
  listDocuments: vi.fn(),
}));

vi.mock("../services/team.js", () => ({
  teamService: () => mockTeam,
}));

vi.mock("../services/human-capabilities.js", () => ({
  humanCapabilitiesService: () => mockCapabilities,
}));

import { humanContextService } from "../services/human-context.js";

describe("humanContextService", () => {
  it("composes identity, authority, responsibilities, capabilities, and markdown", async () => {
    const updatedAt = new Date("2026-07-08T10:00:00.000Z");
    mockTeam.listTeam.mockResolvedValue({
      currentUser: {
        userId: "founder-1",
        role: "founder",
        departmentId: null,
        isSystemAdmin: true,
        permissions: {
          canAssignTasks: true,
          canInviteUsers: true,
          canManageRoles: true,
          canEditIdentityMemory: true,
        },
      },
      members: [
        {
          userId: "founder-1",
          email: "grace@example.com",
          displayName: "Grace Founder",
          avatarUrl: null,
          title: "Founder",
          bio: null,
          location: null,
          timezone: null,
          socialLinks: [],
          avatarAssetId: null,
          role: "founder",
          departmentId: null,
          departmentName: null,
          permissions: [],
          isCurrentUser: true,
          isSystemAdmin: true,
          parentType: null,
          parentId: null,
        },
        {
          userId: "user-1",
          email: "ada@example.com",
          displayName: "Ada Lovelace",
          avatarUrl: null,
          title: "Product Strategist",
          bio: "Turns messy founder intent into crisp product direction.",
          location: "London",
          timezone: "Europe/London",
          socialLinks: [{ type: "linkedin", label: "LinkedIn", url: "https://linkedin.com/in/ada" }],
          avatarAssetId: null,
          role: "team_lead",
          departmentId: "dept-product",
          departmentName: "Product",
          permissions: ["team.manage_roles"],
          isCurrentUser: false,
          isSystemAdmin: false,
          parentType: "user",
          parentId: "founder-1",
        },
      ],
      pendingInvites: [],
    });
    mockTeam.getDependencies.mockResolvedValue({
      teamMembers: [{ userId: "report-1", displayName: "Direct Report", email: "report@example.com", role: "team_member" }],
      agentTrees: [{ rootAgentId: "agent-1", rootAgentName: "Research Lead", subAgentCount: 2, agentIds: ["agent-1", "agent-2"] }],
      assignedTaskCount: 3,
      createdTaskCount: 5,
    });
    mockCapabilities.listDocuments.mockResolvedValue({
      companyId: "company-1",
      userId: "user-1",
      documents: [
        {
          id: "doc-1",
          companyId: "company-1",
          userId: "user-1",
          slug: "skills",
          filename: "skills.md",
          title: "Skills",
          kind: "skills",
          content: "Product strategy\n\nAgent operations",
          sortOrder: 20,
          isStandard: true,
          createdAt: updatedAt,
          updatedAt,
          createdByUserId: null,
          updatedByUserId: "founder-1",
        },
      ],
    });

    const bundle = await humanContextService({} as never).getBundle("company-1", "user-1", "founder-1");

    expect(mockTeam.listTeam).toHaveBeenCalledWith("company-1", "founder-1");
    expect(mockCapabilities.listDocuments).toHaveBeenCalledWith("company-1", "user-1", "founder-1");
    expect(bundle.identity.displayName).toBe("Ada Lovelace");
    expect(bundle.authority.role).toBe("team_lead");
    expect(bundle.authority.departmentName).toBe("Product");
    expect(bundle.authority.reportsToName).toBe("Grace Founder");
    expect(bundle.authority.explicitGrants).toEqual(["team.manage_roles"]);
    expect(bundle.responsibility.directHumanReports).toHaveLength(1);
    expect(bundle.responsibility.directAgentTrees).toHaveLength(1);
    expect(bundle.responsibility.assignedTaskCount).toBe(3);
    expect(bundle.capabilities.map((doc) => doc.filename)).toContain("skills.md");
    expect(bundle.capabilities[0]?.content).toContain("Product strategy");
    expect(bundle.markdown).toContain("## Identity");
    expect(bundle.markdown).toContain("## Authority");
    expect(bundle.markdown).toContain("## Responsibilities");
    expect(bundle.markdown).toContain("## Capability Documents");
    expect(bundle.markdown).toContain("Product strategy");
  });

  it("throws when the requested human is not a company member", async () => {
    mockTeam.listTeam.mockResolvedValue({
      currentUser: { userId: null, role: null, departmentId: null, isSystemAdmin: false, permissions: {} },
      members: [],
      pendingInvites: [],
    });

    await expect(
      humanContextService({} as never).getBundle("company-1", "missing-user", null),
    ).rejects.toThrow("Team member not found");
  });
});
