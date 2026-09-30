import type {
  IssueMonitorClearReason,
  IssueMonitorStatus,
  IssuePriority,
  AgentCompletionPolicy,
  AgentCompletionPolicySource,
  IssueReviewerSource,
  IssueSource,
  IssueStatus,
  IssueWorkMode,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";

export interface IssueAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface IssueAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface IssueAncestor {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: IssueAncestorProject | null;
  goal: IssueAncestorGoal | null;
}

export interface IssueLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAssigneeAdapterOverrides {
  adapterConfig?: Record<string, unknown>;
  useProjectWorkspace?: boolean;
}

export interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: IssueAncestor[];
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  workMode: IssueWorkMode;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  executionWorkspaceId: string | null;
  executionEnvironmentId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  issueNumber: number | null;
  identifier: string | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  source: IssueSource | null;
  /**
   * Provenance of the task — how it was born. Values include `'crew_thread'`
   * (scoped from a discussion), goal/routine/MCP/direct origins, and `null` for
   * tasks with no recorded origin. This is a base `issues` column and is
   * returned on EVERY list shape (any taskScope), not just the crew board — the
   * shared card uses it to label the source badge (routine vs. direct vs.
   * thread). Only the joined `sourceThreadTitle` below is crew-scope-gated.
   */
  originKind?: string | null;
  /**
   * Phase 1 Task A3: the discussion thread (if any) that produced this task
   * via Dispatcher's scope_proposal acceptance. `null` for tasks that did not
   * originate from a thread. Joined with `discussions.title` server-side to
   * provide the optional `sourceThreadTitle` denormalization below.
   */
  sourceDiscussionId?: string | null;
  /**
   * Denormalized title of the source discussion. Populated by the issues list
   * endpoint when `crewBoard=true` is passed; absent otherwise.
   * Read-only on the client — server-derived from a LEFT JOIN.
   */
  sourceThreadTitle?: string | null;
  reviewerUserId: string | null;
  reviewerSource: IssueReviewerSource | null;
  acceptanceCriteria: string[];
  agentCompletionPolicy: AgentCompletionPolicy;
  agentCompletionPolicyOverride: AgentCompletionPolicy | null;
  agentCompletionPolicySource: AgentCompletionPolicySource;
  agentCompletionPolicySourceId: string | null;
  agentCompletionPolicyResolvedAt: Date;
  dueDate: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  artifactId: string | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  project?: Project | null;
  goal?: Goal | null;
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  isUnreadForMe?: boolean;
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorType: IssueCommentAuthorType | null;
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export type IssueCommentAuthorType = "user" | "agent" | "system";

export type IssueCommentPresentation = {
  kind: "plain" | "system_notice";
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  detailsDefaultOpen?: boolean;
};

export type IssueCommentMetadata = {
  version: 1;
  sections: Array<{
    title: string;
    rows: Array<Record<string, unknown>>;
  }>;
};

export interface IssueMonitorPolicy {
  kind: string;
  nextCheckAt: string;
  scheduledBy: "board" | "assignee";
  notes?: string | null;
  maxAttempts?: number | null;
  timeoutAt?: string | null;
  externalRef?: string | null;
  recoveryPolicy?: Record<string, unknown> | null;
}

export interface IssueMonitor {
  id: string;
  companyId: string;
  issueId: string;
  agentId: string | null;
  status: IssueMonitorStatus;
  kind: string;
  scheduledBy: "board" | "assignee" | string;
  nextCheckAt: Date | null;
  lastTriggeredAt: Date | null;
  clearedAt: Date | null;
  clearReason: IssueMonitorClearReason | string | null;
  attemptCount: number;
  maxAttempts: number | null;
  timeoutAt: Date | null;
  notes: string | null;
  externalRef: string | null;
  recoveryPolicy: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAttachment {
  id: string;
  companyId: string;
  issueId: string;
  issueCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
}

export type DocumentFormat = "markdown";

export interface IssueDocumentSummary {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  issueId: string;
  key: string;
  revisionNumber: number;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface LegacyPlanDocument {
  key: "plan";
  body: string;
  source: "issue_description";
}
