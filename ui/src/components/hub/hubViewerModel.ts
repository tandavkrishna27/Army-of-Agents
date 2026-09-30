import type { ViewerTabBase } from "../../lib/viewer-tabs";

export type HubTabKind =
  | "home"
  | "browser"
  | "approval"
  | "join_request"
  | "thread"
  | "runtime_decision"
  | "work_question"
  | "task"
  | "task_output"
  | "agent"
  | "run"
  | "artifact"
  | "memory"
  | "budget"
  | "suggestion"
  | "marketplace_op"
  | "reminder"
  | "routine"
  | "notification";

export interface HubApprovalPayload {
  approvalId: string;
  hubItemId?: string;
}

export interface HubJoinRequestPayload {
  joinRequestId: string;
  hubItemId?: string;
}

export interface HubThreadPayload {
  discussionId: string;
  entryId?: string;
  hubItemId?: string;
}

export interface HubRuntimeDecisionPayload {
  hubItemId: string;
}

export interface HubWorkQuestionPayload {
  questionId: string;
  hubItemId?: string;
}

export interface HubTaskPayload {
  issueId: string;
  hubItemId?: string;
}

export interface HubAgentPayload {
  agentId: string;
  hubItemId?: string;
}

export interface HubRunPayload {
  runId: string;
  agentId: string;
  hubItemId?: string;
}

export interface HubBudgetPayload {
  scope: "company";
}

export interface HubSuggestionPayload {
  suggestionId: string;
  hubItemId?: string;
}

export interface HubMarketplaceOpPayload {
  sourceId: string;
  hubItemId?: string;
}

export interface HubReminderPayload {
  reminderId: string;
  hubItemId?: string;
}

export interface HubRoutinePayload {
  routineId: string;
  hubItemId?: string;
}

export interface HubBrowserPayload {
  url: string;
}

export interface HubNotificationPayload {
  hubItemId: string;
}

export type HubTabPayload =
  | HubApprovalPayload
  | HubJoinRequestPayload
  | HubThreadPayload
  | HubRuntimeDecisionPayload
  | HubWorkQuestionPayload
  | HubTaskPayload
  | HubAgentPayload
  | HubRunPayload
  | HubBudgetPayload
  | HubSuggestionPayload
  | HubMarketplaceOpPayload
  | HubReminderPayload
  | HubRoutinePayload
  | HubBrowserPayload
  | HubNotificationPayload;

export interface HubTab extends ViewerTabBase {
  kind: HubTabKind;
  title: string;
  payload?: HubTabPayload;
}

const TRAILING_URL_PUNCTUATION = /[.,!?;:)\]}]+$/;

export const HOME_TAB: HubTab = {
  key: "home",
  kind: "home",
  title: "Home",
  closeable: false,
};

export function approvalTab(approvalId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `approval:${approvalId}`,
    kind: "approval",
    title: title || "Approval",
    closeable: true,
    payload: { approvalId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubApprovalPayload,
  };
}

export function joinRequestTab(joinRequestId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `join_request:${joinRequestId}`,
    kind: "join_request",
    title: title || "Join request",
    closeable: true,
    payload: { joinRequestId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubJoinRequestPayload,
  };
}

export function threadTab(discussionId: string, title?: string, entryId?: string, hubItemId?: string): HubTab {
  return {
    key: `thread:${discussionId}`,
    kind: "thread",
    title: title || "Discussion",
    closeable: true,
    payload: { discussionId, entryId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubThreadPayload,
  };
}

export function runtimeDecisionTab(hubItemId: string, title?: string): HubTab {
  return {
    key: `runtime_decision:${hubItemId}`,
    kind: "runtime_decision",
    title: title || "Runtime decision",
    closeable: true,
    payload: { hubItemId } satisfies HubRuntimeDecisionPayload,
  };
}

export function workQuestionTab(questionId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `work_question:${questionId}`,
    kind: "work_question",
    title: title || "Question",
    closeable: true,
    payload: { questionId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubWorkQuestionPayload,
  };
}

export function taskTab(issueId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `task:${issueId}`,
    kind: "task",
    title: title || "Task",
    closeable: true,
    payload: { issueId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubTaskPayload,
  };
}

export function agentTab(agentId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `agent:${agentId}`,
    kind: "agent",
    title: title || "Agent",
    closeable: true,
    payload: { agentId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubAgentPayload,
  };
}

export function runTab(runId: string, agentId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `run:${runId}`,
    kind: "run",
    title: title || "Run",
    closeable: true,
    payload: { runId, agentId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubRunPayload,
  };
}

export function budgetTab(title?: string): HubTab {
  return {
    key: "budget:company",
    kind: "budget",
    title: title || "Budget",
    closeable: true,
    payload: { scope: "company" } satisfies HubBudgetPayload,
  };
}

export function suggestionTab(suggestionId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `suggestion:${suggestionId}`,
    kind: "suggestion",
    title: title || "Suggestion",
    closeable: true,
    payload: { suggestionId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubSuggestionPayload,
  };
}

export function marketplaceOpTab(sourceId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `marketplace_op:${sourceId}`,
    kind: "marketplace_op",
    title: title || "Marketplace",
    closeable: true,
    payload: { sourceId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubMarketplaceOpPayload,
  };
}

export function reminderTab(reminderId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `reminder:${reminderId}`,
    kind: "reminder",
    title: title || "Reminder",
    closeable: true,
    payload: { reminderId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubReminderPayload,
  };
}

export function routineTab(routineId: string, title?: string, hubItemId?: string): HubTab {
  return {
    key: `routine:${routineId}`,
    kind: "routine",
    title: title || "Routine",
    closeable: true,
    payload: { routineId, ...(hubItemId ? { hubItemId } : {}) } satisfies HubRoutinePayload,
  };
}

export function browserTab(url: string, title?: string): HubTab {
  const normalizedUrl = normalizeUrl(url);
  return {
    key: `browser:${normalizedUrl}`,
    kind: "browser",
    title: title || browserLabel(normalizedUrl),
    closeable: true,
    payload: { url: normalizedUrl } satisfies HubBrowserPayload,
  };
}

/** Generic fallback tab for hub items without a dedicated viewer. */
export function notificationTab(hubItemId: string, title?: string): HubTab {
  return {
    key: `notification:${hubItemId}`,
    kind: "notification",
    title: title || "Notification",
    closeable: true,
    payload: { hubItemId } satisfies HubNotificationPayload,
  };
}

function normalizeUrl(url: string): string {
  const trimmed = url.replace(TRAILING_URL_PUNCTUATION, "");
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed.trim();
  }
}

function browserLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}
