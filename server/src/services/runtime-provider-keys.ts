import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySecrets, runtimeProviderKeys } from "@armyofagents/db";
import type {
  CreateRuntimeProviderKey,
  CreateRuntimeProviderKeyWithSecret,
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

  /**
   * One-step BYO key: create the company secret (from the pasted raw value) AND
   * its default runtime provider key together, ATOMICALLY.
   *
   * The whole thing runs inside a single `db.transaction`. Passing that `tx` to
   * BOTH `secretService(tx)` and `runtimeProviderKeyService(tx)` means the
   * secret write's own inner `db.transaction` becomes a SAVEPOINT under the outer
   * one — so if the provider-key insert throws, the outer rollback discards the
   * secret too. NO orphan secret is ever left behind (proven at the DB level in
   * runtime-provider-keys-with-secret.integration.test.ts).
   *
   * SECURITY: `input.value` is the raw API key. It is stored encrypted as a
   * company secret via `secretService.create` and is NEVER returned in the
   * created provider-key row, echoed to the caller, or logged. A duplicate secret
   * name surfaces as `secretService.create`'s `conflict(409)` unchanged (a clean
   * 409, not a 500) because the transaction re-throws it as-is.
   */
  async function createWithSecret(
    companyId: string,
    input: CreateRuntimeProviderKeyWithSecret,
    // Actor is threaded to `secretService.create` so the generated secret carries
    // its creator (`company_secrets.created_by_user_id`), matching the normal
    // secret-create route. Without it the one-step path would mint a credential
    // with NULL creator provenance (Codex P1). Structurally `{ userId?, agentId? }`
    // to avoid importing the non-exported `Actor` type from secrets.ts.
    actor?: { userId?: string | null; agentId?: string | null },
  ) {
    return db.transaction(async (tx) => {
      // `tx as unknown as Db` is the repo-wide idiom for handing a transaction to
      // a `(db: Db)` factory (the callback tx lacks `Db`'s `$client`). Both
      // services then share the outer transaction, so the whole write is atomic.
      const txDb = tx as unknown as Db;
      const secret = await secretService(txDb).create(
        companyId,
        {
          name: input.secretName ?? input.displayName,
          value: input.value,
          provider: "local_encrypted",
        },
        actor,
      );
      const providerKey = await runtimeProviderKeyService(txDb).create(companyId, {
        provider: input.provider,
        displayName: input.displayName,
        secretId: secret.id,
        isDefault: input.isDefault ?? true,
      });
      // Return BOTH rows so the route can audit `secret.created` alongside
      // `runtime_provider_key.created`. Neither row carries the raw key value
      // (the material lives in company_secret_versions), so this is safe to return.
      return { secret, providerKey };
    });
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
    createWithSecret,
    update,
    remove,
    resolveCredential,
  };
}
