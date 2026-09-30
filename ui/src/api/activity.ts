import type { ActivityEvent, DetectedOutput } from "@armyofagents/shared";
import { api } from "./client";

export interface RunForIssue {
  runId: string;
  status: string;
  agentId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  logStore?: string | null;
  logRef?: string | null;
  processPid?: number | null;
  processStartedAt?: string | null;
  lastOutputAt?: string | null;
  activeExecutionMs?: number;
  humanQuestionWaitMs?: number;
  runtimePermissionWaitMs?: number;
  totalWallClockMs?: number;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  detectedOutputs: DetectedOutput[] | null;
  retryOfRunId?: string | null;
  scheduledRetryAt?: string | null;
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  errorCode?: string | null;
  /** Redacted+capped snapshot of the assembled system prompt delivered to the
   *  agent CLI. Populated best-effort; null when not yet captured or when the
   *  run predates follow-up #27. Max ~16 000 chars; secrets stripped. */
  promptSnapshot?: string | null;
}

export interface IssueForRun {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export const activityApi = {
  list: (
    companyId: string,
    filters?: {
      entityType?: string;
      entityId?: string;
      actorType?: "agent" | "user" | "system" | "autonomy";
      actorId?: string;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.actorType) params.set("actorType", filters.actorType);
    if (filters?.actorId) params.set("actorId", filters.actorId);
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`);
  },
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
  runsForIssue: (issueId: string) => api.get<RunForIssue[]>(`/issues/${issueId}/runs`),
  issuesForRun: (runId: string) => api.get<IssueForRun[]>(`/heartbeat-runs/${runId}/issues`),
};
