export interface TaskDependency {
  id: string;
  companyId: string;
  dependentIssueId: string;
  dependencyIssueId: string;
  createdAt: Date;
}
