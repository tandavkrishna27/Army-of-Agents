import { describe, expect, it, vi } from "vitest";
import { createQueryTools } from "../services/internal-agent/tools/query-tools.js";

const humanBundle = {
  companyId: "company-1",
  userId: "user-1",
  generatedAt: new Date("2026-07-08T10:00:00.000Z"),
  identity: {
    userId: "user-1",
    email: "ada@example.com",
    displayName: "Ada Lovelace",
    title: "Product Strategist",
    bio: null,
    location: null,
    timezone: null,
    socialLinks: [],
  },
  authority: {
    role: "team_lead",
    departmentId: "dept-product",
    departmentName: "Product",
    reportsToUserId: "founder-1",
    reportsToName: "Grace Founder",
    isSystemAdmin: false,
    explicitGrants: [],
  },
  responsibility: {
    directHumanReports: [],
    directAgentTrees: [],
    assignedTaskCount: 0,
    createdTaskCount: 0,
  },
  capabilities: [],
  markdown: "## Authority\n- Role: team_lead",
};

const humanSearchResult = {
  userId: "user-1",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  avatarUrl: null,
  title: "Product Strategist",
  role: "team_lead",
  departmentId: "dept-product",
  departmentName: "Product",
  reportsToUserId: "founder-1",
  reportsToName: "Grace Founder",
  matchedFields: ["capability_document"],
  snippets: [{ field: "capability_document", label: "Skills", value: "enterprise routing alpha" }],
  responsibilitySummary: {
    directHumanReportCount: 0,
    directAgentTreeCount: 1,
    assignedTaskCount: 2,
    createdTaskCount: 0,
  },
};

describe("query_human_context tool", () => {
  it("returns structured bundle data and markdown for a requested human", async () => {
    const getBundle = vi.fn().mockResolvedValue(humanBundle);

    const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");
    expect(tool).toBeDefined();

    const result = await tool!.execute({ userId: "user-1" }, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanContext: { getBundle }, humanDiscovery: { search: vi.fn() } },
    } as never);

    expect(getBundle).toHaveBeenCalledWith("company-1", "user-1", "commander-user-1");
    expect(result.success).toBe(true);
    expect((result.data as any).mode).toBe("direct_context");
    expect((result.data as any).bundle.identity.displayName).toBe("Ada Lovelace");
    expect((result.data as any).bundle.markdown).toContain("## Authority");
    expect(result.summary).toContain("Ada Lovelace");
  });

  it("resolves a single query match into full human context", async () => {
    const search = vi.fn().mockResolvedValue({
      companyId: "company-1",
      query: "enterprise routing alpha",
      results: [humanSearchResult],
    });
    const getBundle = vi.fn().mockResolvedValue(humanBundle);
    const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");

    const result = await tool!.execute({ q: " enterprise routing alpha " }, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanContext: { getBundle }, humanDiscovery: { search } },
    } as never);

    expect(search).toHaveBeenCalledWith("company-1", {
      q: "enterprise routing alpha",
      role: "all",
      limit: 5,
    });
    expect(getBundle).toHaveBeenCalledWith("company-1", "user-1", "commander-user-1");
    expect(result.success).toBe(true);
    expect((result.data as any).mode).toBe("resolved_context");
    expect((result.data as any).selectedHuman.displayName).toBe("Ada Lovelace");
    expect((result.data as any).candidates).toHaveLength(1);
    expect((result.data as any).bundle.identity.displayName).toBe("Ada Lovelace");
    expect(result.summary).toContain("Resolved");
  });

  it("returns candidates without context when a query has multiple matches", async () => {
    const secondResult = { ...humanSearchResult, userId: "user-2", displayName: "Grace Hopper" };
    const search = vi.fn().mockResolvedValue({
      companyId: "company-1",
      query: "strategy",
      results: [humanSearchResult, secondResult],
    });
    const getBundle = vi.fn();
    const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");

    const result = await tool!.execute({ q: "strategy", limit: 2 }, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanContext: { getBundle }, humanDiscovery: { search } },
    } as never);

    expect(search).toHaveBeenCalledWith("company-1", { q: "strategy", role: "all", limit: 2 });
    expect(getBundle).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect((result.data as any).mode).toBe("multiple_matches");
    expect((result.data as any).bundle).toBeNull();
    expect((result.data as any).candidates).toHaveLength(2);
  });

  it("returns no_match without context when a query has no matches", async () => {
    const search = vi.fn().mockResolvedValue({
      companyId: "company-1",
      query: "unknown capability",
      results: [],
    });
    const getBundle = vi.fn();
    const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");

    const result = await tool!.execute({ q: "unknown capability" }, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanContext: { getBundle }, humanDiscovery: { search } },
    } as never);

    expect(getBundle).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect((result.data as any).mode).toBe("no_match");
    expect((result.data as any).bundle).toBeNull();
    expect(result.summary).toContain("No humans found");
  });

  it("does not treat generic roster questions as a single human context target", async () => {
    const search = vi.fn();
    const getBundle = vi.fn();
    const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");

    const result = await tool!.execute({ q: "humans in this organization" }, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanContext: { getBundle }, humanDiscovery: { search } },
    } as never);

    expect(search).not.toHaveBeenCalled();
    expect(getBundle).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.summary).toContain("Use query_humans");
  });

  it("uses userId when both userId and query are provided", async () => {
    const search = vi.fn();
    const getBundle = vi.fn().mockResolvedValue(humanBundle);
    const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");

    const result = await tool!.execute({ userId: "user-1", q: "strategy" }, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanContext: { getBundle }, humanDiscovery: { search } },
    } as never);

    expect(search).not.toHaveBeenCalled();
    expect(getBundle).toHaveBeenCalledWith("company-1", "user-1", "commander-user-1");
    expect((result.data as any).mode).toBe("direct_context");
  });

  it("fails clearly when userId and query are missing", async () => {
    const tool = createQueryTools().find((candidate) => candidate.name === "query_human_context");

    const result = await tool!.execute({}, {
      companyId: "company-1",
      userId: "commander-user-1",
      services: { humanContext: { getBundle: vi.fn() }, humanDiscovery: { search: vi.fn() } },
    } as never);

    expect(result).toEqual({
      success: false,
      error: "userId or q is required",
      data: null,
      summary: "Missing human context target",
    });
  });
});
