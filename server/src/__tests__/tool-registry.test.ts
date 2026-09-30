import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  getToolsForMessage,
  toolToAnthropicFormat,
  toolToOpenAIFormat,
  executeTool,
} from "../services/internal-agent/tool-registry.js";
import type { AgentTool, ToolContext } from "../services/internal-agent/types.js";

const mockCtx: ToolContext = {
  companyId: "comp-1",
  userId: "user-1",
  userRole: "founder",
  enabledCapabilities: [
    "discussion_processing",
    "system_actions",
    "memory_management",
  ],
  db: {} as any,
  services: {} as any,
};

describe("Tool Registry", () => {
  describe("createToolRegistry", () => {
    it("returns all 79 tools", () => {
      // Task C2 batch 1 (T15) added 7 thread+query tools to the 40 prior tools:
      // thread.listEntries, thread.setIntent, thread.postScopeProposal,
      // thread.updateSummary, thread.createLink, get_thread_summary,
      // find_similar_threads.
      // Task C2 batch 2 (T15) added 5 navigator+artifact+workspace tools:
      // attach_to_thread, spin_off_thread, create_artifact_version,
      // query_artifacts, request_thread_workspace.
      // Task C2 batch 3 (T15) added 7 memory tools:
      // extract_memory_candidates, extract_decisions, extract_insights,
      // extract_references, find_similar_memory_hnsw,
      // propose_memory_from_thread, archive_stale_memory.
      // Task C2 batch 4 (T15) added 1 coordination tool:
      // agent.dispatch (lower-level sibling to delegate_to_subagent).
      // Task 2.4 (crew work-as-tasks) added 1 action tool:
      // propose_crew_work.
      // Routing-card redesign (T8/T9) added 3 Navigator tools:
      // list_thread_cards, promote_inbox_to_thread, defer_inbox_to_human.
      // Spec B Task 2 added 1 query tool: get_task (company-scoped task read).
      // Spec B Task 3 added 2 coordination tools: post_task_comment +
      // attach_task_artifact (crew result-write; coordination confers no capability).
      // Spec B Task 4 added 1 coordination tool: set_task_status (crew own-task
      // transition, dial-gated via the A4 guard; coordination confers no capability).
      // Commander working memory added 3 temporary context tools:
      // remember_working_context, update_working_context, forget_working_context.
      // Task 10 (Commander Viewer P1) added 1 query tool:
      // query_company_artifacts (company-wide artifact listing, ctx.companyId-scoped).
      // Task 9 W3 added 1 memory tool:
      // write_memory (unified write+RAG-index, status=pending, Critical Rule #6).
      // W4 Steward added 2 coordination tools:
      // hub.readCurationContext (redacted curation read) and
      // hub.updateCurationSummary (bounded display-only hub curation write).
      // Human context bundle added 1 query tool:
      // query_human_context (Commander/internal-agent read of human profile context).
      // Human discovery/routing added 1 query tool:
      // find_humans (Commander/internal-agent read-only human search).
      // Commander broad roster discovery added 1 query tool:
      // query_humans (company-scoped human roster listing).
      // Unified team roster added 1 query tool:
      // query_team_roster (humans + org agents + readable hierarchy).
      // Plan 3 B2: +5 approval tools + get_heartbeat_context.
      const tools = createToolRegistry();
      expect(tools).toHaveLength(87);
    });

    it("every tool has required fields", () => {
      const tools = createToolRegistry();
      for (const tool of tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters.type).toBe("object");
        expect(tool.category).toBeTruthy();
        expect(typeof tool.requiredRole).toBe("string");
        expect(typeof tool.requiresConfirmation).toBe("boolean");
        expect(typeof tool.execute).toBe("function");
      }
    });

    it("has no duplicate tool names", () => {
      const tools = createToolRegistry();
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe("getToolsForMessage", () => {
    const allTools = createToolRegistry();

    it("always includes core 3 tools", () => {
      const tools = getToolsForMessage("hello", allTools);
      const names = tools.map((t) => t.name);
      expect(names).toContain("query_tasks");
      expect(names).toContain("query_memory");
      expect(names).toContain("query_goals");
    });

    it("includes action tools for creation intents", () => {
      const tools = getToolsForMessage("create a new task for the design team", allTools);
      const names = tools.map((t) => t.name);
      expect(names).toContain("create_task");
    });

    it("includes memory tools for memory-related messages", () => {
      const tools = getToolsForMessage("what do we remember about the onboarding process?", allTools);
      const names = tools.map((t) => t.name);
      expect(names).toContain("find_similar_memory");
    });

    it("returns max 15 tools", () => {
      const tools = getToolsForMessage("create a task and add memory and start a workflow and check dependencies", allTools);
      expect(tools.length).toBeLessThanOrEqual(15);
    });

    it("returns core + query tools for unclear intent", () => {
      const tools = getToolsForMessage("what's going on?", allTools);
      const categories = [...new Set(tools.map((t) => t.category))];
      expect(categories).toContain("query");
    });

    it("includes query_team_roster for broad team hierarchy questions", () => {
      const tools = getToolsForMessage("who is on the team and who reports to whom?", allTools);
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("query_team_roster");
    });

    it("keeps query_team_roster available when team wording appears with another intent", () => {
      const tools = getToolsForMessage("create a task after checking the team hierarchy", allTools);
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("create_task");
      expect(names).toContain("query_team_roster");
    });
  });

  describe("toolToAnthropicFormat", () => {
    it("produces correct Anthropic tool shape", () => {
      const tool = createToolRegistry()[0];
      const formatted = toolToAnthropicFormat(tool);
      expect(formatted).toHaveProperty("name", tool.name);
      expect(formatted).toHaveProperty("description", tool.description);
      expect(formatted).toHaveProperty("input_schema", tool.parameters);
    });
  });

  describe("toolToOpenAIFormat", () => {
    it("produces correct OpenAI function shape", () => {
      const tool = createToolRegistry()[0];
      const formatted = toolToOpenAIFormat(tool);
      expect(formatted.type).toBe("function");
      expect(formatted.function.name).toBe(tool.name);
      expect(formatted.function.description).toBe(tool.description);
      expect(formatted.function.parameters).toEqual(tool.parameters);
    });
  });

  describe("executeTool", () => {
    it("catches 403 errors and returns FORBIDDEN result", async () => {
      const tool: AgentTool = {
        name: "test_tool",
        description: "test",
        parameters: { type: "object", properties: {} },
        category: "query",
        requiredRole: "founder",
        requiresConfirmation: false,
        execute: async () => {
          const err = new Error("Forbidden") as any;
          err.status = 403;
          throw err;
        },
      };
      const result = await executeTool(tool, {}, mockCtx);
      expect(result.success).toBe(false);
      expect(result.error).toBe("FORBIDDEN");
    });

    it("catches general errors and returns INTERNAL result", async () => {
      const tool: AgentTool = {
        name: "test_tool",
        description: "test",
        parameters: { type: "object", properties: {} },
        category: "query",
        requiredRole: "founder",
        requiresConfirmation: false,
        execute: async () => { throw new Error("something broke"); },
      };
      const result = await executeTool(tool, {}, mockCtx);
      expect(result.success).toBe(false);
      expect(result.error).toBe("INTERNAL");
      expect(result.summary).toContain("something broke");
    });
  });
});
