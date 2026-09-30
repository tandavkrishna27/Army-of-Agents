import type {
  CompanyBrainEdgeKind,
  CompanyBrainMemoryUsageResponse,
  CompanyBrainNeighborsResponse,
  CompanyBrainOverviewResponse,
  CompanyBrainSemanticEdgeRecord,
  CreateCompanyBrainSemanticEdge,
  MemoryItem,
  MemoryItemVersion,
  PendingMemoryQueue,
  Suggestion,
  UpdateCompanyBrainSemanticEdge,
} from "@armyofagents/shared";
import { api } from "./client";

/** Shape returned by GET /companies/:cid/memory */
export interface MemoryListResponse {
  items: MemoryItem[];
  semanticAvailable: boolean;
}

export type SimilarMemoryItem = MemoryItem & {
  similarity?: number | null;
};

export const memoryApi = {
  list: (
    companyId: string,
    filters?: {
      category?: string;
      status?: string;
      source?: string;
      departmentId?: string;
      projectId?: string;
      layer?: string;
      tags?: string[];
      search?: string;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.category) params.set("category", filters.category);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.source) params.set("source", filters.source);
    if (filters?.departmentId) params.set("departmentId", filters.departmentId);
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.layer) params.set("layer", filters.layer);
    if (filters?.tags && filters.tags.length > 0) params.set("tags", filters.tags.join(","));
    if (filters?.search) params.set("search", filters.search);
    const qs = params.toString();
    return api.get<MemoryListResponse>(`/companies/${companyId}/memory${qs ? `?${qs}` : ""}`);
  },
  get: (companyId: string, id: string) =>
    api.get<MemoryItem>(`/companies/${companyId}/memory/${id}`),
  neighbors: (
    companyId: string,
    id: string,
    options?: {
      depth?: 1;
      kinds?: CompanyBrainEdgeKind[];
    },
  ) => {
    const params = new URLSearchParams();
    if (options?.depth !== undefined) params.set("depth", String(options.depth));
    if (options?.kinds && options.kinds.length > 0) params.set("kinds", options.kinds.join(","));
    const qs = params.toString();
    return api.get<CompanyBrainNeighborsResponse>(
      `/companies/${companyId}/memory/items/${encodeURIComponent(id)}/neighbors${qs ? `?${qs}` : ""}`,
    );
  },
  usage: (companyId: string, id: string) =>
    api.get<CompanyBrainMemoryUsageResponse>(
      `/companies/${companyId}/memory/items/${encodeURIComponent(id)}/usage`,
    ),
  companyGraph: (
    companyId: string,
    options?: {
      limit?: number;
      includeStructural?: boolean;
      kinds?: CompanyBrainEdgeKind[];
    },
  ) => {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.includeStructural !== undefined) {
      params.set("includeStructural", String(options.includeStructural));
    }
    if (options?.kinds && options.kinds.length > 0) {
      params.set("kinds", options.kinds.join(","));
    }
    const qs = params.toString();
    return api.get<CompanyBrainOverviewResponse>(
      `/companies/${companyId}/memory/graph${qs ? `?${qs}` : ""}`,
    );
  },
  createGraphEdge: (companyId: string, data: CreateCompanyBrainSemanticEdge) =>
    api.post<CompanyBrainSemanticEdgeRecord>(`/companies/${companyId}/memory/graph/edges`, data),
  updateGraphEdge: (companyId: string, edgeId: string, data: UpdateCompanyBrainSemanticEdge) =>
    api.patch<CompanyBrainSemanticEdgeRecord>(
      `/companies/${companyId}/memory/graph/edges/${encodeURIComponent(edgeId)}`,
      data,
    ),
  archiveGraphEdge: (companyId: string, edgeId: string) =>
    api.delete<CompanyBrainSemanticEdgeRecord>(
      `/companies/${companyId}/memory/graph/edges/${encodeURIComponent(edgeId)}`,
    ),
  listPending: (companyId: string) =>
    api.get<PendingMemoryQueue>(`/companies/${companyId}/memory-pending`),
  findSimilarItems: (
    companyId: string,
    content: string,
    filters?: { departmentId?: string; layer?: string },
  ) => {
    const params = new URLSearchParams({ content });
    if (filters?.departmentId) params.set("departmentId", filters.departmentId);
    if (filters?.layer) params.set("layer", filters.layer);
    return api.get<SimilarMemoryItem[]>(
      `/companies/${companyId}/memory/find-similar?${params.toString()}`,
    );
  },
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<MemoryItem>(`/companies/${companyId}/memory`, data),
  update: (companyId: string, id: string, data: Record<string, unknown>) =>
    api.patch<MemoryItem>(`/companies/${companyId}/memory/${id}`, data),
  remove: (companyId: string, id: string) =>
    api.delete<MemoryItem>(`/companies/${companyId}/memory/${id}`),
  approve: (companyId: string, id: string) =>
    api.post<MemoryItem>(`/companies/${companyId}/memory/${id}/approve`, {}),
  reject: (companyId: string, id: string) =>
    api.post<MemoryItem>(`/companies/${companyId}/memory/${id}/reject`, {}),

  // Version management
  getVersions: (companyId: string, id: string) =>
    api.get<MemoryItemVersion[]>(`/companies/${companyId}/memory/${id}/versions`),
  suggestUpdate: (companyId: string, id: string, content: string, sourceContext: string, agentId: string) =>
    api.post<MemoryItemVersion>(`/companies/${companyId}/memory/${id}/suggest-update`, {
      content,
      sourceContext,
      agentId,
    }),
  suggestArchive: (companyId: string, id: string, sourceContext: string, agentId: string) =>
    api.post<Suggestion>(`/companies/${companyId}/memory/${id}/suggest-archive`, {
      sourceContext,
      agentId,
    }),
  saveDraft: (companyId: string, id: string, content: string) =>
    api.post<MemoryItemVersion>(`/companies/${companyId}/memory/${id}/draft`, { content }),
  publishDraft: (companyId: string, id: string) =>
    api.post<MemoryItemVersion>(`/companies/${companyId}/memory/${id}/publish`, {}),
  approveVersion: (companyId: string, id: string, versionId: string) =>
    api.post<MemoryItemVersion>(`/companies/${companyId}/memory/${id}/versions/${versionId}/approve`, {}),
  rejectVersion: (companyId: string, id: string, versionId: string) =>
    api.post<MemoryItemVersion>(`/companies/${companyId}/memory/${id}/versions/${versionId}/reject`, {}),
  restore: (companyId: string, id: string) =>
    api.post<MemoryItem>(`/companies/${companyId}/memory/${id}/restore`, {}),
  touchAccessedAt: (companyId: string, id: string) =>
    api.post<MemoryItem>(`/companies/${companyId}/memory/${id}/touch`, {}),
  moveItem: async (
    companyId: string,
    id: string,
    folderPath: string,
  ): Promise<MemoryItem> => {
    return api.patch<MemoryItem>(
      `/companies/${companyId}/memory/items/${id}/move`,
      { folderPath },
    );
  },
  setPinnedToTop: async (
    companyId: string,
    id: string,
    pinned: boolean,
  ): Promise<MemoryItem> => {
    return api.patch<MemoryItem>(
      `/companies/${companyId}/memory/items/${id}/pin-to-top`,
      { pinned },
    );
  },
  changeLayer: async (
    companyId: string,
    id: string,
    input: {
      newLayer: "identity" | "domain" | "active_context" | "working";
      departmentId?: string | null;
      goalId?: string | null;
      taskId?: string | null;
      expiresAt?: string | Date | null;
    },
  ): Promise<MemoryItem> => {
    return api.post<MemoryItem>(
      `/companies/${companyId}/memory/items/${id}/change-layer`,
      {
        ...input,
        expiresAt:
          input.expiresAt instanceof Date
            ? input.expiresAt.toISOString()
            : input.expiresAt ?? null,
      },
    );
  },
  searchSemantic: (
    companyId: string,
    q: string,
    filters?: {
      layer?: string;
      departmentId?: string;
      limit?: number;
    },
  ) => {
    const params = new URLSearchParams();
    params.set("q", q);
    if (filters?.layer) params.set("layer", filters.layer);
    if (filters?.departmentId) params.set("departmentId", filters.departmentId);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    return api.get<Array<MemoryItem & { similarity: number | null }>>(
      `/companies/${companyId}/memory/search?${params.toString()}`,
    );
  },

  /** Re-index a single memory item's embedding. */
  reindexItem: (companyId: string, id: string) =>
    api.post<MemoryItem>(`/companies/${companyId}/memory/${encodeURIComponent(id)}/reindex`, {}),

  /** Re-index all failed embeddings for the company. */
  reindexFailed: (companyId: string) =>
    api.post<{ requeued: number }>(`/companies/${companyId}/memory/reindex-failed`, {}),

  /** Founder-only: re-embed every memory item in the company (dedup-safe). */
  reindexAll: (companyId: string) =>
    api.post<{ reindexed: number }>(`/companies/${companyId}/memory/reindex-all`, {}),
};
