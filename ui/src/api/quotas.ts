import { api } from "./client";

export interface ProviderQuotaWindow {
  id: string;
  companyId: string;
  provider: string;
  model: string | null;
  windowKind: string;
  label: string | null;
  limitValue: number | null;
  usedValue: number | null;
  usedPercent: number | null;
  valueLabel: string | null;
  resetAt: string | null;
  lastUpdatedAt: string;
  createdAt: string;
}

export interface RefreshQuotasInput {
  adapterType?: string;
}

export const quotasApi = {
  list: (companyId: string) =>
    api.get<ProviderQuotaWindow[]>(`/companies/${companyId}/quotas`),

  refresh: (companyId: string, input: RefreshQuotasInput = {}) =>
    api.post<ProviderQuotaWindow[]>(`/companies/${companyId}/quotas/refresh`, input),
};
