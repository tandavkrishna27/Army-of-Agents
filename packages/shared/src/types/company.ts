import type { AgentCompletionPolicy, CompanyStatus } from "../constants.js";

export interface Company {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  agentCompletionPolicyDefault?: AgentCompletionPolicy;
  agentCompletionReviewGuardrail?: boolean;
  humanQuestionSlaHours?: number;
  vision: string | null;
  mission: string | null;
  values: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  rootFolder: string | null;
  mcpEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
