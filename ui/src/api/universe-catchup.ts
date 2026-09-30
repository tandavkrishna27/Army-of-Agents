import {universeReconciliationSnapshotSchema,type UniverseReconciliationSnapshot} from "@armyofagents/shared";
import {api} from "./client";
export const universeCatchupApi={async get(companyId:string,conversationId:string,signal?:AbortSignal):Promise<UniverseReconciliationSnapshot>{
  const response=await api.get<UniverseReconciliationSnapshot>(`/companies/${encodeURIComponent(companyId)}/universe/conversations/${encodeURIComponent(conversationId)}/snapshot`,{signal});
  return universeReconciliationSnapshotSchema.parse(response);
}};
