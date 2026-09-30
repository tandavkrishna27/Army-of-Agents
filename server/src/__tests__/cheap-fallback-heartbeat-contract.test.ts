import { describe, it, expect } from "vitest";

// Contract test: verify the cheap-fallback integration contract is honoured.
// The actual injection is exercised by heartbeat integration tests on Linux/macOS.
// This test verifies the shape of the service the heartbeat depends on.
describe("cheap-fallback heartbeat contract", () => {
  it("resolveCheapFallbackModel is exported from cheap-fallback service", async () => {
    const mod = await import("../services/cheap-fallback.js");
    expect(typeof mod.resolveCheapFallbackModel).toBe("function");
  });

  it("resolveCheapFallbackModel accepts (db, companyId, agentId, budgetMonthlyCents) — 4 params", async () => {
    const mod = await import("../services/cheap-fallback.js");
    expect(mod.resolveCheapFallbackModel.length).toBe(4);
  });
});
