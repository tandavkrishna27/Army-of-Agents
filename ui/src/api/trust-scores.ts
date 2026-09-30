import type { AgentTrustScore } from "@armyofagents/shared";
import { api } from "./client";

export const trustScoresApi = {
  list: (companyId: string) =>
    api.get<AgentTrustScore[]>(`/companies/${encodeURIComponent(companyId)}/trust-scores`),
  get: (companyId: string, agentId: string) =>
    api.get<AgentTrustScore | null>(
      `/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/trust-score`,
    ),
};
