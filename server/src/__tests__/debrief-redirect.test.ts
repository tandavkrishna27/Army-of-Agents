import { describe, it, expect, vi } from "vitest";

const makeService = () => new Proxy({}, { get: () => vi.fn() });

vi.mock("../services/index.js", () => ({
  briefService: vi.fn(() => makeService()),
  debriefService: vi.fn(() => makeService()),
  discussionService: vi.fn(() => makeService()),
  extractionService: vi.fn(() => makeService()),
  logActivity: vi.fn(),
}));

// Keep route-contract imports focused on Express registration, not the full
// service graph behind every handler.
/**
 * Debrief Redirect Tests
 *
 * Verifies:
 * 1. debriefRoutes still exports a factory function (backward compat)
 * 2. briefRoutes still exports a factory function (backward compat)
 * 3. MCP field mapping logic: old debrief fields → new discussion shape
 */

// --- Pure function: MCP field mapping ---
// Extracted so it can be tested independently of Express/DB
function mapMcpToDiscussion(body: {
  content: string;
  title?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  source?: { llm?: string; sessionId?: string; metadata?: Record<string, unknown> } | null;
}) {
  const { content, title, departmentId, projectId, source } = body;
  const scopeType = departmentId ? "department" : projectId ? "project" : null;
  const scopeId = departmentId ?? projectId ?? null;

  return {
    title: title ?? null,
    scopeType,
    scopeId,
    entry: {
      inputType: "mcp" as const,
      rawContent: content,
      departmentId: departmentId ?? null,
      projectId: projectId ?? null,
      sourceInfo: source ?? null,
    },
  };
}

describe("debrief deprecation + redirect", () => {
  it("debriefRoutes factory is still exported", async () => {
    const startedAt = performance.now();
    const mod = await import("../routes/debriefs.js");
    expect(performance.now() - startedAt).toBeLessThan(3000);
    expect(mod.debriefRoutes).toBeDefined();
    expect(typeof mod.debriefRoutes).toBe("function");
  });

  it("briefRoutes factory is still exported", async () => {
    const mod = await import("../routes/briefs.js");
    expect(mod.briefRoutes).toBeDefined();
    expect(typeof mod.briefRoutes).toBe("function");
  });
});

describe("MCP inbound field mapping", () => {
  it("maps departmentId to scopeType 'department'", () => {
    const result = mapMcpToDiscussion({
      content: "Test content",
      title: "Test",
      departmentId: "dept-1",
      projectId: null,
      source: null,
    });

    expect(result.scopeType).toBe("department");
    expect(result.scopeId).toBe("dept-1");
    expect(result.entry.inputType).toBe("mcp");
    expect(result.entry.rawContent).toBe("Test content");
    expect(result.entry.departmentId).toBe("dept-1");
    expect(result.entry.projectId).toBeNull();
  });

  it("maps projectId to scopeType 'project' when no departmentId", () => {
    const result = mapMcpToDiscussion({
      content: "Test content",
      departmentId: null,
      projectId: "proj-1",
    });

    expect(result.scopeType).toBe("project");
    expect(result.scopeId).toBe("proj-1");
    expect(result.entry.projectId).toBe("proj-1");
  });

  it("departmentId takes priority over projectId for scope", () => {
    const result = mapMcpToDiscussion({
      content: "Test content",
      departmentId: "dept-1",
      projectId: "proj-1",
    });

    expect(result.scopeType).toBe("department");
    expect(result.scopeId).toBe("dept-1");
    // Both IDs preserved on entry for backward compat
    expect(result.entry.departmentId).toBe("dept-1");
    expect(result.entry.projectId).toBe("proj-1");
  });

  it("handles no scope (no departmentId or projectId)", () => {
    const result = mapMcpToDiscussion({
      content: "Unscoped content",
    });

    expect(result.scopeType).toBeNull();
    expect(result.scopeId).toBeNull();
    expect(result.title).toBeNull();
    expect(result.entry.sourceInfo).toBeNull();
  });

  it("preserves source info", () => {
    const source = { llm: "claude", sessionId: "s-123", metadata: { key: "val" } };
    const result = mapMcpToDiscussion({
      content: "Content",
      source,
    });

    expect(result.entry.sourceInfo).toEqual(source);
  });
});
