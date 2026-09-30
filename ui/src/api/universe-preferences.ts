import type {
  UniversePreferencePatchInput,
  UniversePreferenceResetInput,
  UniversePreferencesSnapshot,
} from "@armyofagents/shared";
import { api } from "./client";

const path = (companyId: string) => `/companies/${companyId}/universe/preferences/me`;
export const universePreferencesApi = {
  get: (companyId: string, signal?: AbortSignal) => api.get<UniversePreferencesSnapshot>(path(companyId), { signal }),
  patch: (companyId: string, input: UniversePreferencePatchInput, signal?: AbortSignal) =>
    api.patch<UniversePreferencesSnapshot>(path(companyId), input, { signal }),
  reset: (companyId: string, input: UniversePreferenceResetInput) =>
    api.post<UniversePreferencesSnapshot>(`${path(companyId)}/reset`, input),
};
