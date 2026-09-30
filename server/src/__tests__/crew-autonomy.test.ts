import { describe, it, expect } from "vitest";
import { isRoleActiveAtAutonomy } from "../services/internal-agent/aoa-agents/autonomy.js";

describe("autonomy gate (L0/L1/L2 = crew activation)", () => {
  // D2 eng-review: Scribe/Memory-Keeper/Curator are core (always on at L0+)
  it("core roles (scribe, memory_keeper, curator) are active at all levels including L0", () => {
    for (const role of ["scribe", "memory_keeper", "curator"] as const) {
      expect(isRoleActiveAtAutonomy(role, 0)).toBe(true);
      expect(isRoleActiveAtAutonomy(role, 1)).toBe(true);
      expect(isRoleActiveAtAutonomy(role, 2)).toBe(true);
    }
  });
  it("agentic roles (router, planner, dispatcher) require L2", () => {
    for (const role of ["router", "planner", "dispatcher"] as const) {
      expect(isRoleActiveAtAutonomy(role, 0)).toBe(false);
      expect(isRoleActiveAtAutonomy(role, 1)).toBe(false);
      expect(isRoleActiveAtAutonomy(role, 2)).toBe(true);
    }
  });
  // WS6: Librarian only ever runs on an explicit founder-triggered braindump
  // dispatch (never a self-initiated sweep/mention), so it's floored at 0
  // like the other founder/system-triggered core roles.
  it("librarian is active at all levels including L0 (founder-triggered, not autonomous)", () => {
    expect(isRoleActiveAtAutonomy("librarian", 0)).toBe(true);
    expect(isRoleActiveAtAutonomy("librarian", 1)).toBe(true);
    expect(isRoleActiveAtAutonomy("librarian", 2)).toBe(true);
  });
});
