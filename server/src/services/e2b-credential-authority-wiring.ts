import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySecretVersions, runtimeProviderKeys } from "@armyofagents/db";
import { resolveRuntimeProviderConfig } from "./environment-runtime.js";
import { runtimeProviderKeyService } from "./runtime-provider-keys.js";
import { formatKeyGeneration, type E2bCredentialResolverDeps } from "./e2b-credential-authority.js";

/**
 * MIG-008 D3 drizzle wiring for the E2B credential authority. Kept OUT of the pure
 * `e2b-credential-authority.ts` acceptance module so the fail-first unit tests never
 * load drizzle internals (Test Patterns / ESM-cycle rule).
 */

/**
 * Derive the per-company monotonic E2B key GENERATION from the
 * `runtime_provider_keys` → `company_secret_versions` pointer: the `version` of the
 * current secret version behind the company's default e2b runtime provider key.
 * Returns null when the company has no BYO key (operator env default — ungenerationed).
 */
export async function deriveE2bKeyGeneration(db: Db, companyId: string): Promise<string | null> {
  const [keyRow] = await db
    .select({ secretId: runtimeProviderKeys.secretId })
    .from(runtimeProviderKeys)
    .where(
      and(
        eq(runtimeProviderKeys.companyId, companyId),
        eq(runtimeProviderKeys.provider, "e2b"),
        eq(runtimeProviderKeys.isDefault, true),
      ),
    )
    .limit(1);
  if (!keyRow) return null;

  const [versionRow] = await db
    .select({ version: companySecretVersions.version })
    .from(companySecretVersions)
    .where(
      and(
        eq(companySecretVersions.secretId, keyRow.secretId),
        eq(companySecretVersions.status, "current"),
      ),
    )
    .orderBy(desc(companySecretVersions.version))
    .limit(1);
  if (versionRow?.version === undefined || versionRow.version === null) return null;
  // SECRET-AWARE composite: a repoint to a DIFFERENT secret is an unconditional
  // supersession (versions restart at 1 per secret, so a bare version is not monotonic
  // across a rotation). The `<secretId>:<version>` identity makes old-key denial correct.
  return formatKeyGeneration(keyRow.secretId, versionRow.version);
}

/**
 * Build the {@link E2bCredentialResolverDeps} for the additive credential-authority
 * move: per-company BYO resolution reuses `resolveRuntimeProviderConfig` (the existing
 * chokepoint — never a new key read), the confined env supplies the default, and the
 * key generation is derived from the secret-version pointer. NEVER persists the key.
 */
export function createE2bCredentialResolverDeps(
  db: Db,
  opts: {
    env?: Record<string, string | undefined>;
    runtimeProviderKeys?: Pick<
      ReturnType<typeof runtimeProviderKeyService>,
      "resolveCredential"
    > | null;
  } = {},
): E2bCredentialResolverDeps {
  const runtimeKeys = opts.runtimeProviderKeys ?? runtimeProviderKeyService(db);
  return {
    env: opts.env ?? process.env,
    resolvePerCompanyConfig: async (companyId: string) => {
      const resolved = await resolveRuntimeProviderConfig({
        companyId,
        provider: "e2b",
        config: {},
        runtimeProviderKeys: runtimeKeys,
      });
      const resolvedApiKey = (resolved as { resolvedApiKey?: unknown }).resolvedApiKey;
      return typeof resolvedApiKey === "string" ? { resolvedApiKey } : {};
    },
    currentKeyGeneration: (companyId: string) => deriveE2bKeyGeneration(db, companyId),
  };
}
