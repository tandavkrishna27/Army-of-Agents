import { universeAttentionCheckpointSchema, universeAttentionResponseSchema, type UniverseAttentionCheckpoint, type UniverseAttentionResponse } from "@armyofagents/shared";
import { api } from "./client";

export const universeAttentionApi = {
  async get(companyId: string, cursor?: string, signal?: AbortSignal): Promise<UniverseAttentionResponse> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await api.get<UniverseAttentionResponse>(
      `/companies/${companyId}/universe/attention${query}`,
      { signal },
    );
    return universeAttentionResponseSchema.parse(response);
  },
  async finish(companyId: string, baseRevision: number, through: string): Promise<UniverseAttentionCheckpoint> {
    return universeAttentionCheckpointSchema.parse(await api.post(
      `/companies/${companyId}/universe/attention/checkpoint`,
      { baseRevision, through },
    ));
  },
};
