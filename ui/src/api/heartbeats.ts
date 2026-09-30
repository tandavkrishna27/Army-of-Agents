import type {
  HeartbeatRun,
  HeartbeatRunEvent,
  InstanceSchedulerHeartbeatAgent,
} from "@armyofagents/shared";
import { api } from "./client";

export interface ActiveRunForIssue extends HeartbeatRun {
  agentId: string;
  agentName: string;
  adapterType: string;
  processPid?: number | null;
  processStartedAt?: string | Date | null;
  lastOutputAt?: string | Date | null;
}

export interface LiveRunForIssue {
  id: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentId: string;
  agentName: string;
  // Heartbeat-run columns. Thread-chat-experience Task 5.5 UNIONs crew
  // (internal_agent) live rows into this response. Crew rows carry
  // { id, status, agentId, agentName, issueId, startedAt, createdAt, source } and
  // leave the heartbeat-only fields below `undefined` at runtime, so they are
  // typed optional to match — consumers (ActiveAgentsPanel, LiveRunWidget,
  // agent-feed) already optional-chain / fall back, and a future consumer can't
  // assume they're present.
  invocationSource?: string;
  triggerDetail?: string | null;
  adapterType?: string;
  logStore?: string | null;
  logRef?: string | null;
  processPid?: number | null;
  processStartedAt?: string | Date | null;
  lastOutputAt?: string | Date | null;
  issueId?: string | null;
  /** Discriminator present on crew rows; absent on heartbeat rows. */
  source?: "internal_agent";
}

export const heartbeatsApi = {
  list: (companyId: string, agentId?: string, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit) searchParams.set("limit", String(limit));
    const qs = searchParams.toString();
    return api.get<HeartbeatRun[]>(`/companies/${companyId}/heartbeat-runs${qs ? `?${qs}` : ""}`);
  },
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/heartbeat-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
    ),
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/heartbeat-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  cancel: (runId: string) => api.post<void>(`/heartbeat-runs/${runId}/cancel`, {}),
  liveRunsForIssue: (issueId: string) =>
    api.get<LiveRunForIssue[]>(`/issues/${issueId}/live-runs`),
  activeRunForIssue: (issueId: string) =>
    api.get<ActiveRunForIssue | null>(`/issues/${issueId}/active-run`),
  liveRunsForCompany: (companyId: string, minCount?: number) =>
    api.get<LiveRunForIssue[]>(`/companies/${companyId}/live-runs${minCount ? `?minCount=${minCount}` : ""}`),
  listInstanceSchedulerAgents: () =>
    api.get<InstanceSchedulerHeartbeatAgent[]>("/instance/scheduler-heartbeats"),
};
