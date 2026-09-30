import { api } from "./client";
import type {
  CreateTeamInput,
  UpdateTeamInput,
  AddTeamMemberInput,
  TeamRole,
  TeamManifest,
} from "@armyofagents/shared";

export interface Team {
  id: string;
  companyId: string;
  /** null = company-wide team with no parent department (D21). */
  parentProjectId: string | null;
  name: string;
  slug: string;
  description: string | null;
  manifest: Record<string, unknown>;
  status: "active" | "archived";
  templateOrigin: string | null;
  templateVersion: string | null;
  createdAt: string;
  updatedAt: string;
  /** Populated by the list endpoint — avoids N+1 member queries in the list view. */
  memberCount: number;
  leadAgentId: string | null;
  memberAgentIds: string[];
}

export interface TeamMember {
  id: string;
  teamId: string;
  agentId: string;
  role: TeamRole;
  createdAt: string;
}

export interface TeamCoordination {
  id: string;
  teamId: string;
  name: string;
  markdown: string;
  status: "draft" | "published" | "archived";
}

/**
 * Mirrors `ImportPreview` from `server/src/services/team-import.ts`. The
 * shape is set by the `_imports/preview` route — see Slice 8 / Task 8.1.
 */
export interface TeamImportPreview {
  manifest: TeamManifest;
  collisions: Array<{ kind: "agent" | "team"; name: string; existingId: string }>;
  skillsToInstall: string[];
  pluginsToInstall: string[];
  workflowsToInstall: string[];
}

/**
 * Body shape posted to `_imports/install`. Mirrors `ImportResolution` plus
 * the raw YAML the server re-parses inside the transaction. See Slice 8 /
 * Task 8.2 + 8.3.
 */
export interface TeamImportResolution {
  yamlContent: string;
  collisions: Record<string, "rename" | "replace" | "skip">;
  parentProjectId: string;
  renames?: Record<string, string>;
}

export const teamsApi = {
  list: (companyId: string, projectId?: string) =>
    api.get<{ items: Team[] }>(
      `/companies/${companyId}/teams${projectId ? `?projectId=${projectId}` : ""}`,
    ),

  get: (teamId: string) => api.get<Team>(`/teams/${teamId}`),

  create: (companyId: string, input: CreateTeamInput) =>
    api.post<Team>(`/companies/${companyId}/teams`, input),

  update: (teamId: string, patch: UpdateTeamInput) =>
    api.patch<Team>(`/teams/${teamId}`, patch),

  updateManifest: (teamId: string, manifest: Record<string, unknown>) =>
    api.put<Team>(`/teams/${teamId}/manifest`, manifest),

  archive: (teamId: string) => api.delete<void>(`/teams/${teamId}`),

  dismantle: (teamId: string) =>
    api.delete<{ dismantledTeamId: string }>(`/teams/${teamId}/dismantle`),

  listMembers: (teamId: string) =>
    api.get<{ items: TeamMember[] }>(`/teams/${teamId}/members`),

  getMember: (teamId: string, agentId: string) =>
    api.get<TeamMember>(`/teams/${teamId}/members/${agentId}`),

  addMember: (teamId: string, input: AddTeamMemberInput) =>
    api.post<TeamMember>(`/teams/${teamId}/members`, input),

  removeMember: (teamId: string, agentId: string) =>
    api.delete<void>(`/teams/${teamId}/members/${agentId}`),

  updateMemberRole: (teamId: string, agentId: string, role: TeamRole) =>
    api.patch<TeamMember>(`/teams/${teamId}/members/${agentId}`, { role }),

  getCoordination: (teamId: string) =>
    api.get<TeamCoordination | null>(`/teams/${teamId}/coordination`),

  upsertCoordination: (teamId: string, name: string, markdown: string, description?: string | null) =>
    api.put<TeamCoordination>(`/teams/${teamId}/coordination`, { name, markdown, description }),

  regenerateCoordination: (teamId: string) =>
    api.post<TeamCoordination>(`/teams/${teamId}/coordination/regenerate`, {}),

  previewImport: (companyId: string, file: File, parentProjectId: string) => {
    const fd = new FormData();
    fd.append("file", file);
    // Task 4 (P1-A): server-side dept gate requires the target department
    // up-front so a team_lead can't probe agent collisions in another dept
    // by uploading a manifest. The dept picker now lives in the upload
    // dialog (was previously in the preview dialog).
    fd.append("parentProjectId", parentProjectId);
    return api.postForm<TeamImportPreview>(
      `/companies/${companyId}/teams/_imports/preview`,
      fd,
    );
  },

  installImport: (companyId: string, body: TeamImportResolution) =>
    api.post<TeamImportInstallResult>(
      `/companies/${companyId}/teams/_imports/install`,
      body,
    ),
};

/**
 * Response shape for the install endpoint. Mirrors the explicit JSON
 * payload set in `routes/team-imports.ts` -- a flat subset of the team
 * row plus a `warnings` array.
 *
 * Task 11 / P3-D: `warnings` surfaces non-fatal install side effects
 * (e.g. 'replace' silently granting dept membership). Always present
 * (server normalizes to []) so consumers can iterate without
 * null-checks.
 */
export interface TeamImportInstallResult {
  id: string;
  slug: string;
  name: string;
  parentProjectId: string;
  warnings: string[];
}
