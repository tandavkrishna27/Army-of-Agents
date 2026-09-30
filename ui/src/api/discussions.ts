import type {
  CreateDiscussion,
  CreateDiscussionEntry,
  UpdateDiscussion,
  ApproveItems,
  CreateAnnotation,
  ShowRef,
} from "@armyofagents/shared";
import { api } from "./client";

export interface DiscussionListItem {
  id: string;
  title: string;
  status: "active" | "archived";
  scopeType: string | null;
  scopeId: string | null;
  scopeName: string | null;
  tags: string[];
  entryCount: number;
  pendingItemCount: number;
  lastEntryAt: string | null;
  lastEntryInputType: string | null;
  createdBy: string;
  createdAt: string;
  participantPreview?: DiscussionParticipantPreview[];
  participantCount?: number;
  linkCount?: number;
  derivedStage?: ThreadDerivedStage;
}

export interface ThreadDerivedStage {
  stage: "live" | "discussing" | "scoping" | "scoped" | "assigned" | "complete" | "archived";
  label: string;
  versionNumber: number | null;
  scopeVersionId: string | null;
  hasNewEntries: boolean;
  newEntryCount: number;
}

export interface DiscussionParticipantPreview {
  principalType: "user" | "agent";
  principalId: string;
  name: string;
  role: string;
}

export interface DiscussionListResponse {
  discussions: DiscussionListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ExtractedItem {
  id: string;
  type: string;
  title: string;
  description: string | null;
  suggestedPriority: string | null;
  suggestedAssigneeId: string | null;
  suggestedDepartmentId: string | null;
  suggestedLayer: string | null;
  layer: string | null;
  priority: string | null;
  dedupAction: string | null;
  status: "pending" | "approved" | "rejected" | "edited";
  resultTaskId: string | null;
  resultMemoryId: string | null;
  conflictsWith: string | null;
  createdAt: string;
}

export interface Annotation {
  id: string;
  content: string;
  anchorStart: number | null;
  anchorEnd: number | null;
  createdBy: string;
  createdAt: string;
}

/**
 * Phase E2: Inline attachment row for a discussion entry. Returned by the
 * server alongside extractedItems/annotations. Either assetId OR artifactId
 * is non-null (or both may be null for legacy rows). artifactType/artifactTitle
 * come from a LEFT JOIN against artifacts.
 */
export interface DiscussionEntryAttachment {
  id: string;
  assetId: string | null;
  artifactId: string | null;
  artifactType: string | null;
  artifactTitle: string | null;
  assetContentType?: string | null;
  assetOriginalFilename?: string | null;
  assetByteSize?: number | null;
  // Artifact Lifecycle P1
  artifactStatus?: string | null;
  currentVersionStorageKind?: string | null;
  currentVersionFilename?: string | null;
  currentVersionContentType?: string | null;
  currentVersionByteSize?: number | null;
  currentVersionAssetId?: string | null;
}

export interface DiscussionEntry {
  id: string;
  inputType: string;
  rawContent: string;
  title: string | null;
  sourceInfo: Record<string, unknown> | null;
  departmentId: string | null;
  projectId: string | null;
  goalId: string | null;
  parentEntryId: string | null;
  authorAgentId: string | null;
  authorAgentName: string | null;
  authorAgentAvatar: string | null;
  extractionStatus: "pending" | "processing" | "completed" | "failed" | "skipped";
  createdBy: string;
  createdAt: string;
  extractedItems: ExtractedItem[];
  annotations: Annotation[];
  /** Phase E2: attachments linked via discussion_entry_attachments. */
  attachments?: DiscussionEntryAttachment[];
  /**
   * Viewer Upgrade Phase 7B: navigational ShowRefs carried by crew run-result
   * entries. Only run-result delivery entries populate this; all other entries
   * omit it.
   */
  outputRefs?: ShowRef[] | null;
  /**
   * Phase E2: number of nested replies (parentEntryId === this.id).
   * Computed client-side from the entries list when not provided by the server.
   */
  replyCount?: number;
}

export interface DiscussionDetail {
  id: string;
  title: string;
  status: "active" | "archived";
  scopeType: string | null;
  scopeId: string | null;
  scopeName: string | null;
  tags: string[];
  entryCount: number;
  pendingItemCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  entries: DiscussionEntry[];
  crewPaused: boolean;
  autonomyLevel: number | null;
  derivedStage?: ThreadDerivedStage;
  /** PR-A2: thread-level coordination error (commit failure / circuit-breaker / runner throw); null when healthy. */
  lastError?: string | null;
  consecutiveCommitFailures?: number;
}

export type ThreadScopeVersionStatus = "draft" | "accepted" | "superseded" | "completed" | "rejected";
export type ThreadScopeItemKind =
  | "task_proposal"
  | "task_change"
  | "memory_candidate"
  | "artifact_link"
  | "decision"
  | "assumption"
  | "open_question"
  | "source_signal";
export type ThreadScopeItemStatus = "draft" | "accepted" | "applied" | "rejected";

export interface ThreadScopeVersionSummary {
  id: string;
  threadId: string;
  versionNumber: number;
  status: ThreadScopeVersionStatus;
  sourceStartSeq: number;
  sourceEndSeq: number;
  summary: string;
  assumptions: unknown[];
  decisions: unknown[];
  openQuestions: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadScopeItem {
  id: string;
  kind: ThreadScopeItemKind;
  status: ThreadScopeItemStatus;
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  sourceEntryIds: unknown[];
  resultIssueId: string | null;
  resultMemoryId: string | null;
  artifactId: string | null;
  artifactVersionId: string | null;
}

export interface ThreadScopeVersionDetail extends ThreadScopeVersionSummary {
  items: ThreadScopeItem[];
}

export interface ThreadScopeVersionsResponse {
  versions: ThreadScopeVersionSummary[];
  total: number;
}

export interface ReviewScopeItemsRequest {
  items: Array<{ itemId: string; status: "draft" | "accepted" | "rejected" }>;
}

export interface UpdateScopeItemRequest {
  title?: string;
  description?: string | null;
  payload?: Record<string, unknown>;
  sourceEntryIds?: string[];
  status?: "draft" | "accepted" | "rejected";
}

export interface CreateScopeOutputItemResponse {
  ok: boolean;
  item: ThreadScopeItem;
  createdTask?: {
    id: string;
    assigneeAgentId: string | null;
    workMode: string | null;
    sourceDiscussionId?: string | null;
    scopeVersionId?: string | null;
  };
  createdMemoryId?: string;
  artifactLinkId?: string;
}

// TODO: Verify ApproveItemsResponse shape matches backend — spec shows object arrays
// ({ itemId, taskId, title }[]) but we type as string[]. Update if backend returns objects.
export interface ApproveItemsResponse {
  approved: number;
  rejected: number;
  tasksCreated: string[];
  memoryItemsCreated: string[];
}

export interface DiscussionListFilters {
  status?: "active" | "archived" | "all";
  scopeType?: string;
  scopeId?: string;
  hasPendingItems?: boolean;
  inputType?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sortBy?: "lastEntryAt" | "createdAt" | "pendingItemCount";
  sortOrder?: "asc" | "desc";
}

function buildDiscussionParams(filters: DiscussionListFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.scopeType) params.set("scopeType", filters.scopeType);
  if (filters.scopeId) params.set("scopeId", filters.scopeId);
  if (filters.hasPendingItems !== undefined)
    params.set("hasPendingItems", String(filters.hasPendingItems));
  if (filters.inputType) params.set("inputType", filters.inputType);
  if (filters.search) params.set("search", filters.search);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  if (filters.sortBy) params.set("sortBy", filters.sortBy);
  if (filters.sortOrder) params.set("sortOrder", filters.sortOrder);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const discussionsApi = {
  list: (companyId: string, filters: DiscussionListFilters = {}) =>
    api.get<DiscussionListResponse>(
      `/companies/${companyId}/discussions${buildDiscussionParams(filters)}`,
    ),

  get: (companyId: string, discussionId: string) =>
    api.get<DiscussionDetail>(`/companies/${companyId}/discussions/${discussionId}`),

  create: (companyId: string, data: CreateDiscussion) =>
    api.post<DiscussionDetail>(`/companies/${companyId}/discussions`, data),

  update: (companyId: string, discussionId: string, data: UpdateDiscussion) =>
    api.patch<DiscussionDetail>(
      `/companies/${companyId}/discussions/${discussionId}`,
      data,
    ),

  addEntry: (companyId: string, discussionId: string, data: CreateDiscussionEntry) =>
    api.post<DiscussionEntry>(
      `/companies/${companyId}/discussions/${discussionId}/entries`,
      data,
    ),

  reprocessEntry: (
    companyId: string,
    discussionId: string,
    entryId: string,
    opts?: { includeAnnotations?: boolean },
  ) =>
    api.post<{ entryId: string; extractionStatus: string; runId: string }>(
      `/companies/${companyId}/discussions/${discussionId}/entries/${entryId}/reprocess`,
      opts ?? {},
    ),

  reprocessAll: (companyId: string, discussionId: string) =>
    api.post<{ reprocessedCount: number; skippedCount: number }>(
      `/companies/${companyId}/discussions/${discussionId}/reprocess`,
      {},
    ),

  approveItems: (companyId: string, discussionId: string, data: ApproveItems) =>
    api.post<ApproveItemsResponse>(
      `/companies/${companyId}/discussions/${discussionId}/approve`,
      data,
    ),

  updateItem: (
    companyId: string,
    discussionId: string,
    entryId: string,
    itemId: string,
    data: Record<string, unknown>,
  ) =>
    api.patch<ExtractedItem>(
      `/companies/${companyId}/discussions/${discussionId}/entries/${entryId}/items/${itemId}`,
      data,
    ),

  rejectItems: (companyId: string, discussionId: string, itemIds: string[]) =>
    api.post<ApproveItemsResponse>(
      `/companies/${companyId}/discussions/${discussionId}/approve`,
      { items: itemIds.map((id) => ({ itemId: id, action: "rejected" as const })) },
    ),

  // TODO: Add entry linking (spec 1.10 — move entries between discussions)
  // TODO: Add updateAnnotation / deleteAnnotation when server endpoints exist

  addAnnotation: (
    companyId: string,
    discussionId: string,
    entryId: string,
    data: CreateAnnotation,
  ) =>
    api.post<Annotation>(
      `/companies/${companyId}/discussions/${discussionId}/entries/${entryId}/annotations`,
      data,
    ),

  /**
   * P1-T7: Approve a scope proposal entry.
   * The server validates authz (founder/team_lead), stale check, and idempotency.
   */
  approveProposal: (companyId: string, discussionId: string, proposalEntryId: string) =>
    api.post<{ alreadyApproved: boolean; tasksCreated: string[] }>(
      `/companies/${companyId}/discussions/${discussionId}/proposals/${proposalEntryId}/approve`,
      {},
    ),

  listScopeVersions: (companyId: string, discussionId: string) =>
    api.get<ThreadScopeVersionsResponse>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions`,
    ),

  getScopeVersion: (companyId: string, discussionId: string, scopeVersionId: string) =>
    api.get<ThreadScopeVersionDetail>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}`,
    ),

  createScopeDraft: (
    companyId: string,
    discussionId: string,
    data: { summary?: string; assumptions?: unknown[]; decisions?: unknown[]; openQuestions?: unknown[]; mode?: "generate" | "manual" } = {},
  ) =>
    api.post<{ status: "created" | "existing_draft" | "no_entries"; version?: ThreadScopeVersionSummary }>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/draft`,
      data,
    ),

  acceptScopeVersion: (companyId: string, discussionId: string, scopeVersionId: string, itemIds: string[]) =>
    api.post<{ ok: boolean; alreadyAccepted?: boolean; createdTasks?: unknown[]; appliedItems?: unknown[] }>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}/accept`,
      { itemIds },
    ),

  reviewScopeItems: (
    companyId: string,
    discussionId: string,
    scopeVersionId: string,
    data: ReviewScopeItemsRequest,
  ) =>
    api.post<{ ok: boolean; updatedItems: ThreadScopeItem[] }>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/review`,
      data,
    ),

  updateScopeItem: (
    companyId: string,
    discussionId: string,
    scopeVersionId: string,
    itemId: string,
    data: UpdateScopeItemRequest,
  ) =>
    api.patch<{ ok: boolean; item: ThreadScopeItem }>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}`,
      data,
    ),

  createScopeOutputItem: (
    companyId: string,
    discussionId: string,
    scopeVersionId: string,
    itemId: string,
    data: { memoryStatus?: "approved" | "pending" } = {},
  ) =>
    api.post<CreateScopeOutputItemResponse>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}/create`,
      data,
    ),

  applyScopeVersion: (companyId: string, discussionId: string, scopeVersionId: string) =>
    api.post<{ ok: boolean; createdTasks?: unknown[]; appliedItems?: unknown[] }>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}/apply`,
      {},
    ),

  rejectScopeVersion: (companyId: string, discussionId: string, scopeVersionId: string) =>
    api.post<{ ok: boolean }>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}/reject`,
      {},
    ),

  completeScopeVersion: (companyId: string, discussionId: string, scopeVersionId: string) =>
    api.post<{ ok: boolean }>(
      `/companies/${companyId}/discussions/${discussionId}/scope-versions/${scopeVersionId}/complete`,
      {},
    ),
};
