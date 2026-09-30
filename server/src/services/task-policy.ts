export type TaskPolicyAllowedMode = "create" | "assign" | "delegate_to_report" | "self_assign";

export type WakeSkippedReason = "assignee_paused" | "assignee_error";

export type TaskPolicyDecision =
  | {
      allowed: true;
      mode: TaskPolicyAllowedMode;
      wakeSkippedReason?: WakeSkippedReason;
    }
  | {
      allowed: false;
      reason:
        | "missing_tasks_create"
        | "missing_tasks_assign"
        | "target_not_direct_report"
        | "target_wrong_company"
        | "target_terminated";
      allowedActions: Array<"create_unassigned" | "assign_to_self" | "request_routing_from_lead">;
    };

export type PolicyAgent = {
  id: string;
  companyId: string;
  role: string;
  reportsTo?: string | null;
  status?: string | null;
  permissions?: Record<string, unknown> | null;
};

function wakeSkippedReasonForStatus(status: string | null | undefined): WakeSkippedReason | undefined {
  if (status === "paused") return "assignee_paused";
  if (status === "error") return "assignee_error";
  return undefined;
}

function allowed(mode: TaskPolicyAllowedMode, targetAgent: PolicyAgent): TaskPolicyDecision {
  const wakeSkippedReason = wakeSkippedReasonForStatus(targetAgent.status);
  return wakeSkippedReason ? { allowed: true, mode, wakeSkippedReason } : { allowed: true, mode };
}

export function canDelegateToTarget(input: {
  actorAgent: PolicyAgent;
  targetAgent: PolicyAgent;
  hasGlobalAssignGrant: boolean;
}): TaskPolicyDecision {
  if (input.targetAgent.companyId !== input.actorAgent.companyId) {
    return {
      allowed: false,
      reason: "target_wrong_company",
      allowedActions: ["create_unassigned", "request_routing_from_lead"],
    };
  }

  if (input.targetAgent.status === "terminated") {
    return {
      allowed: false,
      reason: "target_terminated",
      allowedActions: ["create_unassigned", "request_routing_from_lead"],
    };
  }

  if (input.actorAgent.role === "cxo" || input.hasGlobalAssignGrant) {
    return allowed("assign", input.targetAgent);
  }

  if (input.actorAgent.role === "lead" && input.targetAgent.reportsTo === input.actorAgent.id) {
    return allowed("delegate_to_report", input.targetAgent);
  }

  if (input.targetAgent.id === input.actorAgent.id) {
    return allowed("self_assign", input.targetAgent);
  }

  return {
    allowed: false,
    reason: "target_not_direct_report",
    allowedActions: ["create_unassigned", "assign_to_self", "request_routing_from_lead"],
  };
}
