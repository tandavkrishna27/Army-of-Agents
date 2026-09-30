import type {
  CheckpointPatch, CheckpointSnapshot,
  LayoutAck,
  LayoutPatch,
  UniverseLayoutDocument,
} from "@armyofagents/shared";
import { api } from "./client";

export interface UniverseLayoutResponse {
  schemaVersion: number;
  revision: number;
  document: UniverseLayoutDocument;
}

function base(companyId: string, conversationId: string) {
  return `/companies/${companyId}/universe/conversations/${conversationId}/layout`;
}

export const universeLayoutApi = {
  get: (companyId: string, conversationId: string, signal?: AbortSignal) =>
    api.get<UniverseLayoutResponse>(base(companyId, conversationId), {signal}),
  apply: (companyId: string, conversationId: string, patch: LayoutPatch, signal?: AbortSignal) =>
    api.patch<LayoutAck>(base(companyId, conversationId), patch, {signal}),
  receipt: (companyId: string, conversationId: string, operationId: string, signal?: AbortSignal) =>
    api.get<LayoutAck>(
      `${base(companyId, conversationId)}/operations/${operationId}`, {signal},
    ),
};

function checkpointBase(companyId: string, conversationId: string, panelKey: string) {
  return `/companies/${encodeURIComponent(companyId)}/universe/conversations/${encodeURIComponent(conversationId)}/panels/${encodeURIComponent(panelKey)}/checkpoint`;
}
export const universeCheckpointApi = {
  get: (companyId: string, conversationId: string, panelKey: string, sourceVersionId: string) =>
    api.get<CheckpointSnapshot | null>(`${checkpointBase(companyId, conversationId, panelKey)}?sourceVersionId=${encodeURIComponent(sourceVersionId)}`),
  save: (companyId: string, conversationId: string, panelKey: string, patch: CheckpointPatch) =>
    api.patch<CheckpointSnapshot>(checkpointBase(companyId, conversationId, panelKey), patch),
};
