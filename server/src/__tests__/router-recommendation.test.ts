import { describe, it, expect } from "vitest";
import { recommendDepartment } from "../services/internal-agent/aoa-agents/router-recommendation.js";

const depts = [{ id: "eng", name: "Engineering" }, { id: "design", name: "Design" }];

describe("recommendDepartment", () => {
  it("recommends the most-frequently suggested department", () => {
    const rec = recommendDepartment(
      [
        { id: "1", type: "task", suggestedDepartmentId: "eng", departmentId: null },
        { id: "2", type: "task", suggestedDepartmentId: "eng", departmentId: null },
        { id: "3", type: "task", suggestedDepartmentId: "design", departmentId: null },
      ],
      depts,
    );
    expect(rec?.departmentId).toBe("eng");
    expect(rec?.departmentName).toBe("Engineering");
  });
  it("prefers a committed departmentId over a suggestion", () => {
    const rec = recommendDepartment(
      [{ id: "1", type: "task", suggestedDepartmentId: "eng", departmentId: "design" }],
      depts,
    );
    expect(rec?.departmentId).toBe("design");
  });
  it("returns null when no task item names a department", () => {
    expect(recommendDepartment([{ id: "1", type: "insight", suggestedDepartmentId: null, departmentId: null }], depts)).toBeNull();
  });
});
