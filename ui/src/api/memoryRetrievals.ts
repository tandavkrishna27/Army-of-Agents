import { api } from "./client";
import type { MemoryRetrievalTrigger } from "@armyofagents/shared";

/**
 * Workspace MemorySection consumes this retrieval audit API.
 *
 * Each row is a memory_retrievals audit entry left-joined with the
 * source memory_item. Item fields are nullable because items can be
 * deleted while the audit row persists (audit-preserve invariant).
 */
export interface MemoryRetrievalRowApi {
  id: string;
  companyId: string;
  agentId: string | null;
  runId: string | null;
  taskId: string | null;
  /** Phase 7: set for commander_query retrievals; null for agent/skill paths. */
  conversationId: string | null;
  triggeredBy: MemoryRetrievalTrigger;
  query: string | null;
  itemId: string | null;
  similarityScore: string | null; // numeric serialized as string
  rank: number | null;
  shownToAgent: boolean;
  createdAt: string;
  // joined memory_item fields (null when item deleted)
  itemTitle: string | null;
  itemContent: string | null;
  itemCategory: string | null;
  itemLayer: string | null;
  itemStatus: string | null;
  itemPinnedToSkill: boolean | null;
}

export const memoryRetrievalsApi = {
  listForIssue: (
    companyId: string,
    issueId: string,
    opts: { limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get<MemoryRetrievalRowApi[]>(
      `/companies/${companyId}/issues/${issueId}/memory-retrievals${qs ? `?${qs}` : ""}`,
    );
  },

  /** Phase 7: retrieve memory audit rows for a Commander conversation (Memory cockpit card). */
  listForConversation: (
    companyId: string,
    conversationId: string,
    opts: { limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get<MemoryRetrievalRowApi[]>(
      `/companies/${companyId}/conversations/${conversationId}/memory-retrievals${qs ? `?${qs}` : ""}`,
    );
  },
};
