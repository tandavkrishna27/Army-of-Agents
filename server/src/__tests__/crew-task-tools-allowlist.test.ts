// Spec B Task 6 — wire the 4 crew task tools onto the executor allowlists.
//
// Task 1-4 built four per-task tools so a crew agent dispatched onto a task can
// act on it:
//   - get_task            (query)        — read the assigned task's context
//   - post_task_comment   (coordination) — comment progress back onto the task
//   - attach_task_artifact(coordination) — hand back the deliverable
//   - set_task_status     (coordination) — move the task forward (dial-gated)
// Task 6 exposes them to the three executor roles (Scout, Engineer, Planner) by
// adding them to each role's toolAllowlist (the bridge's default-deny gate).
//
// This file pins TWO guarantees in code:
//   1. CONTAINS — each executor role's resolved allowlist includes all four
//      task tools (so the bridge actually lets the agent call them).
//   2. NO WIDENING — deriving capabilities from each role's allowlist (against
//      the REAL tool registry) does NOT add `system_actions`. Only an
//      `action`-category tool grants system_actions; get_task is `query` and the
//      other three are `coordination`, neither of which is in
//      authorize-tool.ts's CAPABILITY_TO_CATEGORY. Adding read/result-write task
//      tools to an allowlist therefore can never escalate the agent's
//      capability set — this test is the regression fence for that property.
//
// Why the REAL registry (not the stub used by derive-capabilities.test.ts):
// the no-widening claim is only meaningful if the categories asserted here are
// the categories the four tools actually ship with. createToolRegistry() builds
// real tool descriptors (no DB access at construction — DB calls live inside
// each tool's execute()), so importing it here is safe in the drizzle-ESM
// environment without mocking @armyofagents/db.

import { describe, it, expect } from "vitest";

import { SCOUT_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-scout.js";
import { ENGINEER_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-engineer.js";
import { roleToolAllowlist } from "../services/internal-agent/aoa-agents/ensure-command-staff.js";
import { deriveEnabledCapabilities } from "../services/internal-agent/aoa-agents/derive-capabilities.js";
import { createToolRegistry } from "../services/internal-agent/tool-registry.js";

const TASK_TOOLS = [
  "get_task",
  "post_task_comment",
  "attach_task_artifact",
  "set_task_status",
  "ask_human",
] as const;

// Resolve each executor role's allowlist from its real source of truth.
const ROLE_ALLOWLISTS: Record<string, readonly string[]> = {
  scout: SCOUT_TOOL_ALLOWLIST,
  engineer: ENGINEER_TOOL_ALLOWLIST,
  planner: roleToolAllowlist("planner"),
};

describe("crew task tools on executor allowlists (Spec B Task 6)", () => {
  describe("CONTAINS — every executor role can call all four task tools", () => {
    for (const [role, allowlist] of Object.entries(ROLE_ALLOWLISTS)) {
      for (const toolName of TASK_TOOLS) {
        it(`${role} allowlist contains ${toolName}`, () => {
          expect(allowlist).toContain(toolName);
        });
      }
    }
  });

  describe("NO WIDENING — task tools contribute no system_actions", () => {
    // Real registry: the categories of the four task tools come from production
    // descriptors, so the no-widening assertion can't be faked by a stub.
    const registry = createToolRegistry();

    it("all four task tools resolve to query/coordination (never action) in the registry", () => {
      const byName = new Map(registry.map((t) => [t.name, t.category]));
      expect(byName.get("get_task")).toBe("query");
      expect(byName.get("post_task_comment")).toBe("coordination");
      expect(byName.get("attach_task_artifact")).toBe("coordination");
      expect(byName.get("set_task_status")).toBe("coordination");
      expect(byName.get("ask_human")).toBe("coordination");
      // None is `action` — `action` is the only category mapped to
      // system_actions (authorize-tool.ts CAPABILITY_TO_CATEGORY).
      for (const name of TASK_TOOLS) {
        expect(byName.get(name)).not.toBe("action");
      }
    });

    it("deriving capabilities from ONLY the four task tools yields no system_actions / memory_management", () => {
      // The four task tools in isolation grant nothing beyond the baseline:
      // query + coordination categories are absent from CAPABILITY_TO_CATEGORY,
      // so they confer no capability. (get_task=query; the other three=coordination.)
      const caps = deriveEnabledCapabilities([...TASK_TOOLS], registry);
      expect(caps).toEqual(["discussion_processing"]);
      expect(caps).not.toContain("system_actions");
      expect(caps).not.toContain("memory_management");
    });

    // NOTE on the guarantee being tested here:
    //   Scout / Engineer / Planner ALREADY derive `system_actions` from their
    //   pre-existing action-category tools — Engineer & Planner hold
    //   `create_artifact` / `create_artifact_version` (category 'action'); Scout
    //   holds `thread.createLink` (category 'action') and `find_similar_memory_hnsw`
    //   (category 'memory'). So "system_actions absent from the role" is NOT the
    //   right invariant — these roles legitimately have it independent of Task 6.
    //   The correct no-widening fence is: adding the four task tools must not
    //   CHANGE the derived capability set. That is what each per-role test below
    //   asserts (before/after equality), which is the real safety property for
    //   Task 6: exposing read + result-write task tools cannot escalate an
    //   executor's capability class.
    for (const [role, allowlist] of Object.entries(ROLE_ALLOWLISTS)) {
      it(`${role}: adding the four task tools does NOT widen the derived capability set`, () => {
        // Remove the four task tools and re-derive — must yield the SAME
        // capability set as with them present. Proof the task tools contribute
        // zero capabilities on top of whatever the role already had.
        const withoutTaskTools = allowlist.filter(
          (t) => !TASK_TOOLS.includes(t as (typeof TASK_TOOLS)[number]),
        );
        const before = deriveEnabledCapabilities(withoutTaskTools, registry);
        const after = deriveEnabledCapabilities(allowlist, registry);
        expect(new Set(after)).toEqual(new Set(before));
        // And specifically: the task tools didn't introduce system_actions where
        // the role's non-task-tool allowlist didn't already have it.
        if (!before.includes("system_actions")) {
          expect(after).not.toContain("system_actions");
        }
      });
    }
  });
});
