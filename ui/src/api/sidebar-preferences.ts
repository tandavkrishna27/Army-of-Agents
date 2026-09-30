import { api } from "./client";

export interface SidebarPreferences {
  departmentOrder: string[];
  projectOrder: string[];
  updatedAt: string | null;
}

export interface SidebarPreferencesPatch {
  departmentOrder?: string[];
  projectOrder?: string[];
}

function base(companyId: string) {
  return `/companies/${companyId}/sidebar-preferences/me`;
}

export const sidebarPreferencesApi = {
  get: (companyId: string) => api.get<SidebarPreferences>(base(companyId)),
  patch: (companyId: string, patch: SidebarPreferencesPatch) =>
    api.patch<SidebarPreferences>(base(companyId), patch),
  reset: (companyId: string) => api.post<SidebarPreferences>(`${base(companyId)}/reset`, {}),
};
