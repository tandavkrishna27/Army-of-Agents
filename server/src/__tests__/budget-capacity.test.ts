import { describe, expect, it } from "vitest";
import {
  evaluateCapacityAdmission,
  type CapacityExposure,
} from "../services/budget-capacity-policy.js";

const exposure = (patch: Partial<CapacityExposure> = {}): CapacityExposure => ({
  policyId: "policy-1",
  scopeType: "company",
  scopeId: "company-1",
  limitCents: 100,
  postedCents: 40,
  outstandingCents: 20,
  requestedCents: 30,
  ...patch,
});

describe("shared Budget capacity admission", () => {
  it("admits when posted plus unresolved exposure plus request remains within every cap", () => {
    expect(evaluateCapacityAdmission([exposure()])).toEqual({
      outcome: "admitted",
      remainingCents: 10,
    });
  });

  it("denies when simultaneous voice/media exposure would exceed a shared cap", () => {
    expect(
      evaluateCapacityAdmission([exposure({ outstandingCents: 40 })])
    ).toEqual({
      outcome: "denied",
      policyId: "policy-1",
      remainingCents: 20,
      requiredCents: 30,
    });
  });

  it("fails closed when a maximum billable exposure is unknown", () => {
    expect(
      evaluateCapacityAdmission([exposure({ requestedCents: null })])
    ).toEqual({ outcome: "unknown", reason: "unbounded_exposure" });
  });

  it("uses the tightest applicable company, department, or agent cap", () => {
    expect(
      evaluateCapacityAdmission([
        exposure({
          policyId: "company",
          limitCents: 500,
          postedCents: 10,
          outstandingCents: 10,
          requestedCents: 20,
        }),
        exposure({
          policyId: "agent",
          scopeType: "agent",
          scopeId: "agent-1",
          limitCents: 50,
          postedCents: 20,
          outstandingCents: 10,
          requestedCents: 20,
        }),
      ])
    ).toEqual({ outcome: "admitted", remainingCents: 0 });
  });
});
