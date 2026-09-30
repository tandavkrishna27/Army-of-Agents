// T1.3 — pure-function tests for deriveEnabledCapabilities (per eng-review D4).
//
// Why per-agent: the runner used to grant ["discussion_processing"] to ALL
// crew runs uniformly. That broke Maker (create_artifact = category 'action'
// → needs 'system_actions' which wasn't granted → CAPABILITY_DISABLED),
// Memory Keeper (suggest_memory = category 'memory' → needs
// 'memory_management'), and Adjutant (advance_phase = category 'action').
// The plan's first instinct ("just enable all three for everyone") loses
// defense-in-depth. Per eng-review D4, derive the set per-agent from the
// agent's toolAllowlist instead — Maker gets system_actions because its
// allowlist contains create_artifact; Scribe doesn't because its allowlist
// doesn't include any action/memory tools.
//
// This file pins the per-role behavior in code so a future edit can't
// quietly broaden Scribe's capabilities (or quietly drop Maker's).

import { describe, expect, it } from "vitest";
import { deriveEnabledCapabilities } from "../services/internal-agent/aoa-agents/derive-capabilities.js";
import type { AgentTool, ToolCategory } from "../services/internal-agent/types.js";

// Test registry — only `name` and `category` matter for the derivation; the
// rest of AgentTool's surface (execute, parameters, requiredRole, etc.) is
// irrelevant. Using minimal shape keeps the test focused.
function tool(name: string, category: ToolCategory): AgentTool {
  return {
    name,
    description: "",
    parameters: { type: "object", properties: {} },
    category,
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "" }),
  };
}

// Snapshot of the real tool categories crew agents would see in production.
const REGISTRY: readonly AgentTool[] = [
  // discussion (gated by discussion_processing — every crew gets this)
  tool("submit_extracted_items", "discussion"),
  tool("post_entry", "discussion"),
  // action (gated by system_actions)
  tool("create_artifact", "action"),
  tool("advance_phase", "action"),
  tool("notify_owner", "action"),
  tool("create_task", "action"),
  tool("assign_task", "action"),
  tool("add_task_dependency", "action"),
  // memory (gated by memory_management)
  tool("suggest_memory", "memory"),
  // unrelated categories — should NEVER grant extra capabilities (query is
  // always-allowed, has no capability gate)
  tool("query_tasks", "query"),
  tool("read_file", "file"),
  tool("workload_balance", "analysis"),
];

describe("deriveEnabledCapabilities (T1.3)", () => {
  describe("baseline", () => {
    it("empty allowlist → discussion_processing baseline only", () => {
      const caps = deriveEnabledCapabilities([], REGISTRY);
      expect(caps).toEqual(["discussion_processing"]);
    });

    it("baseline is always present even when allowlist has no discussion tool", () => {
      // Pathological: an agent with only an action tool still gets the
      // baseline discussion_processing (defense — most crew runs read+write
      // discussion entries; dropping the baseline would surprise admins).
      const caps = deriveEnabledCapabilities(["create_artifact"], REGISTRY);
      expect(caps).toContain("discussion_processing");
      expect(caps).toContain("system_actions");
    });
  });

  describe("per-role expected output", () => {
    it("scribe (submit_extracted_items) → discussion_processing only", () => {
      const caps = deriveEnabledCapabilities(["submit_extracted_items"], REGISTRY);
      expect(caps).toEqual(["discussion_processing"]);
      // CRITICAL: no system_actions, no memory_management. Scribe is the
      // most-locked-down crew — least-privilege is the whole point.
      expect(caps).not.toContain("system_actions");
      expect(caps).not.toContain("memory_management");
    });

    it("maker (post_entry + create_artifact) → discussion_processing + system_actions", () => {
      const caps = deriveEnabledCapabilities(["post_entry", "create_artifact"], REGISTRY);
      expect(caps).toContain("discussion_processing");
      expect(caps).toContain("system_actions");
      expect(caps).not.toContain("memory_management");
      // exact set (no extras)
      expect(caps.length).toBe(2);
    });

    it("memory_keeper (suggest_memory) → discussion_processing + memory_management", () => {
      const caps = deriveEnabledCapabilities(["suggest_memory"], REGISTRY);
      expect(caps).toContain("discussion_processing");
      expect(caps).toContain("memory_management");
      expect(caps).not.toContain("system_actions");
      expect(caps.length).toBe(2);
    });

    it("adjutant (advance_phase + notify_owner) → discussion_processing + system_actions", () => {
      const caps = deriveEnabledCapabilities(["advance_phase", "notify_owner"], REGISTRY);
      expect(caps).toContain("discussion_processing");
      expect(caps).toContain("system_actions");
      expect(caps).not.toContain("memory_management");
      expect(caps.length).toBe(2);
    });

    it("router (post_entry) → discussion_processing only", () => {
      const caps = deriveEnabledCapabilities(["post_entry"], REGISTRY);
      expect(caps).toEqual(["discussion_processing"]);
    });

    it("planner (post_entry) → discussion_processing only", () => {
      const caps = deriveEnabledCapabilities(["post_entry"], REGISTRY);
      expect(caps).toEqual(["discussion_processing"]);
    });

    it("dispatcher (create_task + assign_task + add_task_dependency) → discussion_processing + system_actions", () => {
      const caps = deriveEnabledCapabilities(
        ["create_task", "assign_task", "add_task_dependency"],
        REGISTRY,
      );
      expect(caps).toContain("discussion_processing");
      expect(caps).toContain("system_actions");
      expect(caps).not.toContain("memory_management");
      expect(caps.length).toBe(2);
    });

    it("commander (post_entry) → discussion_processing only (its tool is discussion-cat)", () => {
      // Note: commander's full allowlist may include other things, but
      // ROLE_ACTION_DIRECTIVE has it on post_entry. Test the minimal case.
      const caps = deriveEnabledCapabilities(["post_entry"], REGISTRY);
      expect(caps).toEqual(["discussion_processing"]);
    });
  });

  describe("edge cases (defense)", () => {
    it("unknown tool in allowlist → ignored (don't grant unknown capabilities)", () => {
      // The agent declared a tool that the registry doesn't know about. Do
      // NOT silently grant a capability — fail closed. Returning the baseline
      // means the agent simply can't call that unknown tool, which is the
      // correct behavior.
      const caps = deriveEnabledCapabilities(
        ["totally_made_up_tool", "submit_extracted_items"],
        REGISTRY,
      );
      expect(caps).toEqual(["discussion_processing"]);
    });

    it("duplicate tool names in allowlist → still only one capability granted", () => {
      // Idempotent: the derivation uses a Set internally so duplicate names
      // don't double-add capabilities.
      const caps = deriveEnabledCapabilities(
        ["create_artifact", "create_artifact"],
        REGISTRY,
      );
      expect(caps.length).toBe(2);
      expect(caps).toContain("system_actions");
    });

    it("multiple action-category tools → single system_actions grant", () => {
      // Adding more action tools must not multiply the capability — the gate
      // is category-based, not tool-count-based.
      const caps = deriveEnabledCapabilities(
        ["create_artifact", "advance_phase", "notify_owner", "create_task"],
        REGISTRY,
      );
      expect(caps.filter((c) => c === "system_actions").length).toBe(1);
    });

    it("query/file/analysis/coordination tools → NO extra capability (they're always-allowed)", () => {
      // CAPABILITY_TO_CATEGORY only gates discussion/action/memory; the other
      // categories pass the authorize gate freely. Granting a capability for
      // them would be a no-op and confuse operators reading the wakeup logs.
      const caps = deriveEnabledCapabilities(
        ["query_tasks", "read_file", "workload_balance"],
        REGISTRY,
      );
      expect(caps).toEqual(["discussion_processing"]);
    });

    it("empty registry → still returns baseline (don't crash)", () => {
      const caps = deriveEnabledCapabilities(["create_artifact"], []);
      // Tool not in registry → can't be matched → no extra capability.
      // Baseline still present.
      expect(caps).toEqual(["discussion_processing"]);
    });

    it("all three categories represented → all three capabilities granted", () => {
      // Worst case: an admin allows a kitchen-sink agent everything. The
      // function must still return exactly the three known capabilities, in
      // some order, with no duplicates.
      const caps = deriveEnabledCapabilities(
        ["submit_extracted_items", "create_artifact", "suggest_memory"],
        REGISTRY,
      );
      expect(new Set(caps)).toEqual(
        new Set(["discussion_processing", "system_actions", "memory_management"]),
      );
      expect(caps.length).toBe(3);
    });
  });

  describe("contract", () => {
    it("returns a sorted-stable ordering so log diffs are not noisy", () => {
      // Not strictly required for correctness, but the runner stamps the
      // capability set into mcpParams and the bridge env. A stable order means
      // two runs of the same agent produce byte-identical bridge configs,
      // which makes log diffing during incident response actually useful.
      const a = deriveEnabledCapabilities(
        ["create_artifact", "suggest_memory", "submit_extracted_items"],
        REGISTRY,
      );
      const b = deriveEnabledCapabilities(
        ["suggest_memory", "submit_extracted_items", "create_artifact"],
        REGISTRY,
      );
      expect(a).toEqual(b);
    });

    it("baseline is the first element", () => {
      // Convention: discussion_processing comes first because it's the gate
      // every crew agent shares. Makes the bridge env easy to scan in logs.
      const caps = deriveEnabledCapabilities(["create_artifact"], REGISTRY);
      expect(caps[0]).toBe("discussion_processing");
    });
  });
});
