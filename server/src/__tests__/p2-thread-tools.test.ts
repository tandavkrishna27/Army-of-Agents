import { describe, expect, it, vi } from "vitest";
import { createThreadTools } from "../services/internal-agent/tools/thread-tools.js";
import type { ToolContext } from "../services/internal-agent/types.js";

describe("Thread Tools (P2.1)", () => {
  describe("query_threads", () => {
    it("returns filtered ThreadSummary list", async () => {
      const tools = createThreadTools();
      const tool = tools.find((t) => t.name === "query_threads");
      expect(tool).toBeDefined();
      expect(tool?.category).toBe("query");
      expect(tool?.requiredRole).toBe("team_member");
      expect(tool?.requiresConfirmation).toBe(false);

      const mockThreads = [
        { id: "t-1", title: "Sprint Planning", phase: "scope", entryCount: 5, pendingItemCount: 2, scopeType: "project", scopeId: "proj-1" },
        { id: "t-2", title: "Team Sync", phase: "discuss", entryCount: 3, pendingItemCount: 0, scopeType: "department", scopeId: "dept-1" },
      ];
      const ctx = {
        companyId: "co-1",
        db: {} as any,
        services: { discussions: { list: vi.fn().mockResolvedValue(mockThreads) } },
      } as unknown as ToolContext;

      const result = await tool!.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(2);
      expect((result.data as any)[0].id).toBe("t-1");
      expect(result.summary).toContain("2");
    });

    it("filters threads by phase", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_threads")!;
      const mockThreads = [
        { id: "t-1", title: "Plan", phase: "scope", entryCount: 2, pendingItemCount: 1, scopeType: null, scopeId: null },
        { id: "t-2", title: "Discuss", phase: "discuss", entryCount: 1, pendingItemCount: 0, scopeType: null, scopeId: null },
        { id: "t-3", title: "Assign", phase: "scope", entryCount: 3, pendingItemCount: 2, scopeType: null, scopeId: null },
      ];
      const ctx = {
        companyId: "co-1",
        db: {} as any,
        services: { discussions: { list: vi.fn().mockResolvedValue(mockThreads) } },
      } as unknown as ToolContext;

      const result = await tool.execute({ phase: "scope" }, ctx);

      expect(result.success).toBe(true);
      const filtered = result.data as any[];
      expect(filtered).toHaveLength(2);
      expect(filtered.every((t) => t.phase === "scope")).toBe(true);
    });

    it("respects limit parameter", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_threads")!;
      const mockThreads = Array.from({ length: 50 }, (_, i) => ({
        id: `t-${i}`, title: `Thread ${i}`, phase: "discuss", entryCount: 1, pendingItemCount: 0, scopeType: null, scopeId: null,
      }));
      const ctx = {
        companyId: "co-1",
        db: {} as any,
        services: { discussions: { list: vi.fn().mockResolvedValue(mockThreads) } },
      } as unknown as ToolContext;

      const result = await tool.execute({ limit: 5 }, ctx);

      expect((result.data as any[]).length).toBe(5);
    });

    it("handles non-array return from discussions.list", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_threads")!;
      const ctx = {
        companyId: "co-1",
        db: {} as any,
        services: { discussions: { list: vi.fn().mockResolvedValue({}) } },
      } as unknown as ToolContext;

      const result = await tool.execute({}, ctx);

      expect(result.success).toBe(true);
      expect(result.summary).toContain("0");
    });
  });

  describe("query_extracted_items", () => {
    function makeMockDb(items: any[]) {
      return {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(items),
              }),
            }),
          }),
        }),
      };
    }

    it("returns items for a thread", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_extracted_items");
      expect(tool?.category).toBe("query");
      expect(tool?.requiredRole).toBe("team_member");
      expect(tool?.requiresConfirmation).toBe(false);

      const mockItems = [
        { id: "item-1", type: "task", title: "Build Feature", status: "pending", description: "Create dashboard", entryId: "entry-1", resultTaskId: null },
        { id: "item-2", type: "decision", title: "Use React", status: "approved", description: "Framework choice", entryId: "entry-1", resultTaskId: null },
      ];
      const ctx = { companyId: "co-1", db: makeMockDb(mockItems) as any, services: {} as any } as unknown as ToolContext;

      const result = await tool!.execute({ threadId: "thread-1" }, ctx);

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.summary).toContain("2");
    });

    it("filters items by status", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_extracted_items")!;
      const mockItems = [
        { id: "i-1", type: "task", title: "T1", status: "pending", description: "", entryId: "e-1", resultTaskId: null },
        { id: "i-2", type: "decision", title: "D1", status: "approved", description: "", entryId: "e-1", resultTaskId: null },
        { id: "i-3", type: "insight", title: "I1", status: "pending", description: "", entryId: "e-2", resultTaskId: null },
      ];
      const ctx = { companyId: "co-1", db: makeMockDb(mockItems) as any, services: {} as any } as unknown as ToolContext;

      const result = await tool.execute({ threadId: "t-1", status: "pending" }, ctx);

      const filtered = result.data as any[];
      expect(filtered).toHaveLength(2);
      expect(filtered.every((i) => i.status === "pending")).toBe(true);
    });

    it("filters items by type", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_extracted_items")!;
      const mockItems = [
        { id: "i-1", type: "task", title: "T1", status: "pending", description: "", entryId: "e-1", resultTaskId: null },
        { id: "i-2", type: "decision", title: "D1", status: "approved", description: "", entryId: "e-1", resultTaskId: null },
        { id: "i-3", type: "task", title: "T2", status: "approved", description: "", entryId: "e-2", resultTaskId: "issue-2" },
      ];
      const ctx = { companyId: "co-1", db: makeMockDb(mockItems) as any, services: {} as any } as unknown as ToolContext;

      const result = await tool.execute({ threadId: "t-1", type: "task" }, ctx);

      const filtered = result.data as any[];
      expect(filtered).toHaveLength(2);
      expect(filtered.every((i) => i.type === "task")).toBe(true);
    });

    it("filters items by both status and type", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_extracted_items")!;
      const mockItems = [
        { id: "i-1", type: "task", title: "T1", status: "pending", description: "", entryId: "e-1", resultTaskId: null },
        { id: "i-2", type: "decision", title: "D1", status: "approved", description: "", entryId: "e-1", resultTaskId: null },
        { id: "i-3", type: "task", title: "T2", status: "approved", description: "", entryId: "e-2", resultTaskId: "issue-2" },
      ];
      const ctx = { companyId: "co-1", db: makeMockDb(mockItems) as any, services: {} as any } as unknown as ToolContext;

      const result = await tool.execute({ threadId: "t-1", status: "approved", type: "task" }, ctx);

      const filtered = result.data as any[];
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe("i-3");
    });

    it("returns no extracted items for a thread outside the company", async () => {
      const tool = createThreadTools().find((t) => t.name === "query_extracted_items")!;
      const ctx = { companyId: "co-1", db: makeMockDb([]) as any, services: {} as any } as unknown as ToolContext;
      const result = await tool.execute({ threadId: "foreign-thread" }, ctx);
      expect(result).toMatchObject({ success: true, data: [] });
    });
  });
});
