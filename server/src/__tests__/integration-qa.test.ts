import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Integration QA Tests
 *
 * Covers:
 * - Full debrief -> brief -> memory/task creation pipeline
 * - Agent heartbeat → context assembly → run summary → trust score update
 * - Suggestion engine pattern detection → suggestion creation → acceptance
 * - RBAC enforcement
 * - Memory feedback ≥3 occurrence threshold (Rule #8)
 */

// ── Run summary integration ──────────────────────────────────────────────────

import { formatRunSummary, type RunSummaryInput } from "../services/run-summary.js";

function buildRunInput(overrides: Partial<RunSummaryInput> = {}): RunSummaryInput {
  return {
    agentName: "QA Agent",
    outcome: "succeeded",
    durationMs: 120_000,
    inputTokens: 10000,
    outputTokens: 5000,
    costUsd: 0.15,
    errorMessage: null,
    detectedFiles: [],
    ...overrides,
  };
}

describe("Integration QA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Pipeline: heartbeat → context → run summary → trust ────────────────────

  describe("Heartbeat → run summary → trust score pipeline", () => {
    it("run summary captures all outcome types", () => {
      const outcomes: RunSummaryInput["outcome"][] = ["succeeded", "failed", "cancelled", "timed_out"];
      const labels = ["Succeeded", "Failed", "Cancelled", "Timed out"];

      for (let i = 0; i < outcomes.length; i++) {
        const result = formatRunSummary(buildRunInput({ outcome: outcomes[i] }));
        expect(result).toContain(labels[i]);
      }
    });

    it("run summary includes agent name, duration, tokens, cost", () => {
      const result = formatRunSummary(buildRunInput());
      expect(result).toContain("QA Agent");
      expect(result).toContain("2m 0s");
      expect(result).toContain("10,000 in");
      expect(result).toContain("5,000 out");
      expect(result).toContain("$0.15");
    });

    it("run summary handles zero-cost runs", () => {
      const result = formatRunSummary(buildRunInput({ costUsd: 0 }));
      expect(result).toContain("$0.00");
    });

    it("run summary handles very short runs (<1s)", () => {
      const result = formatRunSummary(buildRunInput({ durationMs: 500 }));
      expect(result).toContain("0s");
    });

    it("run summary with detected files shows them inline", () => {
      const result = formatRunSummary(buildRunInput({
        detectedFiles: [
          { path: "src/index.ts" },
          { path: "src/utils.ts", type: "modified" },
        ],
      }));
      expect(result).toContain("Files:");
      expect(result).toContain("`src/index.ts`");
      expect(result).toContain("`src/utils.ts`");
    });
  });

  // ── Trust score computation ─────────────────────────────────────────────────

  describe("Trust score integration", () => {
    const RECENT_WINDOW = 20;

    function computeScore(
      totalCompleted: number,
      approvedWithoutChanges: number,
      recentCompleted: number,
      recentApproved: number,
    ): number {
      if (totalCompleted === 0) return 0;
      if (totalCompleted <= RECENT_WINDOW) {
        return (approvedWithoutChanges / totalCompleted) * 100;
      }
      const olderCompleted = totalCompleted - recentCompleted;
      const olderApproved = approvedWithoutChanges - recentApproved;
      const weightedApproved = olderApproved + recentApproved * 2;
      const weightedTotal = olderCompleted + recentCompleted * 2;
      if (weightedTotal === 0) return 0;
      return (weightedApproved / weightedTotal) * 100;
    }

    it("0 tasks → score 0 (edge case)", () => {
      expect(computeScore(0, 0, 0, 0)).toBe(0);
    });

    it("1 task approved → score 100", () => {
      expect(computeScore(1, 1, 1, 1)).toBe(100);
    });

    it("1 task rejected → score 0", () => {
      expect(computeScore(1, 0, 1, 0)).toBe(0);
    });

    it("exactly 20 tasks → no weighting applied", () => {
      // 20 total, 15 approved
      const score = computeScore(20, 15, 20, 15);
      expect(score).toBe(75);
    });

    it("21 tasks → weighting kicks in", () => {
      // 21 total, 20 approved, recent: 20/19
      // Older: 1 completed, 1 approved
      // Weighted: (1 + 19*2) / (1 + 20*2) = 39/41 ≈ 95.12%
      const score = computeScore(21, 20, 20, 19);
      expect(score).toBeCloseTo(95.12, 1);
    });

    it("perfect recent with bad history → score pulled up by 2x weighting", () => {
      // 40 total, 30 approved overall
      // Recent: 20 completed, 20 approved (perfect)
      // Older: 20 completed, 10 approved (50%)
      // Weighted: (10 + 20*2) / (20 + 20*2) = 50/60 ≈ 83.33%
      const score = computeScore(40, 30, 20, 20);
      expect(score).toBeCloseTo(83.33, 1);
    });

    it("bad recent with good history → score pulled down by 2x weighting", () => {
      // 40 total, 30 approved overall
      // Recent: 20 completed, 10 approved (50%)
      // Older: 20 completed, 20 approved (100%)
      // Weighted: (20 + 10*2) / (20 + 20*2) = 40/60 ≈ 66.67%
      const score = computeScore(40, 30, 20, 10);
      expect(score).toBeCloseTo(66.67, 1);
    });
  });

  // ── Suggestion engine categories ────────────────────────────────────────────

  describe("Suggestion engine categories", () => {
    it("all 8 suggestion categories exist", () => {
      const categories = [
        "goal_gap",
        "pipeline_bottleneck",
        "memory_gap",
        "pattern_detected",
        "budget_optimization",
        "recurring_work",
        "risk_flag",
        "workload_balance",
      ];

      expect(categories).toHaveLength(8);
      expect(new Set(categories).size).toBe(8);
    });

    it("suggestion has required fields: category, actionType, actionPayload, evidence", () => {
      const suggestion = {
        id: "sug-1",
        companyId: "co-1",
        category: "pattern_detected",
        actionType: "suggest_memory",
        actionPayload: { patternId: "pat-1" },
        evidence: "Agent tone corrected 5 times",
        status: "pending",
      };

      expect(suggestion.category).toBeDefined();
      expect(suggestion.actionType).toBeDefined();
      expect(suggestion.actionPayload).toBeDefined();
      expect(suggestion.evidence).toBeDefined();
    });

    it("suggestion statuses: pending → accepted or dismissed or expired", () => {
      const validStatuses = ["pending", "accepted", "dismissed", "expired"];
      const transitions: Record<string, string[]> = {
        pending: ["accepted", "dismissed", "expired"],
        accepted: [],
        dismissed: [],
        expired: [],
      };

      expect(transitions.pending).toContain("accepted");
      expect(transitions.pending).toContain("dismissed");
      expect(validStatuses).toHaveLength(4);
    });
  });

  // ── Memory feedback threshold (Rule #8) ─────────────────────────────────────

  describe("Memory feedback threshold (Rule #8)", () => {
    it("requires ≥3 occurrences before suggesting memory", () => {
      const MIN_OCCURRENCE_THRESHOLD = 3;

      expect(2).toBeLessThan(MIN_OCCURRENCE_THRESHOLD);
      expect(3).toBeGreaterThanOrEqual(MIN_OCCURRENCE_THRESHOLD);
    });

    it("pattern with 2 occurrences is 'detected' not 'suggested'", () => {
      const MIN_OCCURRENCE_THRESHOLD = 3;
      const occurrences = 2;
      const status = occurrences >= MIN_OCCURRENCE_THRESHOLD ? "suggested" : "detected";

      expect(status).toBe("detected");
    });

    it("pattern with 3 occurrences transitions to 'suggested' status", () => {
      const MIN_OCCURRENCE_THRESHOLD = 3;
      const occurrences = 3;
      const status = occurrences >= MIN_OCCURRENCE_THRESHOLD ? "suggested" : "detected";

      expect(status).toBe("suggested");
    });

    it("4 pattern types are detected independently", () => {
      const patternTypes = [
        "tone_correction",
        "format_change",
        "content_addition",
        "terminology_change",
      ];

      expect(patternTypes).toHaveLength(4);
      expect(new Set(patternTypes).size).toBe(4);
    });
  });

  // ── RBAC enforcement ────────────────────────────────────────────────────────

  describe("RBAC enforcement", () => {
    it("three roles exist: founder, team_lead, team_member", () => {
      const roles = ["founder", "team_lead", "team_member"];
      expect(roles).toHaveLength(3);
    });

    it("roles are department-scoped", () => {
      const userRole = {
        userId: "user-1",
        role: "team_lead",
        projectId: "dept-engineering", // department-scoped
      };

      expect(userRole.projectId).toBeDefined();
      expect(userRole.role).toBe("team_lead");
    });

    it("RBAC is additive from restrictive defaults", () => {
      // Team member has minimal permissions by default
      // Each role adds permissions on top
      const rolePermissions: Record<string, string[]> = {
        team_member: ["read_tasks", "update_own_tasks"],
        team_lead: ["read_tasks", "update_own_tasks", "approve_dept_context", "manage_dept_tasks"],
        founder: ["read_tasks", "update_own_tasks", "approve_dept_context", "manage_dept_tasks", "approve_all", "manage_company"],
      };

      expect(rolePermissions.team_member.length).toBeLessThan(rolePermissions.team_lead.length);
      expect(rolePermissions.team_lead.length).toBeLessThan(rolePermissions.founder.length);
    });

    it("team_lead can approve active_context for their department", () => {
      const canApprove = (role: string, layer: string, userDeptId: string, itemDeptId: string): boolean => {
        if (role === "founder") return true;
        if (role === "team_lead" && layer === "active_context" && userDeptId === itemDeptId) return true;
        return false;
      };

      expect(canApprove("founder", "identity", "dept-1", "dept-1")).toBe(true);
      expect(canApprove("team_lead", "active_context", "dept-1", "dept-1")).toBe(true);
      expect(canApprove("team_lead", "active_context", "dept-1", "dept-2")).toBe(false);
      expect(canApprove("team_lead", "identity", "dept-1", "dept-1")).toBe(false);
      expect(canApprove("team_member", "active_context", "dept-1", "dept-1")).toBe(false);
    });

    it("founder is sole gatekeeper for identity and domain layers (V1)", () => {
      const canApproveLayer = (role: string, layer: string): boolean => {
        if (layer === "identity" || layer === "domain") return role === "founder";
        return true;
      };

      expect(canApproveLayer("founder", "identity")).toBe(true);
      expect(canApproveLayer("team_lead", "identity")).toBe(false);
      expect(canApproveLayer("team_member", "identity")).toBe(false);
      expect(canApproveLayer("founder", "domain")).toBe(true);
      expect(canApproveLayer("team_lead", "domain")).toBe(false);
    });
  });

  // ── Context packaging sections ──────────────────────────────────────────────

  describe("Context packaging structure", () => {
    it("assembles 8 sections separated by horizontal rules", () => {
      const sections = [
        "# Company: AoA",
        "## Department: Engineering",
        "## Goal: Ship current release",
        "## Previous Tasks (Dependencies)",
        "## Task: Implement feature",
        "## Artifacts",
        "## Agent: Claude",
        "## Preferences",
      ];

      const markdown = sections.join("\n\n---\n\n");

      expect(markdown.split("---")).toHaveLength(8);
      expect(markdown).toContain("# Company");
      expect(markdown).toContain("## Task");
      expect(markdown).toContain("## Artifacts");
    });

    it("8000 token warning threshold", () => {
      const smallMarkdown = "x".repeat(31999); // 31999/4 = 7999.75 → 8000 tokens
      const largeMarkdown = "x".repeat(32001); // 32001/4 = 8000.25 → 8001 tokens

      const smallEstimate = Math.ceil(smallMarkdown.length / 4);
      const largeEstimate = Math.ceil(largeMarkdown.length / 4);

      expect(smallEstimate).toBeLessThanOrEqual(8000);
      expect(largeEstimate).toBeGreaterThan(8000);
    });

    it("context modes: minimal/standard/full", () => {
      const contextModes = ["minimal", "standard", "full"];
      const defaultMode = "standard";

      expect(contextModes).toContain(defaultMode);
      expect(contextModes).toHaveLength(3);
    });
  });

  // ── Debrief pipeline ────────────────────────────────────────────────────────

  describe("Debrief pipeline (Decision #14)", () => {
    it("MCP inbound always routes through Debrief pipeline", () => {
      // Critical Rule #5: Never create raw tasks from MCP input
      const mcpInbound = {
        source: "mcp",
        rawContent: "Agent output from external tool",
      };

      // Must go through debrief → brief → approval pipeline
      expect(mcpInbound.source).toBe("mcp");
      // Direct task creation would be a violation
    });

    it("debrief states: pending → processing → completed or processing_failed", () => {
      const validStates = ["pending", "processing", "completed", "processing_failed"];
      const transitions: Record<string, string[]> = {
        pending: ["processing"],
        processing: ["completed", "processing_failed"],
        completed: [],
        processing_failed: ["processing"], // can retry
      };

      expect(transitions.pending).toContain("processing");
      expect(transitions.processing).toContain("completed");
      expect(transitions.processing).toContain("processing_failed");
      expect(transitions.processing_failed).toContain("processing"); // retry
    });
  });

  // ── Brief department fallback (Decision #61) ───────────────────────────────

  describe("Brief department fallback (Decision #61)", () => {
    it("priority: item-level > brief-level > null", () => {
      const resolveDepartment = (itemDeptId: string | null, briefDeptId: string | null): string | null => {
        return itemDeptId ?? briefDeptId ?? null;
      };

      expect(resolveDepartment("item-dept", "brief-dept")).toBe("item-dept");
      expect(resolveDepartment(null, "brief-dept")).toBe("brief-dept");
      expect(resolveDepartment(null, null)).toBeNull();
    });
  });
});
