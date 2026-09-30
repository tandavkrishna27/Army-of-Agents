import { describe, it, expect } from "vitest";
import { capExceeded, resolveRoleModel, runRateExceeded } from "../services/internal-agent/cost-caps.js";

describe("cost caps + per-role model + run-rate brake", () => {
  it("capExceeded compares spend vs the per-call cap", () => {
    expect(capExceeded(50, 100)).toBe(false);
    expect(capExceeded(150, 100)).toBe(true);
    expect(capExceeded(10, null)).toBe(false); // no cap configured
  });
  it("resolveRoleModel prefers the role's model, then the company default", () => {
    expect(resolveRoleModel({ roleModel: "gpt-4o-mini", companyDefault: "claude-sonnet-4-20250514" })).toBe("gpt-4o-mini");
    expect(resolveRoleModel({ roleModel: null, companyDefault: "claude-sonnet-4-20250514" })).toBe("claude-sonnet-4-20250514");
  });
  // D3: run-rate brake for $0 CLI runs
  it("runRateExceeded correctly gates on count vs window", () => {
    expect(runRateExceeded(3, 5)).toBe(false);
    expect(runRateExceeded(5, 5)).toBe(true);
    expect(runRateExceeded(6, 5)).toBe(true);
  });
});
