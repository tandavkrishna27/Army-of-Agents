/**
 * Cockpit data contract — Phase 3b/3c/3d.
 *
 * ONE batched payload returned by GET /companies/:cid/cockpit.
 * The frontend's useCockpit() hook imports these types from @armyofagents/shared.
 */

// Phase 3d: Pinned card types
export type CockpitPinnedEntityType = "task" | "artifact" | "goal";

export interface CockpitPinnedItem {
  entityType: CockpitPinnedEntityType;
  entityId: string;
  title: string;
  status: string;       // task/goal status, or artifact status
  identifier?: string | null; // task identifier (e.g. TEAM-12)
}

// Phase 3c: Approvals card types
export type CockpitApprovalSource =
  | "approval"
  | "memory"
  | "discussion_item"
  | "join_request"
  | "memory_version"
  | "memory_archive"
  | "runtime_tool_trust";

export interface CockpitApprovalItem {
  source: CockpitApprovalSource;
  /** approval id | memory item id | discussion extracted-item id */
  id: string;
  /** discussion_item only — needed for the batched approveItems endpoint */
  discussionId?: string;
  title: string;
  subtitle: string;
  /** memory_version: versionId · memory_archive: suggestionId */
  relatedEntityId?: string;
  /** "ternary" → runtime_tool_trust (Always/Once/Deny); default binary */
  decisionType?: "binary" | "ternary";
}

export interface CockpitTaskItem {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority?: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  responsibleUserId?: string | null;
  reviewerUserId?: string | null;
  dueDate: string | null;
  responsibility?: CockpitTaskResponsibility;
}

export type CockpitTaskResponsibilityReason =
  | "assigned_to_you"
  | "you_are_responsible"
  | "managed_human"
  | "managed_agent"
  | "your_review"
  | "team_review";

export interface CockpitTaskResponsibility {
  reason: CockpitTaskResponsibilityReason;
  entityType: "user" | "agent";
  entityId: string;
  label: string;
}

export interface CockpitWorkTaskItem extends CockpitTaskItem {
  priority: string;
  responsibleUserId: string | null;
  reviewerUserId: string | null;
  responsibility: CockpitTaskResponsibility;
}

export interface CockpitTaskGroup {
  items: CockpitWorkTaskItem[];
  total: number;
}

export interface CockpitActiveWork {
  mine: CockpitTaskGroup;
  managed: CockpitTaskGroup;
}

export type CockpitAwaitingReview = CockpitTaskGroup;

export type CockpitSliceStatus = "ok" | "error";

export interface CockpitSliceMeta {
  status: CockpitSliceStatus;
  errorCode?: string;
}

export interface CockpitMeta {
  generatedAt: string;
  partial: boolean;
  slices: Record<string, CockpitSliceMeta>;
}

export type CockpitTaskBucket = "mine" | "managed" | "awaiting_review";

export interface CockpitTaskBucketResponse {
  items: CockpitWorkTaskItem[];
  total: number;
  nextCursor: string | null;
}

export interface CockpitCounts {
  activeWorkMine: number;
  activeWorkManaged: number;
  awaitingReview: number;
  running: number;
  inbox: number;
  approvals: number;
  discussions: number;
  generatedAt: string;
}

export interface CockpitRunItem {
  id: string;
  agentName: string | null;
  status: string;
  startedAt: string | null;
  issueId: string | null;
}

export interface CockpitReminderItem {
  id: string;
  content: string;
  triggerAt: string;
}

export interface CockpitNoteItem {
  id: string;
  title: string | null;
  body: string;
  color: "yellow" | "blue" | "green" | "pink";
  updatedAt: string;
}

export interface CockpitInboxItem {
  id: string;
  lane: "waiting_on_you" | "notifications" | "suggestions" | null;
  priority: "low" | "normal" | "high" | "urgent";
  title: string;
  summary: string | null;
  sourceType: string | null;
  sourceId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  unread: boolean;
  createdAt: string;
}

export interface CockpitDiscussionItem {
  id: string;
  title: string | null;
  pendingItemCount: number;
  reason: "pending_items" | "extraction_failed" | "recent_activity";
  entryCount?: number;
  lastEntryAt?: string | null;
}

export interface CockpitData {
  /** V2 accountable-work contract. Optional during the rolling compatibility window. */
  activeWork?: CockpitActiveWork;
  awaitingReview?: CockpitAwaitingReview;
  meta?: CockpitMeta;
  running: CockpitRunItem[];
  /** @deprecated Compatibility alias for awaitingReview.items. */
  review: CockpitTaskItem[];
  /** @deprecated Compatibility alias for activeWork.mine.items. */
  myTasks: CockpitTaskItem[];
  today: {
    reminders: CockpitReminderItem[];
    dueTasks: CockpitTaskItem[];
  };
  /** Private user/company sticky notes for Commander Cockpit. */
  stickyNotes: CockpitNoteItem[];
  /** RBAC-scoped hot Inbox/Hub items for daily triage. */
  inbox: CockpitInboxItem[];
  discussions: CockpitDiscussionItem[];
  /** Unified approvals queue, per-role scoped (founder: all sources; lead: dept memory + own runtime; member: own runtime). */
  approvals: CockpitApprovalItem[];
  /** Phase 3d: user-pinned entities (tasks / artifacts / goals). */
  pinned: CockpitPinnedItem[];
  /** Opt-in card: Goals currently at_risk status (company-scoped). */
  goalsAtRisk: CockpitGoalsAtRiskItem[];
  /** Opt-in card: Budget pulse for the current month (founder-only; null for non-founders or no budget). */
  budgetPulse: CockpitBudgetPulseItem | null;
  /** Opt-in card: Tasks completed today (founder→company-wide; else→own). */
  doneToday: CockpitDoneTodayItem[];
  /** Opt-in card: Recent unread proactive findings from Commander (per-user). */
  proactiveFindings: CockpitProactiveItem[];
  /** Opt-in card: Human teammates' recent activity (RBAC-scoped; member→[]). */
  teammatesActivity: CockpitTeammatesActivityItem[];
}

// ── Opt-in card types (added for the cockpit opt-in cards feature) ────────────

export interface CockpitGoalsAtRiskItem {
  id: string;
  title: string;
  level: string;
  ownerAgentId: string | null;
}

export interface CockpitBudgetPulseItem {
  limitCents: number;
  spentCents: number;
  percentUsed: number;        // >= 0 (0 when no spend); the whole item is null when no budget is configured (limitCents === 0)
  openIncidentCount: number;
}

export interface CockpitDoneTodayItem {
  id: string;
  identifier: string | null;
  title: string;
}

// ── Opt-in card types (proactive findings + teammates' activity) ──────────────

export interface CockpitProactiveItem {
  id: string;
  title: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdAt: string;          // ISO
}

export interface CockpitTeammatesActivityItem {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;          // ISO
}
