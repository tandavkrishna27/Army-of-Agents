import type { Goal, GoalStatus } from "@armyofagents/shared";
import { api } from "./client";

/** A goal enriched for the Objectives tree: multi-parent edges + rolled-up progress. */
export interface GoalTreeNode extends Goal {
  parentIds: string[];
  progress: { done: number; total: number; percent: number };
  atRisk: number;
  statusSuggestion: GoalStatus | null;
}

export const goalsApi = {
  list: (companyId: string, projectId?: string) => {
    const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return api.get<Goal[]>(`/companies/${companyId}/goals${params}`);
  },
  tree: (companyId: string) =>
    api.get<GoalTreeNode[]>(`/companies/${companyId}/goals/tree`),
  get: (id: string) => api.get<Goal>(`/goals/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/companies/${companyId}/goals`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  setParents: (id: string, parentIds: string[]) =>
    api.put<Goal>(`/goals/${id}/parents`, { parentIds }),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
};
