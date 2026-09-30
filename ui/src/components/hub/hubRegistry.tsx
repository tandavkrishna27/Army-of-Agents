import {
  AlertCircle,
  Bell,
  Bot,
  Brain,
  CircleHelp,
  CheckSquare,
  Lightbulb,
  MessageSquare,
  Rocket,
  ShieldQuestion,
  Sparkles,
  UserPlus,
} from "lucide-react";
import {
  HUB_SEMANTIC_TO_LANE,
  HUB_SEMANTIC_TYPES,
  type HubSemanticType,
} from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import type { HubRegistryEntry } from "./hubTypes";
import {
  approvalTab,
  budgetTab,
  joinRequestTab,
  marketplaceOpTab,
  notificationTab,
  reminderTab,
  routineTab,
  runtimeDecisionTab,
  workQuestionTab,
  runTab,
  suggestionTab,
  taskTab,
  threadTab,
  type HubTab,
} from "./hubViewerModel";

const source = (item: HubItemListRow) => item.sourceId;
const sourceLink = (prefix: string) => (item: HubItemListRow) =>
  source(item) ? `${prefix}/${source(item)}` : null;

/**
 * The FIRST colon-segment of a composite sourceId. Used by types whose entity
 * id leads the composite (e.g. mention `taskId:userId` /
 * `threadId:entryId:userId`; notification-registry `entityId:userId:type:evt`).
 */
const firstSegment = (item: HubItemListRow): string =>
  (item.sourceId ?? "").split(":")[0] ?? "";

/**
 * The whole sourceId, verbatim. Used by scan-materialized producers
 * (`hub-source-producers.ts`) whose sourceId IS the raw entity id
 * (run_failed→run.id, budget_alert→companyId, stale_work→issue.id,
 * reminder→reminder.id, extraction_failed→entry.id, routine_outcome→run.id) and
 * by the id-only source producers (approval/join_request/discussion_pending).
 */
const rawSource = (item: HubItemListRow): string => item.sourceId ?? "";

/**
 * marketplace_op composite is `<eventType>:<operationOrCatalogRef>:<ownerUserId>`
 * (marketplace-notifications.ts:53 wraps the per-event
 * `install_completed:<operationId>` in `${sourceId}:${ownerUserId}`). The
 * operation/catalog ref is the SECOND segment — NOT the first.
 */
const marketplaceOpId = (item: HubItemListRow): string => {
  const parts = (item.sourceId ?? "").split(":");
  return parts[1] ?? parts[0] ?? "";
};

/**
 * Shared resolver: ALWAYS prefer the server-persisted `relatedEntityId`; only
 * when it is absent fall back to the supplied per-type parse of the composite
 * `sourceId`. Cite the server format at each call site.
 */
const preferRelated =
  (fallback: (item: HubItemListRow) => string) =>
  (item: HubItemListRow): string => {
    if (item.relatedEntityId) return item.relatedEntityId;
    return fallback(item);
  };

const isDiscussionBacked = (item: HubItemListRow): boolean =>
  item.relatedEntityType === "discussion" || item.sourceType === "discussion";

export const HUB_REGISTRY: Record<HubSemanticType, HubRegistryEntry> = {
  approval_request: {
    semanticType: "approval_request",
    lane: HUB_SEMANTIC_TO_LANE.approval_request,
    label: "Approval",
    icon: ShieldQuestion,
    viewerKind: "approval",
    fullLink: sourceLink("/approvals"),
    tabKind: "approval",
    // hub-source-producers.ts:106-108 — sourceId IS approval.id.
    resolveTabId: preferRelated(rawSource),
  },
  discussion_pending: {
    semanticType: "discussion_pending",
    lane: HUB_SEMANTIC_TO_LANE.discussion_pending,
    label: "Discussion",
    icon: MessageSquare,
    viewerKind: "discussion",
    fullLink: sourceLink("/discussions"),
    tabKind: "thread",
    // hub-source-producers.ts:148-150 — sourceId IS discussion.id.
    resolveTabId: preferRelated(rawSource),
  },
  memory_review: {
    semanticType: "memory_review",
    lane: HUB_SEMANTIC_TO_LANE.memory_review,
    label: "Memory review",
    icon: Brain,
    // No dedicated viewer/producer yet (Task M3a is types + registry only —
    // the hub producer/emit path lands in the follow-up task). Mirrors
    // discussion_pending's "owner" authority but degrades to the generic
    // notification card until a memory-specific tab is wired.
    viewerKind: "notification",
    // Deep-links to the Memory Explorer's Pending Review virtual folder
    // (MemoryTree.tsx / memoryRail.ts `__pending` key; same route
    // PendingReviewPill.tsx already navigates to: `/memory/explore?folder=__pending`,
    // company-prefixed by the router's <Link>/<useNavigate> wrapper).
    fullLink: () => "/memory/explore?folder=__pending",
    tabKind: "notification",
    // Reserved (no live producer yet). rawSource keeps this consistent with
    // the other not-yet-produced sibling types (e.g. run_complete).
    resolveTabId: preferRelated(rawSource),
  },
  join_request: {
    semanticType: "join_request",
    lane: HUB_SEMANTIC_TO_LANE.join_request,
    label: "Join request",
    icon: UserPlus,
    viewerKind: "notification",
    fullLink: () => null,
    tabKind: "join_request",
    // hub-source-producers.ts:125-127 — sourceId IS the join_request id.
    resolveTabId: preferRelated(rawSource),
  },
  // NOTE: human_input_needed + scope_proposal entries were PRUNED (Task 10,
  // 2026-07-04) — both were registry-only hub types with no live producer. The
  // Record<HubSemanticType,…> type forces this cleanup at compile time.
  agent_runtime_decision: {
    semanticType: "agent_runtime_decision",
    lane: HUB_SEMANTIC_TO_LANE.agent_runtime_decision,
    label: "Runtime decision",
    icon: Bot,
    viewerKind: "reserved",
    fullLink: () => null,
    // The runtime_decision viewer is keyed on the HUB ITEM id, not the decision
    // id — the panel fetches the decision via the hub item. resolveTabId is
    // unused for this kind (hubTabForItem passes item.id to runtimeDecisionTab).
    tabKind: "runtime_decision",
    // agent-runtime-decisions.ts:627 sourceId IS decision.id; relatedEntityId is
    // the runId (630-631). We surface the DECISION id here for completeness.
    resolveTabId: preferRelated(rawSource),
  },
  work_question: {
    semanticType: "work_question",
    lane: HUB_SEMANTIC_TO_LANE.work_question,
    label: "Question",
    icon: CircleHelp,
    viewerKind: "reserved",
    fullLink: () => null,
    tabKind: "work_question",
    resolveTabId: rawSource,
  },
  run_failed: {
    semanticType: "run_failed",
    lane: HUB_SEMANTIC_TO_LANE.run_failed,
    label: "Run failed",
    icon: AlertCircle,
    viewerKind: "notification",
    fullLink: () => null,
    tabKind: "run",
    // hub-source-producers.ts:192-194 — sourceId IS run.id (raw, no composite).
    resolveTabId: preferRelated(rawSource),
  },
  budget_alert: {
    semanticType: "budget_alert",
    lane: HUB_SEMANTIC_TO_LANE.budget_alert,
    label: "Budget",
    icon: AlertCircle,
    viewerKind: "notification",
    fullLink: () => "/settings?tab=budget",
    tabKind: "budget",
    // hub-source-producers.ts:207-209 — sourceId IS the companyId (raw). The
    // budget tab is company-scoped, so the id is informational only.
    resolveTabId: preferRelated(rawSource),
  },
  agent_error: {
    semanticType: "agent_error",
    lane: HUB_SEMANTIC_TO_LANE.agent_error,
    label: "Agent error",
    icon: AlertCircle,
    viewerKind: "notification",
    // FIX: agent_error's real source is a discussion THREAD (notification-registry
    // `thread.crew_failed` → semanticType agent_error, defaultSourceType
    // "discussion"), NOT `/agents/all`. Deep-link to the thread via the resolved
    // entity id.
    fullLink: (item) => {
      if (!isDiscussionBacked(item)) return null;
      const id = HUB_REGISTRY.agent_error.resolveTabId(item);
      return id ? `/discussions/${id}` : null;
    },
    tabKind: "thread",
    // relatedEntityId (a discussion id) preferred; else the notification-registry
    // composite `entityId:userId:type:eventId` (registry.ts:26) → first segment.
    resolveTabId: preferRelated(firstSegment),
  },
  mention: {
    semanticType: "mention",
    lane: HUB_SEMANTIC_TO_LANE.mention,
    label: "Mention",
    icon: Bell,
    viewerKind: "notification",
    fullLink: () => null,
    // Static default = thread; hubTabForItem refines to a TASK tab when the
    // mention is on a task (sourceType "issue").
    tabKind: "thread",
    // Neither mention producer sets relatedEntityId, so the composite fallback
    // fires: issues.ts:2193 `taskId:userId` OR threads.ts:321
    // `threadId:entryId:userId` — the entity id is the FIRST segment in both.
    resolveTabId: preferRelated(firstSegment),
  },
  marketplace_op: {
    semanticType: "marketplace_op",
    lane: HUB_SEMANTIC_TO_LANE.marketplace_op,
    label: "Marketplace",
    icon: Sparkles,
    viewerKind: "notification",
    fullLink: () => null,
    tabKind: "marketplace_op",
    // marketplace-notifications.ts:53 — `<eventType>:<operationRef>:<ownerUserId>`.
    // The operation id is the SECOND segment, NOT the first.
    resolveTabId: preferRelated(marketplaceOpId),
  },
  run_complete: {
    semanticType: "run_complete",
    lane: HUB_SEMANTIC_TO_LANE.run_complete,
    label: "Run complete",
    icon: CheckSquare,
    viewerKind: "notification",
    fullLink: () => null,
    tabKind: "run",
    // Reserved type; when produced it mirrors run_failed (sourceId = run.id).
    resolveTabId: preferRelated(rawSource),
  },
  reminder: {
    semanticType: "reminder",
    lane: HUB_SEMANTIC_TO_LANE.reminder,
    label: "Reminder",
    icon: Bell,
    viewerKind: "notification",
    fullLink: () => "/commander",
    tabKind: "reminder",
    // proactive.ts:572 — sourceId IS reminder.id (raw).
    resolveTabId: preferRelated(rawSource),
  },
  extraction_failed: {
    semanticType: "extraction_failed",
    lane: HUB_SEMANTIC_TO_LANE.extraction_failed,
    label: "Extraction failed",
    icon: AlertCircle,
    viewerKind: "notification",
    fullLink: sourceLink("/discussions"),
    tabKind: "thread",
    // discussion-derived; relatedEntityId (discussion id) preferred, else the
    // notification-registry composite → first segment.
    resolveTabId: preferRelated(firstSegment),
  },
  routine_outcome: {
    semanticType: "routine_outcome",
    lane: HUB_SEMANTIC_TO_LANE.routine_outcome,
    label: "Routine",
    icon: Rocket,
    viewerKind: "notification",
    fullLink: sourceLink("/routines"),
    tabKind: "routine",
    // Reserved (no live producer). Best-effort: raw sourceId as the routine id.
    resolveTabId: preferRelated(rawSource),
  },
  legacy_other: {
    semanticType: "legacy_other",
    lane: HUB_SEMANTIC_TO_LANE.legacy_other,
    label: "Notification",
    icon: Bell,
    viewerKind: "notification",
    fullLink: () => null,
    // No dedicated entity → generic notification tab keyed on the hub item id.
    tabKind: "notification",
    resolveTabId: preferRelated(rawSource),
  },
  suggestion: {
    semanticType: "suggestion",
    lane: HUB_SEMANTIC_TO_LANE.suggestion,
    label: "Suggestion",
    icon: Lightbulb,
    viewerKind: "suggestion",
    fullLink: () => "/home",
    tabKind: "suggestion",
    // cockpit.ts:654 relatedEntityId = suggestion.id; else raw sourceId.
    resolveTabId: preferRelated(rawSource),
  },
  stale_work: {
    semanticType: "stale_work",
    lane: HUB_SEMANTIC_TO_LANE.stale_work,
    label: "Stale task",
    icon: CheckSquare,
    viewerKind: "task",
    fullLink: sourceLink("/issues"),
    tabKind: "task",
    // hub-source-producers.ts:175-177 — sourceId IS issue.id (raw).
    resolveTabId: preferRelated(rawSource),
  },
  proactive: {
    semanticType: "proactive",
    lane: HUB_SEMANTIC_TO_LANE.proactive,
    label: "Proactive",
    icon: Sparkles,
    viewerKind: "suggestion",
    fullLink: () => "/commander",
    // No dedicated entity → inline in Home; the tab fallback is a notification.
    tabKind: "notification",
    resolveTabId: preferRelated(rawSource),
  },
};

const semanticTypeSet = new Set<string>(HUB_SEMANTIC_TYPES);

export function resolveHubEntry(value: string): HubRegistryEntry | null {
  if (!semanticTypeSet.has(value)) return null;
  return HUB_REGISTRY[value as HubSemanticType] ?? null;
}

/**
 * Map a hub item to the viewer-tab that should open when its row is clicked.
 * Reads `HUB_REGISTRY[semanticType].tabKind` + `resolveTabId(item)` and dispatches
 * to the matching `hubViewerModel` factory. E2 (row-click wiring) calls this.
 *
 * Where a factory needs a second id (a run tab needs the agentId), it is pulled
 * from the item's available fields; when unavailable we degrade gracefully to a
 * notification tab rather than fabricate an id.
 */
export function hubTabForItem(item: HubItemListRow): HubTab {
  const entry = HUB_REGISTRY[item.semanticType];
  if (!entry) return notificationTab(item.id, item.title);
  const id = entry.resolveTabId(item);
  const title = item.title || undefined;

  switch (entry.tabKind) {
    case "approval":
      return id ? approvalTab(id, title, item.id) : notificationTab(item.id, title);
    case "join_request":
      return id ? joinRequestTab(id, title, item.id) : notificationTab(item.id, title);
    case "thread": {
      if (item.semanticType === "agent_error" && !isDiscussionBacked(item)) {
        return notificationTab(item.id, title);
      }
      // mention on a TASK (sourceType "issue") targets a task, not a thread.
      if (item.semanticType === "mention" && !item.relatedEntityId && item.sourceType === "issue") {
        return id ? taskTab(id, title, item.id) : notificationTab(item.id, title);
      }
      return id ? threadTab(id, title, undefined, item.id) : notificationTab(item.id, title);
    }
    case "runtime_decision":
      // Keyed on the HUB ITEM id — the panel fetches the decision from it.
      return runtimeDecisionTab(item.id, title);
    case "work_question":
      return id ? workQuestionTab(id, title, item.id) : notificationTab(item.id, title);
    case "task":
      return id ? taskTab(id, title, item.id) : notificationTab(item.id, title);
    case "run": {
      // A run tab needs BOTH the runId and the owning agentId. The run producers
      // (hub-source-producers.ts) set sourceId = run.id AND relatedEntityId =
      // run.agentId, so resolveTabId's preferRelated would hand back the AGENT id
      // for `id` — wrong for the run slot. Build runTab explicitly from the raw
      // sourceId (the run id) and relatedEntityId (the agent id); if either is
      // missing there is no run/agent id on the row → degrade to notification.
      const runId = rawSource(item) || null;
      const agentId = item.relatedEntityType === "agent" ? item.relatedEntityId : null;
      if (runId && agentId) return runTab(runId, agentId, title, item.id);
      return notificationTab(item.id, title);
    }
    case "budget":
      return budgetTab(title);
    case "suggestion":
      return id ? suggestionTab(id, title, item.id) : notificationTab(item.id, title);
    case "marketplace_op":
      return id ? marketplaceOpTab(id, title, item.id) : notificationTab(item.id, title);
    case "reminder":
      return id ? reminderTab(id, title, item.id) : notificationTab(item.id, title);
    case "routine":
      return id ? routineTab(id, title, item.id) : notificationTab(item.id, title);
    case "notification":
    default:
      return notificationTab(item.id, title);
  }
}
