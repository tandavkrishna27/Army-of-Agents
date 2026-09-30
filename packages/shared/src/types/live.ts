import type { LiveEventType } from "../constants.js";
import type { HubItemStatus, HubLane, HubSemanticType } from "../hub.js";

export interface LiveEvent {
  id: number;
  companyId: string;
  type: LiveEventType;
  createdAt: string;
  payload: Record<string, unknown>;
  /**
   * MIG-003: the durable, per-company contiguous sequence assigned by the
   * `live_event_log` when a durable-eligible event is appended. ADDITIVE and
   * OPTIONAL — the synchronous same-replica local-emit fast path carries no
   * seq; only events delivered through the durable log reader (cross-replica
   * fan-out + `?sinceSeq=N` reconnect catch-up) carry one. Clients track the
   * max `seq` seen for gap-recovery + duplicate suppression. `id` stays the
   * process-local React list key and is NOT a cursor.
   */
  seq?: number;
}

export interface HubItemChangedLivePayload {
  itemId: string;
  semanticType: HubSemanticType;
  lane: HubLane;
  status: HubItemStatus;
  version: number;
  change: "created" | "updated" | "state_changed" | "resolved" | "archived";
}

export interface HubCountsChangedLivePayload {
  reason: "item_changed" | "personal_state_changed" | "digest_changed";
}

export interface HubDigestChangedLivePayload {
  reason: "queued" | "acked";
}
