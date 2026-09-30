import { describe, expect, it } from "vitest";
import {
  canDelegateToTarget,
  type PolicyAgent,
} from "../services/task-policy.js";

function agent(overrides: Partial<PolicyAgent> = {}): PolicyAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    role: "general",
    reportsTo: null,
    status: "idle",
    permissions: {},
    ...overrides,
  };
}

describe("task policy", () => {
  it("allows CXO agents to assign broadly within the same company", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "cxo", role: "cxo" }),
      targetAgent: agent({ id: "target", reportsTo: null }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({ allowed: true, mode: "assign" });
  });

  it("allows lead agents to delegate to direct reports", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "lead", role: "lead" }),
      targetAgent: agent({ id: "report", reportsTo: "lead" }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({ allowed: true, mode: "delegate_to_report" });
  });

  it("blocks lead agents from delegating outside their direct reports without tasks:assign", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "lead", role: "lead" }),
      targetAgent: agent({ id: "other", reportsTo: "different-lead" }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "target_not_direct_report",
      allowedActions: ["create_unassigned", "assign_to_self", "request_routing_from_lead"],
    });
  });

  it("allows general agents to assign work to themselves", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "worker", role: "general" }),
      targetAgent: agent({ id: "worker", role: "general" }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({ allowed: true, mode: "self_assign" });
  });

  it("blocks general agents from assigning another agent", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "worker", role: "general" }),
      targetAgent: agent({ id: "peer", role: "general" }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "target_not_direct_report",
      allowedActions: ["create_unassigned", "assign_to_self", "request_routing_from_lead"],
    });
  });

  it("allows an explicit tasks:assign grant to assign within the company", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "worker", role: "general" }),
      targetAgent: agent({ id: "peer", role: "general" }),
      hasGlobalAssignGrant: true,
    });

    expect(decision).toEqual({ allowed: true, mode: "assign" });
  });

  it("blocks assigning an agent from another company", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "lead", role: "lead", companyId: "company-1" }),
      targetAgent: agent({ id: "report", reportsTo: "lead", companyId: "company-2" }),
      hasGlobalAssignGrant: true,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "target_wrong_company",
      allowedActions: ["create_unassigned", "request_routing_from_lead"],
    });
  });

  it("allows assigning a paused target but returns wakeSkippedReason assignee_paused", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "lead", role: "lead" }),
      targetAgent: agent({ id: "report", reportsTo: "lead", status: "paused" }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({
      allowed: true,
      mode: "delegate_to_report",
      wakeSkippedReason: "assignee_paused",
    });
  });

  it("allows assigning an error target but returns wakeSkippedReason assignee_error", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "lead", role: "lead" }),
      targetAgent: agent({ id: "report", reportsTo: "lead", status: "error" }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({
      allowed: true,
      mode: "delegate_to_report",
      wakeSkippedReason: "assignee_error",
    });
  });

  it("blocks assigning a terminated target", () => {
    const decision = canDelegateToTarget({
      actorAgent: agent({ id: "cxo", role: "cxo" }),
      targetAgent: agent({ id: "target", status: "terminated" }),
      hasGlobalAssignGrant: false,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "target_terminated",
      allowedActions: ["create_unassigned", "request_routing_from_lead"],
    });
  });
});
