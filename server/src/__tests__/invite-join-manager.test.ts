import { describe, expect, it } from "vitest";
import { resolveJoinRequestAgentManagerId } from "../routes/access-helpers.js";

describe("resolveJoinRequestAgentManagerId", () => {
  it("returns null when no CXO exists in the company agent list", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "a1", role: "cto", reportsTo: null },
      { id: "a2", role: "engineer", reportsTo: "a1" },
    ]);

    expect(managerId).toBeNull();
  });

  it("selects the root CXO when available", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-child", role: "cxo", reportsTo: "manager-1" },
      { id: "manager-1", role: "cto", reportsTo: null },
      { id: "ceo-root", role: "cxo", reportsTo: null },
    ]);

    expect(managerId).toBe("ceo-root");
  });

  it("selects the root CXO using parentId when available", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-child", role: "cxo", reportsTo: "manager-1", parentType: "agent", parentId: "manager-1" },
      { id: "manager-1", role: "cto", reportsTo: null, parentType: null, parentId: null },
      { id: "ceo-root", role: "cxo", reportsTo: null, parentType: null, parentId: null },
    ]);

    expect(managerId).toBe("ceo-root");
  });

  it("falls back to the first CXO when no root CXO is present", () => {
    const managerId = resolveJoinRequestAgentManagerId([
      { id: "ceo-1", role: "cxo", reportsTo: "mgr" },
      { id: "ceo-2", role: "cxo", reportsTo: "mgr" },
      { id: "mgr", role: "cto", reportsTo: null },
    ]);

    expect(managerId).toBe("ceo-1");
  });
});
