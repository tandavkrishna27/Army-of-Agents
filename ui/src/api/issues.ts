import type { Approval, Issue, IssueAttachment, IssueComment, IssueDocument, DocumentRevision, UpsertIssueDocument, IssueLabel } from "@armyofagents/shared";
import { api } from "./client";

export type IssueContextBundle = {
  id: string;
  companyId: string;
  sourceIssueId?: string | null;
  sourceDiscussionId?: string | null;
  sourceScopeVersionId?: string | null;
  sourceScopeItemId?: string | null;
  sourceKind?: "issue" | "discussion_scope" | string;
  targetIssueId: string;
  brief?: string | null;
  items: Array<{
    id: string;
    itemType: string;
    sourceId?: string | null;
    label?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
};

export const issuesApi = {
  list: (
    companyId: string,
    filters?: {
      status?: string;
      projectId?: string;
      assigneeAgentId?: string;
      assigneeUserId?: string;
      responsibleUserId?: string;
      createdByUserId?: string;
      touchedByUserId?: string;
      unreadForUserId?: string;
      labelId?: string;
      q?: string;
      /** UUID to get children of that parent; `null` for top-level tasks only; omit for all. */
      parentId?: string | null;
      /**
       * Task 1.4: when true, restrict to tasks with origin_kind='crew_thread'
       * (crew-board provenance, decision D10). The server-side handler also opts
       * into a LEFT JOIN that populates `Issue.sourceThreadTitle` so the
       * TeamPage Tasks tab can group results by source thread title.
       * Renamed from `sourceDiscussionIdNotNull`.
       *
       * @deprecated Prefer `taskScope: 'crew'`. The server maps a bare
       * `crewBoard=true` to `taskScope='crew'`, and an explicit `taskScope`
       * always wins, so the two are interchangeable. Kept for back-compat.
       */
      crewBoard?: boolean;
      /**
       * Crew/org board separation (unified-crew-board design 2026-06-02).
       *   `org`  — exclude crew-agent tasks (the fail-safe DEFAULT applied
       *            server-side when omitted). Board surfaces that should NOT
       *            show crew work pass nothing and inherit this.
       *   `crew` — only crew-agent tasks (the Crew Board).
       *   `all`  — include both. The task GRAPH (dependencies, children,
       *            live-run labeling, search, an agent's own task list) MUST
       *            pass `all` so crew tasks stay visible there.
       * Forwarded verbatim as the `taskScope` query param.
       */
      taskScope?: "org" | "crew" | "all";
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.assigneeAgentId) params.set("assigneeAgentId", filters.assigneeAgentId);
    if (filters?.assigneeUserId) params.set("assigneeUserId", filters.assigneeUserId);
    if (filters?.responsibleUserId) params.set("responsibleUserId", filters.responsibleUserId);
    if (filters?.createdByUserId) params.set("createdByUserId", filters.createdByUserId);
    if (filters?.touchedByUserId) params.set("touchedByUserId", filters.touchedByUserId);
    if (filters?.unreadForUserId) params.set("unreadForUserId", filters.unreadForUserId);
    if (filters?.labelId) params.set("labelId", filters.labelId);
    if (filters?.q) params.set("q", filters.q);
    if (filters && Object.prototype.hasOwnProperty.call(filters, "parentId")) {
      params.set("parentId", filters.parentId === null ? "null" : (filters.parentId as string));
    }
    if (filters?.crewBoard) {
      params.set("crewBoard", "true");
    }
    if (filters?.taskScope) {
      params.set("taskScope", filters.taskScope);
    }
    const qs = params.toString();
    return api.get<Issue[]>(`/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
  },
  listLabels: (companyId: string) => api.get<IssueLabel[]>(`/companies/${companyId}/labels`),
  createLabel: (companyId: string, data: { name: string; color: string }) =>
    api.post<IssueLabel>(`/companies/${companyId}/labels`, data),
  deleteLabel: (id: string) => api.delete<IssueLabel>(`/labels/${id}`),
  get: (id: string) => api.get<Issue>(`/issues/${id}`),
  markRead: (id: string) => api.post<{ id: string; lastReadAt: Date }>(`/issues/${id}/read`, {}),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Issue>(`/companies/${companyId}/issues`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Issue>(`/issues/${id}`, data),
  remove: (id: string) => api.delete<Issue>(`/issues/${id}`),
  checkout: (id: string, agentId: string) =>
    api.post<Issue>(`/issues/${id}/checkout`, {
      agentId,
      expectedStatuses: ["todo", "backlog", "blocked"],
    }),
  release: (id: string) => api.post<Issue>(`/issues/${id}/release`, {}),
  listComments: (id: string) => api.get<IssueComment[]>(`/issues/${id}/comments`),
  addComment: (
    id: string,
    body: string,
    reopen?: boolean,
    interrupt?: boolean,
    structured?: Pick<IssueComment, "authorType" | "presentation" | "metadata">,
    /** Idempotency key (mock §5): the server replays the original comment when
     *  the same submission is retried, so an ambiguous failure never double-posts. */
    clientSubmissionId?: string,
  ) =>
    api.post<IssueComment>(
      `/issues/${id}/comments`,
      {
        body,
        ...(reopen === undefined ? {} : { reopen }),
        ...(interrupt === undefined ? {} : { interrupt }),
        ...(structured?.authorType === undefined ? {} : { authorType: structured.authorType }),
        ...(structured?.presentation === undefined ? {} : { presentation: structured.presentation }),
        ...(structured?.metadata === undefined ? {} : { metadata: structured.metadata }),
        ...(clientSubmissionId === undefined ? {} : { clientSubmissionId }),
      },
    ),
  addCommentWithAttachments: (
    id: string,
    body: string,
    files: File[],
    reopen?: boolean,
    interrupt?: boolean,
    /** Idempotency key (mock §5) — same replay semantics as addComment. */
    clientSubmissionId?: string,
  ) => {
    const form = new FormData();
    form.append("body", body);
    if (reopen !== undefined) form.append("reopen", String(reopen));
    if (interrupt !== undefined) form.append("interrupt", String(interrupt));
    if (clientSubmissionId !== undefined) form.append("clientSubmissionId", clientSubmissionId);
    for (const file of files) {
      form.append("files", file);
    }
    return api.postForm<{ comment: IssueComment; attachments: IssueAttachment[] }>(
      `/issues/${id}/comments-with-attachments`,
      form,
    );
  },
  listAttachments: (id: string) => api.get<IssueAttachment[]>(`/issues/${id}/attachments`),
  listContextBundles: (id: string) => api.get<IssueContextBundle[]>(`/issues/${id}/context-bundles`),
  updateContextBundleItemIncluded: (issueId: string, itemId: string, included: boolean) =>
    api.patch<IssueContextBundle["items"][number]>(
      `/issues/${issueId}/context-bundles/items/${itemId}`,
      { included },
    ),
  uploadAttachment: (
    companyId: string,
    issueId: string,
    file: File,
    issueCommentId?: string | null,
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (issueCommentId) {
      form.append("issueCommentId", issueCommentId);
    }
    return api.postForm<IssueAttachment>(`/companies/${companyId}/issues/${issueId}/attachments`, form);
  },
  deleteAttachment: (id: string) => api.delete<{ ok: true }>(`/attachments/${id}`),
  listApprovals: (id: string) => api.get<Approval[]>(`/issues/${id}/approvals`),
  linkApproval: (id: string, approvalId: string) =>
    api.post<Approval[]>(`/issues/${id}/approvals`, { approvalId }),
  unlinkApproval: (id: string, approvalId: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/approvals/${approvalId}`),
  listDocuments: (id: string) =>
    api.get<IssueDocument[]>(`/issues/${id}/documents`),

  getDocument: (id: string, key: string) =>
    api.get<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`),

  upsertDocument: (id: string, key: string, data: UpsertIssueDocument) =>
    api.put<IssueDocument>(`/issues/${id}/documents/${encodeURIComponent(key)}`, data),

  listDocumentRevisions: (id: string, key: string) =>
    api.get<DocumentRevision[]>(`/issues/${id}/documents/${encodeURIComponent(key)}/revisions`),

  deleteDocument: (id: string, key: string) =>
    api.delete<{ ok: true }>(`/issues/${id}/documents/${encodeURIComponent(key)}`),
};
