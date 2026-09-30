import type {
  Company,
  McpApiKey,
  McpApiKeyCreated,
  McpClientConnection,
  McpStatus,
} from "@armyofagents/shared";
import { api } from "./client";

export const mcpApi = {
  status: (companyId: string) => api.get<McpStatus>(`/companies/${companyId}/mcp/status`),
  updateSettings: (companyId: string, enabled: boolean) =>
    api.patch<Company>(`/companies/${companyId}/mcp/settings`, { enabled }),
  listKeys: (companyId: string) => api.get<McpApiKey[]>(`/companies/${companyId}/mcp/keys`),
  createKey: (companyId: string, name: string) =>
    api.post<McpApiKeyCreated>(`/companies/${companyId}/mcp/keys`, { name }),
  revokeKey: (companyId: string, keyId: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/mcp/keys/${keyId}`),
  listClients: (companyId: string) =>
    api.get<McpClientConnection[]>(`/companies/${companyId}/mcp/clients`),
};
