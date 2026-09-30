import { api } from "./client";

export type ViewerControlLevel = "manual" | "own_output" | "full";
export type ViewerControlSource = "user" | "company";

export interface ViewerPreference {
  viewerControlLevel: ViewerControlLevel | null;
  effectiveLevel: ViewerControlLevel;
  source: ViewerControlSource;
}

function base(companyId: string) {
  return `/companies/${companyId}/viewer-preferences/me`;
}

export const viewerPreferencesApi = {
  get: (companyId: string) => api.get<ViewerPreference>(base(companyId)),
  patch: (companyId: string, viewerControlLevel: ViewerControlLevel | null) =>
    api.patch<ViewerPreference>(base(companyId), { viewerControlLevel }),
};
