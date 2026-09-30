import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Agent, Issue, LiveEvent } from "@armyofagents/shared";
import { useCompany } from "./CompanyContext";
import type { ToastInput } from "./ToastContext";
import { useToast } from "./ToastContext";
import { queryKeys } from "../lib/queryKeys";

/** WS connection lifecycle state surfaced to consumers (e.g. ThreadDetail). */
export type LiveConnectionState = "connecting" | "open" | "reconnecting" | "offline";

export interface ThreadPresenceMember {
  userId: string;
  /** epoch ms of last presence heartbeat (server clock, echoed through). */
  lastSeen: number;
  /** whether this member is currently typing. */
  typing?: boolean;
}

export interface ThreadWorkingAgent {
  agentId: string;
  name: string;
  /**
   * Humanized activity label pushed by the crew runner (e.g. "researching",
   * "writing the plan", "creating an artifact"). Absent for heartbeat-fed
   * presence and older servers — consumers fall back to "typing".
   */
  activity?: string;
}

interface LiveUpdatesContextValue {
  connectionState: LiveConnectionState;
  /** Subscribe the active WS to a thread's events (ref-counted). */
  subscribeThread: (threadId: string) => void;
  /** Unsubscribe (ref-counted; only sends unsubscribe when the last consumer leaves). */
  unsubscribeThread: (threadId: string) => void;
  /** Send a presence/typing heartbeat for a thread. */
  sendPresence: (threadId: string, opts?: { typing?: boolean }) => void;
  /** Register a callback fired whenever the WS reconnects after a drop. Returns an unsubscribe fn. */
  onReconnect: (cb: () => void) => () => void;
  /** Register a callback fired when a visible hub item changes. Returns an unsubscribe fn. */
  onHubItemChanged: (cb: (itemId: string) => void) => () => void;
  /** Latest presence roster per thread (keyed by threadId). */
  presenceByThread: Record<string, ThreadPresenceMember[]>;
  /** Latest working-agents roster per thread (keyed by threadId). */
  workingAgentsByThread: Record<string, ThreadWorkingAgent[]>;
}

const LiveUpdatesContext = createContext<LiveUpdatesContextValue | null>(null);

// Safe no-op fallback used when a component renders outside LiveUpdatesProvider
// (e.g. isolated component tests, Storybook). Live updates simply degrade to
// nothing — the page still works, it just won't receive pokes/presence.
const NOOP_LIVE_UPDATES: LiveUpdatesContextValue = {
  connectionState: "connecting",
  subscribeThread: () => {},
  unsubscribeThread: () => {},
  sendPresence: () => {},
  onReconnect: () => () => {},
  onHubItemChanged: () => () => {},
  presenceByThread: {},
  workingAgentsByThread: {},
};

/** Access the live-updates WS context (connection state, thread subscribe, presence). */
export function useLiveUpdates(): LiveUpdatesContextValue {
  return useContext(LiveUpdatesContext) ?? NOOP_LIVE_UPDATES;
}

const TOAST_COOLDOWN_WINDOW_MS = 10_000;
const TOAST_COOLDOWN_MAX = 3;
const RECONNECT_SUPPRESS_MS = 2000;

/**
 * Plan 7: map a thread.* live event to the React Query keys to invalidate
 * (refetch-on-poke). RBAC stays in REST; invalidation just triggers a refetch.
 * Returns:
 *   ["thread", companyId, threadId]   — canonical thread key (Plan 7 contract)
 *   ["threads", companyId]            — the threads list
 *   ["threads", companyId, threadId]  — the concrete detail key ThreadDetail uses
 * Empty array when the event carries no threadId (e.g. presence is handled
 * separately and never refetches).
 */
export function threadEventToInvalidations(
  event: { type: string; threadId?: string },
  companyId: string,
): Array<readonly unknown[]> {
  const threadId = event.threadId;
  if (typeof threadId !== "string" || threadId.length === 0) return [];
  return [
    ["thread", companyId, threadId],
    ["threads", companyId],
    queryKeys.threads.list(companyId),
    queryKeys.threads.detail(companyId, threadId),
    queryKeys.discussions.list(companyId),
    queryKeys.discussions.detail(companyId, threadId),
  ];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function resolveAgentName(
  queryClient: QueryClient,
  companyId: string,
  agentId: string,
): string | null {
  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  if (!agents) return null;
  const agent = agents.find((a) => a.id === agentId);
  return agent?.name ?? null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function resolveActorLabel(
  queryClient: QueryClient,
  companyId: string,
  actorType: string | null,
  actorId: string | null,
): string {
  if (actorType === "agent" && actorId) {
    return resolveAgentName(queryClient, companyId, actorId) ?? `Agent ${shortId(actorId)}`;
  }
  if (actorType === "system") return "System";
  if (actorType === "user" && actorId) {
    return "Board";
  }
  return "Someone";
}

interface IssueToastContext {
  ref: string;
  title: string | null;
  label: string;
  href: string;
}

function resolveIssueQueryRefs(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): string[] {
  const refs = new Set<string>([issueId]);
  const detailIssue = queryClient.getQueryData<Issue>(queryKeys.issues.detail(issueId));
  const listIssues = queryClient.getQueryData<Issue[]>(queryKeys.issues.list(companyId));
  const detailsIdentifier =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier);

  if (detailsIdentifier) refs.add(detailsIdentifier);

  if (detailIssue?.id) refs.add(detailIssue.id);
  if (detailIssue?.identifier) refs.add(detailIssue.identifier);

  const listIssue = listIssues?.find((issue) => {
    if (issue.id === issueId) return true;
    if (issue.identifier && issue.identifier === issueId) return true;
    if (detailsIdentifier && issue.identifier === detailsIdentifier) return true;
    return false;
  });
  if (listIssue?.id) refs.add(listIssue.id);
  if (listIssue?.identifier) refs.add(listIssue.identifier);

  return Array.from(refs);
}

function resolveIssueToastContext(
  queryClient: QueryClient,
  companyId: string,
  issueId: string,
  details: Record<string, unknown> | null,
): IssueToastContext {
  const issueRefs = resolveIssueQueryRefs(queryClient, companyId, issueId, details);
  const detailIssue = issueRefs
    .map((ref) => queryClient.getQueryData<Issue>(queryKeys.issues.detail(ref)))
    .find((issue): issue is Issue => !!issue);
  const listIssue = queryClient
    .getQueryData<Issue[]>(queryKeys.issues.list(companyId))
    ?.find((issue) => issueRefs.some((ref) => issue.id === ref || issue.identifier === ref));
  const cachedIssue = detailIssue ?? listIssue ?? null;
  const ref =
    readString(details?.identifier) ??
    readString(details?.issueIdentifier) ??
    cachedIssue?.identifier ??
    `Task ${shortId(issueId)}`;
  const title =
    readString(details?.title) ??
    readString(details?.issueTitle) ??
    cachedIssue?.title ??
    null;
  return {
    ref,
    title,
    label: title ? `${ref} - ${truncate(title, 72)}` : ref,
    href: `/issues/${cachedIssue?.identifier ?? issueId}`,
  };
}

const ISSUE_TOAST_ACTIONS = new Set(["issue.created", "issue.updated", "issue.comment_added"]);
const AGENT_TOAST_STATUSES = new Set(["running", "error"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);

function describeIssueUpdate(details: Record<string, unknown> | null): string | null {
  if (!details) return null;
  const changes: string[] = [];
  if (typeof details.status === "string") changes.push(`status -> ${details.status.replace(/_/g, " ")}`);
  if (typeof details.priority === "string") changes.push(`priority -> ${details.priority}`);
  if (typeof details.assigneeAgentId === "string" || typeof details.assigneeUserId === "string") {
    changes.push("reassigned");
  } else if (details.assigneeAgentId === null || details.assigneeUserId === null) {
    changes.push("unassigned");
  }
  if (details.reopened === true) {
    const from = readString(details.reopenedFrom);
    changes.push(from ? `reopened from ${from.replace(/_/g, " ")}` : "reopened");
  }
  if (typeof details.title === "string") changes.push("title changed");
  if (typeof details.description === "string") changes.push("description changed");
  if (changes.length > 0) return changes.join(", ");
  return null;
}

function buildActivityToast(
  queryClient: QueryClient,
  companyId: string,
  payload: Record<string, unknown>,
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);
  const action = readString(payload.action);
  const details = readRecord(payload.details);
  const actorId = readString(payload.actorId);
  const actorType = readString(payload.actorType);

  if (entityType !== "issue" || !entityId || !action || !ISSUE_TOAST_ACTIONS.has(action)) {
    return null;
  }

  const issue = resolveIssueToastContext(queryClient, companyId, entityId, details);
  const actor = resolveActorLabel(queryClient, companyId, actorType, actorId);

  if (action === "issue.created") {
    return {
      title: `${actor} created ${issue.ref}`,
      body: issue.title ? truncate(issue.title, 96) : undefined,
      tone: "success",
      action: { label: `View ${issue.ref}`, href: issue.href },
      meta: { ref: issue.ref },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  if (action === "issue.updated") {
    if (details?.reopened === true && readString(details.source) === "comment") {
      // Reopen-via-comment emits a paired comment event; show one combined toast on the comment event.
      return null;
    }
    const changeDesc = describeIssueUpdate(details);
    const body = changeDesc
      ? issue.title
        ? `${truncate(issue.title, 64)} - ${changeDesc}`
        : changeDesc
      : issue.title
        ? truncate(issue.title, 96)
        : issue.label;
    return {
      title: `${actor} updated ${issue.ref}`,
      body: truncate(body, 100),
      tone: "info",
      action: { label: `View ${issue.ref}`, href: issue.href },
      meta: { ref: issue.ref },
      dedupeKey: `activity:${action}:${entityId}`,
    };
  }

  const commentId = readString(details?.commentId);
  const bodySnippet = readString(details?.bodySnippet);
  const reopened = details?.reopened === true;
  const reopenedFrom = readString(details?.reopenedFrom);
  const reopenedLabel = reopened
    ? reopenedFrom
      ? `reopened from ${reopenedFrom.replace(/_/g, " ")}`
      : "reopened"
    : null;
  const title = reopened ? `${actor} reopened and commented on ${issue.ref}` : `${actor} commented on ${issue.ref}`;
  const body = bodySnippet
    ? reopenedLabel
      ? `${reopenedLabel} - ${bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")}`
      : bodySnippet.replace(/^#+\s*/m, "").replace(/\n/g, " ")
    : reopenedLabel
      ? issue.title
        ? `${reopenedLabel} - ${issue.title}`
        : reopenedLabel
      : issue.title ?? undefined;
  return {
    title,
    body: body ? truncate(body, 96) : undefined,
    tone: "info",
    action: { label: `View ${issue.ref}`, href: issue.href },
    meta: { ref: issue.ref },
    dedupeKey: `activity:${action}:${entityId}:${commentId ?? "na"}`,
  };
}

function buildJoinRequestToast(
  payload: Record<string, unknown>,
): ToastInput | null {
  const entityType = readString(payload.entityType);
  const action = readString(payload.action);
  const entityId = readString(payload.entityId);
  const details = readRecord(payload.details);

  if (entityType !== "join_request" || !action || !entityId) return null;
  if (action !== "join.requested" && action !== "join.request_replayed") return null;

  const requestType = readString(details?.requestType);
  const label = requestType === "agent" ? "Agent" : "Someone";

  return {
    title: `${label} wants to join`,
    body: "A new join request is waiting for approval.",
    tone: "info",
    action: { label: "View inbox", href: "/inbox/waiting" },
    dedupeKey: `join-request:${entityId}`,
  };
}

function buildAgentStatusToast(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string | null,
  queryClient: QueryClient,
  companyId: string,
): ToastInput | null {
  const agentId = readString(payload.agentId);
  const status = readString(payload.status);
  if (!agentId || !status || !AGENT_TOAST_STATUSES.has(status)) return null;

  const tone = status === "error" ? "error" : "info";
  const name = nameOf(agentId) ?? `Agent ${shortId(agentId)}`;
  const title =
    status === "running"
      ? `${name} started`
      : `${name} errored`;

  const agents = queryClient.getQueryData<Agent[]>(queryKeys.agents.list(companyId));
  const agent = agents?.find((a) => a.id === agentId);
  const body = agent?.title ?? undefined;

  return {
    title,
    body,
    tone,
    action: { label: "View agent", href: `/agents/${agentId}` },
    dedupeKey: `agent-status:${agentId}:${status}`,
  };
}

function buildRunStatusToast(
  payload: Record<string, unknown>,
  nameOf: (id: string) => string | null,
): ToastInput | null {
  const runId = readString(payload.runId);
  const agentId = readString(payload.agentId);
  const status = readString(payload.status);
  if (!runId || !agentId || !status || !TERMINAL_RUN_STATUSES.has(status)) return null;

  const error = readString(payload.error);
  const triggerDetail = readString(payload.triggerDetail);
  const name = nameOf(agentId) ?? `Agent ${shortId(agentId)}`;
  const tone = status === "succeeded" ? "success" : status === "cancelled" ? "warn" : "error";
  const statusLabel =
    status === "succeeded" ? "succeeded"
      : status === "failed" ? "failed"
        : status === "timed_out" ? "timed out"
          : "cancelled";
  const title = `${name} run ${statusLabel}`;

  let body: string | undefined;
  if (error) {
    body = truncate(error, 100);
  } else if (triggerDetail) {
    body = `Trigger: ${triggerDetail}`;
  }

  return {
    title,
    body,
    tone,
    ttlMs: status === "succeeded" ? 5000 : 7000,
    action: { label: "View run", href: `/agents/${agentId}/runs/${runId}` },
    meta: { ref: `run ${shortId(runId)}` },
    dedupeKey: `run-status:${runId}:${status}`,
  };
}

function invalidateHeartbeatQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  payload: Record<string, unknown>,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });

  const agentId = readString(payload.agentId);
  if (agentId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, agentId) });
  }

  // Broaden invalidation to issue views: a run completion typically changes
  // issue status (in_progress → in_review / done / cancelled), so the list
  // and any cached issue details need to be refreshed.  Mirrors the
  // issueRefs-loop from AoA 68f69975, adapted for AoA (no issueRefs
  // field in the live-event payload — invalidate the whole list instead).
  const status = readString(payload.status);
  if (status && TERMINAL_RUN_STATUSES.has(status)) {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    // Also invalidate any issue detail / run queries keyed by runId in case
    // the UI has the run's contextSnapshot.issueId cached.
    const runId = readString(payload.runId);
    if (runId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(runId) });
    }
  }
}

function invalidateActivityQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  companyId: string,
  payload: Record<string, unknown>,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });

  const entityType = readString(payload.entityType);
  const entityId = readString(payload.entityId);

  if (entityType === "issue") {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    if (entityId) {
      const details = readRecord(payload.details);
      const issueRefs = resolveIssueQueryRefs(queryClient, companyId, entityId, details);
      for (const ref of issueRefs) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(ref) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(ref) });
      }
    }
    return;
  }

  if (entityType === "agent") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
    if (entityId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(entityId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(companyId, entityId) });
    }
    return;
  }

  if (entityType === "project") {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(entityId) });
    return;
  }

  if (entityType === "goal") {
    queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(companyId) });
    if (entityId) queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(entityId) });
    return;
  }

  if (entityType === "approval") {
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    return;
  }

  if (entityType === "join_request") {
    queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(companyId) });
    return;
  }

  if (entityType === "cost_event") {
    queryClient.invalidateQueries({ queryKey: queryKeys.costs(companyId) });
    return;
  }

  if (entityType === "company") {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }
}

interface ToastGate {
  cooldownHits: Map<string, number[]>;
  suppressUntil: number;
}

function shouldSuppressToast(gate: ToastGate, category: string): boolean {
  const now = Date.now();
  if (now < gate.suppressUntil) return true;

  const hits = gate.cooldownHits.get(category);
  if (!hits) return false;

  const recent = hits.filter((t) => now - t < TOAST_COOLDOWN_WINDOW_MS);
  gate.cooldownHits.set(category, recent);
  return recent.length >= TOAST_COOLDOWN_MAX;
}

function recordToastHit(gate: ToastGate, category: string) {
  const now = Date.now();
  const hits = gate.cooldownHits.get(category) ?? [];
  hits.push(now);
  gate.cooldownHits.set(category, hits);
}

function gatedPushToast(
  gate: ToastGate,
  pushToast: (toast: ToastInput) => string | null,
  category: string,
  toast: ToastInput,
) {
  if (shouldSuppressToast(gate, category)) return;
  const id = pushToast(toast);
  if (id !== null) recordToastHit(gate, category);
}

// Trailing-coalesce the broad `["hub-items", cid]` LIST invalidation. Both
// `hub.item.changed` and `hub.counts.changed(personal_state_changed)` invalidate
// it, and each can arrive back-to-back with the actor's own mutation-side
// invalidation — collapsing them into one trailing refetch avoids the double
// list refetch/re-render. This defers only the LIST refetch by a few hundred ms;
// counts/sidebar/digest and notifyHubItemChanged stay immediate below, and the
// mutation-side invalidation still fires now (WS-down safety unaffected).
const HUB_LIST_INVALIDATE_DEBOUNCE_MS = 200;
const hubListInvalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleHubListInvalidate(queryClient: QueryClient, companyId: string) {
  const existing = hubListInvalidateTimers.get(companyId);
  if (existing) clearTimeout(existing);
  hubListInvalidateTimers.set(
    companyId,
    setTimeout(() => {
      hubListInvalidateTimers.delete(companyId);
      void queryClient.invalidateQueries({ queryKey: ["hub-items", companyId] });
    }, HUB_LIST_INVALIDATE_DEBOUNCE_MS),
  );
}

function invalidateCockpitQueries(queryClient: QueryClient, companyId: string) {
  queryClient.invalidateQueries({ queryKey: queryKeys.cockpit(companyId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.cockpitCounts(companyId) });
  queryClient.invalidateQueries({ queryKey: ["cockpit-tasks", companyId] });
}

export function handleLiveEvent(
  queryClient: QueryClient,
  expectedCompanyId: string,
  event: LiveEvent,
  pushToast: (toast: ToastInput) => string | null,
  gate: ToastGate,
  notifyHubItemChanged?: (itemId: string) => void,
) {
  if (event.companyId !== expectedCompanyId) return;

  const nameOf = (id: string) => resolveAgentName(queryClient, expectedCompanyId, id);
  const payload = event.payload ?? {};
  if (event.type === "heartbeat.run.log") {
    return;
  }

  if (event.type === "heartbeat.run.queued" || event.type === "heartbeat.run.status") {
    invalidateHeartbeatQueries(queryClient, expectedCompanyId, payload);
    // Cockpit Running card tracks queued + running runs → invalidate on both.
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    if (event.type === "heartbeat.run.status") {
      const toast = buildRunStatusToast(payload, nameOf);
      if (toast) gatedPushToast(gate, pushToast, "run-status", toast);
    }
    return;
  }

  if (event.type === "heartbeat.run.event") {
    return;
  }

  if (event.type === "agent.status") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.org(expectedCompanyId) });
    const agentId = readString(payload.agentId);
    if (agentId) queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
    const toast = buildAgentStatusToast(payload, nameOf, queryClient, expectedCompanyId);
    if (toast) gatedPushToast(gate, pushToast, "agent-status", toast);
    return;
  }

  if (event.type === "activity.logged") {
    invalidateActivityQueries(queryClient, expectedCompanyId, payload);
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    const action = readString(payload.action);
    const toast =
      buildActivityToast(queryClient, expectedCompanyId, payload) ??
      buildJoinRequestToast(payload);
    if (toast) gatedPushToast(gate, pushToast, `activity:${action ?? "unknown"}`, toast);
    return;
  }

  // Thread chat experience Phase 5 (Task 5.6 / plan R3): crew agents (and the
  // founder) moving a card emit a company-broadcast `issue.status_changed`
  // {companyId, issueId, status} — NOT a thread.* envelope. Invalidate the
  // issues list and the Crew Board task query so the card moves columns live.
  if (event.type === "issue.status_changed") {
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(expectedCompanyId) });
    // Crew Board (unified flat tracker) key is ["tasks", "crew-board", companyId];
    // a prefix match (the default predicate) refetches it.
    queryClient.invalidateQueries({ queryKey: ["tasks", "crew-board", expectedCompanyId] });
    // Also nudge the live-runs query so the "Live" pill clears/updates promptly.
    queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(expectedCompanyId) });
    // Cockpit live invalidation: task status changes affect review/myTasks/today cards
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    const issueId = readString(payload.issueId);
    if (issueId) {
      const details = readRecord(payload.details);
      const issueRefs = resolveIssueQueryRefs(queryClient, expectedCompanyId, issueId, details);
      for (const ref of issueRefs) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(ref) });
      }
    }
    return;
  }

  if (event.type === "discussion.entry.created") {
    queryClient.invalidateQueries({ queryKey: queryKeys.discussions.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: ["threads", expectedCompanyId] });
    // Cockpit live invalidation: new entries may change pending discussion counts
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    const discussionId = readString(payload.discussionId);
    if (discussionId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.discussions.detail(expectedCompanyId, discussionId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.threads.detail(expectedCompanyId, discussionId),
      });
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(expectedCompanyId) });
    return;
  }

  if (
    event.type === "discussion.extraction.completed" ||
    event.type === "discussion.extraction.failed"
  ) {
    queryClient.invalidateQueries({ queryKey: queryKeys.discussions.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: ["threads", expectedCompanyId] });
    // Cockpit live invalidation: extraction status changes affect discussions card
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    const discussionId = readString(payload.discussionId);
    if (discussionId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.discussions.detail(expectedCompanyId, discussionId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.threads.detail(expectedCompanyId, discussionId),
      });
    }
    return;
  }

  if (event.type === "hub.item.changed") {
    scheduleHubListInvalidate(queryClient, expectedCompanyId);
    queryClient.invalidateQueries({ queryKey: queryKeys.hubItems.counts(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications.digest(expectedCompanyId) });
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    const itemId = readString(payload.itemId);
    if (itemId) notifyHubItemChanged?.(itemId);
    return;
  }

  if (event.type === "hub.counts.changed") {
    if (readString(payload.reason) === "personal_state_changed") {
      scheduleHubListInvalidate(queryClient, expectedCompanyId);
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.hubItems.counts(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(expectedCompanyId) });
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    return;
  }

  if (event.type === "hub.digest.changed") {
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications.digest(expectedCompanyId) });
    return;
  }

  // Plan 7: thread.* events (refetch-on-poke). Presence is ephemeral and never
  // refetches; the ThreadDetail page consumes thread.presence directly.
  if (event.type.startsWith("thread.") && event.type !== "thread.presence") {
    const threadId = readString(payload.threadId);
    if (threadId) {
      for (const key of threadEventToInvalidations({ type: event.type, threadId }, expectedCompanyId)) {
        queryClient.invalidateQueries({ queryKey: key as unknown[] });
      }
      // Lifecycle changes (scope/participant) can also alter the threads list & badges.
      queryClient.invalidateQueries({ queryKey: queryKeys.discussions.list(expectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.threads.list(expectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: ["threads", expectedCompanyId] });
      invalidateCockpitQueries(queryClient, expectedCompanyId);
    }
    return;
  }

  if (event.type === "internal_agent.greeting") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agentConversation(expectedCompanyId) });
    return;
  }

  if (event.type === "internal_agent.reminder") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agentReminders(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list(expectedCompanyId) });
    // Cockpit live invalidation: reminders affect the Today card
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    return;
  }

  if (event.type === "internal_agent.notification") {
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list(expectedCompanyId) });
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    return;
  }

  if (event.type === "internal_agent.message") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agentConversation(expectedCompanyId) });
    return;
  }

  if (event.type === "internal_agent.run.status") {
    queryClient.invalidateQueries({ queryKey: queryKeys.agentConversation(expectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agentRuns(expectedCompanyId) });
    // Cockpit live invalidation: internal agent run status affects running card
    invalidateCockpitQueries(queryClient, expectedCompanyId);
    const status = readString(payload.status);
    if (status === "failed") {
      gatedPushToast(gate, pushToast, "internal-agent-run", {
        title: "Agent run failed",
        tone: "error",
        dedupeKey: `internal-agent-run:${readString(payload.runId) ?? "unknown"}:failed`,
      });
    }
    return;
  }

  if (event.type.startsWith("budget.")) {
    invalidateCockpitQueries(queryClient, expectedCompanyId);
  }
}

function parsePresenceMembers(payload: Record<string, unknown>): ThreadPresenceMember[] {
  const raw = payload.members;
  if (!Array.isArray(raw)) return [];
  const out: ThreadPresenceMember[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) continue;
    const rec = m as Record<string, unknown>;
    const userId = typeof rec.userId === "string" ? rec.userId : null;
    if (!userId) continue;
    out.push({
      userId,
      lastSeen: typeof rec.lastSeen === "number" ? rec.lastSeen : Date.now(),
      typing: rec.typing === true,
    });
  }
  return out;
}

function parseWorkingAgents(payload: Record<string, unknown>): ThreadWorkingAgent[] {
  const raw = payload.workingAgents;
  if (!Array.isArray(raw)) return [];
  const out: ThreadWorkingAgent[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (typeof rec.agentId === "string" && typeof rec.name === "string") {
        // activity is optional — the server adds it for crew runs; heartbeat
        // presence and older servers omit it, in which case the pill says "typing".
        const activity = typeof rec.activity === "string" && rec.activity.length > 0 ? rec.activity : undefined;
        out.push({ agentId: rec.agentId, name: rec.name, activity });
      }
    }
  }
  return out;
}

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const gateRef = useRef<ToastGate>({ cooldownHits: new Map(), suppressUntil: 0 });

  // Live socket + the threads we want subscribed (ref-counted so multiple
  // components can subscribe to the same thread). Held in refs so the context
  // callbacks always see the current socket without re-subscribing the effect.
  const socketRef = useRef<WebSocket | null>(null);
  const subscribedThreadsRef = useRef<Map<string, number>>(new Map());
  const reconnectListenersRef = useRef<Set<() => void>>(new Set());
  const hubItemChangedListenersRef = useRef<Set<(itemId: string) => void>>(new Set());

  const [connectionState, setConnectionState] = useState<LiveConnectionState>(
    typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "connecting",
  );
  const [presenceByThread, setPresenceByThread] = useState<Record<string, ThreadPresenceMember[]>>({});
  const [workingAgentsByThread, setWorkingAgentsByThread] = useState<Record<string, ThreadWorkingAgent[]>>({});

  const sendRaw = useCallback((msg: Record<string, unknown>) => {
    const sock = socketRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }, []);

  const subscribeThread = useCallback(
    (threadId: string) => {
      if (!threadId) return;
      const map = subscribedThreadsRef.current;
      const next = (map.get(threadId) ?? 0) + 1;
      map.set(threadId, next);
      if (next === 1) sendRaw({ subscribe: threadId });
    },
    [sendRaw],
  );

  const unsubscribeThread = useCallback(
    (threadId: string) => {
      if (!threadId) return;
      const map = subscribedThreadsRef.current;
      const current = map.get(threadId) ?? 0;
      if (current <= 1) {
        map.delete(threadId);
        sendRaw({ unsubscribe: threadId });
        setPresenceByThread((prev) => {
          if (!(threadId in prev)) return prev;
          const copy = { ...prev };
          delete copy[threadId];
          return copy;
        });
        // Mirror the presence cleanup so stale working-agent state doesn't
        // accumulate per visited thread for the session.
        setWorkingAgentsByThread((prev) => {
          if (!(threadId in prev)) return prev;
          const copy = { ...prev };
          delete copy[threadId];
          return copy;
        });
      } else {
        map.set(threadId, current - 1);
      }
    },
    [sendRaw],
  );

  const sendPresence = useCallback(
    (threadId: string, opts?: { typing?: boolean }) => {
      if (!threadId) return;
      sendRaw({ presence: threadId, typing: opts?.typing === true });
    },
    [sendRaw],
  );

  const onReconnect = useCallback((cb: () => void) => {
    reconnectListenersRef.current.add(cb);
    return () => {
      reconnectListenersRef.current.delete(cb);
    };
  }, []);

  const onHubItemChanged = useCallback((cb: (itemId: string) => void) => {
    hubItemChangedListenersRef.current.add(cb);
    return () => {
      hubItemChangedListenersRef.current.delete(cb);
    };
  }, []);

  const notifyHubItemChanged = useCallback((itemId: string) => {
    if (!itemId) return;
    for (const cb of hubItemChangedListenersRef.current) {
      try {
        cb(itemId);
      } catch {
        // listener errors must not break the socket
      }
    }
  }, []);

  // Track browser online/offline so the composer can warn instead of failing silently.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOffline = () => setConnectionState("offline");
    const onOnline = () => setConnectionState((s) => (s === "offline" ? "reconnecting" : s));
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  useEffect(() => {
    if (!selectedCompanyId) return;

    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      setConnectionState("reconnecting");
      reconnectAttempt += 1;
      const delayMs = Math.min(15000, 1000 * 2 ** Math.min(reconnectAttempt - 1, 4));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(selectedCompanyId)}/events/ws`;
      socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        const wasReconnect = reconnectAttempt > 0;
        if (wasReconnect) {
          gateRef.current.suppressUntil = Date.now() + RECONNECT_SUPPRESS_MS;
        }
        reconnectAttempt = 0;
        setConnectionState("open");

        // Re-subscribe every thread we still care about (the server registry is
        // per-connection, so a fresh socket starts with zero subscriptions).
        for (const threadId of subscribedThreadsRef.current.keys()) {
          sendRaw({ subscribe: threadId });
        }
        // Notify consumers so they can catch up (refetch / sinceSeq) on reconnect.
        if (wasReconnect) {
          for (const cb of reconnectListenersRef.current) {
            try {
              cb();
            } catch {
              // listener errors must not break the socket
            }
          }
        }
      };

      socket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;

        try {
          const parsed = JSON.parse(raw) as LiveEvent;
          // Presence is ephemeral — consume it directly into local state.
          if (parsed.type === "thread.presence") {
            const threadId = readString(parsed.payload?.threadId);
            if (threadId) {
              const members = parsePresenceMembers(parsed.payload ?? {});
              setPresenceByThread((prev) => ({ ...prev, [threadId]: members }));
              const working = parseWorkingAgents(parsed.payload ?? {});
              setWorkingAgentsByThread((prev) => ({ ...prev, [threadId]: working }));
            }
            return;
          }
          handleLiveEvent(
            queryClient,
            selectedCompanyId,
            parsed,
            pushToast,
            gateRef.current,
            notifyHubItemChanged,
          );
        } catch {
          // Ignore non-JSON payloads.
        }
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (closed) return;
        scheduleReconnect();
      };
    };

    setConnectionState("connecting");
    connect();

    return () => {
      closed = true;
      clearReconnect();
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "provider_unmount");
      }
      socketRef.current = null;
    };
  }, [queryClient, selectedCompanyId, pushToast, sendRaw, notifyHubItemChanged]);

  const contextValue = useMemo<LiveUpdatesContextValue>(
    () => ({
      connectionState,
      subscribeThread,
      unsubscribeThread,
      sendPresence,
      onReconnect,
      onHubItemChanged,
      presenceByThread,
      workingAgentsByThread,
    }),
    [
      connectionState,
      subscribeThread,
      unsubscribeThread,
      sendPresence,
      onReconnect,
      onHubItemChanged,
      presenceByThread,
      workingAgentsByThread,
    ],
  );

  return (
    <LiveUpdatesContext.Provider value={contextValue}>{children}</LiveUpdatesContext.Provider>
  );
}
