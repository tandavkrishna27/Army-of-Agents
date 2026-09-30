import type { BudgetOverview, UpsertBudgetPolicyInput, ResolveBudgetIncidentInput } from "@armyofagents/shared";
import { api } from "./client";

export const budgetsApi = {
  overview: (companyId: string) =>
    api.get<BudgetOverview>(`/companies/${companyId}/budgets/overview`),

  upsertPolicy: (companyId: string, input: UpsertBudgetPolicyInput) =>
    api.post<{ id: string }>(`/companies/${companyId}/budgets/policies`, input),

  deletePolicy: (companyId: string, policyId: string) =>
    api.delete<{ ok: boolean }>(`/companies/${companyId}/budgets/policies/${policyId}`),

  resolveIncident: (companyId: string, incidentId: string, input: ResolveBudgetIncidentInput) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/budget-incidents/${incidentId}/resolve`, input),
};
