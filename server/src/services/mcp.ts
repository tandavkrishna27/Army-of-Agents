import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { mcpApiKeys, mcpClientConnections } from "@armyofagents/db";
import { notFound } from "../errors.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `aoa_mcp_${randomBytes(24).toString("hex")}`;
}

export function mcpService(db: Db) {
  return {
    listKeys: (companyId: string) =>
      db
        .select({
          id: mcpApiKeys.id,
          companyId: mcpApiKeys.companyId,
          userId: mcpApiKeys.userId,
          name: mcpApiKeys.name,
          lastUsedAt: mcpApiKeys.lastUsedAt,
          revokedAt: mcpApiKeys.revokedAt,
          createdAt: mcpApiKeys.createdAt,
        })
        .from(mcpApiKeys)
        .where(eq(mcpApiKeys.companyId, companyId))
        .orderBy(desc(mcpApiKeys.createdAt)),

    createKey: async (companyId: string, userId: string, name: string) => {
      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(mcpApiKeys)
        .values({
          companyId,
          userId,
          name,
          keyHash,
        })
        .returning({
          id: mcpApiKeys.id,
          companyId: mcpApiKeys.companyId,
          userId: mcpApiKeys.userId,
          name: mcpApiKeys.name,
          lastUsedAt: mcpApiKeys.lastUsedAt,
          revokedAt: mcpApiKeys.revokedAt,
          createdAt: mcpApiKeys.createdAt,
        })
        .then((rows) => rows[0]);

      return {
        ...created,
        token,
      };
    },

    revokeKey: async (companyId: string, keyId: string) =>
      db
        .update(mcpApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(mcpApiKeys.id, keyId), eq(mcpApiKeys.companyId, companyId)))
        .returning({
          id: mcpApiKeys.id,
          companyId: mcpApiKeys.companyId,
          userId: mcpApiKeys.userId,
          name: mcpApiKeys.name,
          lastUsedAt: mcpApiKeys.lastUsedAt,
          revokedAt: mcpApiKeys.revokedAt,
          createdAt: mcpApiKeys.createdAt,
        })
        .then((rows) => rows[0] ?? null),

    listClients: (companyId: string) =>
      db
        .select()
        .from(mcpClientConnections)
        .where(eq(mcpClientConnections.companyId, companyId))
        .orderBy(desc(mcpClientConnections.lastSeenAt)),

    async touchClient(input: {
      companyId: string;
      userId: string;
      apiKeyId?: string | null;
      clientName?: string | null;
      clientVersion?: string | null;
      userAgent?: string | null;
      transport?: string | null;
      remoteAddress?: string | null;
      lastMethod?: string | null;
    }) {
      const existing = await db
        .select()
        .from(mcpClientConnections)
        .where(
          and(
            eq(mcpClientConnections.companyId, input.companyId),
            eq(mcpClientConnections.userId, input.userId),
            input.apiKeyId ? eq(mcpClientConnections.apiKeyId, input.apiKeyId) : isNull(mcpClientConnections.apiKeyId),
          ),
        )
        .orderBy(desc(mcpClientConnections.lastSeenAt))
        .then((rows) => rows.find((row) => (row.clientName ?? null) === (input.clientName ?? null)) ?? rows[0] ?? null);

      if (!existing) {
        return db
          .insert(mcpClientConnections)
          .values({
            companyId: input.companyId,
            userId: input.userId,
            apiKeyId: input.apiKeyId ?? null,
            clientName: input.clientName ?? null,
            clientVersion: input.clientVersion ?? null,
            userAgent: input.userAgent ?? null,
            transport: input.transport ?? "http",
            remoteAddress: input.remoteAddress ?? null,
            lastMethod: input.lastMethod ?? null,
          })
          .returning()
          .then((rows) => rows[0]);
      }

      return db
        .update(mcpClientConnections)
        .set({
          clientName: input.clientName ?? existing.clientName,
          clientVersion: input.clientVersion ?? existing.clientVersion,
          userAgent: input.userAgent ?? existing.userAgent,
          transport: input.transport ?? existing.transport,
          remoteAddress: input.remoteAddress ?? existing.remoteAddress,
          lastMethod: input.lastMethod ?? existing.lastMethod,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpClientConnections.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    },

    async getStatus(companyId: string) {
      const [keys, clients] = await Promise.all([
        db.select({ id: mcpApiKeys.id }).from(mcpApiKeys).where(and(eq(mcpApiKeys.companyId, companyId), isNull(mcpApiKeys.revokedAt))),
        db.select({ id: mcpClientConnections.id }).from(mcpClientConnections).where(eq(mcpClientConnections.companyId, companyId)),
      ]);

      return {
        companyId,
        endpointPath: `/api/companies/${companyId}/mcp`,
        keyCount: keys.length,
        connectedClients: clients.length,
      };
    },

    async requireOwnedKey(companyId: string, keyId: string) {
      const key = await db
        .select()
        .from(mcpApiKeys)
        .where(and(eq(mcpApiKeys.id, keyId), eq(mcpApiKeys.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!key) throw notFound("MCP API key not found");
      return key;
    },
  };
}
