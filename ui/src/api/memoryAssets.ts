import { api } from "./client";
import type {
  MemoryAssetRecord,
  MemoryAssetUpdateInput,
} from "@armyofagents/shared";

export const memoryAssetsApi = {
  list: async (
    companyId: string,
    params?: {
      departmentId?: string;
      folderPath?: string;
      mimeType?: string;
    },
  ): Promise<MemoryAssetRecord[]> => {
    const search = new URLSearchParams();
    if (params?.departmentId) search.set("departmentId", params.departmentId);
    if (params?.folderPath) search.set("folderPath", params.folderPath);
    if (params?.mimeType) search.set("mimeType", params.mimeType);
    const qs = search.toString() ? `?${search.toString()}` : "";
    return api.get(`/companies/${companyId}/memory/assets${qs}`);
  },

  get: async (companyId: string, id: string): Promise<MemoryAssetRecord> => {
    return api.get(`/companies/${companyId}/memory/assets/${id}`);
  },

  /** Returns the URL the browser can hit directly to stream content. */
  contentUrl: (companyId: string, id: string): string => {
    return `/api/companies/${companyId}/memory/assets/${id}/content`;
  },

  /** Returns the URL the browser can hit to fetch a server-rendered HTML view of the asset (DOCX + XLSX). */
  renderUrl: (companyId: string, id: string): string =>
    `/api/companies/${companyId}/memory/assets/${id}/render`,

  update: async (
    companyId: string,
    id: string,
    patch: MemoryAssetUpdateInput,
  ): Promise<MemoryAssetRecord> => {
    return api.patch(`/companies/${companyId}/memory/assets/${id}`, patch);
  },

  remove: async (companyId: string, id: string): Promise<void> => {
    return api.delete(`/companies/${companyId}/memory/assets/${id}`);
  },

  upload: async (
    companyId: string,
    file: File,
    params: { departmentId?: string; folderPath?: string } = {},
  ): Promise<{ asset: MemoryAssetRecord; jobId: string }> => {
    const formData = new FormData();
    formData.append("file", file);
    if (params.departmentId) formData.append("departmentId", params.departmentId);
    if (params.folderPath) formData.append("folderPath", params.folderPath);
    const r = await fetch(`/api/companies/${companyId}/memory/assets/upload`, {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    if (!r.ok) {
      let msg = `Upload failed (HTTP ${r.status})`;
      try {
        const j = await r.json();
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }
    return r.json();
  },
};
