import { api } from "./client";

export interface ContextPackageResult {
  markdown: string;
  tokenEstimate: number;
}

export const contextPackagingApi = {
  getContextPackage: (companyId: string, issueId: string) =>
    api.get<ContextPackageResult>(
      `/companies/${companyId}/issues/${issueId}/context-package`,
    ),
};
