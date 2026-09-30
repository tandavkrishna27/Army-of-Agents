// Phase 5 execution-target registry (multi-tenant cloud, Task 12). Read-only
// client for the org-admin-gated listing route added in Task 13
// (server/src/routes/execution-targets.ts: GET /organizations/:orgId/execution-targets).
// Used by EnvironmentsSection's "Pin to execution target" picker.
import type { ExecutionTargetKind, ExecutionTargetStatus, ExecutionTargetTrustClass } from "@armyofagents/shared";
import { api } from "./client";

export interface ExecutionTargetSummary {
  id: string;
  organizationId: string | null;
  slug: string;
  kind: ExecutionTargetKind;
  trustClass: ExecutionTargetTrustClass;
  status: ExecutionTargetStatus;
  lastSeenAt: string | null;
}

export interface ExecutionTargetRegistration extends ExecutionTargetSummary {
  workerToken: string;
}

export const executionTargetsApi = {
  list: (organizationId: string) =>
    api.get<ExecutionTargetSummary[]>(`/organizations/${organizationId}/execution-targets`),
  rotateToken: (organizationId: string, targetId: string) =>
    api.post<ExecutionTargetRegistration>(
      `/organizations/${organizationId}/execution-targets/${targetId}/rotate-token`,
      {},
    ),
  revoke: (organizationId: string, targetId: string) =>
    api.post<ExecutionTargetSummary>(`/organizations/${organizationId}/execution-targets/${targetId}/revoke`, {}),
};
