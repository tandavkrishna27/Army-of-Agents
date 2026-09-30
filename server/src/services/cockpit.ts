/**
 * cockpitService — Phase 3b/3c batched, RBAC-scoped cockpit data engine.
 *
 * GET /companies/:cid/cockpit returns ONE payload: Promise.all of the resolvers
 * (Running / Review / MyTasks / Today / Discussions / Approvals / Pinned +
 * opt-in: Goals-at-risk / Budget pulse / Done-today / Proactive findings /
 * Teammates' activity). The "In this conversation" zone is client-side (fed by
 * the chat's conversationRefs, not this endpoint). Mirrors the sidebar-badges +
 * home batching pattern.
 *
 * Security model:
 *   - resolveCockpitScope() drives every per-card scope decision.
 *   - Running: company-wide live runs (crew scoping is a 3c refinement).
 *   - Review: taskScope:"all" (Codex #2 — crew in_review must appear).
 *     Translates ReviewFilter from cockpit-scope:
 *       {}: founder — no extra filter
 *       {projectIds}: team_lead — loop per dept, dedupe by id (bounded)
 *       {assigneeUserId}: member — scoped to own assigned tasks
 *   - MyTasks: assigneeUserId=scope.userId, default taskScope (org).
 *   - Today: reminders (userId=scope.userId, pending, triggerAt <= EOD)
 *     + dueTasks (assigneeUserId=scope.userId, dueDate <= EOD, non-terminal).
 *   - Discussions: canonical threadService.list visibility (Codex #3).
 *     Then filter to needs-me: pendingItemCount > 0 OR a failed/pending
 *     extraction entry over the visible ids. Map to CockpitDiscussionItem.
 *   - Approvals (Phase 3c + A4): per-role scoping.
 *     approval/discussion_item/join_request/memory_archive → founder-only.
 *     memory/memory_version → founder OR (team_lead AND layer==="active_context" AND dept ∈ leadDepartmentIds).
 *     runtime_tool_trust → any role, owner-scoped by userId (HC4).
 */

import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  activityLog,
  approvals,
  artifacts,
  budgetIncidents,
  companies,
  costEvents,
  discussionEntries,
  discussionExtractedItems,
  discussions,
  goals,
  internalAgentReminders,
  internalAgentRuntimeApprovals,
  issues,
  joinRequests,
  notifications,
  userEntityPins,
  userRoles,
} from "@armyofagents/db";
import type {
  CockpitApprovalItem,
  CockpitBudgetPulseItem,
  CockpitCounts,
  CockpitData,
  CockpitDoneTodayItem,
  CockpitGoalsAtRiskItem,
  CockpitInboxItem,
  CockpitNoteItem,
  CockpitPinnedItem,
  CockpitProactiveItem,
  CockpitTaskItem,
  CockpitTaskBucket,
  CockpitTaskBucketResponse,
  CockpitTeammatesActivityItem,
} from "@armyofagents/shared";
import { threadService } from "./threads.js";
import { hubItemsService } from "./hub-items.js";
import { userNotesService } from "./user-notes.js";
import { memoryService } from "./memory.js";
import { liveRunsForCompany } from "../routes/agents-live-runs.js";
import { resolveCockpitScope } from "./cockpit-scope.js";
import type { ActorLike, CockpitScope } from "./cockpit-scope.js";
import { cockpitWorkService } from "./cockpit-work.js";

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

function sliceStatus(result: PromiseSettledResult<unknown>) {
  return result.status === "fulfilled"
    ? ({ status: "ok" } as const)
    : ({ status: "error", errorCode: "unavailable" } as const);
}

/** End-of-today (23:59:59.999 local time on the server). */
function endOfToday(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Start-of-today (00:00:00.000 local time on the server). Mirror of endOfToday(). */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** UTC calendar month window [start, end). Mirrors budgets.ts:14-19. */
function utcMonthWindow(): { start: Date; end: Date } {
  const n = new Date();
  return {
    start: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)),
    end: new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1)),
  };
}

/** Map a raw issues row to a CockpitTaskItem (minimal shape for the card). */
function toTaskItem(row: {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority?: string;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
  responsibleUserId?: string | null;
  reviewerUserId?: string | null;
  dueDate?: Date | null;
}): CockpitTaskItem {
  return {
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    status: row.status,
    priority: row.priority ?? "medium",
    assigneeUserId: row.assigneeUserId ?? null,
    assigneeAgentId: row.assigneeAgentId ?? null,
    responsibleUserId: row.responsibleUserId ?? null,
    reviewerUserId: row.reviewerUserId ?? null,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
  };
}

// ── Phase 3c: Approvals aggregation (founder-only) ───────────────────────────

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];

/**
 * List pending approvals rows for the company (status pending or revision_requested).
 * Returns minimal fields needed for the cockpit card.
 */
async function listPendingApprovals(
  db: Db,
  companyId: string,
): Promise<Array<{ id: string; type: string; status: string; payload: Record<string, unknown> }>> {
  return db
    .select({
      id: approvals.id,
      type: approvals.type,
      status: approvals.status,
      payload: approvals.payload,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
      ),
    );
}

/**
 * List pending discussion extracted items for the company.
 *
 * HC3: discussionExtractedItems has discussionEntryId (NOT discussionId directly).
 * Join: discussion_extracted_items → discussion_entries (via discussionEntryId)
 *       → discussions (via discussionId) to scope by companyId.
 * Returns discussionId from discussion_entries so the UI can route to the right page.
 */
async function listPendingExtractedItems(
  db: Db,
  companyId: string,
): Promise<Array<{ id: string; discussionId: string; title: string; type: string }>> {
  return db
    .select({
      id: discussionExtractedItems.id,
      discussionId: discussionEntries.discussionId,
      title: discussionExtractedItems.title,
      type: discussionExtractedItems.type,
    })
    .from(discussionExtractedItems)
    .innerJoin(
      discussionEntries,
      eq(discussionEntries.id, discussionExtractedItems.discussionEntryId),
    )
    .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
    .where(
      and(
        eq(discussions.companyId, companyId),
        eq(discussionExtractedItems.status, "pending"),
      ),
    );
}

/** Build a human-readable title for an approval row from its type + payload. */
function approvalTitle(row: { type: string; payload: Record<string, unknown> }): string {
  // Hire approvals carry payload.name (set at agents.ts when creating the agent); guard
  // the free-form payload value so a non-string can never reach React as a title.
  const raw = row.payload?.name ?? row.payload?.agentName;
  const name = typeof raw === "string" ? raw : null;
  if (row.type === "hire_agent") return name ? `Hire ${name}` : "Agent hire request";
  return name ?? row.type.replace(/_/g, " ");
}

/** Subtitle for an approval: the type in a readable form. */
function approvalSubtitle(row: { type: string }): string {
  return row.type.replace(/_/g, " ");
}

/**
 * Resolve the user's pinned entities (Phase 3d).
 *
 * Fetches the user's pins ordered by pinnedAt desc, then batches company-scoped
 * id-set queries against issues/artifacts/goals. Keys the result map as
 * `${entityType}:${id}` to prevent cross-table uuid collision mis-resolution.
 * Pins whose entity no longer resolves (deleted / out-of-company) are dropped.
 */
async function cockpitPinned(
  db: Db,
  companyId: string,
  scope: CockpitScope,
): Promise<CockpitPinnedItem[]> {
  const pins = await db
    .select({
      entityType: userEntityPins.entityType,
      entityId: userEntityPins.entityId,
      pinnedAt: userEntityPins.pinnedAt,
    })
    .from(userEntityPins)
    .where(
      and(
        eq(userEntityPins.userId, scope.userId),
        eq(userEntityPins.companyId, companyId),
      ),
    )
    .orderBy(desc(userEntityPins.pinnedAt));

  if (pins.length === 0) return [];

  const taskIds = pins.filter((p) => p.entityType === "task").map((p) => p.entityId);
  const artifactIds = pins.filter((p) => p.entityType === "artifact").map((p) => p.entityId);
  const goalIds = pins.filter((p) => p.entityType === "goal").map((p) => p.entityId);

  // Company-scoped id-set lookups (getById's don't scope; we MUST add eq(companyId)).
  // Deliberate: pinned tasks are NOT filtered by hiddenAt (unlike dueTasks/My Tasks).
  // A pin is explicit user intent — it overrides a soft-hide, so a pinned-then-hidden
  // task stays visible (with its status) until the user unpins it. entityExistsInCompany
  // is symmetric (hidden tasks remain pinnable). Only deleted/out-of-company pins drop.
  const [tasks, arts, gls] = await Promise.all([
    taskIds.length
      ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(inArray(issues.id, taskIds), eq(issues.companyId, companyId)))
      : ([] as { id: string; identifier: string | null; title: string; status: string }[]),
    artifactIds.length
      ? db
          .select({ id: artifacts.id, title: artifacts.title, status: artifacts.status })
          .from(artifacts)
          .where(and(inArray(artifacts.id, artifactIds), eq(artifacts.companyId, companyId)))
      : ([] as { id: string; title: string; status: string }[]),
    goalIds.length
      ? db
          .select({ id: goals.id, title: goals.title, status: goals.status })
          .from(goals)
          .where(and(inArray(goals.id, goalIds), eq(goals.companyId, companyId)))
      : ([] as { id: string; title: string; status: string }[]),
  ]);

  // Key by `${entityType}:${id}` — pins are polymorphic; a bare-id map could
  // mis-resolve a cross-table uuid collision (Codex #2).
  const byKey = new Map<string, CockpitPinnedItem>();
  for (const t of tasks) {
    byKey.set(`task:${t.id}`, {
      entityType: "task",
      entityId: t.id,
      title: t.title,
      status: t.status,
      identifier: t.identifier,
    });
  }
  for (const a of arts) {
    byKey.set(`artifact:${a.id}`, {
      entityType: "artifact",
      entityId: a.id,
      title: a.title,
      status: a.status,
    });
  }
  for (const g of gls) {
    byKey.set(`goal:${g.id}`, {
      entityType: "goal",
      entityId: g.id,
      title: g.title,
      status: g.status,
    });
  }

  // Preserve pin order (pinnedAt desc); drop pins whose entity no longer resolves.
  return pins
    .map((p) => byKey.get(`${p.entityType}:${p.entityId}`))
    .filter((x): x is CockpitPinnedItem => !!x);
}

// ── Opt-in card resolvers ─────────────────────────────────────────────────────

/**
 * Goals-at-risk: company-scoped goals with status='at_risk', ordered by most-recently-updated.
 * Goals have no dept RBAC in v1, so this is company-wide for all roles.
 */
async function cockpitGoalsAtRisk(
  db: Db,
  companyId: string,
): Promise<CockpitGoalsAtRiskItem[]> {
  const rows = await db
    .select({
      id: goals.id,
      title: goals.title,
      level: goals.level,
      ownerAgentId: goals.ownerAgentId,
    })
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.status, "at_risk")))
    .orderBy(desc(goals.updatedAt))
    .limit(20);
  return rows;
}

/**
 * Budget pulse: current-month spend vs. company limit (founder-only v1).
 *
 * Returns null for non-founders and when no budget is configured (limitCents=0).
 * Spend window = UTC calendar month (mirrors budgets.ts).
 * Open incident count from budget_incidents table.
 */
async function cockpitBudgetPulse(
  db: Db,
  companyId: string,
  scope: CockpitScope,
): Promise<CockpitBudgetPulseItem | null> {
  // Founder-only v1 (plan §Codex #5): company-wide budget is broader than dept scope.
  // Dept-scoped lead budget view is a documented follow-up.
  if (!scope.isFounder) return null;

  const [company] = await db
    .select({ limitCents: companies.budgetMonthlyCents })
    .from(companies)
    .where(eq(companies.id, companyId));
  const limitCents = company?.limitCents ?? 0;
  // No budget configured → nothing to pulse.
  if (limitCents === 0) return null;

  const { start, end } = utcMonthWindow();
  const [{ spent }] = await db
    .select({ spent: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, companyId),
        gte(costEvents.occurredAt, start),
        lt(costEvents.occurredAt, end),
      ),
    );
  const [{ incidents }] = await db
    .select({ incidents: sql<number>`count(*)::int` })
    .from(budgetIncidents)
    .where(
      and(
        eq(budgetIncidents.companyId, companyId),
        eq(budgetIncidents.status, "open"),
      ),
    );

  const spentCents = Number(spent);
  return {
    limitCents,
    spentCents,
    percentUsed: Math.round((spentCents / limitCents) * 100),
    openIncidentCount: Number(incidents),
  };
}

/**
 * Done-today: tasks completed within today's local-midnight window.
 *
 * Bounded on BOTH ends (plan §Codex #2) to defend against future/clock-skewed completedAt.
 * Founder → company-wide; non-founder → own assigned tasks only.
 */
async function cockpitDoneToday(
  db: Db,
  companyId: string,
  scope: CockpitScope,
): Promise<CockpitDoneTodayItem[]> {
  const start = startOfToday();
  const conds = [
    eq(issues.companyId, companyId),
    gte(issues.completedAt, start),
    lte(issues.completedAt, endOfToday()),
    isNull(issues.hiddenAt), // exclude soft-hidden tasks (consistent with dueTasks; holistic review)
  ];
  // Founder → company-wide; else → own assigned tasks only.
  if (!scope.isFounder) {
    conds.push(eq(issues.assigneeUserId, scope.userId));
  }
  const rows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
    .from(issues)
    .where(and(...conds))
    .orderBy(desc(issues.completedAt))
    .limit(20);
  return rows;
}

// ── Opt-in card resolvers: proactive findings + teammates' activity ────────────

/**
 * Proactive findings: recent unread + undismissed Commander proactive items
 * for the current user. Prefer hub semantic type, while keeping dot/underscore
 * legacy type compatibility until a data backfill removes old rows.
 */
async function cockpitProactiveFindings(
  db: Db,
  companyId: string,
  scope: CockpitScope,
): Promise<CockpitProactiveItem[]> {
  const rows = await db
    .select({
      id: notifications.id,
      title: notifications.title,
      relatedEntityType: notifications.relatedEntityType,
      relatedEntityId: notifications.relatedEntityId,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, companyId),
        eq(notifications.userId, scope.userId),
        or(
          eq(notifications.semanticType, "proactive"),
          inArray(notifications.type, ["internal_agent.proactive", "internal_agent_proactive"]),
        )!,
        isNull(notifications.readAt),
        isNull(notifications.dismissedAt),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(20);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * Teammates' activity: recent human-actor activity excluding the current user.
 *
 * "Teammates" = humans only. Verified actorType values:
 *   - humans: "user" AND "board" (board actor = browser session acting on behalf of a user)
 *   - non-humans: "agent", "system", "commander"
 * We EXCLUDE the non-human set (robust to which human label a route uses).
 *
 * Scoping:
 *   - founder → company-wide human activity
 *   - team_lead → only actors who belong to one of the lead's departments (actor-based scoping)
 *   - team_member → [] (no card)
 *
 * Uses plain db.select + JS Set dedup (NOT db.selectDistinct — the cockpit test mocks
 * only stub `select`, and selectDistinct would throw; Codex #2/#5).
 */
// "Teammates" = humans. ALLOWLIST (not denylist): activity is logged with these
// actorTypes for humans; everything else (agent/system/commander/plugin/…) is
// excluded. An allowlist is robust against future non-human actor types leaking in
// (holistic review: `plugin` would have slipped past a denylist of agent/system/commander).
const HUMAN_ACTORS = ["user", "board"];

async function cockpitTeammatesActivity(
  db: Db,
  companyId: string,
  scope: CockpitScope,
): Promise<CockpitTeammatesActivityItem[]> {
  // member → no card
  if (!scope.isFounder && scope.leadDepartmentIds.length === 0) return [];

  const conds = [
    eq(activityLog.companyId, companyId),
    inArray(activityLog.actorType, HUMAN_ACTORS),
    ne(activityLog.actorId, scope.userId),
  ];

  if (!scope.isFounder) {
    // team_lead → only actors who belong to one of the lead's departments.
    // Use plain select + JS Set dedup (NOT db.selectDistinct — the cockpit test mocks
    // only stub `select`, and selectDistinct would throw; Codex #2/#5).
    const deptRows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), inArray(userRoles.projectId, scope.leadDepartmentIds)));
    const ids = [...new Set(deptRows.map((u) => u.userId))].filter((id) => id !== scope.userId);
    if (ids.length === 0) return [];
    conds.push(inArray(activityLog.actorId, ids));
  }

  const rows = await db
    .select({
      id: activityLog.id,
      actorId: activityLog.actorId,
      actorType: activityLog.actorType,
      action: activityLog.action,
      entityType: activityLog.entityType,
      entityId: activityLog.entityId,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(and(...conds))
    .orderBy(desc(activityLog.createdAt))
    .limit(20);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/**
 * Aggregate the unified approvals queue (Phase 3c + approval families + A4 per-role scoping).
 *
 * A4: per-role scoping (replaces the old founder-only short-circuit). approval / discussion_item /
 *      join_request / memory_archive → founder-only; memory / memory_version → founder OR dept-lead
 *      (active_context layer only, dept ∈ leadDepartmentIds); runtime_tool_trust → any role, owner-scoped (HC4).
 * HC2: memory.listPending returns { items, versions, archives, totalCount } — use .items for
 *      the original "memory" source; .versions and .archives for the new memory_version /
 *      memory_archive sources (reuses same call, no extra query).
 * HC3: discussion join goes through discussionEntryId → discussion_entries → discussions.
 * HC4 (Codex #1 BLOCKER): runtime query filters eq(userId, scope.userId) — the confirm
 *      route is owner-scoped; cross-user rows would 404. Every shown row must be actionable.
 */
async function cockpitApprovals(
  db: Db,
  companyId: string,
  scope: CockpitScope,
): Promise<CockpitApprovalItem[]> {
  // A4: per-role scoping.
  // - approval (hire), discussion_item, memory_archive, join_request → founder-only.
  // - memory + memory_version → founder OR (team_lead AND layer==="active_context" AND dept ∈ leadDepartmentIds).
  // - runtime_tool_trust → any role, owner-scoped by userId (HC4).
  const isFounder = scope.isFounder;
  const isLead = scope.role === "team_lead";
  const canSeeMemory = isFounder || isLead;

  const [approvalRows, memPending, discItems, joinReqRows, runtimeRows] = await Promise.all([
    // element 0: hire/board approvals — founder-only.
    isFounder
      ? listPendingApprovals(db, companyId)
      : Promise.resolve([] as Awaited<ReturnType<typeof listPendingApprovals>>),
    // HC2: listPending returns an OBJECT { items, versions, archives, totalCount }, not an array.
    // Reused for all 3 memory-related sources (memory / memory_version / memory_archive).
    // element 1: memory — founder OR team_lead (filtered below before return).
    canSeeMemory
      ? memoryService(db).listPending(companyId)
      : Promise.resolve({ items: [], versions: [], archives: [], totalCount: 0 }),
    // HC3: join via discussionEntryId. element 2: discussion items — founder-only.
    isFounder
      ? listPendingExtractedItems(db, companyId)
      : Promise.resolve([] as Awaited<ReturnType<typeof listPendingExtractedItems>>),
    // element 3: join requests — founder-only.
    isFounder
      ? db
          .select({
            id: joinRequests.id,
            requestType: joinRequests.requestType,
            requestingUserId: joinRequests.requestingUserId,
            agentName: joinRequests.agentName,
          })
          .from(joinRequests)
          .where(
            and(
              eq(joinRequests.companyId, companyId),
              eq(joinRequests.status, "pending_approval"),
            ),
          )
      : Promise.resolve(
          [] as { id: string; requestType: string; requestingUserId: string | null; agentName: string | null }[],
        ),
    // element 4: runtime tool-trust approvals (HC4: owner-scoped by userId — confirm route is
    // per-user; rows for other users would 404 on action, so we filter to scope.userId).
    // ALWAYS run for every role (owner-scoped, every role can have pending tool approvals).
    db
      .select({
        id: internalAgentRuntimeApprovals.id,
        toolName: internalAgentRuntimeApprovals.toolName,
        expiresAt: internalAgentRuntimeApprovals.expiresAt,
      })
      .from(internalAgentRuntimeApprovals)
      .where(
        and(
          eq(internalAgentRuntimeApprovals.companyId, companyId),
          eq(internalAgentRuntimeApprovals.status, "pending"),
          gt(internalAgentRuntimeApprovals.expiresAt, new Date()),
          eq(internalAgentRuntimeApprovals.userId, scope.userId),
        ),
      ),
  ]);

  // Replicate canApproveMemory in-memory (mirrors permissions.ts:185-205).
  // NO per-item DB call — pure filter over the already-fetched memPending results.
  // R5 (PR #199): the founder is sole gatekeeper for identity AND domain. A team
  // lead may approve only `active_context` for their own department — keep this in
  // lockstep with canApproveMemory in permissions.ts.
  const canApproveMem = (layer: string | null, departmentId: string | null) =>
    isFounder ||
    (isLead && layer === "active_context" && !!departmentId && scope.leadDepartmentIds.includes(departmentId));

  const memItems = memPending.items.filter((m) =>
    canApproveMem(m.layer ?? null, m.departmentId ?? null),
  );
  const memVersions = memPending.versions.filter((v) =>
    canApproveMem(v.itemLayer ?? null, v.itemDepartmentId ?? null),
  );
  // memory_archive — founder-only (no dept-level archive approval for leads).
  const memArchives = isFounder ? memPending.archives : [];

  return [
    ...approvalRows.map(
      (a): CockpitApprovalItem => ({
        source: "approval",
        id: a.id,
        title: approvalTitle(a),
        subtitle: approvalSubtitle(a),
      }),
    ),
    // HC2: use .items (not the whole object).
    ...memItems.map(
      (m): CockpitApprovalItem => ({
        source: "memory",
        id: m.id,
        title: m.title,
        subtitle: [m.layer, m.category].filter(Boolean).join(" · ") || "memory",
      }),
    ),
    ...discItems.map(
      (d): CockpitApprovalItem => ({
        source: "discussion_item",
        id: d.id,
        discussionId: d.discussionId,
        title: d.title,
        subtitle: d.type,
      }),
    ),
    // New: join_request source.
    ...joinReqRows.map(
      (j): CockpitApprovalItem => ({
        source: "join_request",
        id: j.id,
        title:
          j.requestType === "agent"
            ? (j.agentName ?? "Agent join request")
            : (j.requestingUserId ?? "User join request"),
        subtitle: j.requestType === "agent" ? "Agent join" : "User join",
      }),
    ),
    // New: memory_version source (reuses memPending.versions — no extra query).
    ...memVersions.map(
      (v): CockpitApprovalItem => ({
        source: "memory_version",
        id: v.itemId,
        relatedEntityId: v.version.id,
        title: v.itemTitle,
        subtitle:
          [v.itemLayer, v.itemCategory].filter(Boolean).join(" · ") + " (edit)",
      }),
    ),
    // New: memory_archive source (reuses memPending.archives — no extra query).
    ...memArchives.map(
      (a): CockpitApprovalItem => ({
        source: "memory_archive",
        id: a.item.id,
        relatedEntityId: a.suggestion.id,
        title: a.item.title,
        subtitle: "Suggested for archival",
      }),
    ),
    // New: runtime_tool_trust source (ternary — Always/Once/Deny).
    ...runtimeRows.map(
      (r): CockpitApprovalItem => ({
        source: "runtime_tool_trust",
        id: r.id,
        title: r.toolName,
        subtitle: "Tool execution approval",
        decisionType: "ternary",
      }),
    ),
  ];
}

export function cockpitService(db: Db) {
  return {
    async get(companyId: string, actor: ActorLike): Promise<CockpitData> {
      const scope = await resolveCockpitScope(db, companyId, actor);
      const workSvc = cockpitWorkService(db);
      const threadSvc = threadService(db);
      const hubSvc = hubItemsService(db);
      const notesSvc = userNotesService(db);

      // Build the threadService Actor from scope (canonical visibility — Codex #3).
      const threadActor = {
        userId: scope.userId,
        role: scope.role,
        isHuman: true,
      };

      const eod = endOfToday();

      const [runResult, workSummaryResult, remindersResult, dueTodayResult, stickyNotesResult, inboxResult, visibleThreadsResult, approvalsResult, pinnedResult, goalsAtRiskResult, budgetPulseResult, doneTodayResult, proactiveFindingsResult, teammatesActivityResult] =
        await Promise.allSettled([
          // ── 1. Running ────────────────────────────────────────────────────
          // Company-wide live runs (heartbeat + crew internal_agent runs).
          // Per-user scoping for crew is a 3c refinement (note in plan §13).
          liveRunsForCompany(db, companyId),

          // ── 2. Review ────────────────────────────────────────────────────
          // taskScope:"all" is REQUIRED (Codex #2) — default "org" scope
          // hides crew agent tasks via notCrewAssigned; Review IS crew work.
          workSvc.summary(companyId, scope.userId),

          // ── 3. My Tasks ───────────────────────────────────────────────────
          // The human's own assigned tasks, excluding terminal ones.
          // Default org-scope is correct — My tasks = the human's own tasks.
          // ── 4a. Today: pending reminders for this user ────────────────────
          db
            .select({
              id: internalAgentReminders.id,
              content: internalAgentReminders.content,
              triggerAt: internalAgentReminders.triggerAt,
            })
            .from(internalAgentReminders)
            .where(
              and(
                eq(internalAgentReminders.companyId, companyId),
                eq(internalAgentReminders.userId, scope.userId),
                eq(internalAgentReminders.status, "pending"),
                lte(internalAgentReminders.triggerAt, eod),
              ),
            ),

          // ── 4b. Today: due tasks for this user ────────────────────────────
          db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              priority: issues.priority,
              assigneeUserId: issues.assigneeUserId,
              assigneeAgentId: issues.assigneeAgentId,
              responsibleUserId: issues.responsibleUserId,
              reviewerUserId: issues.reviewerUserId,
              dueDate: issues.dueDate,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                eq(issues.assigneeUserId, scope.userId),
                lte(issues.dueDate, eod),
                sql`${issues.status} NOT IN ('done', 'cancelled')`,
                sql`${issues.hiddenAt} IS NULL`,
              ),
            ),

          // 4c. Sticky notes: private human scratchpad for this user.
          notesSvc.list(companyId, scope.userId),

          // 4d. Inbox: same RBAC-scoped hot set as the Inbox Hub.
          hubSvc.query(companyId, {
            actorUserId: scope.userId,
            role: scope.role,
            groupMode: "none",
            limit: 5,
          }),

          // Discussions: canonical visibility. threadService.list handles
          // participant + dept-role access internally.
          threadSvc.list(companyId, threadActor),

          // ── 6. Approvals (Phase 3c): founder-only unified queue ───────────
          // Non-founders: returns [] immediately without sub-queries (HC1).
          cockpitApprovals(db, companyId, scope),

          // ── 7. Pinned (Phase 3d): user's pinned entities (company-scoped) ──
          cockpitPinned(db, companyId, scope),

          // ── 8. Opt-in: Goals at risk (company-scoped, all roles) ──────────
          cockpitGoalsAtRisk(db, companyId),

          // ── 9. Opt-in: Budget pulse (founder-only) ────────────────────────
          cockpitBudgetPulse(db, companyId, scope),

          // ── 10. Opt-in: Done today ────────────────────────────────────────
          cockpitDoneToday(db, companyId, scope),

          // ── 11. Opt-in: Proactive findings (per-user unread Commander proactive) ─
          cockpitProactiveFindings(db, companyId, scope),

          // ── 12. Opt-in: Teammates' activity (human actors only, RBAC-scoped) ───
          cockpitTeammatesActivity(db, companyId, scope),
        ]);

      const emptyWorkSummary = {
        activeWork: {
          mine: { items: [], total: 0, nextCursor: null },
          managed: { items: [], total: 0, nextCursor: null },
        },
        awaitingReview: { items: [], total: 0, nextCursor: null },
      };
      const runRows = settledValue(runResult, []);
      const workSummary = settledValue(workSummaryResult, emptyWorkSummary);
      const remindersRows = settledValue(remindersResult, []);
      const dueTodayRows = settledValue(dueTodayResult, []);
      const stickyNoteRows = settledValue(stickyNotesResult, []);
      const visibleThreads = settledValue(visibleThreadsResult, []);
      const approvalsItems = settledValue(approvalsResult, []);
      const pinnedItems = settledValue(pinnedResult, []);
      const goalsAtRiskItems = settledValue(goalsAtRiskResult, []);
      const budgetPulseItem = settledValue(budgetPulseResult, null);
      const doneTodayItems = settledValue(doneTodayResult, []);
      const proactiveFindingsItems = settledValue(proactiveFindingsResult, []);
      const teammatesActivityItems = settledValue(teammatesActivityResult, []);
      const slices = {
        running: sliceStatus(runResult),
        work: sliceStatus(workSummaryResult),
        todayReminders: sliceStatus(remindersResult),
        todayTasks: sliceStatus(dueTodayResult),
        stickyNotes: sliceStatus(stickyNotesResult),
        inbox: sliceStatus(inboxResult),
        discussions: sliceStatus(visibleThreadsResult),
        approvals: sliceStatus(approvalsResult),
        pinned: sliceStatus(pinnedResult),
        goalsAtRisk: sliceStatus(goalsAtRiskResult),
        budgetPulse: sliceStatus(budgetPulseResult),
        doneToday: sliceStatus(doneTodayResult),
        proactiveFindings: sliceStatus(proactiveFindingsResult),
        teammatesActivity: sliceStatus(teammatesActivityResult),
      };

      // ── Map running ───────────────────────────────────────────────────────
      const running = (
        runRows as Array<{
          id: string;
          agentName?: string | null;
          status: string;
          startedAt?: Date | string | null;
          issueId?: string | null;
        }>
      )
        .filter((r) => r.status === "running" || r.status === "queued")
        .map((r) => ({
        id: r.id,
        agentName: r.agentName ?? null,
        status: r.status,
        startedAt: r.startedAt
          ? typeof r.startedAt === "string"
            ? r.startedAt
            : (r.startedAt as Date).toISOString()
          : null,
        issueId: r.issueId ?? null,
      }));

      // ── Map review ────────────────────────────────────────────────────────
      const review = workSummary.awaitingReview.items;

      // ── Map myTasks (exclude terminal) ───────────────────────────────────
      const myTasks = workSummary.activeWork.mine.items;

      // ── Map today ────────────────────────────────────────────────────────
      const reminders = remindersRows.map((r) => ({
        id: r.id,
        content: r.content,
        triggerAt: r.triggerAt.toISOString(),
      }));
      const dueTasks = dueTodayRows.map(toTaskItem);
      const stickyNotes: CockpitNoteItem[] = stickyNoteRows.slice(0, 5).map((note) => ({
        id: note.id,
        title: note.title,
        body: note.body,
        color: note.color as CockpitNoteItem["color"],
        updatedAt: note.updatedAt,
      }));
      const inboxRows = inboxResult.status === "fulfilled" ? inboxResult.value.items : [];
      const inbox: CockpitInboxItem[] = inboxRows.map((item) => ({
        id: item.id,
        lane: item.lane,
        priority: item.priority as CockpitInboxItem["priority"],
        title: item.title,
        summary: item.summary,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        relatedEntityType: item.relatedEntityType,
        relatedEntityId: item.relatedEntityId,
        unread: item.readAt === null,
        createdAt: item.createdAt.toISOString(),
      }));

      // ── Map discussions: filter to needs-me ──────────────────────────────
      // "needs me" = pendingItemCount > 0 OR a pending/failed extraction entry.
      const visibleIds = visibleThreads.map((t) => t.id);

      let needsMeIds = new Set<string>();

      // Quick pass: threads with pendingItemCount already populated.
      const alreadyPending = visibleThreads.filter(
        (t) => (t.pendingItemCount ?? 0) > 0,
      );
      for (const t of alreadyPending) needsMeIds.add(t.id);

      // Batch query: find any visible thread with a pending/failed entry.
      if (visibleIds.length > 0) {
        try {
          const entryRows = await db
            .select({ discussionId: discussionEntries.discussionId })
            .from(discussionEntries)
            .where(
              and(
                inArray(discussionEntries.discussionId, visibleIds),
                inArray(discussionEntries.extractionStatus, ["pending", "failed"]),
              ),
            );
          for (const e of entryRows) needsMeIds.add(e.discussionId);
        } catch {
          slices.discussions = { status: "error", errorCode: "unavailable" };
        }
      }

      const threadById = new Map(visibleThreads.map((t) => [t.id, t]));

      // Determine the reason per discussion (prefer pending_items over extraction_failed
      // since pendingItemCount is the higher-signal indicator).
      const highSignalItems = [...needsMeIds].map((id) => {
        const t = threadById.get(id)!;
        const hasPending = (t.pendingItemCount ?? 0) > 0;
        return {
          id: t.id,
          title: t.title ?? null,
          pendingItemCount: t.pendingItemCount ?? 0,
          reason: hasPending
            ? ("pending_items" as const)
            : ("extraction_failed" as const),
          entryCount: t.entryCount ?? 0,
          lastEntryAt: t.lastEntryAt ? t.lastEntryAt.toISOString() : null,
        };
      });
      const recentItems = visibleThreads
        .filter((t) => t.status !== "archived" && !needsMeIds.has(t.id))
        .slice(0, Math.max(0, 5 - highSignalItems.length))
        .map((t) => ({
          id: t.id,
          title: t.title ?? null,
          pendingItemCount: t.pendingItemCount ?? 0,
          reason: "recent_activity" as const,
          entryCount: t.entryCount ?? 0,
          lastEntryAt: t.lastEntryAt ? t.lastEntryAt.toISOString() : null,
        }));
      const discussionItems = [...highSignalItems, ...recentItems].slice(0, 5);

      return {
        activeWork: workSummary.activeWork,
        awaitingReview: workSummary.awaitingReview,
        meta: {
          generatedAt: new Date().toISOString(),
          partial: Object.values(slices).some((slice) => slice.status === "error"),
          slices,
        },
        running,
        review,
        myTasks,
        today: { reminders, dueTasks },
        stickyNotes,
        inbox,
        discussions: discussionItems,
        approvals: approvalsItems,
        pinned: pinnedItems,
        goalsAtRisk: goalsAtRiskItems,
        budgetPulse: budgetPulseItem,
        doneToday: doneTodayItems,
        proactiveFindings: proactiveFindingsItems,
        teammatesActivity: teammatesActivityItems,
      };
    },

    async listTasks(
      companyId: string,
      actor: ActorLike,
      bucket: CockpitTaskBucket,
      options: { limit?: number; cursor?: string } = {},
    ): Promise<CockpitTaskBucketResponse> {
      const scope = await resolveCockpitScope(db, companyId, actor);
      return cockpitWorkService(db).listBucket(
        companyId,
        scope.userId,
        bucket,
        options.limit,
        options.cursor,
      );
    },

    async getCounts(companyId: string, actor: ActorLike): Promise<CockpitCounts> {
      const scope = await resolveCockpitScope(db, companyId, actor);
      const threadActor = { userId: scope.userId, role: scope.role, isHuman: true };
      const [workSummary, runRows, inboxResult, visibleThreads, approvalsItems] = await Promise.all([
        cockpitWorkService(db).summary(companyId, scope.userId),
        liveRunsForCompany(db, companyId),
        hubItemsService(db).query(companyId, {
          actorUserId: scope.userId,
          role: scope.role,
          groupMode: "none",
          limit: 1,
        }),
        threadService(db).list(companyId, threadActor),
        cockpitApprovals(db, companyId, scope),
      ]);

      return {
        activeWorkMine: workSummary.activeWork.mine.total,
        activeWorkManaged: workSummary.activeWork.managed.total,
        awaitingReview: workSummary.awaitingReview.total,
        running: runRows.filter((run) => {
          if (!run || typeof run !== "object" || !("status" in run)) return false;
          return run.status === "running" || run.status === "queued";
        }).length,
        inbox: inboxResult.totalKnown ?? inboxResult.items.length,
        approvals: approvalsItems.length,
        discussions: visibleThreads.filter((thread) => thread.status !== "archived").length,
        generatedAt: new Date().toISOString(),
      };
    },
  };
}
