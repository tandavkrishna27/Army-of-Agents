import { describe, it, expect } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

describe("crew bundle content invariants", () => {
  it("memory_keeper SOUL/TOOLS enforce propose-only memory", async () => {
    const b = await loadDefaultAgentInstructionsBundle("memory_keeper" as any);
    const all = Object.values(b).join("\n").toLowerCase();
    expect(all).toMatch(/propose/);
    expect(all).toMatch(/never.*create_memory|must not.*create_memory|only.*pending/);
  });
  it("dispatcher TOOLS lists its create/assign/wire/wake tools", async () => {
    const t = (await loadDefaultAgentInstructionsBundle("dispatcher" as any))["TOOLS.md"];
    for (const tool of ["create_task", "assign_task", "add_task_dependency", "wakeup_agent"]) {
      expect(t).toContain(tool);
    }
  });
  it("router/planner/dispatcher AGENTS state their phase-gated autonomy", async () => {
    for (const role of ["router", "planner", "dispatcher"]) {
      const a = (await loadDefaultAgentInstructionsBundle(role as any))["AGENTS.md"].toLowerCase();
      expect(a).toMatch(/autonomy|level 2|l2|phase/);
    }
  });
  it("adjutant TOOLS bundle documents propose_crew_work (Task 2.5)", async () => {
    const t = (await loadDefaultAgentInstructionsBundle("adjutant" as any))["TOOLS.md"];
    expect(t).toContain("propose_crew_work");
  });
});
