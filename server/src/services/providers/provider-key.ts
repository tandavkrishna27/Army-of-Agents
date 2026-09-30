/**
 * Company-level provider API key storage.
 *
 * This is the write half of Settings -> Providers: a founder pastes a key for a
 * catalog provider and it becomes the COMPANY DEFAULT for that provider's env
 * var. A later task applies it at runtime as a fallback for agents that carry no
 * binding of their own.
 *
 * THREE things this module is deliberately strict about:
 *
 *   1. THE CATALOG IS THE SOURCE OF TRUTH. Nothing here hardcodes a provider
 *      name, env var or secret name — every one is read from PROVIDER_CATALOG
 *      via `getProviderById`. Adding a provider must require zero edits here.
 *
 *   2. CREDENTIAL OWNERSHIP IS RESOLVED BEFORE STORAGE. Some providers READ a
 *      credential another provider OWNS (pi -> anthropic, cursor_cloud ->
 *      cursor). They share an env var, and the same env var must mean the same
 *      secret — otherwise saving a Pi key would create a second row that
 *      claude_local never reads, and rotating one would leave the other stale.
 *      So the owner is resolved FIRST and the OWNER's spec supplies both the
 *      secret name and the env var. Reading the borrower's own spec happens to
 *      give the same answer for today's catalog (each borrower entry copies the
 *      owner's values), which is exactly why this must not be left implicit:
 *      the day a borrower's copy drifts, storage would silently fork.
 *
 *   3. IT NEVER TOUCHES AN AGENT. This is the difference from
 *      `server/src/services/commander-key.ts`, which deliberately binds a
 *      secret_ref into the COMMANDER AGENT's adapterConfig.env and syncs
 *      per-agent env bindings. This service writes company_secrets + activity_log
 *      and nothing else. No adapterConfig merge, no syncEnvBindingsForTarget.
 *
 * The raw key is never logged, never returned, and never written to the audit
 * row — only the durable secret id is (matching routes/secrets.ts and
 * routes/commander-key.ts).
 *
 * NOTE ON COEXISTING SECRETS: `provider:<id>` is NOT the only secret name that
 * can bind a given env var. `llm:<provider>`, the bare `<ENV_VAR>` legacy name
 * and `Commander <p> API key` all legitimately exist for the same var (see
 * KNOWN_EXTERNAL_SECRET_BINDINGS in the catalog). This module addresses its own
 * row by NAME and touches nothing else — detecting/reconciling the others is the
 * routes/UI task's job, and nothing here forecloses it.
 */
import type { Db } from "@armyofagents/db";
import {
  getCredentialOwner,
  getProviderById,
  type ProviderDescriptor,
  type ProviderId,
} from "@armyofagents/shared";
import { secretService } from "../secrets.js";
import { logActivity } from "../activity-log.js";
import { badRequest } from "../../errors.js";

export interface ProviderKeyTarget {
  /** The provider whose credential is actually stored (may differ from the request). */
  ownerId: ProviderId;
  /** Reserved `provider:*` secret name, from the OWNER's catalog entry. */
  secretName: string;
  /** Env var the stored secret binds, from the OWNER's catalog entry. */
  envVar: string;
}

/**
 * Resolve a descriptor to the storage target its credential actually lives at.
 *
 * The owner hop happens BEFORE the apiKey spec is read — that ordering is the
 * whole guarantee (see §2 of the module docblock).
 */
export function keyTargetForDescriptor(descriptor: ProviderDescriptor): ProviderKeyTarget {
  const owner = getCredentialOwner(descriptor);
  const spec = owner.credential.apiKey;
  if (!spec) {
    throw badRequest(`Provider ${descriptor.id} does not support an API key.`);
  }
  return { ownerId: owner.id, secretName: spec.secretName, envVar: spec.envVar };
}

/** Resolve a provider id to its storage target, hopping to the credential owner. */
export function resolveProviderKeyTarget(providerId: string): ProviderKeyTarget {
  const descriptor = getProviderById(providerId);
  if (!descriptor) throw badRequest(`Unknown provider: ${providerId}`);
  // A borrower that itself declares no apiKey is still saveable if its owner has
  // one, but a provider with NEITHER (opencode) is not — keyTargetForDescriptor
  // raises that, naming the requested provider rather than the owner.
  return keyTargetForDescriptor(descriptor);
}

/** The `provider:*` secret name a saved key for this provider lands in. */
export function secretNameForProvider(providerId: string): string {
  return resolveProviderKeyTarget(providerId).secretName;
}

/** The env var a saved key for this provider binds. */
export function envVarForProvider(providerId: string): string {
  return resolveProviderKeyTarget(providerId).envVar;
}

export interface SaveProviderKeyInput {
  companyId: string;
  providerId: string;
  /** The pasted key. Never logged, never returned. */
  value: string;
  actorUserId: string;
}

export interface SaveProviderKeyResult {
  secretId: string;
  /** The provider the founder asked to save (may be a borrower). */
  providerId: string;
  /** The provider whose secret was actually written. */
  credentialOwnerId: ProviderId;
  envVar: string;
  operation: SaveOperation;
}

type SaveOperation = "created" | "rotated" | "reactivated";

/**
 * Save (create / rotate / reactivate) the company-level key for a provider.
 *
 * ONE transaction covers the vault mutation AND the audit row, so "every
 * committed credential mutation is audited" holds by construction — a failure
 * anywhere rolls both back rather than leaving a committed secret with no audit
 * entry (the same invariant routes/commander-key.ts enforces).
 *
 * The secret ops open their own `db.transaction`; on a tx handle those become
 * savepoints, the same nested-tx pattern used elsewhere in this codebase.
 */
export async function saveProviderKey(
  db: Db,
  input: SaveProviderKeyInput,
): Promise<SaveProviderKeyResult> {
  // Validate BEFORE opening a transaction: a bad provider id or empty value must
  // never reach the vault, and must never produce an audit row.
  const target = resolveProviderKeyTarget(input.providerId);
  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (!value) throw badRequest("value is required");

  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const secrets = secretService(txDb);
    const actorRef = { userId: input.actorUserId, agentId: null };

    let operation: SaveOperation = "created";
    let secretId: string;

    // Addressed by NAME, so other secrets binding the same env var (llm:*,
    // Commander *, legacy <ENV_VAR>) are left completely untouched.
    const existing = await secrets.getByName(input.companyId, target.secretName);
    if (existing) {
      // `getByName` filters on deletedAt only, not status. A founder may have
      // disabled or archived this secret from Settings; rotate() appends a
      // version but never touches status, so without reactivating first the new
      // value would be stored yet still rejected at resolve time as "not
      // active" — pasting a fresh key could never recover. Reactivate through
      // the canonical update() seam FIRST, then rotate, so the end state is
      // active + newest value. Both run on the tx handle, so a later failure
      // rolls the reactivation back too.
      if (existing.status !== "active") {
        operation = "reactivated";
        await secrets.update(existing.id, { status: "active" });
      } else {
        operation = "rotated";
      }
      await secrets.rotate(existing.id, { value }, actorRef);
      secretId = existing.id;
    } else {
      operation = "created";
      const created = (await secrets.create(
        input.companyId,
        {
          name: target.secretName,
          key: target.envVar,
          provider: "local_encrypted",
          managedMode: "aoa_managed",
          value,
        },
        actorRef,
      )) as { id?: string; secretId?: string } | null;
      const createdId = created?.secretId ?? created?.id;
      if (!createdId) throw new Error("secret create returned no id");
      secretId = createdId;
    }

    // Audited INSIDE the tx. The raw key is NEVER included; the durable secret
    // reference is entityId (unredacted), matching routes/secrets.ts.
    await logActivity(txDb, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: `provider.key.${operation}`,
      entityType: "secret",
      entityId: secretId,
      details: {
        providerId: input.providerId,
        credentialOwnerId: target.ownerId,
        envVar: target.envVar,
        secretId,
        operation,
      },
    });

    return { secretId, operation };
  });

  return {
    secretId: result.secretId,
    providerId: input.providerId,
    credentialOwnerId: target.ownerId,
    envVar: target.envVar,
    operation: result.operation,
  };
}
