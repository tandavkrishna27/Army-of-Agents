/**
 * useCockpitApprovalAction — Phase 3c + approval-families extension.
 *
 * Single dispatcher hook: maps CockpitApprovalItem.source → the correct per-source
 * API call + invalidation keys. Always invalidates queryKeys.cockpit so the approved/
 * denied item optimistically disappears from the card on success.
 *
 * HC7 (plan): per-source approve/deny calls the RIGHT api:
 *   approval         → approvalsApi.approve(id) / reject(id)
 *   memory           → memoryApi.approve(companyId, id) / reject(companyId, id)
 *   discussion_item  → discussionsApi.approveItems(companyId, discussionId!, { items:[{itemId,action}] })
 *                      discussionsApi.rejectItems(companyId, discussionId!, [id])  (array, HC4)
 *   join_request     → accessApi.approveJoinRequest / rejectJoinRequest
 *   memory_version   → memoryApi.approveVersion(companyId, id, relatedEntityId!) / rejectVersion
 *   memory_archive   → suggestionsApi.accept(companyId, relatedEntityId!) / dismiss
 *   runtime_tool_trust → internalAgentApi.confirmAction(companyId, id, decision)
 *                        approve → "allow_once", allowAlways → "allow_always", deny → "deny"
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CockpitApprovalItem } from "@armyofagents/shared";
import { approvalsApi } from "../../../api/approvals";
import { memoryApi } from "../../../api/memory";
import { discussionsApi } from "../../../api/discussions";
import { accessApi } from "../../../api/access";
import { suggestionsApi } from "../../../api/suggestions";
import { internalAgentApi } from "../../../api/internal-agent";
import { queryKeys } from "../../../lib/queryKeys";
import { useToast } from "../../../context/ToastContext";

export function useCockpitApprovalAction(companyId: string) {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  function invalidateAll(item: CockpitApprovalItem) {
    // Always invalidate cockpit so the item disappears (the dopamine).
    void qc.invalidateQueries({ queryKey: queryKeys.cockpit(companyId) });

    // Also invalidate the source-specific keys so those pages stay fresh.
    if (item.source === "approval") {
      void qc.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    } else if (item.source === "memory") {
      void qc.invalidateQueries({ queryKey: queryKeys.memory.pending(companyId) });
      void qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
    } else if (item.source === "discussion_item") {
      if (item.discussionId) {
        void qc.invalidateQueries({
          queryKey: queryKeys.discussions.detail(companyId, item.discussionId),
        });
      }
      void qc.invalidateQueries({ queryKey: queryKeys.discussions.list(companyId) });
    } else if (item.source === "join_request") {
      void qc.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId, "pending_approval"),
      });
    } else if (item.source === "memory_version" || item.source === "memory_archive") {
      void qc.invalidateQueries({ queryKey: queryKeys.memory.pending(companyId) });
      void qc.invalidateQueries({ queryKey: queryKeys.memory.list(companyId) });
      if (item.source === "memory_archive") {
        void qc.invalidateQueries({ queryKey: queryKeys.suggestions.pending(companyId) });
      }
    }
    // runtime_tool_trust: cockpit invalidation is sufficient (the item belongs to the current user)
  }

  async function approveItem(item: CockpitApprovalItem): Promise<void> {
    if (item.source === "approval") {
      await approvalsApi.approve(item.id);
    } else if (item.source === "memory") {
      await memoryApi.approve(companyId, item.id);
    } else if (item.source === "discussion_item") {
      // HC4: approveItems takes { items: [{ itemId, action: "approved" }] }
      await discussionsApi.approveItems(companyId, item.discussionId!, {
        items: [{ itemId: item.id, action: "approved" as const }],
      });
    } else if (item.source === "join_request") {
      await accessApi.approveJoinRequest(companyId, item.id);
    } else if (item.source === "memory_version") {
      await memoryApi.approveVersion(companyId, item.id, item.relatedEntityId!);
    } else if (item.source === "memory_archive") {
      await suggestionsApi.accept(companyId, item.relatedEntityId!);
    } else if (item.source === "runtime_tool_trust") {
      await internalAgentApi.confirmAction(companyId, item.id, "allow_once");
    }
  }

  async function denyItem(item: CockpitApprovalItem): Promise<void> {
    if (item.source === "approval") {
      await approvalsApi.reject(item.id);
    } else if (item.source === "memory") {
      await memoryApi.reject(companyId, item.id);
    } else if (item.source === "discussion_item") {
      // HC4: rejectItems takes an itemIds ARRAY
      await discussionsApi.rejectItems(companyId, item.discussionId!, [item.id]);
    } else if (item.source === "join_request") {
      await accessApi.rejectJoinRequest(companyId, item.id);
    } else if (item.source === "memory_version") {
      await memoryApi.rejectVersion(companyId, item.id, item.relatedEntityId!);
    } else if (item.source === "memory_archive") {
      await suggestionsApi.dismiss(companyId, item.relatedEntityId!);
    } else if (item.source === "runtime_tool_trust") {
      await internalAgentApi.confirmAction(companyId, item.id, "deny");
    }
  }

  async function allowAlwaysItem(item: CockpitApprovalItem): Promise<void> {
    if (item.source !== "runtime_tool_trust") {
      throw new Error("allowAlways is only valid for runtime_tool_trust items");
    }
    await internalAgentApi.confirmAction(companyId, item.id, "allow_always");
  }

  const approve = useMutation({
    mutationFn: (item: CockpitApprovalItem) => approveItem(item),
    onSuccess: (_data, item) => {
      pushToast({ title: "Approved", tone: "success" });
      invalidateAll(item);
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Approve failed",
        tone: "error",
      }),
  });

  const deny = useMutation({
    mutationFn: (item: CockpitApprovalItem) => denyItem(item),
    onSuccess: (_data, item) => {
      pushToast({ title: "Denied", tone: "success" });
      invalidateAll(item);
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Deny failed",
        tone: "error",
      }),
  });

  const allowAlways = useMutation({
    mutationFn: (item: CockpitApprovalItem) => allowAlwaysItem(item),
    onSuccess: (_data, item) => {
      pushToast({ title: "Always allowed", tone: "success" });
      invalidateAll(item);
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Allow always failed",
        tone: "error",
      }),
  });

  return { approve, deny, allowAlways };
}
