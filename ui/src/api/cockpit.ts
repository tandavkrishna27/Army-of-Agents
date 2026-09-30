import type {
  CockpitCounts,
  CockpitData,
  CockpitTaskBucket,
  CockpitTaskBucketResponse,
} from "@armyofagents/shared";
import { api } from "./client";

export const cockpitApi = {
  get: (companyId: string) => api.get<CockpitData>(`/companies/${companyId}/cockpit`),
  listTasks: (
    companyId: string,
    bucket: CockpitTaskBucket,
    options: { limit?: number; cursor?: string } = {},
  ) => {
    const params = new URLSearchParams({ bucket });
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    return api.get<CockpitTaskBucketResponse>(
      `/companies/${companyId}/cockpit/tasks?${params.toString()}`,
    );
  },
  counts: (companyId: string) =>
    api.get<CockpitCounts>(`/companies/${companyId}/cockpit/counts`),
};
