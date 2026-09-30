import type { CommanderContextScope, CompanySkillListItem, ShowRef, UpdateInternalAgentConfig } from "@armyofagents/shared";
import { api, ApiError } from "./client";

/* ------------------------------------------------------------------ */
/*  Response types                                                     */
/* ------------------------------------------------------------------ */

export interface AgentConversation {
  conversation: {
    id: string;
    status: "active" | "archived";
    messageCount: number;
    createdAt: string;
    updatedAt: string;
  };
  messages: AgentMessage[];
  summarizedContext: string | null;
  total: number;
  limit: number;
  offset: number;
}

export interface AgentMessageToolCall { name: string; success?: boolean; summary?: string }

export interface AgentMessage {
  id: string;
  role: "assistant" | "user" | "system" | "tool";
  content: string | null;
  toolCalls: AgentMessageToolCall[] | null;
  reasoning: string | null;
  outputRefs: ShowRef[] | null;
  pageContext: string | null;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  executionMode: string;
  provider: string | null;
  model: string | null;
  cliTool: string | null;
  crewModel: string | null;
  /** D18: Commander's own dial. Not read by crew/heartbeat/thread flows. */
  autonomyLevel: number;
  /** D18: the agent-work dial — crew runs, org heartbeat, Adjutant/thread flows. */
  crewAutonomyLevel: number;
  enabledCapabilities: string[];
  notificationPreference: string;
  contextTokenBudget: number;
  budgetMonthlyCents: number | null;
  spentMonthlyCents: number;
  proactiveIntervalMinutes: number;
  lastProactiveRunAt: string | null;
  cheapModel: string | null;
  runtimeApprovalsEnabled: boolean;
  runtimeAllowAlwaysEnabled: boolean;
  vendorCliBypassEnabled: boolean;
  inboundRoutingLevel: string;
  viewerControlLevel: "manual" | "own_output" | "full";
}

export interface AgentRunToolCall {
  name: string;
  durationMs: number;
  success: boolean;
}

export interface AgentRuntimeSettings {
  runtimeApprovalsEnabled: boolean;
  runtimeAllowAlwaysEnabled: boolean;
}

export interface AgentRun {
  id: string;
  triggerType: "conversation" | "proactive" | "event" | "sub_agent";
  triggerSource: string;
  status: "running" | "completed" | "failed";
  toolsCalled: AgentRunToolCall[];
  tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  costCents: number;
  durationMs: number;
  activeExecutionMs: number;
  humanQuestionWaitMs: number;
  runtimePermissionWaitMs: number;
  totalWallClockMs: number;
  summary: string | null;
  departmentContext: string | null;
  userId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentRunsResponse {
  runs: AgentRun[];
  total: number;
  limit: number;
  offset: number;
  aggregates: {
    totalCostCents: number;
    totalRuns: number;
    avgDurationMs: number;
    failureRate: number;
  };
}

export interface AgentRunFilters {
  triggerType?: string;
  triggerSource?: string;
  status?: string;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}

export interface AgentReminder {
  id: string;
  content: string;
  triggerAt: string;
  status: "pending" | "fired" | "cancelled";
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdAt: string;
}

export interface AgentRemindersResponse {
  reminders: AgentReminder[];
}

/* ------------------------------------------------------------------ */
/*  SSE streaming types                                                */
/* ------------------------------------------------------------------ */

export type SSEEventType =
  | "thinking"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "content"
  | "action_confirm"
  | "options_prompt"
  | "done"
  | "error";

export interface SSEEvent {
  event: SSEEventType;
  data: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Confirmation API types                                             */
/* ------------------------------------------------------------------ */

export interface ConfirmActionResult {
  confirmId: string;
  result: "denied" | "rejected" | "executed" | "failed";
  summary: string | null;
  error: string | null;
  entityType: string | null;
  entityId: string | null;
}

export type ConfirmActionDecision = "allow_once" | "allow_always" | "deny";

/* ------------------------------------------------------------------ */
/*  SSE streaming helper (POST-based — NOT EventSource)                */
/* ------------------------------------------------------------------ */

function parseSSEPart(part: string): SSEEvent | null {
  if (!part.trim()) return null;

  const lines = part.split("\n");
  let event = "message";
  let dataStr = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice(7);
    } else if (line.startsWith("data: ")) {
      // Accumulate multi-line data fields per SSE spec
      dataStr += (dataStr ? "\n" : "") + line.slice(6);
    }
  }

  if (!dataStr) return null;

  try {
    const data = JSON.parse(dataStr) as Record<string, unknown>;
    return { event: event as SSEEventType, data };
  } catch {
    return null;
  }
}

export async function* streamAgentChat(
  companyId: string,
  message: string,
  pageContext?: string | null,
  signal?: AbortSignal,
  conversationId?: string | null,
  contextScope?: CommanderContextScope | null,
  attachmentAssetIds?: string[],
  clientSubmissionId?: string,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(
    `/api/companies/${encodeURIComponent(companyId)}/internal-agent/chat`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        pageContext,
        ...(conversationId ? { conversationId } : {}),
        ...(contextScope ? { contextScope } : {}),
        ...(attachmentAssetIds && attachmentAssetIds.length > 0 ? { attachmentAssetIds } : {}),
        // Idempotent replay key (B-states, mock §5): the server's agent-loop
        // replays the matching conversation turn instead of double-posting
        // when a failed-looking request actually landed.
        ...(clientSubmissionId ? { clientSubmissionId } : {}),
      }),
      signal,
    },
  );

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ??
        `Agent chat failed: ${response.status}`,
      response.status,
      errorBody,
    );
  }

  if (!response.body) {
    throw new ApiError("No response body received", response.status, null);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const parsed = parseSSEPart(part);
        if (parsed) yield parsed;
      }
    }

    // Process any remaining buffer
    const parsed = parseSSEPart(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Confirm or reject a pending Commander action.
 * Wraps POST /companies/:companyId/internal-agent/confirm.
 */
export function confirmAction(
  companyId: string,
  body:
    | { confirmId: string; decision: ConfirmActionDecision }
    | { confirmId: string; approved: boolean },
): Promise<ConfirmActionResult> {
  return api.post<ConfirmActionResult>(
    `/companies/${companyId}/internal-agent/confirm`,
    body,
  );
}

/* ------------------------------------------------------------------ */
/*  REST API client                                                    */
/* ------------------------------------------------------------------ */

function buildRunParams(filters: AgentRunFilters): string {
  const params = new URLSearchParams();
  if (filters.triggerType) params.set("triggerType", filters.triggerType);
  if (filters.triggerSource) params.set("triggerSource", filters.triggerSource);
  if (filters.status) params.set("status", filters.status);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface AgentGreeting {
  greeting: string;
  findingCount: number;
  lastCheckedAt: string | null;
}

export const internalAgentApi = {
  getGreeting: (companyId: string) =>
    api.get<AgentGreeting>(`/companies/${companyId}/internal-agent/greeting`),

  getConversation: (
    companyId: string,
    opts?: { limit?: number; offset?: number; includeArchived?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts?.includeArchived) params.set("includeArchived", "true");
    const qs = params.toString();
    return api.get<AgentConversation>(
      `/companies/${companyId}/internal-agent/conversation${qs ? `?${qs}` : ""}`,
    );
  },

  resetConversation: (companyId: string) =>
    api.delete<{ archivedConversationId: string; newConversationId: string }>(
      `/companies/${companyId}/internal-agent/conversation`,
    ),

  confirmAction: (
    companyId: string,
    confirmId: string,
    decision: ConfirmActionDecision,
  ) => confirmAction(companyId, { confirmId, decision }),

  listSkills: (companyId: string) =>
    api.get<CompanySkillListItem[]>(`/companies/${companyId}/internal-agent/skills`),

  getConfig: (companyId: string) =>
    api.get<AgentConfig>(`/companies/${companyId}/internal-agent/config`),

  getRuntimeSettings: (companyId: string) =>
    api.get<AgentRuntimeSettings>(
      `/companies/${companyId}/internal-agent/runtime-settings`,
    ),

  updateConfig: (companyId: string, data: UpdateInternalAgentConfig) =>
    api.patch<AgentConfig>(`/companies/${companyId}/internal-agent/config`, data),

  getRuns: (companyId: string, filters: AgentRunFilters = {}) =>
    api.get<AgentRunsResponse>(
      `/companies/${companyId}/internal-agent/runs${buildRunParams(filters)}`,
    ),

  getReminders: (companyId: string, status?: string) => {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return api.get<AgentRemindersResponse>(
      `/companies/${companyId}/internal-agent/reminders${params}`,
    );
  },

  cancelReminder: (companyId: string, reminderId: string) =>
    api.patch<AgentReminder>(
      `/companies/${companyId}/internal-agent/reminders/${reminderId}`,
      { status: "cancelled" },
    ),

  testConnection: (companyId: string) =>
    api.post<{ success: boolean; error?: string }>(
      `/companies/${companyId}/internal-agent/test-connection`,
      {},
    ),
};

/* ------------------------------------------------------------------ */
/*  Conversations (sessions sidebar)                                   */
/* ------------------------------------------------------------------ */

export interface ConversationRow {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  userId: string;
  pinned: boolean;
  /** Manual drag-order index. null = not manually ordered (recency/date groups). */
  sortOrder: number | null;
}

export const commanderConversationsApi = {
  list: (companyId: string) =>
    api.get<{ conversations: ConversationRow[] }>(
      `/companies/${companyId}/internal-agent/conversations`,
    ),

  create: (companyId: string, title?: string) =>
    api.post<ConversationRow>(
      `/companies/${companyId}/internal-agent/conversations`,
      { title },
    ),

  archive: (companyId: string, convId: string) =>
    api.patch<ConversationRow>(
      `/companies/${companyId}/internal-agent/conversations/${convId}/archive`,
      {},
    ),

  pin: (companyId: string, convId: string, pinned: boolean) =>
    api.patch<ConversationRow>(
      `/companies/${companyId}/internal-agent/conversations/${convId}/pin`,
      { pinned },
    ),

  rename: (companyId: string, convId: string, title: string) =>
    api.patch<ConversationRow>(
      `/companies/${companyId}/internal-agent/conversations/${convId}/rename`,
      { title },
    ),

  remove: (companyId: string, convId: string) =>
    api.delete<{ ok: true }>(
      `/companies/${companyId}/internal-agent/conversations/${convId}`,
    ),

  /**
   * Persist a manual drag order. `orderedIds` is the full visible non-pinned
   * list in its new top-to-bottom order; the server assigns sortOrder by index.
   */
  reorder: (companyId: string, orderedIds: string[]) =>
    api.patch<{ ok: true }>(
      `/companies/${companyId}/internal-agent/conversations/reorder`,
      { orderedIds },
    ),

  /** Clear the manual order (back to recency/date groups). */
  resetOrder: (companyId: string) =>
    api.delete<{ ok: true }>(
      `/companies/${companyId}/internal-agent/conversations/order`,
    ),
};

/* ------------------------------------------------------------------ */
/*  Conversation messages (session history)                           */
/* ------------------------------------------------------------------ */

export const conversationMessagesApi = {
  list: (companyId: string, convId: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    params.set("limit", String(opts?.limit ?? 50));
    params.set("offset", String(opts?.offset ?? 0));
    return api.get<{ messages: AgentMessage[]; conversationId: string }>(
      `/companies/${companyId}/internal-agent/conversations/${convId}/messages?${params.toString()}`,
    );
  },
};

/* ------------------------------------------------------------------ */
/*  Tool permissions                                                   */
/* ------------------------------------------------------------------ */

export interface CommanderToolPermission {
  enabled: boolean;
  requireConfirmation: boolean;
  minimumRole: "founder" | "team_lead" | "team_member";
}

export const toolPermissionsApi = {
  get: (companyId: string) =>
    api.get<{ permissions: Record<string, CommanderToolPermission>; default: CommanderToolPermission }>(
      `/companies/${companyId}/internal-agent/tool-permissions`,
    ),

  update: (companyId: string, permissions: Record<string, CommanderToolPermission>) =>
    api.patch<{ success: boolean }>(
      `/companies/${companyId}/internal-agent/tool-permissions`,
      permissions,
    ),
};

export interface CommanderTrustRule {
  id: string;
  toolName: string;
  scope: "exact_params";
  paramsHashPrefix: string;
  paramsHashVersion: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export const commanderTrustRulesApi = {
  list: (companyId: string) =>
    api.get<{ rules: CommanderTrustRule[] }>(
      `/companies/${companyId}/internal-agent/tool-trust-rules`,
    ),

  revoke: (companyId: string, ruleId: string) =>
    api.delete<{ success: true }>(
      `/companies/${companyId}/internal-agent/tool-trust-rules/${ruleId}`,
    ),
};
