import type { LiveEventType } from "../constants.js";
import type { HubItemStatus, HubLane, HubSemanticType } from "../hub.js";

export interface LiveEvent {
  id: number;
  companyId: string;
  type: LiveEventType;
  createdAt: string;
  payload: Record<string, unknown>;
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
