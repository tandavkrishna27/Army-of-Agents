import { api } from "./client";
import type {
  MemoryFolderRecord,
  MemoryFolderCreateInput,
  MemoryFolderUpdateInput,
} from "@armyofagents/shared";

export const memoryFoldersApi = {
  list: async (
    companyId: string,
    params?: { departmentId?: string },
  ): Promise<MemoryFolderRecord[]> => {
    const qs = params?.departmentId
      ? `?departmentId=${encodeURIComponent(params.departmentId)}`
      : "";
    return api.get(`/companies/${companyId}/memory/folders${qs}`);
  },

  create: async (
    companyId: string,
    input: MemoryFolderCreateInput,
  ): Promise<MemoryFolderRecord> => {
    return api.post(`/companies/${companyId}/memory/folders`, input);
  },

  update: async (
    companyId: string,
    id: string,
    patch: MemoryFolderUpdateInput,
  ): Promise<MemoryFolderRecord> => {
    return api.patch(`/companies/${companyId}/memory/folders/${id}`, patch);
  },

  remove: async (companyId: string, id: string): Promise<void> => {
    return api.delete(`/companies/${companyId}/memory/folders/${id}`);
  },
};
