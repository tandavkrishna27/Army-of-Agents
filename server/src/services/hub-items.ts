import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@armyofagents/db";
import {
  hubItems,
  hubItemUserState,
  hubAudit,
  activityLog,
  agentRuntimeDecisions,
  companyMemberships,
  approvals,
  heartbeatRuns,
  joinRequests,
  discussions,
  discussionEntries,
  suggestions,
  issues,
  companies,
  costEvents,
  workQuestions,
  memoryItems,
} from "@armyofagents/db";
import type {
  HubCountsChangedLivePayload,
  HubGroupMode,
  HubItemChangedLivePayload,
  HubItemStatus,
  HubLane,
  HubSemanticType,
  HubOwnerPool,
  HubUserStateInput,
  NotificationPreferences,
} from "@armyofagents/shared";
import {
  HUB_SEMANTIC_TYPES,
  HUB_SOURCE_MIRRORED_TYPES,
  laneForSemanticType,
  authorityForSemanticType,
} from "@armyofagents/shared";
import type { UserRole } from "@armyofagents/shared";

// Mirror-model guard (R3 + H1): a runtime-decision hub item is manually
// clearable ONLY once its backing decision has left the answerable window.
// {created, shown} = the founder can still decide it → block resolve/archive.
// {answered, relay_failed} are deliberately NOT in this set so the dead-run
// stall rows Task 5 sweeps stay clearable (using the reconciler's generic
// `terminal` flag here would block them and collide with Task 5).
const RUNTIME_DECISION_ANSWERABLE_STATUSES: ReadonlySet<string> = new Set(["created", "shown"]);

// Heartbeat-backed hub items are actionable while the source run is live, or
// while it is the latest failed/timed-out run for its agent. Successful process
// exits are run-history facts, not attention items; excluding "succeeded" also
// archives historical run_complete rows during reconciliation.
const HEARTBEAT_ACTIONABLE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "scheduled_retry",
  "running",
  "failed",
  "timed_out",
]);
const APPROVAL_OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "revision_requested"]);
const STALE_WORK_STATUSES: ReadonlySet<string> = new Set(["todo", "in_progress"]);
const STALE_WORK_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const HUB_UNDO_WINDOW_MS = 8_000;
// budget_alert closes symmetric with the producer (hub-legacy-alerts.ts): the
// budget_alert item fires at >= 80% utilization, so the reconciler closes it
// (terminal) once utilization drops back below 80% (or the budget is unset).
// Keep this in sync with hub-legacy-alerts.ts's BUDGET_WARNING_PERCENT — both
// are the same 80% threshold; a shared export would create an import cycle
// (hub-items <-> hub-source-producers <-> hub-legacy-alerts).
const BUDGET_WARNING_PERCENT = 80;
import { redactSecretsInString } from "../redaction.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { HttpError } from "../errors.js";
import { hubCounterSnapshotsService } from "./hub-counter-snapshots.js";
import { notificationDigestService } from "./notification-digest.js";
import { notificationPreferencesService } from "./notification-preferences.js";
import { orgHierarchyService } from "./org-hierarchy.js";
import { permissionService } from "./permissions.js";
import { publishLiveEvent } from "./live-events.js";
import { runtimeDecisionSourceSnapshot } from "./agent-runtime-decisions.js";
// Shared budget-alert summary formatter (H3): the producer and this reconciler
// MUST format the summary through the same function so heal writes are
// byte-identical to producer emits (no ping-pong). Runtime-only usage keeps the
// hub-source-producers <-> hub-items import cycle safe (no module-eval call).
import { formatBudgetAlertSummary } from "./hub-source-producers.js";

// Semantic types that resolve to a given lane (lane is derived, not a column).
function semanticTypesForLane(lane: HubLane): HubSemanticType[] {
  return HUB_SEMANTIC_TYPES.filter((t) => laneForSemanticType(t) === lane);
}

// Fast membership check for decorateItem's P3-1 unknown-type strip (Task 10).
const HUB_SEMANTIC_TYPE_SET: ReadonlySet<string> = new Set(HUB_SEMANTIC_TYPES);

// P3-1 (Task 10) pure resolver: map a stored semanticType to its lane, degrading
// null OR an unknown/pruned string (a leftover human_input_needed/scope_proposal
// [SEED] row after the prune) to legacy_other's lane (notifications) — never
// `undefined`. Exported so the strip is unit-testable without a DB.
export function resolveLaneForStoredType(semanticType: string | null): HubLane | null {
  if (!semanticType) return null;
  return HUB_SEMANTIC_TYPE_SET.has(semanticType)
    ? laneForSemanticType(semanticType as HubSemanticType)
    : laneForSemanticType("legacy_other");
}

export function normalizeStoredSemanticType(semanticType: string | null): HubSemanticType | null {
  if (!semanticType) return null;
  return HUB_SEMANTIC_TYPE_SET.has(semanticType)
    ? semanticType as HubSemanticType
    : "legacy_other";
}

// ── Emit ────────────────────────────────────────────────────────────────────

export interface EmitArgs {
  companyId: string;
  semanticType: HubSemanticType;
  sourceType: string;
  sourceId: string;
  title: string;
  summary?: string | null;
  legacyType?: string | null;
  message?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  deliveryAttempts?: number;
  deliveredAt?: Date | null;
  deliveryError?: string | null;
  scopeKey?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  // Owner resolution: pass ownerUserId for NATURAL-owner items (mention → the
  // mentioned user, reminder → the user). For agent/run-sourced events, pass
  // sourceActorType/sourceActorId and emit resolves the first human ancestor.
  ownerUserId?: string | null;
  sourceActorType?: "agent" | "user" | null;
  sourceActorId?: string | null;
  ownerPool?: HubOwnerPool | null; // ADDITIONAL pool visibility; never replaces the human owner
  slaAt?: Date | null;
  sourcePermissionRevision?: string | null;
  // OPT-IN reopen for AGGREGATE signposts (default false). A memory_review /
  // budget-style row is ONE row per company that the founder clears to
  // `archived` when the backing count hits zero; the next qualifying emit must be
  // able to REOPEN that non-open row so the signpost reappears (the clear→refill
  // cycle is normal for such aggregates). Set true ONLY by aggregate producers.
  // Mirror/source items (approval, join_request, runtime decision, …) MUST leave
  // this undefined/false so a decided/archived row is NEVER resurrected.
  reopenWhenArchived?: boolean;
  // Emit in the SAME transaction as the source mutation (no silent drops). A
  // PgTransaction is NOT assignable to Db — callers pass `tx as unknown as Db`.
  executor?: Db;
}

export type HubListRow = typeof hubItems.$inferSelect & {
  lane: HubLane | null;
  readAt: Date | null;
  snoozedUntil: Date | null;
  dismissedAt: Date | null;
  groupKey: string | null;
  groupLabel: string | null;
  groupCount: number | null;
  scopeKey: string | null;
  slaAt: Date | null;
  curationGroupLabel: string | null;
  curationGroupSummary: string | null;
  curationReason: string | null;
  curationPriorityReason: string | null;
  curationRevision: number;
  curatedAt: Date | null;
  curatedByAgentId: string | null;
};

export interface HubListResponse {
  items: HubListRow[];
  nextCursor: string | null;
  totalKnown: number | null;
}

function encodeCursor(row: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }), "utf8")
    .toString("base64url");
}

function decodeCursor(cursor: string) {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    createdAt: string;
    id: string;
  };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

function likePattern(q: string) {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function deriveFallbackGroupKey(
  item: { semanticType: string | null; scopeKey: string | null; sourceType: string | null; groupKey: string | null },
  groupMode: HubGroupMode,
) {
  if (groupMode === "none") return null;
  if (item.groupKey) return item.groupKey;
  if (groupMode === "source") return item.sourceType ? `source:${item.sourceType}` : null;
  if (groupMode === "scope") return item.scopeKey ? `scope:${item.scopeKey}` : null;
  if (groupMode === "type") return item.semanticType ? `type:${item.semanticType}` : null;
  const parts = [item.semanticType ?? "unknown", item.scopeKey ?? "global", item.sourceType ?? "unknown"];
  return `auto:${parts.join(":")}`;
}

function deriveGroupLabel(
  item: { semanticType: string | null; scopeKey: string | null; sourceType: string | null; groupKey: string | null },
  groupMode: HubGroupMode,
) {
  if (groupMode === "none") return null;
  if (item.groupKey) return item.groupKey;
  if (groupMode === "source") return item.sourceType ?? null;
  if (groupMode === "scope") return item.scopeKey ?? null;
  if (groupMode === "type") return item.semanticType ?? null;
  return [item.semanticType, item.scopeKey, item.sourceType].filter(Boolean).join(" / ") || null;
}

export function hubItemsService(db: Db) {
  const counterSnapshots = hubCounterSnapshotsService(db);

  async function invalidateCounterSnapshotsForCompany(companyId: string) {
    try {
      await counterSnapshots.invalidateCompany(companyId);
    } catch {
      // Counter snapshots are a performance cache; hub mutations must not fail
      // because a test double or partially migrated DB cannot update the cache.
    }
  }

  async function invalidateCounterSnapshotsForUser(companyId: string, userId: string) {
    try {
      await counterSnapshots.invalidateUser(companyId, userId);
    } catch {
      // See invalidateCounterSnapshotsForCompany.
    }
  }

  function sourceUniqueKey(a: EmitArgs): string {
    return [a.companyId, a.sourceType, a.sourceId, a.semanticType, a.scopeKey ?? ""].join(":");
  }

  // P3-1 (Task 10): a row whose semanticType is null OR an unknown/pruned string
  // (e.g. a leftover `human_input_needed`/`scope_proposal` [SEED] row after the
  // prune) must NOT surface with `lane: undefined` in the lane-LESS reads (Home
  // fetch, `q` search). Map an unknown non-null type to legacy_other's lane
  // (notifications) — the internal catch-all sink — so it degrades cleanly.
  function decorateItem<T extends { semanticType: string | null }>(row: T) {
    const semanticType = normalizeStoredSemanticType(row.semanticType);
    return { ...row, semanticType, lane: resolveLaneForStoredType(row.semanticType) };
  }

  function publishHubItemChanged(
    item: { id: string; companyId: string; semanticType: string | null; status: string; version: number },
    change: HubItemChangedLivePayload["change"],
  ) {
    if (!item.semanticType) return;
    const semanticType = item.semanticType as HubSemanticType;
    publishLiveEvent({
      companyId: item.companyId,
      type: "hub.item.changed",
      payload: {
        itemId: item.id,
        semanticType,
        lane: laneForSemanticType(semanticType),
        status: item.status as HubItemStatus,
        version: item.version,
        change,
      } satisfies HubItemChangedLivePayload,
    });
  }

  function toListRow(
    item: typeof hubItems.$inferSelect,
    state: {
      readAt?: Date | null;
      snoozedUntil?: Date | null;
      dismissedAt?: Date | null;
    } = {},
    groupMode: HubGroupMode = "auto",
  ): HubListRow {
    const semanticType = normalizeStoredSemanticType(item.semanticType);
    return {
      ...item,
      semanticType,
      lane: resolveLaneForStoredType(item.semanticType),
      readAt: state.readAt ?? null,
      snoozedUntil: state.snoozedUntil ?? null,
      dismissedAt: state.dismissedAt ?? null,
      groupKey: deriveFallbackGroupKey(item, groupMode),
      groupLabel: item.curationGroupLabel ?? deriveGroupLabel(item, groupMode),
      groupCount: null,
      scopeKey: item.scopeKey,
      slaAt: item.slaAt,
    };
  }

  function publishHubCountsChanged(companyId: string, reason: HubCountsChangedLivePayload["reason"]) {
    publishLiveEvent({
      companyId,
      type: "hub.counts.changed",
      payload: { reason } satisfies HubCountsChangedLivePayload,
    });
  }

  function hubOwnedPriorState(item: {
    status: string;
    version: number;
    resolvedAt: Date | null;
    archivedAt: Date | null;
    claimedByUserId?: string | null;
    claimedAt?: Date | null;
  }) {
    return {
      status: item.status,
      version: item.version,
      resolvedAt: item.resolvedAt,
      archivedAt: item.archivedAt,
      claimedByUserId: item.claimedByUserId ?? null,
      claimedAt: item.claimedAt ?? null,
    };
  }

  function jsonDate(value: unknown): Date | null {
    if (value == null) return null;
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") return new Date(value);
    return null;
  }

  // §7/§19: every item has a real human Owner. Natural owner → use it; agent/run
  // source → first human ancestor (W6); else the founder. Never null/"" (W6
  // guarantees a human-at-top, so getFounderUserId is the floor).
  async function resolveOwner(conn: Db, a: EmitArgs): Promise<string> {
    if (a.ownerUserId) return a.ownerUserId;
    const org = orgHierarchyService(conn);
    if (a.sourceActorType === "agent" && a.sourceActorId) {
      const human = await org.getFirstHumanAncestor(a.companyId, "agent", a.sourceActorId);
      if (human) return human;
    }
    const founder = await org.getFounderUserId(a.companyId);
    if (!founder) throw unprocessable("Cannot emit a hub item: company has no human owner");
    return founder;
  }

  function clockMinutes(value: string) {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
  }

  function zonedClockMinutes(now: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const hourPart = parts.find((part) => part.type === "hour")?.value ?? "0";
    const minutePart = parts.find((part) => part.type === "minute")?.value ?? "0";
    const hour = Number(hourPart) % 24;
    return hour * 60 + Number(minutePart);
  }

  function quietHoursActive(
    quietHours: NotificationPreferences["quietHours"],
    now = new Date(),
  ) {
    if (!quietHours.enabled) return false;
    const start = clockMinutes(quietHours.start);
    const end = clockMinutes(quietHours.end);
    if (start === end) return true;
    const current = zonedClockMinutes(now, quietHours.timezone);
    return start < end
      ? current >= start && current < end
      : current >= start || current < end;
  }

  async function findDigestCandidateUserIds(
    conn: Db,
    item: { companyId: string; ownerUserId: string | null; scopeKey: string | null },
  ) {
    const memberships = await conn
      .select({ userId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, item.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );
    const candidates = new Set<string>();
    const permissions = permissionService(conn);
    for (const membership of memberships) {
      const userId = membership.userId;
      if (userId === item.ownerUserId) {
        candidates.add(userId);
        continue;
      }
      const role = await permissions.getEffectiveRole(item.companyId, userId);
      if (role === "founder") {
        candidates.add(userId);
        continue;
      }
      if (role === "team_lead" && item.scopeKey) {
        const leadDepartments = await permissions.getTeamLeadDepartments(item.companyId, userId);
        if (leadDepartments.includes(item.scopeKey)) {
          candidates.add(userId);
        }
      }
    }
    return [...candidates];
  }

  async function queueDigestDeliveries(
    conn: Db,
    item: {
      id: string;
      companyId: string;
      semanticType: string | null;
      status: string;
      ownerUserId: string | null;
      scopeKey: string | null;
    },
    publish: boolean,
  ) {
    if (item.status !== "open" || !item.semanticType) return;
    const semanticType = item.semanticType as HubSemanticType;
    const userIds = await findDigestCandidateUserIds(conn, item);
    const preferences = notificationPreferencesService(conn);
    const digest = notificationDigestService(conn);
    for (const userId of userIds) {
      const userPreferences = await preferences.get(userId, item.companyId);
      if (!userPreferences.digest.enabled) continue;
      const rule = userPreferences.rules.find((r) => r.semanticType === semanticType);
      if (!rule || rule.deliveryMode === "silent") continue;
      const shouldQueue =
        rule.deliveryMode === "digest" ||
        (rule.deliveryMode === "realtime" && quietHoursActive(userPreferences.quietHours));
      if (!shouldQueue) continue;
      await digest.queueForUser({
        companyId: item.companyId,
        userId,
        hubItemId: item.id,
        semanticType,
        publish,
      });
    }
  }

  async function emit(a: EmitArgs) {
    const conn = (a.executor ?? db) as unknown as Db; // executor may be a PgTransaction
    const ownerUserId = await resolveOwner(conn, a); // a real human; never ""
    const key = sourceUniqueKey(a);
    const body = a.summary ?? a.message ?? null;
    const safeSummary = body == null ? null : redactSecretsInString(body);
    const values = {
      companyId: a.companyId,
      userId: ownerUserId, // legacy NOT NULL column = the resolved human owner
      type: a.legacyType ?? a.semanticType, // preserve old notification type when supplied
      title: a.title,
      message: safeSummary,
      relatedEntityType: a.relatedEntityType ?? null,
      relatedEntityId: a.relatedEntityId ?? null,
      deliveryAttempts: a.deliveryAttempts ?? 0,
      deliveredAt: a.deliveredAt ?? new Date(),
      deliveryError: a.deliveryError ?? null,
      semanticType: a.semanticType,
      sourceType: a.sourceType,
      sourceId: a.sourceId,
      scopeKey: a.scopeKey ?? null,
      sourceUniqueKey: key,
      summary: safeSummary,
      priority: a.priority ?? "normal",
      ownerUserId,
      ownerPool: a.ownerPool ?? null,
      slaAt: a.slaAt ?? null,
      sourcePermissionRevision: a.sourcePermissionRevision ?? null,
      status: "open" as const,
    };
    // Idempotent upsert, gated to STILL-OPEN rows: a re-emit refreshes the
    // denormalized fields ONLY while the item is open — it never resurrects a
    // resolved/archived item nor clobbers fields under an in-flight action.
    //
    // Storm guard (change detection): the UPDATE additionally fires only when a
    // meaningful field actually differs. Without this, every re-emit rewrote the
    // row (deliveredAt is always-new) and published hub.item.changed +
    // hub.counts.changed — and because GET /sidebar-badges scan-materializes
    // legacy alerts on read while the client refetches badges on exactly those
    // events, one open browser tab + one failed latest-run turned into a
    // self-sustaining ~125Hz client<->server feedback storm (millions of no-op
    // row rewrites). deliveredAt is deliberately EXCLUDED from the check: it is
    // `?? new Date()` and would defeat it.
    // OPT-IN reopen (Fix 1): only aggregate producers (memory_review) set this.
    // When false/absent, the setWhere + set below are byte-for-byte the historical
    // open-only, no-status-write path — mirror/source items never resurrect.
    const reopen = a.reopenWhenArchived === true;
    // The existing storm-guard gate: still-open AND some meaningful field differs.
    // Reused verbatim so the non-reopen setWhere is unchanged.
    const openAndChanged = sql`${hubItems.status} = 'open' AND (
          ${hubItems.title} IS DISTINCT FROM ${values.title}
          OR ${hubItems.message} IS DISTINCT FROM ${values.message}
          OR ${hubItems.summary} IS DISTINCT FROM ${values.summary}
          OR ${hubItems.relatedEntityType} IS DISTINCT FROM ${values.relatedEntityType}
          OR ${hubItems.relatedEntityId} IS DISTINCT FROM ${values.relatedEntityId}
          OR ${hubItems.deliveryAttempts} IS DISTINCT FROM ${values.deliveryAttempts}
          OR ${hubItems.deliveryError} IS DISTINCT FROM ${values.deliveryError}
          OR ${hubItems.priority} IS DISTINCT FROM ${values.priority}
          OR ${hubItems.userId} IS DISTINCT FROM ${values.userId}
          OR ${hubItems.ownerUserId} IS DISTINCT FROM ${values.ownerUserId}
          OR ${hubItems.ownerPool} IS DISTINCT FROM ${values.ownerPool}
          OR ${hubItems.slaAt} IS DISTINCT FROM ${values.slaAt?.toISOString() ?? null}
          OR ${hubItems.sourcePermissionRevision} IS DISTINCT FROM ${values.sourcePermissionRevision}
        )`;
    // Reopen path: also fire the UPDATE when the row is NON-open (needs
    // reopening). Non-reopen path: the gate is unchanged (open-only + storm guard).
    const setWhere = reopen
      ? sql`(${hubItems.status} <> 'open') OR (${openAndChanged})`
      : openAndChanged;
    // Denormalized fields refreshed on every qualifying re-emit (unchanged).
    const baseSet = {
      title: values.title,
      message: values.message,
      relatedEntityType: values.relatedEntityType,
      relatedEntityId: values.relatedEntityId,
      deliveryAttempts: values.deliveryAttempts,
      deliveredAt: values.deliveredAt,
      deliveryError: values.deliveryError,
      summary: values.summary,
      priority: values.priority,
      // Keep the legacy `userId` and the hub `ownerUserId` in lockstep: a
      // re-emit that resolves a different owner must update BOTH, or the two
      // owner columns diverge (P2-3).
      userId: values.userId,
      ownerUserId: values.ownerUserId,
      ownerPool: values.ownerPool,
      slaAt: values.slaAt,
      sourcePermissionRevision: values.sourcePermissionRevision,
    };
    // Reopen path ALSO rewrites the lifecycle columns so the reopened row is a
    // fresh open item: status→open, clear archivedAt/resolvedAt, bump version so
    // downstream optimistic-concurrency readers see a new revision. Non-reopen
    // path leaves `set` free of any status/version/*At keys (byte-for-byte the
    // historical set) so a decided/archived mirror row is never resurrected.
    const set = reopen
      ? {
          ...baseSet,
          status: sql`'open'`,
          archivedAt: sql`null`,
          resolvedAt: sql`null`,
          version: sql`${hubItems.version} + 1`,
        }
      : baseSet;
    const inserted = await conn
      .insert(hubItems)
      .values(values)
      .onConflictDoUpdate({
        target: hubItems.sourceUniqueKey,
        setWhere,
        set,
      })
      .returning();
    // A conflict where setWhere is false — the row is NON-open, or nothing
    // meaningful changed — updates nothing → RETURNING is empty; re-select the
    // existing row so callers always get the current item.
    let row = inserted[0];
    const changed = Boolean(row);
    if (!row) {
      row = await conn
        .select()
        .from(hubItems)
        .where(eq(hubItems.sourceUniqueKey, key))
        .limit(1)
        .then((r) => r[0]);
    }
    // TOCTOU guard: if the row was concurrently deleted between the gated upsert
    // (empty RETURNING) and the re-select, `row` is undefined — never return an
    // id-less `{ lane }` object to callers (P2-5).
    if (!row) throw conflict("Hub item vanished during emit; retry.");
    // Side-effects only when the emit actually inserted or changed something —
    // a no-op re-emit must not invalidate counters, queue digests, or publish
    // live events (the storm guard above).
    if (changed) {
      await invalidateCounterSnapshotsForCompany(a.companyId);
      await queueDigestDeliveries(conn, row, !a.executor);
      if (!a.executor) {
        publishHubItemChanged(row, "created");
        publishHubCountsChanged(a.companyId, "item_changed");
      }
    }
    return { ...row, lane: laneForSemanticType(a.semanticType) };
  }

  // ── Query / Action / Reconcile ──────────────────────────────────────────────
  // NOTE: the public `return` sits at the END of this closure (after every
  // const/function declaration below) so the module-scoped reconciler consts
  // actually evaluate — a `return` before them would leave them unreachable
  // (TDZ at reconcile()-call time). Function declarations hoist; consts do not.

  // Version-guarded status transition + audit row, written in ONE transaction.
  // Used by reconcile (system close) so a system transition and a concurrent
  // user action (via recordLifecycleAction, which shares the same `version`-
  // guarded UPDATE idiom) can't lost-update each other. Throws `conflict` (409)
  // on a version miss.
  async function applyGuardedTransition(
    tx: Db,
    item: { id: string; companyId: string; status: string; version: number; resolvedAt: Date | null; archivedAt: Date | null },
    nextStatus: "resolved" | "archived" | "snoozed",
    audit: {
      actorType: string;
      actorId: string;
      action: string;
      authorityBasis?: string | null;
      reason?: string | null;
      idempotencyKey?: string | null;
      sourceRevision?: string | null;
    },
    // The version the UPDATE is guarded on (the client's expectedVersion for a
    // manual action). Defaults to the item's own version (system/sweeper path).
    // priorState always records the item's TRUE current version, not the guard.
    guardVersion: number = item.version,
  ) {
    const updated = await tx
      .update(hubItems)
      .set({
        status: nextStatus,
        version: guardVersion + 1,
        resolvedAt: nextStatus === "resolved" ? new Date() : item.resolvedAt,
        archivedAt: nextStatus === "archived" ? new Date() : item.archivedAt,
      })
      .where(and(eq(hubItems.id, item.id), eq(hubItems.version, guardVersion)))
      .returning()
      .then((r) => r[0] ?? null);
    if (!updated) {
      throw conflict("This item was changed by someone else. Reload and retry.", {
        currentVersion: item.version,
      });
    }
    await tx.insert(hubAudit).values({
      companyId: item.companyId,
      hubItemId: item.id,
      actorType: audit.actorType,
      actorId: audit.actorId,
      action: audit.action,
      authorityBasis: audit.authorityBasis ?? null,
      reason: audit.reason ?? null,
      idempotencyKey: audit.idempotencyKey ?? null,
      sourceRevision: audit.sourceRevision ?? null,
      priorState: { status: item.status, version: item.version },
    });
    return updated;
  }

  async function visibilityConds(
    companyId: string,
    actorUserId: string,
    role: UserRole,
  ) {
    const conds = [eq(hubItems.companyId, companyId)];
    if (role !== "founder") {
      const ownedCond = eq(hubItems.ownerUserId, actorUserId);
      if (role === "team_lead") {
        const leadDepts = await permissionService(db).getTeamLeadDepartments(companyId, actorUserId);
        const scopeCond = leadDepts.length > 0 ? inArray(hubItems.scopeKey, leadDepts) : undefined;
        conds.push(scopeCond ? or(ownedCond, scopeCond)! : ownedCond);
      } else {
        // team_member (and any unknown role) → owned only.
        conds.push(ownedCond);
      }
    }
    return conds;
  }

  // RBAC-scoped, hot-set (open by default), per-principal-state-joined query.
  async function query(
    companyId: string,
    opts: {
      actorUserId: string;
      role?: UserRole;
      lane?: HubLane;
      status?: HubItemStatus;
      includeDismissed?: boolean;
      includeSnoozed?: boolean;
      q?: string;
      cursor?: string;
      groupMode?: HubGroupMode;
      limit?: number;
    },
  ): Promise<HubListResponse> {
    const { actorUserId } = opts;
    // Resolve the effective role if not supplied by the caller (route may pass it).
    const role = opts.role ?? (await permissionService(db).getEffectiveRole(companyId, actorUserId));

    const conds = await visibilityConds(companyId, actorUserId, role);

    // Hot set: open items only by default (uses hub_items_open_idx).
    conds.push(eq(hubItems.status, opts.status ?? "open"));

    // Lane filter (derived from semanticType — no lane column).
    if (opts.lane) {
      const types = semanticTypesForLane(opts.lane);
      conds.push(inArray(hubItems.semanticType, types));
    }
    if (!opts.includeDismissed) {
      conds.push(isNull(hubItemUserState.dismissedAt));
    }
    if (!opts.includeSnoozed) {
      const now = new Date();
      conds.push(or(isNull(hubItemUserState.snoozedUntil), lte(hubItemUserState.snoozedUntil, now))!);
    }
    if (opts.q) {
      const pattern = likePattern(opts.q);
      conds.push(
        or(
          sql`lower(${hubItems.title}) like ${pattern} escape '\\'`,
          sql`lower(${hubItems.summary}) like ${pattern} escape '\\'`,
          sql`lower(${hubItems.sourceType}) like ${pattern} escape '\\'`,
          sql`lower(${hubItems.scopeKey}) like ${pattern} escape '\\'`,
          sql`lower(${hubItems.semanticType}) like ${pattern} escape '\\'`,
        )!,
      );
    }
    if (opts.cursor) {
      const cursor = decodeCursor(opts.cursor);
      conds.push(
        or(
          lt(hubItems.createdAt, cursor.createdAt),
          and(eq(hubItems.createdAt, cursor.createdAt), lt(hubItems.id, cursor.id)),
        )!,
      );
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);
    const groupMode = opts.groupMode ?? "auto";

    const rows = await db
      .select({
        item: hubItems,
        readAt: hubItemUserState.readAt,
        snoozedUntil: hubItemUserState.snoozedUntil,
        dismissedAt: hubItemUserState.dismissedAt,
      })
      .from(hubItems)
      .leftJoin(
        hubItemUserState,
        and(
          eq(hubItemUserState.hubItemId, hubItems.id),
          eq(hubItemUserState.principalType, "user"),
          eq(hubItemUserState.principalId, actorUserId),
        ),
      )
      .where(and(...conds))
      // Stable order: createdAt is not unique, so add id as a deterministic
      // tiebreaker before W1b builds ordered lists / pagination (P2-6).
      .orderBy(sql`${hubItems.createdAt} DESC, ${hubItems.id} DESC`)
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const nextCursor = rows.length > limit && pageRows.length > 0
      ? encodeCursor(pageRows[pageRows.length - 1]!.item)
      : null;

    const items = pageRows
      .map((r) => toListRow(r.item, {
        readAt: r.readAt,
        snoozedUntil: r.snoozedUntil,
        dismissedAt: r.dismissedAt,
      }, groupMode));

    return { items, nextCursor, totalKnown: null };
  }

  async function getVisible(
    companyId: string,
    opts: {
      hubItemId: string;
      actorUserId: string;
      role?: UserRole;
      status?: HubItemStatus | "any";
    },
  ) {
    const role = opts.role ?? (await permissionService(db).getEffectiveRole(companyId, opts.actorUserId));
    const conds = await visibilityConds(companyId, opts.actorUserId, role);
    conds.push(eq(hubItems.id, opts.hubItemId));
    if (opts.status !== "any") {
      conds.push(eq(hubItems.status, opts.status ?? "open"));
    }
    return db
      .select({
        item: hubItems,
        readAt: hubItemUserState.readAt,
        snoozedUntil: hubItemUserState.snoozedUntil,
        dismissedAt: hubItemUserState.dismissedAt,
      })
      .from(hubItems)
      .leftJoin(
        hubItemUserState,
        and(
          eq(hubItemUserState.hubItemId, hubItems.id),
          eq(hubItemUserState.principalType, "user"),
          eq(hubItemUserState.principalId, opts.actorUserId),
        ),
      )
      .where(and(...conds))
      .limit(1)
      .then((r) => {
        const row = r[0];
        return row ? toListRow(row.item, row) : null;
      });
  }

  async function getVisibleBySource(
    companyId: string,
    opts: {
      sourceType: string;
      sourceId: string;
      actorUserId: string;
      role?: UserRole;
      status?: HubItemStatus | "any";
    },
  ) {
    const role = opts.role ?? (await permissionService(db).getEffectiveRole(companyId, opts.actorUserId));
    const conds = await visibilityConds(companyId, opts.actorUserId, role);
    conds.push(eq(hubItems.sourceType, opts.sourceType));
    conds.push(eq(hubItems.sourceId, opts.sourceId));
    if (opts.status !== "any") {
      conds.push(eq(hubItems.status, opts.status ?? "open"));
    }
    return db
      .select({
        item: hubItems,
        readAt: hubItemUserState.readAt,
        snoozedUntil: hubItemUserState.snoozedUntil,
        dismissedAt: hubItemUserState.dismissedAt,
      })
      .from(hubItems)
      .leftJoin(
        hubItemUserState,
        and(
          eq(hubItemUserState.hubItemId, hubItems.id),
          eq(hubItemUserState.principalType, "user"),
          eq(hubItemUserState.principalId, opts.actorUserId),
        ),
      )
      .where(and(...conds))
      .limit(1)
      .then((r) => {
        const row = r[0];
        return row ? toListRow(row.item, row) : null;
      });
  }

  async function applyPersonalState(args: {
    companyId: string;
    hubItemId: string;
    actorUserId: string;
    role?: UserRole;
    state: HubUserStateInput;
  }) {
    const visibleItem = await getVisible(args.companyId, {
      hubItemId: args.hubItemId,
      actorUserId: args.actorUserId,
      role: args.role,
      status: "any",
    });
    if (!visibleItem) throw notFound("Hub item not found");

    const now = new Date();
    const patch =
      args.state.kind === "read"
        ? { readAt: now }
        : args.state.kind === "unread"
          ? { readAt: null }
          : args.state.kind === "snooze"
            ? { snoozedUntil: new Date(args.state.until) }
            : args.state.kind === "unsnooze"
              ? { snoozedUntil: null }
              : args.state.kind === "dismiss"
                ? { dismissedAt: now }
                : { dismissedAt: null };

    const [row] = await db
      .insert(hubItemUserState)
      .values({
        companyId: args.companyId,
        hubItemId: args.hubItemId,
        principalType: "user",
        principalId: args.actorUserId,
        ...patch,
      })
      .onConflictDoUpdate({
        target: [
          hubItemUserState.hubItemId,
          hubItemUserState.principalType,
          hubItemUserState.principalId,
        ],
        set: { ...patch, updatedAt: now },
      })
      .returning();

    if (visibleItem.userId === args.actorUserId) {
      const legacyPatch =
        args.state.kind === "read"
          ? { readAt: now }
          : args.state.kind === "unread"
            ? { readAt: null }
            : args.state.kind === "dismiss"
              ? { dismissedAt: now }
              : args.state.kind === "undismiss"
                ? { dismissedAt: null }
                : null;
      if (legacyPatch) {
        await db
          .update(hubItems)
          .set(legacyPatch)
          .where(
            and(
              eq(hubItems.id, args.hubItemId),
              eq(hubItems.companyId, args.companyId),
              eq(hubItems.userId, args.actorUserId),
            ),
          );
      }
    }

    await invalidateCounterSnapshotsForUser(args.companyId, args.actorUserId);
    publishHubCountsChanged(args.companyId, "personal_state_changed");
    return row;
  }

  async function getAudit(args: {
    companyId: string;
    hubItemId: string;
    actorUserId: string;
    role?: UserRole;
  }) {
    const visibleItem = await getVisible(args.companyId, {
      hubItemId: args.hubItemId,
      actorUserId: args.actorUserId,
      role: args.role,
      status: "any",
    });
    if (!visibleItem) throw notFound("Hub item not found");

    return db
      .select({
        id: hubAudit.id,
        companyId: hubAudit.companyId,
        hubItemId: hubAudit.hubItemId,
        actorType: hubAudit.actorType,
        actorId: hubAudit.actorId,
        action: hubAudit.action,
        authorityBasis: hubAudit.authorityBasis,
        reason: hubAudit.reason,
        undoDeadline: hubAudit.undoDeadline,
        createdAt: hubAudit.createdAt,
      })
      .from(hubAudit)
      .where(and(eq(hubAudit.companyId, args.companyId), eq(hubAudit.hubItemId, args.hubItemId)))
      .orderBy(desc(hubAudit.createdAt));
  }

  // Mirror-model source-class predicate (R3 + H1): does this semantic type
  // mirror a backing source decision (approval / join request / runtime prompt)?
  function isSourceMirroredHubType(semanticType: string | null): boolean {
    return semanticType != null && (HUB_SOURCE_MIRRORED_TYPES as readonly string[]).includes(semanticType);
  }

  // Returns true when the mirrored item's source is STILL PENDING (→ block
  // resolve/archive). SOURCE_RECONCILERS is referenced at call time (assigned
  // before any exported method runs), mirroring how reconcile() consumes it.
  async function isMirroredSourcePending(
    companyId: string,
    semanticType: string,
    sourceType: string | null,
    sourceId: string,
  ): Promise<boolean> {
    // agent_runtime_decision: bespoke check on the answerable window. Do NOT use
    // the reconciler's `terminal` flag — answered/relay_failed stay clearable.
    if (semanticType === "agent_runtime_decision") {
      const row = await db
        .select({ status: agentRuntimeDecisions.status })
        .from(agentRuntimeDecisions)
        .where(
          and(eq(agentRuntimeDecisions.id, sourceId), eq(agentRuntimeDecisions.companyId, companyId)),
        )
        .limit(1)
        .then((r) => r[0] ?? null);
      if (!row) return false; // gone source → fail-open (allow clear)
      return RUNTIME_DECISION_ANSWERABLE_STATUSES.has(row.status);
    }
    // approval_request / join_request: block while the source reconciler reports
    // non-terminal. Missing reconciler or gone source → fail-open (allow).
    const reconciler = sourceType ? SOURCE_RECONCILERS[sourceType] : undefined;
    if (!reconciler) return false;
    const snapshot = await reconciler(companyId, sourceId);
    return snapshot.terminal === false;
  }

  // Action with optimistic concurrency + audit-before-side-effect (§5/§6/§10).
  async function recordLifecycleAction(args: {
    companyId: string;
    hubItemId: string;
    action: "resolve" | "archive" | "claim" | "release";
    expectedVersion: number;
    actorType: "user" | "agent" | "system" | "autonomy";
    actorId: string;
    actorIsFounder: boolean;
    authorityBasis?: string;
    autonomyLevel?: string;
    reason?: string;
    idempotencyKey?: string;
    decisionContext?: unknown;
    sideEffect?: () => Promise<{ irreversibleSideEffects?: unknown; relayResult?: unknown }>;
  }) {
    const current = await db
      .select()
      .from(hubItems)
      .where(and(eq(hubItems.id, args.hubItemId), eq(hubItems.companyId, args.companyId)))
      .limit(1)
      .then((r) => r[0]);
    if (!current) throw notFound("Hub item not found");
    if (args.idempotencyKey) {
      const dup = await db
        .select({
          id: hubAudit.id,
          undoDeadline: hubAudit.undoDeadline,
        })
        .from(hubAudit)
        .where(
          and(
            eq(hubAudit.companyId, args.companyId),
            eq(hubAudit.idempotencyKey, args.idempotencyKey),
          ),
        )
        .limit(1)
        .then((r) => r[0]);
      if (dup) {
        return { item: decorateItem(current), auditId: dup.id, undoDeadline: dup.undoDeadline };
      }
    }
    if (current.status !== "open") {
      throw conflict("This item is no longer open. Reload and retry.", {
        currentVersion: current.version,
      });
    }

    // Mirror-model guard (R3 + H1): resolve/archive on a source-backed decision
    // item whose source is still pending is a MIRROR violation — it hides a live,
    // undecided decision from every board user with zero effect on the source.
    // Reject; the founder must decide at the source (approve/reject the approval,
    // answer the runtime prompt) or use personal Dismiss (per-user, safety-netted).
    // TWO source classes, DIFFERENT pending checks (P1-3):
    //  - approval_request / join_request → block while the source reconciler
    //    reports non-terminal (still pending). A terminal or gone source →
    //    allow (fail-open; QA seed rows + already-decided rows stay cleanable).
    //  - agent_runtime_decision → block ONLY while status ∈ {created, shown}.
    //    answered/relay_failed rows MUST stay clearable (they're the dead-run
    //    stall rows Task 5 sweeps) — do NOT use the reconciler's generic
    //    `terminal` flag here, which marks them non-terminal and would collide.
    // dismiss/snooze (personal state) and claim/release never reach this guard.
    if (
      (args.action === "resolve" || args.action === "archive") &&
      isSourceMirroredHubType(current.semanticType) &&
      current.semanticType &&
      current.sourceId
    ) {
      const stillPending = await isMirroredSourcePending(
        current.companyId,
        current.semanticType,
        current.sourceType,
        current.sourceId,
      );
      if (stillPending) {
        throw conflict(
          "Decide it at the source — approve/reject the approval or answer the runtime prompt (or Dismiss it for yourself). It cannot be resolved or archived while the decision is still pending.",
          {
            sourceStillPending: true,
            sourceType: current.sourceType,
            sourceId: current.sourceId,
          },
        );
      }
    }

    if (
      (args.action === "resolve" || args.action === "archive") &&
      authorityForSemanticType(current.semanticType as HubSemanticType) === "founder" &&
      !args.actorIsFounder
    ) {
      throw forbidden("This decision requires founder/board authority — route or escalate it.");
    }
    if (args.action === "claim") {
      if (!args.actorIsFounder) throw forbidden("Claiming board-pool work requires board authority.");
      if (current.ownerPool !== "board") throw conflict("Only board-pool items can be claimed.");
      if (current.claimedByUserId) {
        throw conflict("This item is already claimed. Reload and retry.", {
          currentVersion: current.version,
        });
      }
    }
    if (args.action === "release") {
      if (!current.claimedByUserId) throw conflict("This item is not claimed.");
      if (current.claimedByUserId !== args.actorId && !args.actorIsFounder) {
        throw forbidden("Only the claimant or founder can release this item.");
      }
    }

    const undoDeadline = new Date(Date.now() + HUB_UNDO_WINDOW_MS);
    const committed = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      if (args.idempotencyKey) {
        const dup = await tx
          .select({
            id: hubAudit.id,
            undoDeadline: hubAudit.undoDeadline,
          })
          .from(hubAudit)
          .where(
            and(
              eq(hubAudit.companyId, args.companyId),
              eq(hubAudit.idempotencyKey, args.idempotencyKey),
            ),
          )
          .limit(1)
          .then((r) => r[0]);
        if (dup) {
          return { item: decorateItem(current), auditId: dup.id, undoDeadline: dup.undoDeadline, replayed: true as const };
        }
      }

      const now = new Date();
      const patch =
        args.action === "resolve"
          ? { status: "resolved" as const, resolvedAt: now, version: args.expectedVersion + 1 }
          : args.action === "archive"
            ? { status: "archived" as const, archivedAt: now, version: args.expectedVersion + 1 }
            : args.action === "claim"
              ? { claimedByUserId: args.actorId, claimedAt: now, version: args.expectedVersion + 1 }
              : { claimedByUserId: null, claimedAt: null, version: args.expectedVersion + 1 };

      const updated = await tx
        .update(hubItems)
        .set(patch)
        .where(
          and(
            eq(hubItems.id, args.hubItemId),
            eq(hubItems.companyId, args.companyId),
            eq(hubItems.version, args.expectedVersion),
          ),
        )
        .returning()
        .then((r) => r[0] ?? null);
      if (!updated) {
        throw conflict("This item was changed by someone else. Reload and retry.", {
          currentVersion: current.version,
        });
      }

      const audit = await tx
        .insert(hubAudit)
        .values({
          companyId: args.companyId,
          hubItemId: args.hubItemId,
          actorType: args.actorType,
          actorId: args.actorId,
          action: args.action,
          authorityBasis: args.authorityBasis ?? null,
          autonomyLevel: args.autonomyLevel ?? null,
          reason: args.reason ?? null,
          idempotencyKey: args.idempotencyKey ?? null,
          decisionContext: args.decisionContext ?? null,
          priorState: hubOwnedPriorState(current),
          undoDeadline,
        })
        .returning({
          id: hubAudit.id,
          undoDeadline: hubAudit.undoDeadline,
        })
        .then((r) => r[0]);

      await tx.insert(activityLog).values({
        companyId: args.companyId,
        actorType: args.actorType,
        actorId: args.actorId,
        action: `hub_item.${args.action}`,
        entityType: "hub_item",
        entityId: args.hubItemId,
        details: {
          action: args.action,
          reason: args.reason ?? null,
        },
      });

      return { item: decorateItem(updated), auditId: audit.id, undoDeadline: audit.undoDeadline, replayed: false as const };
    });

    if (!committed.replayed && args.sideEffect) await args.sideEffect();
    if (!committed.replayed) {
      await invalidateCounterSnapshotsForCompany(args.companyId);
      publishHubItemChanged(
        committed.item,
        args.action === "resolve"
          ? "resolved"
          : args.action === "archive"
            ? "archived"
            : "state_changed",
      );
      publishHubCountsChanged(args.companyId, "item_changed");
    }
    return {
      item: committed.item,
      auditId: committed.auditId,
      undoDeadline: committed.undoDeadline,
    };
  }

  async function undoAction(args: {
    companyId: string;
    hubItemId: string;
    auditId: string;
    expectedVersion: number;
    actorType: "user" | "agent" | "system";
    actorId: string;
  }) {
    const audit = await db
      .select()
      .from(hubAudit)
      .where(
        and(
          eq(hubAudit.id, args.auditId),
          eq(hubAudit.companyId, args.companyId),
          eq(hubAudit.hubItemId, args.hubItemId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!audit) throw notFound("Hub audit row not found");
    if (!audit.undoDeadline || audit.undoDeadline.getTime() < Date.now()) {
      throw conflict("Undo window has expired.");
    }
    if (audit.irreversibleSideEffects != null || audit.relayResult != null) {
      throw conflict("This action cannot be undone.");
    }

    const current = await db
      .select()
      .from(hubItems)
      .where(and(eq(hubItems.id, args.hubItemId), eq(hubItems.companyId, args.companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!current) throw notFound("Hub item not found");
    if (current.version !== args.expectedVersion) {
      throw conflict("This item was changed by someone else. Reload and retry.", {
        currentVersion: current.version,
      });
    }

    const prior = (audit.priorState ?? {}) as Record<string, unknown>;
    const result = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const updated = await tx
        .update(hubItems)
        .set({
          status: String(prior.status ?? current.status),
          version: typeof prior.version === "number" ? prior.version : current.version,
          resolvedAt: jsonDate(prior.resolvedAt),
          archivedAt: jsonDate(prior.archivedAt),
          claimedByUserId: typeof prior.claimedByUserId === "string" ? prior.claimedByUserId : null,
          claimedAt: jsonDate(prior.claimedAt),
        })
        .where(
          and(
            eq(hubItems.id, args.hubItemId),
            eq(hubItems.companyId, args.companyId),
            eq(hubItems.version, args.expectedVersion),
          ),
        )
        .returning()
        .then((r) => r[0] ?? null);
      if (!updated) {
        throw conflict("This item was changed by someone else. Reload and retry.", {
          currentVersion: current.version,
        });
      }

      const undoAudit = await tx
        .insert(hubAudit)
        .values({
          companyId: args.companyId,
          hubItemId: args.hubItemId,
          actorType: args.actorType,
          actorId: args.actorId,
          action: "undo",
          authorityBasis: "undo_window",
          priorState: hubOwnedPriorState(current),
        })
        .returning({ id: hubAudit.id })
        .then((r) => r[0]);

      await tx.insert(activityLog).values({
        companyId: args.companyId,
        actorType: args.actorType,
        actorId: args.actorId,
        action: "hub_item.undo",
        entityType: "hub_item",
        entityId: args.hubItemId,
        details: {
          auditId: args.auditId,
        },
      });

      return { item: decorateItem(updated), auditId: undoAudit.id };
    });
    await invalidateCounterSnapshotsForCompany(args.companyId);
    return result;
  }

  async function bulkAction(args: {
    companyId: string;
    actorUserId: string;
    actorIsFounder: boolean;
    role?: UserRole;
    actorType: "user" | "agent" | "system" | "autonomy";
    bulkId?: string;
    items: Array<{
      id: string;
      action: "resolve" | "archive" | "dismiss" | "snooze" | "claim" | "release";
      expectedVersion?: number;
      until?: string;
      idempotencyKey?: string;
      reason?: string;
    }>;
  }) {
    const bulkId = args.bulkId ?? randomUUID();
    const results = [];

    for (const item of args.items) {
      try {
        if (
          item.action === "resolve" ||
          item.action === "archive" ||
          item.action === "claim" ||
          item.action === "release"
        ) {
          if (item.expectedVersion == null) {
            throw new HttpError(400, "expectedVersion is required for shared lifecycle actions");
          }
          const result = await recordLifecycleAction({
            companyId: args.companyId,
            hubItemId: item.id,
            action: item.action,
            expectedVersion: item.expectedVersion,
            actorType: args.actorType,
            actorId: args.actorUserId,
            actorIsFounder: args.actorIsFounder,
            authorityBasis: args.actorIsFounder ? "founder" : "owner",
            reason: item.reason,
            idempotencyKey: item.idempotencyKey,
          });
          results.push({
            id: item.id,
            status: "success" as const,
            item: result.item,
            auditId: result.auditId,
            undoDeadline: result.undoDeadline,
          });
          continue;
        }

        const state =
          item.action === "dismiss"
            ? { kind: "dismiss" as const }
            : { kind: "snooze" as const, until: item.until! };
        const result = await applyPersonalState({
          companyId: args.companyId,
          hubItemId: item.id,
          actorUserId: args.actorUserId,
          role: args.role,
          state,
        });
        results.push({
          id: item.id,
          status: "success" as const,
          state: result,
        });
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : "Bulk action failed";
        results.push({
          id: item.id,
          status: "failed" as const,
          error: { status, message },
        });
      }
    }

    const summary = results.reduce(
      (acc, result) => {
        if (result.status === "success") acc.succeeded += 1;
        else if (result.status === "failed") acc.failed += 1;
        else acc.skipped += 1;
        return acc;
      },
      { succeeded: 0, failed: 0, skipped: 0 },
    );

    return { bulkId, summary, results };
  }

  // NOTE: the former `recordAndAct` wrapper was an unreachable duplicate of
  // `recordLifecycleAction` (its body `return`ed after delegating, leaving ~62
  // dead lines) — deleted 2026-07-04 (R3). All production callers and tests use
  // `recordLifecycleAction` directly.

  // ── Reconciliation sweeper (sources = truth) ────────────────────────────────

  // A per-source-type reconciler reports, for a given hub item, whether its
  // backing source is terminal/gone (→ close) and the source's current
  // denormalized snapshot (summary + permission revision) for drift healing.
  interface SourceSnapshot {
    terminal: boolean; // source row is gone OR in a terminal state → close the hub item
    title?: string | null; // current denormalized title when the source owns it
    summary: string | null; // current denormalized summary (PRE-redaction)
    ownerUserId?: string | null; // current resolved human owner when the source owns it
    ownerPool?: HubOwnerPool | null; // current pool visibility when the source owns it
    scopeKey?: string | null; // current source RBAC scope when the source owns it
    permissionRevision: string | null; // monotonic-ish source revision for drift detection
  }
  type SourceReconciler = (companyId: string, sourceId: string) => Promise<SourceSnapshot>;

  // approvals: pending/revision_requested = open; anything else (or a missing row) = terminal.
  const reconcileApproval: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select({ status: approvals.status, decisionNote: approvals.decisionNote, updatedAt: approvals.updatedAt })
      .from(approvals)
      .where(and(eq(approvals.id, sourceId), eq(approvals.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    return {
      terminal: !APPROVAL_OPEN_STATUSES.has(row.status),
      summary: row.decisionNote ?? null,
      permissionRevision: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  };

  // heartbeat_runs: a run that is queued / scheduled_retry / running is still
  // live (non-terminal). A finished/dead run — or a missing row — is terminal.
  // The live set is derived from the shared HEARTBEAT_RUN_STATUSES (module top).
  const reconcileHeartbeatRun: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select({
        agentId: heartbeatRuns.agentId,
        createdAt: heartbeatRuns.createdAt,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, sourceId), eq(heartbeatRuns.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    const latestRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, row.agentId),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((r) => r[0] ?? null);
    const isSuperseded = latestRun != null && latestRun.id !== sourceId;
    return {
      terminal: !HEARTBEAT_ACTIONABLE_STATUSES.has(row.status) || isSuperseded,
      summary: row.error ?? null,
      permissionRevision: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  };

  const reconcileJoinRequest: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select({
        requestType: joinRequests.requestType,
        status: joinRequests.status,
        agentName: joinRequests.agentName,
        requestEmailSnapshot: joinRequests.requestEmailSnapshot,
        adapterType: joinRequests.adapterType,
        updatedAt: joinRequests.updatedAt,
      })
      .from(joinRequests)
      .where(and(eq(joinRequests.id, sourceId), eq(joinRequests.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    const subject =
      row.requestType === "agent"
        ? row.agentName ?? `${row.adapterType ?? "Agent"} request`
        : row.requestEmailSnapshot ?? "Human join request";
    return {
      terminal: row.status !== "pending_approval",
      summary: `${subject} (${row.requestType.replace(/_/g, " ")})`,
      permissionRevision: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  };

  const reconcileDiscussion: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select({
        title: discussions.title,
        ownerUserId: discussions.ownerUserId,
        scopeType: discussions.scopeType,
        scopeId: discussions.scopeId,
        pendingItemCount: discussions.pendingItemCount,
        updatedAt: discussions.updatedAt,
      })
      .from(discussions)
      .where(and(eq(discussions.id, sourceId), eq(discussions.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    const count = row.pendingItemCount;
    const founder = row.ownerUserId ? null : await orgHierarchyService(db).getFounderUserId(companyId);
    const ownerUserId = row.ownerUserId ?? founder ?? null;
    const title = row.title?.trim() || "Discussion";
    return {
      terminal: count <= 0,
      title: `Review ${count} pending ${count === 1 ? "item" : "items"} in ${title}`,
      summary: `${count} extracted ${count === 1 ? "item needs" : "items need"} review.`,
      ownerUserId,
      scopeKey: row.scopeType && row.scopeId ? row.scopeId : null,
      permissionRevision: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  };

  // discussion_entry backs the extraction_failed item (Task 10, D3). It is
  // terminal (→ close) once the entry recovers — extractionStatus is no longer
  // 'failed' (reprocess resets to 'pending'; success sets 'completed') — or the
  // entry is gone. Joined to discussions for the company scope (the entry table
  // has no companyId column). Fail-open on a missing row (safe: close).
  const reconcileDiscussionEntry: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select({
        extractionStatus: discussionEntries.extractionStatus,
        // discussion_entries has no updatedAt column — use createdAt as the
        // (stable) permission revision anchor.
        createdAt: discussionEntries.createdAt,
      })
      .from(discussionEntries)
      .innerJoin(discussions, eq(discussionEntries.discussionId, discussions.id))
      .where(and(eq(discussionEntries.id, sourceId), eq(discussions.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    return {
      terminal: row.extractionStatus !== "failed",
      summary: null,
      permissionRevision: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    };
  };

  const reconcileSuggestion: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select({
        status: suggestions.status,
        evidence: suggestions.evidence,
        updatedAt: suggestions.updatedAt,
      })
      .from(suggestions)
      .where(and(eq(suggestions.id, sourceId), eq(suggestions.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    return {
      terminal: row.status !== "pending",
      summary: row.evidence ?? null,
      permissionRevision: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  };

  const reconcileIssue: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select({
        title: issues.title,
        status: issues.status,
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(eq(issues.id, sourceId), eq(issues.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    const updatedAt = row.updatedAt ? new Date(row.updatedAt) : null;
    const isOldInboxStale =
      STALE_WORK_STATUSES.has(row.status) &&
      updatedAt != null &&
      Date.now() - updatedAt.getTime() > STALE_WORK_THRESHOLD_MS;
    const founder = row.assigneeUserId ? null : await orgHierarchyService(db).getFounderUserId(companyId);
    const ownerUserId = row.assigneeUserId ?? founder ?? null;
    return {
      terminal: !isOldInboxStale,
      title: `Stale task: ${row.title}`,
      summary: "No recent human or crew progress.",
      ownerUserId,
      ownerPool: row.assigneeUserId ? null : "board",
      permissionRevision: updatedAt ? updatedAt.toISOString() : null,
    };
  };

  const reconcileRuntimeDecision: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select()
      .from(agentRuntimeDecisions)
      .where(and(eq(agentRuntimeDecisions.id, sourceId), eq(agentRuntimeDecisions.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    return runtimeDecisionSourceSnapshot(row);
  };

  const reconcileWorkQuestion: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select()
      .from(workQuestions)
      .where(and(eq(workQuestions.id, sourceId), eq(workQuestions.companyId, companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return { terminal: true, summary: null, permissionRevision: null };
    return {
      terminal: row.status !== "open",
      title: row.title,
      summary: row.question,
      ownerUserId: row.currentRecipientUserId,
      permissionRevision: `${row.version}:${new Date(row.updatedAt).toISOString()}`,
    };
  };

  // company_budget (H3): the budget_alert item's sourceId IS the companyId. The
  // producer only re-fires while utilization stays >= 80%, so nothing ever closes
  // the item when the budget is cleared/raised, spend resets on month rollover, or
  // utilization simply drops — and the last-emitted "% used" freezes stale. This
  // reconciler recomputes month-to-date utilization the SAME way the producer does
  // (spend since the first of the current month / budgetMonthlyCents) and:
  //   - terminal (close) when the company is gone, budget <= 0 (unset/cleared), or
  //     utilization < 80% (symmetric with the >= 80% producer threshold; month
  //     rollover closes naturally since cost_events spend resets).
  //   - otherwise NON-terminal with summary = formatBudgetAlertSummary(...) so the
  //     generic heal path refreshes a stale % IN PLACE. Because the producer and
  //     this reconciler share that formatter, a steady-state summary is byte-
  //     identical → the change-gated heal is a no-op (no write, no version bump).
  // permissionRevision = companies.updatedAt (matches the producer's
  // sourcePermissionRevision) so the strictly-newer revision compare only writes
  // on real budget edits — returning now() here would force a write every sweep.
  const reconcileCompanyBudget: SourceReconciler = async (companyId, sourceId) => {
    const company = await db
      .select({
        budgetMonthlyCents: companies.budgetMonthlyCents,
        updatedAt: companies.updatedAt,
      })
      .from(companies)
      .where(eq(companies.id, sourceId))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!company || company.budgetMonthlyCents <= 0) {
      return { terminal: true, summary: null, permissionRevision: null };
    }
    const permissionRevision = company.updatedAt ? new Date(company.updatedAt).toISOString() : null;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [{ monthSpend }] = await db
      .select({ monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart)));
    const monthSpendCents = Number(monthSpend ?? 0);
    const monthUtilizationPercent = (monthSpendCents / company.budgetMonthlyCents) * 100;
    if (monthUtilizationPercent < BUDGET_WARNING_PERCENT) {
      return { terminal: true, summary: null, permissionRevision };
    }
    return {
      terminal: false,
      summary: formatBudgetAlertSummary(monthSpendCents, company.budgetMonthlyCents),
      permissionRevision,
    };
  };

  // memory (memory_review, Mem T4): ONE hub row per company — the sourceId IS
  // the companyId (no parsing). Recompute the total founder-gated pending memory
  // across ALL scopes with the SAME predicate the emit uses (memory-write.ts
  // countPendingMemory) so emit-count and reconcile-count never disagree:
  //   status = 'pending' AND source <> 'founder' AND (layer IS NULL OR layer <> 'working').
  // The layer column is NULLABLE — `ne(layer,'working')` alone silently drops
  // NULL-layer rows and undercounts, so the or(isNull(...)) form is REQUIRED.
  // Terminal (close) once zero remain; otherwise the title heals in place as the
  // count changes. permissionRevision is null (the aggregate has no single source
  // row): the title heal is revision-independent, and a null revision means the
  // revision-drift heal is a no-op — so there is no per-sweep write churn.
  const reconcileMemoryReview: SourceReconciler = async (companyId, sourceId) => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.companyId, sourceId),
          eq(memoryItems.status, "pending"),
          ne(memoryItems.source, "founder"),
          or(isNull(memoryItems.layer), ne(memoryItems.layer, "working")),
        ),
      );
    const count = Number(row?.count ?? 0);
    const founder = await orgHierarchyService(db).getFounderUserId(companyId);
    return {
      terminal: count <= 0,
      title: `Review ${count} memory ${count === 1 ? "item" : "items"}`,
      summary: `${count} memory ${count === 1 ? "item is" : "items are"} ready for your approval.`,
      ownerUserId: founder,
      permissionRevision: null,
    };
  };

  const SOURCE_RECONCILERS: Record<string, SourceReconciler> = {
    approval: reconcileApproval,
    memory: reconcileMemoryReview,
    heartbeat_run: reconcileHeartbeatRun,
    runtime_decision: reconcileRuntimeDecision,
    work_question: reconcileWorkQuestion,
    join_request: reconcileJoinRequest,
    discussion: reconcileDiscussion,
    discussion_entry: reconcileDiscussionEntry,
    suggestion: reconcileSuggestion,
    issue: reconcileIssue,
    company_budget: reconcileCompanyBudget,
  };

  // Sweep open hub items of `sourceType`: close terminal/gone-source items via the
  // SAME version-guarded path (system audit row) so a concurrent user action can't
  // lost-update; heal redacted-summary / sourcePermissionRevision drift (§18).
  // Sources are truth — this is the safety net for missed same-tx emits.
  async function reconcile(
    companyId: string,
    opts: { sourceType: string; sourceId?: string },
  ): Promise<{ healed: number; closed: number; refreshed: number }> {
    const reconciler = SOURCE_RECONCILERS[opts.sourceType];
    if (!reconciler) {
      throw unprocessable(`No reconciler registered for source type "${opts.sourceType}"`);
    }

    const semanticType =
      opts.sourceType === "issue"
        ? "stale_work"
        : opts.sourceType === "discussion"
          ? "discussion_pending"
          // The expiry path emits an `agent_error` follow-up with the SAME
          // sourceType/sourceId as the waiting-lane item (BUG-2, D105/D106
          // amendment). Scope the sweep to the decision item's semanticType so
          // it never instantly archives that follow-up.
          : opts.sourceType === "runtime_decision"
            ? "agent_runtime_decision"
            : opts.sourceType === "work_question"
              ? "work_question"
            // company_budget carries exactly one semanticType (budget_alert);
            // scope for symmetry with the other multi-meaning sourceTypes (H3).
            : opts.sourceType === "company_budget"
              ? "budget_alert"
              // discussion_entry backs exactly the extraction_failed item
              // (Task 10, D3); scope so the sweep only closes that row.
              : opts.sourceType === "discussion_entry"
                ? "extraction_failed"
                // memory carries exactly one semanticType (memory_review, Mem
                // T4); scope for symmetry with the other multi-meaning sources.
                : opts.sourceType === "memory"
                  ? "memory_review"
                  : null;

    const conditions = [
      eq(hubItems.companyId, companyId),
      eq(hubItems.sourceType, opts.sourceType),
      eq(hubItems.status, "open"),
    ];
    if (semanticType) conditions.push(eq(hubItems.semanticType, semanticType));
    if (opts.sourceId) conditions.push(eq(hubItems.sourceId, opts.sourceId));

    const open = await db
      .select()
      .from(hubItems)
      .where(and(...conditions));

    let closed = 0;
    let refreshed = 0;
    const runTransaction = async <T>(fn: (tx: Db) => Promise<T>) => {
      const conn = db as Db & { transaction?: (callback: (tx: unknown) => Promise<T>) => Promise<T> };
      if (typeof conn.transaction === "function") {
        return conn.transaction(async (txRaw) => fn(txRaw as unknown as Db));
      }
      return fn(db);
    };
    for (const item of open) {
      if (!item.sourceId) continue;
      const snap = await reconciler(companyId, item.sourceId);

      if (snap.terminal) {
        // Close via the shared version-guarded transition (system actor). A
        // concurrent user action bumps the version → this UPDATE 409s; we swallow
        // it and let the next sweep reconcile (sources stay truth).
        try {
          const closedItem = await runTransaction(async (tx) =>
            applyGuardedTransition(tx, item, "archived", {
              actorType: "system",
              actorId: "reconciler",
              action: "reconcile_close",
              authorityBasis: "system_reconciliation",
              reason: `source ${opts.sourceType} is gone/terminal`,
              sourceRevision: snap.permissionRevision,
            }),
          );
          closed += 1;
          // Realtime close (BUG-2): push the archive so the item leaves the
          // open lane without a hub reload.
          publishHubItemChanged(closedItem, "archived");
        } catch (err) {
          // 409 from a concurrent action → skip; anything else rethrows.
          if (!(err instanceof Error) || (err as { status?: number }).status !== 409) throw err;
        }
        continue;
      }

      // Permission-drift healing: the source is still live but its denormalized
      // snapshot moved forward. This must be a NO-OP in steady state (no write/log
      // churn) and must NEVER clobber a meaningful emit-time summary with a null
      // source field (P1-2). Two independent, conservative heals:
      //
      //  (1) Revision: drift only when the source supplies a revision that is
      //      strictly NEWER than the stored one. Revisions are UTC ISO-8601
      //      timestamps → lexicographic compare == chronological. A null source
      //      revision, an equal revision, or a null STORED baseline (nothing to be
      //      "newer than") are all NOT drift — so items emitted without a revision
      //      are never force-refreshed every sweep.
      //  (2) Summary: heal only when the source provides a NON-null value; an
      //      empty/null source field leaves the existing summary untouched. The
      //      healed value is redacted-before-persist.
      const revisionIsNewer =
        snap.permissionRevision != null &&
        item.sourcePermissionRevision != null &&
        snap.permissionRevision > item.sourcePermissionRevision;

      const patch: {
        title?: string;
        summary?: string;
        message?: string;
        sourcePermissionRevision?: string;
        userId?: string;
        ownerUserId?: string | null;
        ownerPool?: HubOwnerPool | null;
        scopeKey?: string | null;
      } = {};
      if (snap.title != null && snap.title !== "" && snap.title !== item.title) {
        patch.title = snap.title;
      }
      if (revisionIsNewer) patch.sourcePermissionRevision = snap.permissionRevision!;
      if (snap.summary != null && snap.summary !== "") {
        const nextSummary = redactSecretsInString(snap.summary);
        if (nextSummary !== item.summary) {
          patch.summary = nextSummary;
          patch.message = nextSummary;
        }
      }
      if (snap.ownerUserId !== undefined && snap.ownerUserId !== item.ownerUserId) {
        patch.ownerUserId = snap.ownerUserId;
        if (snap.ownerUserId) patch.userId = snap.ownerUserId;
      }
      if (snap.ownerPool !== undefined && snap.ownerPool !== item.ownerPool) {
        patch.ownerPool = snap.ownerPool;
      }
      if (snap.scopeKey !== undefined && snap.scopeKey !== item.scopeKey) {
        patch.scopeKey = snap.scopeKey;
      }
      if (Object.keys(patch).length > 0) {
        await db.update(hubItems).set(patch).where(eq(hubItems.id, item.id));
        refreshed += 1;
      }
    }

    const healed = closed + refreshed;
    console.log(
      `[hub.reconcile] company=${companyId} source=${opts.sourceType} healed=${healed} (closed=${closed} refreshed=${refreshed})`,
    );
    if (healed > 0) await invalidateCounterSnapshotsForCompany(companyId);
    // ONE counts broadcast per sweep, not per closed row (badge refetch fan-in).
    if (closed > 0) publishHubCountsChanged(companyId, "item_changed");
    return { healed, closed, refreshed };
  }

  // RBAC-scoped open/unread counters for the hub badge. This is a LIVE count
  // computed off the partial `hub_items_open_idx` (open rows only) — not a
  // maintained counter table; a fully-maintained counter is a W1d optimization.
  //  - `open`   = RBAC-scoped open-item count (same scoping as `query`).
  //  - `unread` = `open` minus rows this principal has a `readAt` on (in their
  //               sparse `hub_item_user_state` row).
  // Reuses the exact RBAC scope `query` builds so the badge can never disagree
  // with the list (founder → all; team_lead → owned OR led-department; member →
  // owned only).
  async function counts(
    companyId: string,
    actorUserId: string,
    role?: UserRole,
  ): Promise<{ open: number; unread: number }> {
    const effectiveRole =
      role ?? (await permissionService(db).getEffectiveRole(companyId, actorUserId));

    const conds = [eq(hubItems.companyId, companyId), eq(hubItems.status, "open")];

    if (effectiveRole !== "founder") {
      const ownedCond = eq(hubItems.ownerUserId, actorUserId);
      if (effectiveRole === "team_lead") {
        const leadDepts = await permissionService(db).getTeamLeadDepartments(
          companyId,
          actorUserId,
        );
        const scopeCond = leadDepts.length > 0 ? inArray(hubItems.scopeKey, leadDepts) : undefined;
        conds.push(scopeCond ? or(ownedCond, scopeCond)! : ownedCond);
      } else {
        conds.push(ownedCond);
      }
    }
    const now = new Date();
    conds.push(isNull(hubItemUserState.dismissedAt));
    conds.push(or(isNull(hubItemUserState.snoozedUntil), lte(hubItemUserState.snoozedUntil, now))!);

    // Single pass: count open rows + count those WITHOUT a readAt for this
    // principal. The left-join keeps the open set as the universe (a missing
    // user-state row = unread), so `unread` ≤ `open` by construction.
    const [row] = await db
      .select({
        open: sql<number>`count(*)::int`,
        unread: sql<number>`count(*) filter (where ${hubItemUserState.readAt} is null)::int`,
      })
      .from(hubItems)
      .leftJoin(
        hubItemUserState,
        and(
          eq(hubItemUserState.hubItemId, hubItems.id),
          eq(hubItemUserState.principalType, "user"),
          eq(hubItemUserState.principalId, actorUserId),
        ),
      )
      .where(and(...conds));

    return { open: row?.open ?? 0, unread: row?.unread ?? 0 };
  }

  // Per-lane count of OPEN items this principal has personally hidden
  // (dismissed OR actively snoozed) — the inverse of the `counts` filter, which
  // subtracts exactly these rows. Powers the waiting-lane "N hidden" chip (the
  // dismiss-hole safety net now that /approvals is out of the nav). Kept as a
  // dedicated lane-scoped query rather than widening the `{open,unread}` snapshot
  // cache: the cache is company/user-global and typed `{open,unread}`, whereas
  // this is lane-scoped and personal — the cheaper, lower-risk path. Runs off the
  // same partial `hub_items_open_idx` and reuses the exact RBAC scope `counts`
  // builds, so it can never disagree with the list. Per-actor by construction
  // (hub_item_user_state keyed by principalId) → only the current user's rows.
  async function hiddenCount(
    companyId: string,
    actorUserId: string,
    lane: HubLane,
    role?: UserRole,
  ): Promise<number> {
    const effectiveRole =
      role ?? (await permissionService(db).getEffectiveRole(companyId, actorUserId));

    const conds = [eq(hubItems.companyId, companyId), eq(hubItems.status, "open")];

    if (effectiveRole !== "founder") {
      const ownedCond = eq(hubItems.ownerUserId, actorUserId);
      if (effectiveRole === "team_lead") {
        const leadDepts = await permissionService(db).getTeamLeadDepartments(
          companyId,
          actorUserId,
        );
        const scopeCond = leadDepts.length > 0 ? inArray(hubItems.scopeKey, leadDepts) : undefined;
        conds.push(scopeCond ? or(ownedCond, scopeCond)! : ownedCond);
      } else {
        conds.push(ownedCond);
      }
    }

    // Lane filter (derived from semanticType — no lane column), mirroring `query`.
    conds.push(inArray(hubItems.semanticType, semanticTypesForLane(lane)));

    // Hidden = dismissed OR still-active snooze for THIS principal. The inner-join
    // is deliberate: rows with no user-state row (or a state row that is neither
    // dismissed nor snoozed) are visible, not hidden. Use Drizzle operators (not a
    // raw `sql` Date interpolation) so the postgres driver serializes the Date —
    // `counts` does the same via `lte(snoozedUntil, now)`.
    const now = new Date();
    conds.push(
      or(
        isNotNull(hubItemUserState.dismissedAt),
        and(isNotNull(hubItemUserState.snoozedUntil), gt(hubItemUserState.snoozedUntil, now)),
      )!,
    );

    const [row] = await db
      .select({ hidden: sql<number>`count(*)::int` })
      .from(hubItems)
      .innerJoin(
        hubItemUserState,
        and(
          eq(hubItemUserState.hubItemId, hubItems.id),
          eq(hubItemUserState.principalType, "user"),
          eq(hubItemUserState.principalId, actorUserId),
        ),
      )
      .where(and(...conds));

    return row?.hidden ?? 0;
  }

  // Public surface (declared last so every const above has evaluated).
  return {
    emit,
    sourceUniqueKey,
    resolveOwner,
    query,
    getVisible,
    getVisibleBySource,
    applyPersonalState,
    getAudit,
    recordLifecycleAction,
    undoAction,
    bulkAction,
    reconcile,
    counts,
    hiddenCount,
  };
}
