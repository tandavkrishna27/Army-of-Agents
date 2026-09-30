import type {
  ExecutionWorkspace,
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceSummary,
  WorkspaceOperation,
  WorkspaceRuntimeControlTarget,
} from "@armyofagents/shared";
import { api } from "./client";

export interface WorkspaceRuntimeControlResult {
  workspace: ExecutionWorkspace;
  runtimeServiceCount: number;
  stdout: string;
  stderr: string;
}

// --- Git operation types ---

export interface GitFileEntry {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
  staged: boolean;
}

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  timestamp: string;
}

export interface GitStatusResponse {
  gitAvailable: boolean;
  reason?: string;
  branch?: string | null;
  detachedHead?: boolean;
  remote?: GitRemoteInfo | null;
  ahead?: number | null;
  behind?: number | null;
  files?: GitFileEntry[];
  clean?: boolean;
}

export interface GitLogResponse {
  gitAvailable: boolean;
  entries?: GitLogEntry[];
}

export interface GitCommitResponse {
  hash: string;
  message: string;
  filesCommitted: string[];
  skippedFiles: string[];
  activeRunWarning?: boolean;
}

export interface GitPushResponse {
  pushed: boolean;
  remote: string;
  branch: string;
  activeRunWarning?: boolean;
}

export interface WorkspaceMutationSafety {
  task: {
    id: string;
    title: string;
    status: string;
    identifier?: string | null;
  } | null;
  activeRun: {
    id: string;
    status: string;
    startedAt: string | null;
    agentName?: string | null;
  } | null;
  requiresConfirmation: {
    commit: boolean;
    push: boolean;
    createPr: boolean;
  };
  warnings: string[];
}

export interface WorkspaceRuntimeService {
  id: string;
  serviceName: string;
  status: string;
  port: number | null;
  url: string | null;
  previewUrl?: string | null;
  previewAccess?: "local" | "company" | "external" | null;
  localTargetUrl?: string | null;
  command: string | null;
  cwd: string | null;
  provider: string;
  providerRef?: string | null;
  ownerAgentId?: string | null;
  startedByRunId?: string | null;
  scopeType?: string | null;
  lifecycle: string;
  startedAt: string | null;
  stoppedAt: string | null;
  stopPolicy?: Record<string, unknown> | null;
  healthStatus?: string | null;
  healthCheckedAt?: string | null;
}

export const executionWorkspacesApi = {
  list: (
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    const qs = params.toString();
    return api.get<ExecutionWorkspace[]>(`/companies/${companyId}/execution-workspaces${qs ? `?${qs}` : ""}`);
  },
  listSummaries: (
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams({ summary: "true" });
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    return api.get<ExecutionWorkspaceSummary[]>(
      `/companies/${companyId}/execution-workspaces?${params.toString()}`,
    );
  },
  get: (id: string) => api.get<ExecutionWorkspace>(`/execution-workspaces/${id}`),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<ExecutionWorkspace>(`/execution-workspaces/${id}`, data),
  runtimeServices: (workspaceId: string) =>
    api.get<WorkspaceRuntimeService[]>(`/execution-workspaces/${workspaceId}/runtime-services`),
  getCloseReadiness: (id: string) =>
    api.get<ExecutionWorkspaceCloseReadiness>(`/execution-workspaces/${id}/close-readiness`),
  controlRuntimeServices: (
    id: string,
    action: "start" | "stop" | "restart" | "run",
    target: WorkspaceRuntimeControlTarget,
  ) =>
    api.post<WorkspaceRuntimeControlResult>(
      `/execution-workspaces/${id}/runtime-services/${action}`,
      target,
    ),
  controlRuntimeCommands: (
    id: string,
    action: "start" | "stop" | "restart" | "run",
    target: WorkspaceRuntimeControlTarget,
  ) =>
    api.post<WorkspaceRuntimeControlResult>(
      `/execution-workspaces/${id}/runtime-commands/${action}`,
      target,
    ),
  listWorkspaceOperations: (id: string, opts?: { limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get<WorkspaceOperation[]>(
      `/execution-workspaces/${id}/workspace-operations${qs ? `?${qs}` : ""}`,
    );
  },

  // --- Git operations ---
  getGitStatus: (id: string) =>
    api.get<GitStatusResponse>(`/execution-workspaces/${id}/git/status`),
  safety: (id: string) =>
    api.get<WorkspaceMutationSafety>(`/execution-workspaces/${id}/git/safety`),
  getGitLog: (id: string, limit?: number) => {
    const params = limit ? `?limit=${limit}` : "";
    return api.get<GitLogResponse>(`/execution-workspaces/${id}/git/log${params}`);
  },
  gitCommit: (id: string, data: { message: string; files: string[] }) =>
    api.post<GitCommitResponse>(`/execution-workspaces/${id}/git/commit`, data),
  gitPush: (id: string, data?: { remote?: string; branch?: string }) =>
    api.post<GitPushResponse>(`/execution-workspaces/${id}/git/push`, data ?? {}),
};
