import type { CreateFinanceEvent } from "@armyofagents/shared";
import { api } from "./client";

export interface FinanceSummary {
  companyId: string;
  debitCents: number;
  creditCents: number;
  netCents: number;
  estimatedDebitCents: number;
  eventCount: number;
}

export interface FinanceBillerRow {
  biller: string | null;
  debitCents: number;
  creditCents: number;
  estimatedDebitCents: number;
  eventCount: number;
  kindCount: number;
  netCents: number;
}

export interface FinanceKindRow {
  eventKind: string;
  debitCents: number;
  creditCents: number;
  estimatedDebitCents: number;
  eventCount: number;
  billerCount: number;
  netCents: number;
}

export interface FinanceEvent {
  id: string;
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  costEventId: string | null;
  billingCode: string | null;
  description: string | null;
  eventKind: string;
  direction: "debit" | "credit";
  biller: string;
  provider: string | null;
  executionAdapterType: string | null;
  pricingTier: string | null;
  region: string | null;
  model: string | null;
  quantity: number | null;
  unit: string | null;
  amountCents: number;
  currency: string;
  estimated: boolean;
  externalInvoiceId: string | null;
  metadataJson: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
}

export interface FinanceListParams {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

function rangeParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function listParams(params: FinanceListParams): string {
  const search = new URLSearchParams();
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.limit != null) search.set("limit", String(params.limit));
  if (params.offset != null) search.set("offset", String(params.offset));
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export const financeApi = {
  summary: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceSummary>(`/companies/${companyId}/finance/summary${rangeParams(from, to)}`),

  byBiller: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceBillerRow[]>(`/companies/${companyId}/finance/by-biller${rangeParams(from, to)}`),

  byKind: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceKindRow[]>(`/companies/${companyId}/finance/by-kind${rangeParams(from, to)}`),

  list: (companyId: string, params: FinanceListParams = {}) =>
    api.get<FinanceEvent[]>(`/companies/${companyId}/finance/list${listParams(params)}`),

  createEvent: (companyId: string, input: CreateFinanceEvent) =>
    api.post<FinanceEvent>(`/companies/${companyId}/finance-events`, input),
};
