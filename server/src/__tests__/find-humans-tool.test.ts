import { describe, expect, it, vi } from "vitest";
import { createQueryTools } from "../services/internal-agent/tools/query-tools.js";

describe("find_humans tool", () => {
  it("returns structured human discovery results for routing", async () => {
    const search = vi.fn().mockResolvedValue({
      companyId: "company-1",
      query: "enterprise security",
      results: [
        {
          userId: "user-1",
          email: "ada@example.com",
          displayName: "Ada Lovelace",
          avatarUrl: null,
          title: "Security Reviewer",
          role: "team_lead",
          departmentId: "dept-security",
          departmentName: "Security",
          reportsToUserId: "founder-1",
          reportsToName: "Grace Founder",
          matchedFields: ["identity", "capability_document"],
          snippets: [{ field: "capability_document", label: "Skills", value: "enterprise security reviews" }],
          responsibilitySummary: {
            directHumanReportCount: 0,
            directAgentTreeCount: 1,
            assignedTaskCount: 2,
            createdTaskCount: 0,
          },
        },
      ],
    });

    const tool = createQueryTools().find((candidate) => candidate.name === "find_humans");
    expect(tool).toBeDefined();
    expect(tool?.requiredRole).toBe("team_member");
    expect(tool?.requiresConfirmation).toBe(false);

    const result = await tool!.execute({ q: " enterprise security ", limit: 5 }, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanDiscovery: { search } },
    } as never);

    expect(search).toHaveBeenCalledWith("company-1", {
      q: "enterprise security",
      role: "all",
      limit: 5,
    });
    expect(result.success).toBe(true);
    expect((result.data as any).results[0].displayName).toBe("Ada Lovelace");
    expect(result.summary).toContain("Found 1 human(s)");
  });

  it("fails clearly when query is missing", async () => {
    const tool = createQueryTools().find((candidate) => candidate.name === "find_humans");

    const result = await tool!.execute({}, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanDiscovery: { search: vi.fn() } },
    } as never);

    expect(result).toEqual({
      success: false,
      error: "q is required",
      data: null,
      summary: "Missing search query",
    });
  });
});
