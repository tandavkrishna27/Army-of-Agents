import { describe, it, expect } from "vitest";
import { DEPARTMENT_FUNCTION_TYPES } from "../constants.js";

describe("DEPARTMENT_FUNCTION_TYPES", () => {
  it("includes sales (new) and relabels support to Customer Support", () => {
    const byValue = Object.fromEntries(DEPARTMENT_FUNCTION_TYPES.map((t) => [t.value, t.label]));
    expect(byValue.sales).toBe("Sales");
    expect(byValue.support).toBe("Customer Support");
    expect(byValue.software_development).toBe("Product (Software)");
  });
  it("keeps software_development as the workspace-tooling gate value", () => {
    expect(DEPARTMENT_FUNCTION_TYPES.some((t) => t.value === "software_development")).toBe(true);
  });
  it("every entry has value/label/icon", () => {
    for (const t of DEPARTMENT_FUNCTION_TYPES) {
      expect(typeof t.value).toBe("string");
      expect(typeof t.label).toBe("string");
      expect(typeof t.icon).toBe("string");
    }
  });
});
