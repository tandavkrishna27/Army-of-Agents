import type { CostSummary, CostByAgent } from "@armyofagents/shared";
import { api } from "./client";

export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostByModelRow {
  model: string | null;
  totalCostCents: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
}

export interface CostByBillerRow {
  biller: string | null;
  totalCostCents: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  eventCount: number;
}

function dateParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  summary: (companyId: string, from?: string, to?: string) =>
    api.get<CostSummary>(`/companies/${companyId}/costs/summary${dateParams(from, to)}`),
  byAgent: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(`/companies/${companyId}/costs/by-agent${dateParams(from, to)}`),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(`/companies/${companyId}/costs/by-project${dateParams(from, to)}`),
  byModel: (companyId: string, from?: string, to?: string) =>
    api.get<CostByModelRow[]>(`/companies/${companyId}/costs/by-model${dateParams(from, to)}`),
  byBiller: (companyId: string, from?: string, to?: string) =>
    api.get<CostByBillerRow[]>(`/companies/${companyId}/costs/by-biller${dateParams(from, to)}`),
};
