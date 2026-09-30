import type { HomeBoardLayoutItem } from "@armyofagents/shared";
import { api } from "./client";

export interface HomeBoardLayoutResponse {
  layout: HomeBoardLayoutItem[];
  schemaVersion: number;
}

function base(companyId: string) {
  return `/companies/${companyId}/home-board-layout/me`;
}

export const homeBoardLayoutApi = {
  get: (companyId: string) =>
    api.get<HomeBoardLayoutResponse | null>(base(companyId)),
  save: (companyId: string, layout: HomeBoardLayoutItem[]) =>
    api.patch<HomeBoardLayoutResponse>(base(companyId), { layout }),
  reset: (companyId: string) =>
    api.post<{ ok: true }>(`${base(companyId)}/reset`, {}),
};
