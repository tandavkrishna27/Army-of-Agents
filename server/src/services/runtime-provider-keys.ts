import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySecrets, runtimeProviderKeys } from "@armyofagents/db";
import type {
  CreateRuntimeProviderKey,
  RuntimeProviderKeyProvider,
  UpdateRuntimeProviderKey,
} from "@armyofagents/shared";
import { conflict, notFound } from "../errors.js";
import { secretService, type SecretConsumerContext } from "./secrets.js";

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function runtimeProviderKeyService(
  db: Db,
  options: { secrets?: ReturnType<typeof secretService> } = {},
) {
  const secrets = options.secrets ?? secretService(db);

  async function assertSecret(companyId: string, secretId: string) {
    const rows = await db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId)));
    const secret = rows[0];
    if (!secret || secret.deletedAt || secret.status !== "active") {
      throw badRequest("Provider key must reference an active company secret.");
    }
    return secret;
  }

  async function clearDefault(companyId: string, provider: RuntimeProviderKeyProvider) {
    await db
      .update(runtimeProviderKeys)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(runtimeProviderKeys.companyId, companyId), eq(runtimeProviderKeys.provider, provider)));
  }

  async function list(companyId: string) {
    return db.select().from(runtimeProviderKeys).where(eq(runtimeProviderKeys.companyId, companyId));
  }

  async function getById(id: string) {
    const rows = await db.select().from(runtimeProviderKeys).where(eq(runtimeProviderKeys.id, id));
    return rows[0] ?? null;
  }

  async function create(companyId: string, input: CreateRuntimeProviderKey) {
    await assertSecret(companyId, input.secretId);
    if (input.isDefault) await clearDefault(companyId, input.provider);
    const [created] = await db
      .insert(runtimeProviderKeys)
      .values({
        companyId,
        provider: input.provider,
        displayName: input.displayName,
        secretId: input.secretId,
        isDefault: input.isDefault ?? false,
        status: "active",
        metadata: input.metadata ?? null,
      })
      .returning();
    return created ?? null;
  }

  async function update(id: string, input: UpdateRuntimeProviderKey) {
    const existing = await getById(id);
    if (!existing) throw notFound("Provider key not found");
    if (input.secretId) await assertSecret(existing.companyId, input.secretId);
    if (input.isDefault) {
      await clearDefault(existing.companyId, existing.provider as RuntimeProviderKeyProvider);
    }
    const [updated] = await db
      .update(runtimeProviderKeys)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(runtimeProviderKeys.id, id))
      .returning();
    return updated ?? null;
  }

  async function remove(id: string) {
    const existing = await getById(id);
    if (!existing) throw notFound("Provider key not found");
    if (existing.isDefault) throw conflict("Cannot delete the default provider key. Choose another default first.");
    const [deleted] = await db.delete(runtimeProviderKeys).where(eq(runtimeProviderKeys.id, id)).returning();
    return deleted ?? null;
  }

  async function resolveCredential(
    companyId: string,
    provider: RuntimeProviderKeyProvider,
    config: Record<string, unknown>,
    context: SecretConsumerContext,
  ): Promise<string> {
    const credentialSecretId = readString(config.credentialSecretId);
    if (credentialSecretId) {
      await assertSecret(companyId, credentialSecretId);
      return secrets.resolveSecretValue(companyId, credentialSecretId, "latest", context);
    }

    const credentialRef = readString(config.credentialRef) ?? "default";
    if (credentialRef !== "default") {
      throw badRequest(`Unsupported credentialRef "${credentialRef}"`);
    }

    const rows = await db
      .select()
      .from(runtimeProviderKeys)
      .where(
        and(
          eq(runtimeProviderKeys.companyId, companyId),
          eq(runtimeProviderKeys.provider, provider),
          eq(runtimeProviderKeys.isDefault, true),
        ),
      );
    const key = rows[0];
    if (!key || key.status !== "active") {
      throw notFound(`No default ${provider} provider key configured.`);
    }
    return secrets.resolveSecretValue(companyId, key.secretId, "latest", context);
  }

  return {
    list,
    getById,
    create,
    update,
    remove,
    resolveCredential,
  };
}
