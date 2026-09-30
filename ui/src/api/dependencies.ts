import { api } from "./client";

export interface DependencyItem {
  id: string;
  dependencyIssueId?: string;
  dependentIssueId?: string;
  title: string;
  status: string;
  identifier?: string | null;
  createdAt: string;
}

export interface DependenciesResponse {
  upstream: DependencyItem[];
  downstream: DependencyItem[];
}

export const dependenciesApi = {
  list: (companyId: string, issueId: string) =>
    api.get<DependenciesResponse>(
      `/companies/${companyId}/issues/${issueId}/dependencies`,
    ),
  add: (companyId: string, issueId: string, dependencyIssueId: string) =>
    api.post(`/companies/${companyId}/issues/${issueId}/dependencies`, {
      dependencyIssueId,
    }),
  remove: (
    companyId: string,
    issueId: string,
    dependencyIssueId: string,
  ) =>
    api.delete(
      `/companies/${companyId}/issues/${issueId}/dependencies/${dependencyIssueId}`,
    ),
};
