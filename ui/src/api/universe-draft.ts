import type {
  UniverseDraft,
  UniverseDraftDestination,
  UniverseDraftPatchInput,
} from "@armyofagents/shared";
import { api } from "./client";

function base(
  companyId: string,
  conversationId: string,
  destination: UniverseDraftDestination,
) {
  return `/companies/${companyId}/universe/conversations/${conversationId}/drafts/${
    destination.kind
  }/${encodeURIComponent(destination.id)}`;
}

export const universeDraftApi = {
  get: (
    companyId: string,
    conversationId: string,
    destination: UniverseDraftDestination,
    signal?: AbortSignal,
  ) => api.get<UniverseDraft>(base(companyId, conversationId, destination), {signal}),
  save: (
    companyId: string,
    conversationId: string,
    destination: UniverseDraftDestination,
    patch: UniverseDraftPatchInput,
    signal?: AbortSignal,
  ) =>
    api.patch<UniverseDraft>(base(companyId, conversationId, destination), patch, {signal}),
};
