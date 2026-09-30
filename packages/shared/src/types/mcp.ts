export interface McpApiKey {
  id: string;
  companyId: string;
  userId: string;
  name: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface McpApiKeyCreated extends McpApiKey {
  token: string;
}

export interface McpClientConnection {
  id: string;
  companyId: string;
  apiKeyId: string | null;
  userId: string;
  clientName: string | null;
  clientVersion: string | null;
  userAgent: string | null;
  transport: string;
  remoteAddress: string | null;
  lastMethod: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpStatus {
  companyId: string;
  enabled: boolean;
  endpointPath: string;
  keyCount: number;
  connectedClients: number;
}
