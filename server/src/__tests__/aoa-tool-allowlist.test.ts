// server/src/__tests__/aoa-tool-allowlist.test.ts
//
// D2: Per-agent tool allowlist (Decision #95 access model)
// Tests that AoA agents are subject to default-deny tool allowlist enforcement:
//   - absent/empty allowlist → deny
//   - tool in allowlist → allow (still subject to role/capability gates)
//   - non-AoA agents → existing behavior (not gated by allowlist)

import { describe, expect, it } from "vitest";
import {
  authorizeToolInvocation,
} from "../services/internal-agent/authorize-tool.js";
import type { AgentTool } from "../services/internal-agent/types.js";

// ── Minimal tool stubs ───────────────────────────────────────────────────────

function makeTool(name: string, category: "action" | "discussion" | "query" | "memory" | "workflow" | "file" | "coordination" | "analysis" = "query"): AgentTool {
  return {
    name,
    description: `stub tool: ${name}`,
    parameters: { type: "object", properties: {} },
    category,
    requiredRole: "founder",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "stub" }),
  };
}

const submitTool = makeTool("submit_extracted_items", "discussion");
const delegateTool = makeTool("delegate_to_subagent", "action");
const queryTasksTool = makeTool("query_tasks", "query");

// Capabilities needed to pass the capability gate for discussion tools
const discussionCaps = ["discussion_processing"];
const actionCaps = ["system_actions"];
const queryCaps: string[] = [];

// ── authorizeToolInvocation — AoA allowlist gate ─────────────────────────────

describe("D2: AoA tool allowlist — authorizeToolInvocation", () => {

  describe("non-AoA agent (no agentKind) — allowlist gate is bypassed", () => {
    it("allows a tool even without opts (existing Commander path)", () => {
      const result = authorizeToolInvocation(
        queryTasksTool,
        "founder",
        queryCaps,
        // no opts → non-AoA path
      );
      expect(result.allowed).toBe(true);
    });

    it("allows a tool when agentKind is not 'aoa'", () => {
      const result = authorizeToolInvocation(
        queryTasksTool,
        "founder",
        queryCaps,
        { agentKind: "internal" },
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("AoA agent — default-deny when allowlist is absent/empty", () => {
    it("denies when opts.agentKind='aoa' and no toolAllowlist provided", () => {
      const result = authorizeToolInvocation(
        submitTool,
        "founder",
        discussionCaps,
        { agentKind: "aoa" },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("NOT_IN_ALLOWLIST");
        expect(result.summary).toContain("submit_extracted_items");
      }
    });

    it("denies when toolAllowlist is empty array", () => {
      const result = authorizeToolInvocation(
        submitTool,
        "founder",
        discussionCaps,
        { agentKind: "aoa", toolAllowlist: [] },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("NOT_IN_ALLOWLIST");
      }
    });

    it("denies when tool is NOT in the allowlist", () => {
      const result = authorizeToolInvocation(
        delegateTool,
        "founder",
        actionCaps,
        { agentKind: "aoa", toolAllowlist: ["submit_extracted_items"] },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("NOT_IN_ALLOWLIST");
        expect(result.summary).toContain("delegate_to_subagent");
      }
    });
  });

  describe("AoA agent — tool in allowlist is allowed (still subject to other gates)", () => {
    it("allows submit_extracted_items when it is in the allowlist", () => {
      const result = authorizeToolInvocation(
        submitTool,
        "founder",
        discussionCaps,
        { agentKind: "aoa", toolAllowlist: ["submit_extracted_items"] },
      );
      expect(result.allowed).toBe(true);
    });

    it("allows delegate_to_subagent when it is in the allowlist", () => {
      const result = authorizeToolInvocation(
        delegateTool,
        "founder",
        actionCaps,
        { agentKind: "aoa", toolAllowlist: ["delegate_to_subagent", "query_tasks"] },
      );
      expect(result.allowed).toBe(true);
    });

    it("allows query_tasks (no capability gate) when in allowlist", () => {
      const result = authorizeToolInvocation(
        queryTasksTool,
        "founder",
        [],
        { agentKind: "aoa", toolAllowlist: ["query_tasks"] },
      );
      expect(result.allowed).toBe(true);
    });

    it("tool in allowlist but wrong role → FORBIDDEN_ROLE (allowlist alone is not enough)", () => {
      const memberOnlyTool: AgentTool = {
        ...submitTool,
        requiredRole: "founder",
      };
      const result = authorizeToolInvocation(
        memberOnlyTool,
        "team_member", // rank 0, submit_extracted_items requires founder (rank 2)
        discussionCaps,
        { agentKind: "aoa", toolAllowlist: ["submit_extracted_items"] },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("FORBIDDEN_ROLE");
      }
    });

    it("tool in allowlist but missing capability → CAPABILITY_DISABLED", () => {
      const result = authorizeToolInvocation(
        submitTool,
        "founder",
        [], // discussion_processing capability missing
        { agentKind: "aoa", toolAllowlist: ["submit_extracted_items"] },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error).toBe("CAPABILITY_DISABLED");
      }
    });
  });

  describe("Extraction agent scenario: allowlist = [submit_extracted_items]", () => {
    const extractionAllowlist = ["submit_extracted_items"];

    it("submit_extracted_items → allowed", () => {
      expect(authorizeToolInvocation(submitTool, "founder", discussionCaps, { agentKind: "aoa", toolAllowlist: extractionAllowlist }).allowed).toBe(true);
    });

    it("delegate_to_subagent → denied (not in extraction allowlist)", () => {
      const r = authorizeToolInvocation(delegateTool, "founder", actionCaps, { agentKind: "aoa", toolAllowlist: extractionAllowlist });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.error).toBe("NOT_IN_ALLOWLIST");
    });

    it("query_tasks → denied (not in extraction allowlist)", () => {
      const r = authorizeToolInvocation(queryTasksTool, "founder", [], { agentKind: "aoa", toolAllowlist: extractionAllowlist });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.error).toBe("NOT_IN_ALLOWLIST");
    });
  });

  describe("Commander scenario: allowlist includes delegate_to_subagent but NOT submit_extracted_items", () => {
    const commanderAllowlist = [
      "delegate_to_subagent",
      "query_tasks",
      "query_goals",
      "create_task",
    ];

    it("delegate_to_subagent → allowed", () => {
      expect(authorizeToolInvocation(delegateTool, "founder", actionCaps, { agentKind: "aoa", toolAllowlist: commanderAllowlist }).allowed).toBe(true);
    });

    it("query_tasks → allowed", () => {
      expect(authorizeToolInvocation(queryTasksTool, "founder", [], { agentKind: "aoa", toolAllowlist: commanderAllowlist }).allowed).toBe(true);
    });

    it("submit_extracted_items → denied (not in commander allowlist)", () => {
      const r = authorizeToolInvocation(submitTool, "founder", discussionCaps, { agentKind: "aoa", toolAllowlist: commanderAllowlist });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.error).toBe("NOT_IN_ALLOWLIST");
    });
  });
});
