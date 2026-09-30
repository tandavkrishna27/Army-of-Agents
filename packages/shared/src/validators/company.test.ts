import { describe, expect, it } from "vitest";
import { createCompanySchema, updateCompanySchema } from "./company.js";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const REQUEST_ID = "d259a6f1-d10a-4f79-a057-d47d3ef11152";

describe("updateCompanySchema — tenant key (organizationId) is immutable on update", () => {
  it("strips organizationId from a PATCH body (never reparent a company cross-tenant)", () => {
    const parsed = updateCompanySchema.parse({ name: "Renamed", organizationId: ORG });
    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed.name).toBe("Renamed");
  });

  it("still accepts the other mutable update fields", () => {
    const parsed = updateCompanySchema.parse({
      vision: "V",
      requireBoardApprovalForNewAgents: true,
      budgetMonthlyCents: 5000,
    });
    expect(parsed).toMatchObject({
      vision: "V",
      requireBoardApprovalForNewAgents: true,
      budgetMonthlyCents: 5000,
    });
    expect(parsed).not.toHaveProperty("organizationId");
  });

  it("createCompanySchema still accepts organizationId (create-time tenant pick unchanged)", () => {
    const parsed = createCompanySchema.parse({
      name: "New Co",
      organizationId: ORG,
      creationRequestId: REQUEST_ID,
    });
    expect(parsed.organizationId).toBe(ORG);
    expect(parsed.creationRequestId).toBe(REQUEST_ID);
  });

  it("rejects malformed request ids and strips request ids from updates", () => {
    expect(() =>
      createCompanySchema.parse({ name: "New Co", creationRequestId: "not-a-uuid" }),
    ).toThrow();
    expect(updateCompanySchema.parse({ creationRequestId: REQUEST_ID }))
      .not.toHaveProperty("creationRequestId");
  });
});
