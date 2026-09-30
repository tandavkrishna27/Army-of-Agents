import type {
  HubGroupMode,
  HubPreferences,
  HubItemPriority,
  HubItemStatus,
  HubLane,
  HubSemanticType,
  HubAutopilotActionsResponse,
  HubAutopilotPolicy,
  NotificationPreferences,
  UpdateHubAutopilotPolicyInput,
  UpdateNotificationPreferencesInput,
  UpdateHubPreferencesInput,
} from "@armyofagents/shared";
import { api } from "./client";

export interface HubItemListRow {
  id: string;
  companyId: string;
  semanticType: HubSemanticType;
  lane: HubLane | null;
  status: HubItemStatus;
  priority: HubItemPriority;
  title: string;
  summary: string | null;
  sourceType: string | null;
  sourceId: string | null;
  // Server-persisted, canonical target entity for deep-links (hub-items.ts row
  // spread, ~408-409/438-439). PREFER these over parsing composite sourceIds —
  // a generic `split(":")[0]` is wrong for several types (e.g. marketplace_op).
  relatedEntityId?: string | null;
  relatedEntityType?: string | null;
  ownerUserId: string | null;
  ownerPool: string | null;
  claimedByUserId: string | null;
  claimedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  groupKey: string | null;
  groupLabel: string | null;
  groupCount: number | null;
  scopeKey: string | null;
  slaAt: string | null;
  curationGroupLabel?: string | null;
  curationGroupSummary?: string | null;
  curationReason?: string | null;
  curationPriorityReason?: string | null;
  curationRevision?: number;
  curatedAt?: string | null;
  curatedByAgentId?: string | null;
}

export interface HubListOptions {
  lane?: HubLane;
  status?: HubItemStatus;
  includeDismissed?: boolean;
  includeSnoozed?: boolean;
  q?: string;
  cursor?: string;
  groupMode?: HubGroupMode;
  limit?: number;
}

export interface HubListResponse {
  items: HubItemListRow[];
  nextCursor: string | null;
  totalKnown: number | null;
}

export interface HubCounts {
  open: number;
  unread: number;
}

export interface NotificationDigestResponse {
  items: HubItemListRow[];
}

export interface NotificationDigestAckResponse {
  acked: number;
}

export type HubPersonalState =
  | { kind: "read" }
  | { kind: "unread" }
  | { kind: "snooze"; until: string }
  | { kind: "unsnooze" }
  | { kind: "dismiss" }
  | { kind: "undismiss" };

export interface HubItemUserState {
  id: string;
  companyId: string;
  hubItemId: string;
  principalType: "user";
  principalId: string;
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
  updatedAt: string;
}

export interface HubLifecycleActionPayload {
  action: "resolve" | "archive" | "claim" | "release";
  expectedVersion: number;
  idempotencyKey?: string;
  reason?: string;
}

export interface HubLifecycleActionResult {
  item: HubItemListRow;
  auditId: string;
  undoDeadline: string | null;
}

export interface HubUndoPayload {
  auditId: string;
  expectedVersion: number;
}

export interface HubUndoResult {
  item: HubItemListRow;
  auditId: string;
}

export type HubBulkActionItem =
  | ({
      id: string;
      action: "resolve" | "archive" | "claim" | "release";
      expectedVersion: number;
    } & Pick<HubLifecycleActionPayload, "idempotencyKey" | "reason">)
  | {
      id: string;
      action: "dismiss";
      idempotencyKey?: string;
      reason?: string;
    }
  | {
      id: string;
      action: "snooze";
      until: string;
      idempotencyKey?: string;
      reason?: string;
    };

export interface HubBulkActionPayload {
  bulkId?: string;
  items: HubBulkActionItem[];
}

export interface HubBulkActionResult {
  bulkId: string;
  summary: { succeeded: number; failed: number; skipped: number };
  results: Array<{
    id: string;
    status: "success" | "failed" | "skipped";
    item?: HubItemListRow;
    state?: HubItemUserState;
    auditId?: string;
    undoDeadline?: string | null;
    error?: { status: number; message: string; code?: string };
  }>;
}

export interface HubAuditRow {
  id: string;
  companyId: string;
  hubItemId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  authorityBasis: string | null;
  reason: string | null;
  undoDeadline: string | null;
  createdAt: string;
}

function listQuery(opts: HubListOptions = {}) {
  const params = new URLSearchParams();
  if (opts.lane) params.set("lane", opts.lane);
  if (opts.status) params.set("status", opts.status);
  if (opts.q) params.set("q", opts.q);
  if (opts.groupMode) params.set("groupMode", opts.groupMode);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.includeDismissed) params.set("includeDismissed", "true");
  if (opts.includeSnoozed) params.set("includeSnoozed", "true");
  const rawLimit = Number.isFinite(opts.limit) ? opts.limit! : 50;
  params.set("limit", String(Math.min(Math.max(rawLimit, 1), 50)));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function normalizeHubListResponse(
  response: HubListResponse | HubItemListRow[],
): HubListResponse {
  if (Array.isArray(response)) {
    return { items: response, nextCursor: null, totalKnown: null };
  }
  return response;
}

export const hubItemsApi = {
  list: async (companyId: string, opts?: HubListOptions) =>
    normalizeHubListResponse(
      await api.get<HubListResponse | HubItemListRow[]>(
        `/companies/${companyId}/hub-items${listQuery(opts)}`,
      ),
    ),
  getOne: (companyId: string, itemId: string) =>
    api.get<HubItemListRow>(`/companies/${companyId}/hub-items/${itemId}`),
  counts: (companyId: string) =>
    api.get<HubCounts>(`/companies/${companyId}/hub-items/counts`),
  hiddenCount: (companyId: string, lane: HubLane) =>
    api.get<{ hiddenOpen: number }>(
      `/companies/${companyId}/hub-items/hidden-count?lane=${encodeURIComponent(lane)}`,
    ),
  getPreferences: (companyId: string) =>
    api.get<HubPreferences>(`/companies/${companyId}/hub-items/preferences/me`),
  updatePreferences: (companyId: string, patch: UpdateHubPreferencesInput) =>
    api.patch<HubPreferences>(
      `/companies/${companyId}/hub-items/preferences/me`,
      patch,
    ),
  resetPreferences: (companyId: string) =>
    api.post<HubPreferences>(
      `/companies/${companyId}/hub-items/preferences/me/reset`,
      {},
    ),
  autopilotPolicy: {
    get: (companyId: string) =>
      api.get<HubAutopilotPolicy>(`/companies/${companyId}/hub-autopilot/policy`),
    update: (companyId: string, patch: UpdateHubAutopilotPolicyInput) =>
      api.patch<HubAutopilotPolicy>(
        `/companies/${companyId}/hub-autopilot/policy`,
        patch,
      ),
    reset: (companyId: string) =>
      api.post<HubAutopilotPolicy>(
        `/companies/${companyId}/hub-autopilot/policy/reset`,
        {},
      ),
  },
  autopilotActions: {
    list: (companyId: string) =>
      api.get<HubAutopilotActionsResponse>(`/companies/${companyId}/hub-autopilot/actions`),
  },
  notificationPreferences: {
    get: (companyId: string) =>
      api.get<NotificationPreferences>(`/companies/${companyId}/notifications/preferences/me`),
    update: (companyId: string, patch: UpdateNotificationPreferencesInput) =>
      api.patch<NotificationPreferences>(
        `/companies/${companyId}/notifications/preferences/me`,
        patch,
      ),
    reset: (companyId: string) =>
      api.post<NotificationPreferences>(
        `/companies/${companyId}/notifications/preferences/me/reset`,
        {},
      ),
  },
  notificationDigest: {
    list: (companyId: string) =>
      api.get<NotificationDigestResponse>(`/companies/${companyId}/notifications/digest/me`),
    ack: (companyId: string) =>
      api.post<NotificationDigestAckResponse>(
        `/companies/${companyId}/notifications/digest/me/ack`,
        {},
      ),
  },
  markRead: (companyId: string, itemId: string) =>
    api.patch(`/companies/${companyId}/hub-items/${itemId}/state`, {
      kind: "read",
    }),
  markUnread: (companyId: string, itemId: string) =>
    api.patch(`/companies/${companyId}/hub-items/${itemId}/state`, {
      kind: "unread",
    }),
  snooze: (companyId: string, itemId: string, until: string) =>
    api.patch(`/companies/${companyId}/hub-items/${itemId}/state`, {
      kind: "snooze",
      until,
    }),
  unsnooze: (companyId: string, itemId: string) =>
    api.patch(`/companies/${companyId}/hub-items/${itemId}/state`, {
      kind: "unsnooze",
    }),
  dismiss: (companyId: string, itemId: string) =>
    api.patch(`/companies/${companyId}/hub-items/${itemId}/state`, {
      kind: "dismiss",
    }),
  undismiss: (companyId: string, itemId: string) =>
    api.patch(`/companies/${companyId}/hub-items/${itemId}/state`, {
      kind: "undismiss",
    }),
  act: (companyId: string, itemId: string, payload: HubLifecycleActionPayload) =>
    api.post<HubLifecycleActionResult>(
      `/companies/${companyId}/hub-items/${itemId}/action`,
      payload,
    ),
  undo: (companyId: string, itemId: string, payload: HubUndoPayload) =>
    api.post<HubUndoResult>(
      `/companies/${companyId}/hub-items/${itemId}/undo`,
      payload,
    ),
  bulkAction: (companyId: string, payload: HubBulkActionPayload) =>
    api.post<HubBulkActionResult>(
      `/companies/${companyId}/hub-items/bulk-action`,
      payload,
    ),
  audit: (companyId: string, itemId: string) =>
    api.get<HubAuditRow[]>(`/companies/${companyId}/hub-items/${itemId}/audit`),
};
