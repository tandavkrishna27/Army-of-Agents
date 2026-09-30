import { describe, it, expect } from "vitest";
import { upsertBudgetPolicySchema, resolveBudgetIncidentSchema } from "@armyofagents/shared";

describe("upsertBudgetPolicySchema", () => {
  it("accepts valid company policy", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: 5000,
      warnPercent: 80,
      hardStopEnabled: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid agent policy", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "agent",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: 1000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnPercent).toBe(80);
      expect(result.data.hardStopEnabled).toBe(true);
    }
  });

  it("defaults warnPercent to 80 and hardStopEnabled to true", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: 100,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnPercent).toBe(80);
      expect(result.data.hardStopEnabled).toBe(true);
    }
  });

  it("rejects invalid scopeType", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "project",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID scopeId", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId: "not-a-uuid",
      amountCents: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative amountCents", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: -100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects warnPercent out of range", () => {
    expect(upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: 100,
      warnPercent: 0,
    }).success).toBe(false);

    expect(upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: 100,
      warnPercent: 100,
    }).success).toBe(false);
  });

  it("accepts zero amountCents (disables policy)", () => {
    const result = upsertBudgetPolicySchema.safeParse({
      scopeType: "company",
      scopeId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      amountCents: 0,
    });
    expect(result.success).toBe(true);
  });
});

describe("resolveBudgetIncidentSchema", () => {
  it("accepts dismiss without newAmountCents", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "dismiss",
    });
    expect(result.success).toBe(true);
  });

  it("accepts raise_and_resume with newAmountCents", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_and_resume",
      newAmountCents: 10000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects raise_and_resume without newAmountCents", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_and_resume",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid action", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "ignore",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative newAmountCents", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_and_resume",
      newAmountCents: -500,
    });
    expect(result.success).toBe(false);
  });
});
