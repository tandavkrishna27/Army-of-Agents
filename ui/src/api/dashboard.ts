import type { DashboardSummary, HomeSummary } from "@armyofagents/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
};

export const homeApi = {
  summary: (companyId: string) => api.get<HomeSummary>(`/companies/${companyId}/home`),
};
