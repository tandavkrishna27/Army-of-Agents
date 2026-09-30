import { NOTIFICATION_TYPES, type NotificationType } from "./constants.js";
import type { HubLane, HubSemanticType } from "./hub.js";
import { laneForSemanticType } from "./hub.js";

export const DEAD_NOTIFICATION_TYPES = ["discussion.extraction_complete"] as const;
export type DeadNotificationType = (typeof DEAD_NOTIFICATION_TYPES)[number];

export type ActiveNotificationType = Exclude<NotificationType, DeadNotificationType>;

export const ACTIVE_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter(
  (type): type is ActiveNotificationType => !DEAD_NOTIFICATION_TYPES.includes(type as DeadNotificationType),
);

export const PERSISTED_NOTIFICATION_ALIASES = ["internal_agent_proactive"] as const;
export type PersistedNotificationAlias = (typeof PERSISTED_NOTIFICATION_ALIASES)[number];

export type RegisteredNotificationType = NotificationType | PersistedNotificationAlias;

export type NotificationRegistryEntry =
  | {
      status: "active";
      type: ActiveNotificationType;
      semanticType: HubSemanticType;
      defaultSourceType: string;
    }
  | {
      status: "dead";
      type: DeadNotificationType;
      replacementSemanticType: HubSemanticType;
      reason: string;
    }
  | {
      status: "alias";
      type: PersistedNotificationAlias;
      semanticType: HubSemanticType;
      canonicalType: ActiveNotificationType;
      reason: string;
    };

export const NOTIFICATION_REGISTRY = {
  "discussion.extraction_complete": {
    status: "dead",
    type: "discussion.extraction_complete",
    replacementSemanticType: "discussion_pending",
    reason: "Successful extraction is represented by pending discussion items, not awareness notifications.",
  },
  "discussion.extraction_failed": {
    status: "active",
    type: "discussion.extraction_failed",
    semanticType: "extraction_failed",
    defaultSourceType: "discussion",
  },
  "internal_agent.reminder": {
    status: "active",
    type: "internal_agent.reminder",
    semanticType: "reminder",
    defaultSourceType: "internal_agent_reminder",
  },
  "internal_agent.proactive": {
    status: "active",
    type: "internal_agent.proactive",
    semanticType: "proactive",
    defaultSourceType: "internal_agent_check",
  },
  "internal_agent.action_result": {
    status: "active",
    type: "internal_agent.action_result",
    semanticType: "legacy_other",
    defaultSourceType: "internal_agent_action",
  },
  "internal_agent.compaction_failed": {
    status: "active",
    type: "internal_agent.compaction_failed",
    // agent_error -> lane "notifications", authority "owner" (founder-only) —
    // matches this notification's audience (see hub.ts HUB_AUTHORITY_BY_TYPE).
    semanticType: "agent_error",
    defaultSourceType: "internal_agent_conversation",
  },
  "marketplace.install_completed": {
    status: "active",
    type: "marketplace.install_completed",
    semanticType: "marketplace_op",
    defaultSourceType: "marketplace_operation",
  },
  "marketplace.install_failed": {
    status: "active",
    type: "marketplace.install_failed",
    semanticType: "marketplace_op",
    defaultSourceType: "marketplace_operation",
  },
  "marketplace.install_requested": {
    status: "active",
    type: "marketplace.install_requested",
    semanticType: "marketplace_op",
    defaultSourceType: "marketplace_operation",
  },
  "marketplace.update_available": {
    status: "active",
    type: "marketplace.update_available",
    semanticType: "marketplace_op",
    defaultSourceType: "marketplace_update",
  },
  "marketplace.update_completed": {
    status: "active",
    type: "marketplace.update_completed",
    semanticType: "marketplace_op",
    defaultSourceType: "marketplace_update",
  },
  "marketplace.update_failed": {
    status: "active",
    type: "marketplace.update_failed",
    semanticType: "marketplace_op",
    defaultSourceType: "marketplace_update",
  },
  "thread.mention": {
    status: "active",
    type: "thread.mention",
    semanticType: "mention",
    defaultSourceType: "discussion",
  },
  "thread.artifact_needs_review": {
    status: "active",
    type: "thread.artifact_needs_review",
    semanticType: "discussion_pending",
    defaultSourceType: "discussion",
  },
  "thread.crew_failed": {
    status: "active",
    type: "thread.crew_failed",
    semanticType: "agent_error",
    defaultSourceType: "discussion",
  },
  "thread.spinoff_suggested": {
    status: "active",
    type: "thread.spinoff_suggested",
    semanticType: "suggestion",
    defaultSourceType: "discussion",
  },
  "work_question.sla_breached": {
    status: "active",
    type: "work_question.sla_breached",
    semanticType: "reminder",
    defaultSourceType: "issue",
  },
  internal_agent_proactive: {
    status: "alias",
    type: "internal_agent_proactive",
    semanticType: "proactive",
    canonicalType: "internal_agent.proactive",
    reason: "Persisted by older proactive-notification code before semantic hub types existed.",
  },
} satisfies Record<RegisteredNotificationType, NotificationRegistryEntry>;

export function getPersistentNotificationRegistryEntry(
  type: string,
): NotificationRegistryEntry | undefined {
  if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_REGISTRY, type)) return undefined;
  return NOTIFICATION_REGISTRY[type as RegisteredNotificationType];
}

export function mapPersistedNotificationType(type: string): HubSemanticType {
  const entry = getPersistentNotificationRegistryEntry(type);
  if (!entry) return "legacy_other";
  if (entry.status === "dead") return entry.replacementSemanticType;
  return entry.semanticType;
}

export function notificationTypeToLane(type: string): HubLane {
  return laneForSemanticType(mapPersistedNotificationType(type));
}
