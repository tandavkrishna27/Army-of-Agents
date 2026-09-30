import { api } from "./client";
import type {
  GitHubAppStatus,
  GitHubPrCreateRequest,
  GitHubPrCreateResponse,
  GitHubPrSyncResponse,
  GitHubRepoCollaborator,
  GitHubRepoLabel,
  GitHubRepoMilestone,
  GitHubRepoBranch,
  GitHubAuthorizedRepo,
  GitHubPrMergeRequest,
  GitHubPrActionResponse,
} from "@armyofagents/shared";

export const githubIntegrationApi = {
  // ── GitHub App auth ───────────────────────────────────────────────────────
  /**
   * `returnTo` is an opaque, server-allowlisted key (see
   * `ONBOARDING_RETURN_PATHS` in `server/src/services/github-app.ts`) — NOT a
   * raw path. The server validates it against that allowlist and embeds it in
   * the signed install state; an unrecognized key is silently dropped. This
   * lets the onboarding Integrations step (WS5) land back on itself after the
   * GitHub App install completes, without opening a redirect vector.
   */
  getAppInstallUrl: (companyId: string, returnTo?: string) =>
    api.get<{ url: string }>(
      `/companies/${companyId}/github/app/install-url${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""}`,
    ),

  appStatus: (companyId: string) =>
    api.get<GitHubAppStatus>(`/companies/${companyId}/github/app/status`),

  disconnectApp: (companyId: string) =>
    api.delete<{ removed: boolean }>(`/companies/${companyId}/github/app`),

  getAuthorizedRepos: (companyId: string) =>
    api.get<GitHubAuthorizedRepo[]>(`/companies/${companyId}/github/app/repositories`),

  // ── Auth ──────────────────────────────────────────────────────────────────
  setPat: (companyId: string, pat: string) =>
    api.post<{ configured: boolean; githubUser: string }>(
      `/companies/${companyId}/github/pat`,
      { pat },
    ),
  removePat: (companyId: string) =>
    api.delete<{ removed: boolean }>(`/companies/${companyId}/github/pat`),
  status: (companyId: string) =>
    api.get<{ configured: boolean; githubUser?: string; createdAt?: string }>(
      `/companies/${companyId}/github/pat/status`,
    ),

  // ── PR create / sync ──────────────────────────────────────────────────────
  syncWorkspacePR: (workspaceId: string, input?: { force?: boolean }) =>
    api.post<GitHubPrSyncResponse>(
      `/execution-workspaces/${workspaceId}/github-pr/sync`,
      input ?? {},
    ),
  createPR: (issueId: string, input: GitHubPrCreateRequest) =>
    api.post<GitHubPrCreateResponse>(`/issues/${issueId}/github-pr`, input),

  // ── Repo metadata (feed CreatePrDialog selects) ───────────────────────────
  getCollaborators: (workspaceId: string) =>
    api.get<GitHubRepoCollaborator[]>(
      `/execution-workspaces/${workspaceId}/github/collaborators`,
    ),
  getLabels: (workspaceId: string) =>
    api.get<GitHubRepoLabel[]>(
      `/execution-workspaces/${workspaceId}/github/labels`,
    ),
  getMilestones: (workspaceId: string) =>
    api.get<GitHubRepoMilestone[]>(
      `/execution-workspaces/${workspaceId}/github/milestones`,
    ),
  getBranches: (workspaceId: string) =>
    api.get<GitHubRepoBranch[]>(
      `/execution-workspaces/${workspaceId}/github/branches`,
    ),

  // ── PR actions ────────────────────────────────────────────────────────────
  mergePr: (workspaceId: string, input: GitHubPrMergeRequest) =>
    api.post<GitHubPrActionResponse>(
      `/execution-workspaces/${workspaceId}/github-pr/merge`,
      input,
    ),
  closePr: (workspaceId: string) =>
    api.post<GitHubPrActionResponse>(
      `/execution-workspaces/${workspaceId}/github-pr/close`,
      {},
    ),
  reopenPr: (workspaceId: string) =>
    api.post<GitHubPrActionResponse>(
      `/execution-workspaces/${workspaceId}/github-pr/reopen`,
      {},
    ),
  requestReview: (workspaceId: string, reviewers: string[]) =>
    api.post<{ success: boolean }>(
      `/execution-workspaces/${workspaceId}/github-pr/request-review`,
      { reviewers },
    ),
};
