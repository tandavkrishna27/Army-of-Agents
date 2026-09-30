import type {
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
} from "@armyofagents/shared";
import { api } from "./client";

export const companyPortabilityApi = {
  previewExport: (companyId: string, include: CompanyPortabilityInclude) =>
    api.post<CompanyPortabilityExportPreviewResult>(
      `/companies/${companyId}/export/preview`,
      { include },
    ),
  exportBundle: (companyId: string, include: CompanyPortabilityInclude) =>
    api.post<CompanyPortabilityExportResult>(
      `/companies/${companyId}/export`,
      { include },
    ),
  previewImport: (request: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>(
      `/companies/import/preview`,
      request,
    ),
  importBundle: (request: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>(
      `/companies/import`,
      request,
    ),
};
