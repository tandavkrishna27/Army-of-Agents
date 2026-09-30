export type TaskOutputType =
  | "artifact"
  | "artifact_version"
  | "detected_file"
  | "preview_url"
  | "runtime_service"
  | "pull_request"
  | "branch"
  | "commit"
  | "external_link";

export type TaskOutputStatus =
  | "pending"
  | "active"
  | "running"
  | "stopped"
  | "merged"
  | "closed"
  | "failed"
  | "dismissed";

export type TaskOutputReviewState = "none" | "needs_review" | "approved" | "changes_requested";

export interface TaskOutput {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string;
  type: TaskOutputType;
  provider: string;
  externalId: string | null;
  artifactId: string | null;
  artifactVersionId: string | null;
  assetId: string | null;
  executionWorkspaceId: string | null;
  runtimeServiceId: string | null;
  url: string | null;
  title: string;
  status: TaskOutputStatus;
  reviewState: TaskOutputReviewState;
  isPrimary: boolean;
  healthStatus: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdByRunId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
