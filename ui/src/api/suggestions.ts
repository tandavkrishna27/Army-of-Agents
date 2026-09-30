import type { Suggestion } from "@armyofagents/shared";
import { api } from "./client";

export const suggestionsApi = {
  pending: (companyId: string) =>
    api.get<Suggestion[]>(`/companies/${companyId}/suggestions/pending`),
  detect: (companyId: string) =>
    api.post<{ ok: true }>(`/companies/${companyId}/suggestions/detect`, {}),
  accept: (companyId: string, suggestionId: string) =>
    api.post<Suggestion>(`/companies/${companyId}/suggestions/${suggestionId}/accept`, {}),
  dismiss: (companyId: string, suggestionId: string) =>
    api.post<Suggestion>(`/companies/${companyId}/suggestions/${suggestionId}/dismiss`, {}),
};
