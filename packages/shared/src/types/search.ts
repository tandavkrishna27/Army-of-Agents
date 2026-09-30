export type GlobalSearchEntityType =
  | "task"
  | "goal"
  | "agent"
  | "brief"
  | "memory"
  | "artifact"
  | "suggestion";

export interface GlobalSearchResult {
  id: string;
  type: GlobalSearchEntityType;
  title: string;
  subtitle: string | null;
  href: string;
  score: number;
  identifier?: string | null;
  status?: string | null;
  role?: string | null;
  projectId?: string | null;
  projectIds?: string[] | null;
  departmentName?: string | null;
  departmentId?: string | null;
  category?: string | null;
  layer?: string | null;
  visibility?: string | null;
  assigneeUserId?: string | null;
  taskAssigneeUserId?: string | null;
  artifactType?: string | null;
  currentVersionNumber?: number | null;
  linkedIssueProjectId?: string | null;
  linkedIssueAssigneeUserId?: string | null;
  suggestionCategory?: string | null;
  relatedMemoryItemId?: string | null;
  relatedMemoryDepartmentId?: string | null;
  relatedMemoryProjectId?: string | null;
  relatedMemoryVisibility?: string | null;
  relatedMemoryTaskAssigneeUserId?: string | null;
}

export interface GlobalSearchGroup {
  type: GlobalSearchEntityType;
  label: string;
  count: number;
  items: GlobalSearchResult[];
}

export interface GlobalSearchResponse {
  query: string;
  tookMs: number;
  totalCount: number;
  groups: GlobalSearchGroup[];
}
