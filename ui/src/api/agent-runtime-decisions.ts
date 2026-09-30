import type { RuntimeDecisionAnswerInput, RuntimeDecisionDetail } from "@armyofagents/shared";
import { api } from "./client";

export interface AgentRuntimeTrustRule {
  id: string;
  agentId: string | null;
  runId: string | null;
  grantScope: "persistent" | "run";
  adapterType: string;
  toolName: string | null;
  commandHashPrefix: string | null;
  pathScope: string | null;
  networkScope: string | null;
  riskClass: string | null;
  enabled: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const agentRuntimeDecisionsApi = {
  detail: (companyId: string, decisionId: string) =>
    api.get<RuntimeDecisionDetail>(
      `/companies/${companyId}/agent-runtime-decisions/${decisionId}`,
    ),
  answer: (companyId: string, decisionId: string, payload: RuntimeDecisionAnswerInput) =>
    api.post<RuntimeDecisionDetail>(
      `/companies/${companyId}/agent-runtime-decisions/${decisionId}/answer`,
      payload,
    ),
  listTrustRules: (companyId: string) =>
    api.get<{ rules: AgentRuntimeTrustRule[] }>(
      `/companies/${companyId}/agent-runtime-decisions/trust-rules`,
    ),
  revokeTrustRule: (companyId: string, ruleId: string) =>
    api.delete<{ success: true }>(
      `/companies/${companyId}/agent-runtime-decisions/trust-rules/${ruleId}`,
    ),
};
