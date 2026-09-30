import type { MutableTaskOutput, TaskOutput } from "@armyofagents/shared";
import { api } from "./client";

export const taskOutputsApi = {
  listForIssue: (issueId: string) =>
    api.get<TaskOutput[]>(`/issues/${issueId}/outputs`),
  // GET /task-outputs/:id is not company-prefixed (companyId is asserted from the
  // row server-side); the companyId arg is kept for call-site + cache-key symmetry
  // with the other viewer body fetchers.
  get: (_companyId: string, id: string) =>
    api.get<TaskOutput>(`/task-outputs/${id}`),
  update: (id: string, patch: MutableTaskOutput) =>
    api.patch<TaskOutput>(`/task-outputs/${id}`, patch),
};
