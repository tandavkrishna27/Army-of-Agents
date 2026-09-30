import { api } from "./client";
import type { ThreadVisibility, ThreadSubtype } from "@armyofagents/shared";
import {
  discussionsApi,
  type DiscussionListItem,
  type DiscussionDetail,
  type DiscussionListFilters,
  type DiscussionListResponse,
  type ThreadScopeVersionDetail,
  type ThreadScopeVersionsResponse,
  type ReviewScopeItemsRequest,
  type UpdateScopeItemRequest,
} from "./discussions";

// threads.ts extends the discussions API — threads ARE discussions with extra fields

/** Phase E batch 2 (T22): static roster row surfaced by GET /discussions/:id. */
export interface ThreadParticipantRow {
  /** "user" | "agent" — mirrors thread_participants.principalType. */
  principalType: "user" | "agent";
  /** user id (text/uuid) OR agent id (uuid stored as text). */
  principalId: string;
  /** Resolved display name (auth_users.email-prefix or agents.name). */
  name: string;
  /** owner | co_owner | collaborator | viewer | worker */
  role: string;
  /** ISO timestamp. */
  addedAt: string;
}

export interface ThreadFields {
  phase: "discuss" | "scope" | "assign" | "done";
  // Phase 1 (Task A2): canonicalized from open|private to private|department|company.
  // Phase 1 Phase E batch 2 (T22): the OriginCard now surfaces a 3-option
  // dropdown (Private / Department / Company); the legacy binary toggle was
  // removed. Server still patches via PATCH /discussions/:id { visibility }.
  visibility: ThreadVisibility;
  ownerUserId: string | null;
  originSource: string | null;
  intent: string[] | null;
  goalId: string | null;
  summaryText: string | null;
  summaryNext: string | null;
  /** Phase 1 Phase E batch 2 (T22): "normal" | "live" — drives feed-style UI. */
  subtype: ThreadSubtype;
  /** Phase 1 Phase E batch 2 (T22): public share link token; null when not set. */
  shareToken: string | null;
  /** Phase 1 Phase E batch 2 (T22): static roster of thread_participants rows. */
  participants: ThreadParticipantRow[];
  /**
   * Phase G3 (T5, D6): when false, memory.propose refuses with
   * MEMORY_EXTRACTION_DISABLED for entries in this thread. DB default is true.
   * Toggled by the founder in OriginCard's advanced settings.
   */
  allowMemoryExtraction: boolean;
  // crewPaused and autonomyLevel come from DiscussionDetail (the base type),
  // but are thread-specific semantics so documented here.
}

export type ThreadListItem = DiscussionListItem & ThreadFields;
export type ThreadDetail = DiscussionDetail & ThreadFields;

export interface ThreadListResponse
  extends Omit<DiscussionListResponse, "discussions"> {
  discussions: ThreadListItem[];
}

export const threadsApi = {
  list: (companyId: string, filters?: { phase?: string } & DiscussionListFilters) =>
    discussionsApi.list(companyId, filters ?? {}) as Promise<DiscussionListResponse & { discussions: ThreadListItem[] }>,

  detail: (companyId: string, id: string) =>
    discussionsApi.get(companyId, id) as Promise<ThreadDetail>,

  advancePhase: (companyId: string, id: string, phase: string) =>
    api.patch<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}/phase`,
      { phase },
    ),

  claim: (companyId: string, id: string) =>
    api.post<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}/claim`,
      {},
    ),

  transfer: (companyId: string, id: string, toUserId: string) =>
    api.post<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}/transfer`,
      { toUserId },
    ),

  addParticipant: (companyId: string, id: string, userId: string) =>
    api.post<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}/participants`,
      { userId },
    ),

  promoteToGoal: (companyId: string, id: string, goalData: Record<string, unknown>) =>
    api.post<{ threadId: string; goalId: string }>(
      `/companies/${companyId}/discussions/${id}/promote-to-goal`,
      goalData,
    ),

  setVisibility: (companyId: string, id: string, visibility: ThreadVisibility) =>
    api.patch<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}`,
      { visibility },
    ),

  setStatus: (companyId: string, id: string, status: "active" | "archived") =>
    api.patch<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}`,
      { status },
    ),

  // Phase 1 Phase E batch 2 (T22): public share-link toggle.
  // Generate creates a new opaque token (32+ bytes urlsafe) on the discussions
  // row; revoke clears it. Both are founder-only on the server.
  generateShareToken: (companyId: string, id: string) =>
    api.post<{ token: string }>(
      `/companies/${companyId}/discussions/${id}/share-token`,
      {},
    ),

  revokeShareToken: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(
      `/companies/${companyId}/discussions/${id}/share-token`,
    ),

  createLink: (companyId: string, fromId: string, toThreadId: string, kind: string) =>
    api.post<{ id: string; fromThreadId: string; toThreadId: string; kind: string }>(
      `/companies/${companyId}/discussions/${fromId}/links`,
      { toThreadId, kind },
    ),

  listLinks: (companyId: string, id: string) =>
    api.get<{ links: Array<{ id: string; fromThreadId: string; toThreadId: string; kind: string }> }>(
      `/companies/${companyId}/discussions/${id}/links`,
    ),

  spinOff: (companyId: string, id: string, scopeItemId: string, title?: string) =>
    api.post<{ id: string; forkedFromId: string; title: string | null }>(
      `/companies/${companyId}/discussions/${id}/spin-off`,
      { scopeItemId, title },
    ),

  routeItem: (
    companyId: string,
    discussionId: string,
    itemId: string,
    routing: { departmentId?: string; assigneeAgentId?: string; assigneeUserId?: string },
  ) =>
    api.patch<{ itemId: string }>(
      `/companies/${companyId}/discussions/${discussionId}/items/${itemId}/routing`,
      routing,
    ),

  pauseCrew: (companyId: string, id: string) =>
    api.post<{ crewPaused: true }>(
      `/companies/${companyId}/discussions/${id}/crew/pause`,
      {},
    ),

  resumeCrew: (companyId: string, id: string) =>
    api.post<{ crewPaused: false }>(
      `/companies/${companyId}/discussions/${id}/crew/resume`,
      {},
    ),

  setAutonomyLevel: (companyId: string, id: string, autonomyLevel: number | null) =>
    api.patch<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}`,
      { autonomyLevel },
    ),

  // Phase G3 (T5, D6): per-thread Memory Keeper opt-out toggle. Patches the
  // same PATCH /discussions/:id endpoint as visibility/autonomyLevel.
  setAllowMemoryExtraction: (companyId: string, id: string, allowMemoryExtraction: boolean) =>
    api.patch<ThreadDetail>(
      `/companies/${companyId}/discussions/${id}`,
      { allowMemoryExtraction },
    ),

  // Task 0.6 (Inbound Dirty-Data Routing, Decision #14): enqueue a manual
  // human paste into thread_inbox_items (the Unlisted lane).
  // Returns { inboxItemId, deduped } — same shape as enqueueInboxItem.
  sendToInbox: (
    companyId: string,
    payload: { rawContent: string; originSource?: string },
  ) =>
    api.post<{ inboxItemId: string; deduped: boolean }>(
      `/companies/${companyId}/discussions/inbox`,
      payload,
    ),

  listScopeVersions: (companyId: string, id: string): Promise<ThreadScopeVersionsResponse> =>
    discussionsApi.listScopeVersions(companyId, id),

  getScopeVersion: (companyId: string, id: string, scopeVersionId: string): Promise<ThreadScopeVersionDetail> =>
    discussionsApi.getScopeVersion(companyId, id, scopeVersionId),

  createScopeDraft: (
    companyId: string,
    id: string,
    data: { summary?: string; assumptions?: unknown[]; decisions?: unknown[]; openQuestions?: unknown[]; mode?: "generate" | "manual" } = {},
  ) => discussionsApi.createScopeDraft(companyId, id, data),

  acceptScopeVersion: (companyId: string, id: string, scopeVersionId: string, itemIds: string[]) =>
    discussionsApi.acceptScopeVersion(companyId, id, scopeVersionId, itemIds),

  reviewScopeItems: (
    companyId: string,
    id: string,
    scopeVersionId: string,
    data: ReviewScopeItemsRequest,
  ) => discussionsApi.reviewScopeItems(companyId, id, scopeVersionId, data),

  updateScopeItem: (
    companyId: string,
    id: string,
    scopeVersionId: string,
    itemId: string,
    data: UpdateScopeItemRequest,
  ) => discussionsApi.updateScopeItem(companyId, id, scopeVersionId, itemId, data),

  createScopeOutputItem: (
    companyId: string,
    id: string,
    scopeVersionId: string,
    itemId: string,
    data?: { memoryStatus?: "approved" | "pending" },
  ) => discussionsApi.createScopeOutputItem(companyId, id, scopeVersionId, itemId, data),

  applyScopeVersion: (companyId: string, id: string, scopeVersionId: string) =>
    discussionsApi.applyScopeVersion(companyId, id, scopeVersionId),

  rejectScopeVersion: (companyId: string, id: string, scopeVersionId: string) =>
    discussionsApi.rejectScopeVersion(companyId, id, scopeVersionId),

  completeScopeVersion: (companyId: string, id: string, scopeVersionId: string) =>
    discussionsApi.completeScopeVersion(companyId, id, scopeVersionId),
};
