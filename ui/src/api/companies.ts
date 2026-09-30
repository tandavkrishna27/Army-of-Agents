import type {
  Company,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
} from "@armyofagents/shared";
import { api } from "./client";

export type CompanyStats = Record<
  string,
  {
    agentCount: number;
    issueCount: number;
    pendingApprovalCount: number;
    unreadNotificationCount: number;
  }
>;

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  stats: () => api.get<CompanyStats>("/companies/stats"),
  // The OnboardingWizard no longer sends Commander/Crew adapter picks at
  // company-create time. The live internal_agent_config fields (Commander
  // cliTool/model + crew provider/crewModel) are written by a follow-up
  // internalAgentApi.updateConfig PATCH after the company is created — see
  // OnboardingWizard.handleStep4Next. The server's create validator and the
  // legacy DB columns are kept for rollback safety, but the UI create flow no
  // longer populates commanderAdapterConfig / crewAdapterConfig, so they are
  // dropped from this payload type.
  create: (data: {
    name: string;
    // Phase 2 Task 12: optional here (the server derives DEFAULT_ORGANIZATION_ID
    // when omitted — self-hosted single-tenant callers, if any are added
    // later, don't need to send it). The onboarding CompanyContext.createCompany
    // caller always supplies it.
    organizationId?: string;
    creationRequestId?: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) => api.post<Company>("/companies", data),
  update: (
    companyId: string,
    data: Partial<
      Pick<
        Company,
        "name" | "description" | "status" | "budgetMonthlyCents" | "requireBoardApprovalForNewAgents" | "brandColor" | "vision" | "mission" | "values" | "mcpEnabled" | "rootFolder" | "humanQuestionSlaHours"
      >
    >,
  ) => api.patch<Company>(`/companies/${companyId}`, data),
  archive: (companyId: string) => api.post<Company>(`/companies/${companyId}/archive`, {}),
  remove: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}`),
  exportBundle: (companyId: string, data: { include?: { company?: boolean; agents?: boolean } }) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/export`, data),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
  uploadLogo: (companyId: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return api.postForm<{ logoAssetId: string; logoUrl: string }>(
      `/companies/${companyId}/logo`,
      formData,
    );
  },
  removeLogo: (companyId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/logo`),
};
