import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@armyofagents/db";
import {
  agentProviderCredentialBindings,
  internalAgentConfig,
  providerCredentials,
} from "@armyofagents/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { resolveCliAuthTopology, resolveScopedCliAuthHome } from "./cli-auth-topology.js";
import { logActivity } from "./activity-log.js";
import { loadConfig } from "../config.js";
import { unprocessable } from "../errors.js";

type ScopedSubscriptionCredential = {
  companyId: string;
  userId: string;
  provider: "openai" | "anthropic";
  executionTargetId: string;
};

function resolveCredentialHome(
  args: ScopedSubscriptionCredential & { env?: NodeJS.ProcessEnv },
): string {
  return resolveScopedCliAuthHome({
    env: args.env,
    executionTargetId: args.executionTargetId,
    companyId: args.companyId,
    userId: args.userId,
    provider: args.provider,
  });
}

export async function markScopedSubscriptionVerified(
  db: Db,
  args: ScopedSubscriptionCredential,
): Promise<string[]> {
  // Fail closed on a shared multi-tenant host: never PROMOTE a personal_subscription
  // credential to verified. This is the verify-path member of the "every mint/verify
  // path asserts" BOOT INVARIANT contract (provider-connections.ts:12-19); both
  // callers (verifyAndBindCommanderSubscriptionCredential + the commander-verify
  // route) flow through here, so gating it here covers them locally. (Defense-in-
  // depth: even without this, the resolver backstop + heartbeat gate + subscription
  // chokepoint already prevent a verified sub from being injected into a run.)
  const topology = resolveCliAuthTopology({
    deploymentMode: loadConfig().deploymentMode,
    deploymentExposure: loadConfig().deploymentExposure,
  });
  if (topology.trustBoundary === "multi_tenant") {
    throw unprocessable(
      "Personal subscription credentials are disabled on shared multi-tenant hosts.",
      { code: "subscription_disabled_multi_tenant" },
    );
  }
  const authHome = resolveCredentialHome(args);
  const credentialFile = path.join(
    authHome,
    args.provider === "openai" ? "auth.json" : ".credentials.json",
  );
  // Do not follow a credential-file symlink out of the scoped auth home.
  const stat = await fs.lstat(credentialFile).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) return [];
  const now = new Date();
  const rows = await db
    .update(providerCredentials)
    .set({ state: "verified", verifiedAt: now, updatedAt: now })
    .where(
      and(
        eq(providerCredentials.companyId, args.companyId),
        eq(providerCredentials.provider, args.provider),
        eq(providerCredentials.ownerUserId, args.userId),
        eq(providerCredentials.executionTargetId, args.executionTargetId),
        eq(providerCredentials.kind, "personal_subscription"),
        inArray(providerCredentials.state, ["pending", "verified"]),
      ),
    )
    .returning({ id: providerCredentials.id });
  return rows.map((row) => row.id);
}

/**
 * Promote provider-native evidence and approve it for the configured Commander
 * in one transaction. Without the binding, enabling AOA_SCOPED_CLI_AUTH makes
 * the very next heartbeat fail closed with `binding_missing`.
 */
export async function verifyAndBindCommanderSubscriptionCredential(
  db: Db,
  args: ScopedSubscriptionCredential & { actorUserId: string },
): Promise<{ credentialIds: string[]; bindingIds: string[] }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const credentialIds = await markScopedSubscriptionVerified(txDb, args);
    if (credentialIds.length === 0) return { credentialIds, bindingIds: [] };

    const [commander] = await txDb
      .select({ agentId: internalAgentConfig.agentId })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, args.companyId))
      .limit(1);
    const agentId = commander?.agentId ?? null;
    const bindingIds: string[] = [];

    if (agentId) {
      await txDb.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`provider-binding:${args.companyId}:${agentId}:${args.provider}`}))`,
      );
      const active = await txDb
        .select({
          id: agentProviderCredentialBindings.id,
          credentialId: agentProviderCredentialBindings.credentialId,
        })
        .from(agentProviderCredentialBindings)
        .innerJoin(
          providerCredentials,
          eq(agentProviderCredentialBindings.credentialId, providerCredentials.id),
        )
        .where(
          and(
            eq(agentProviderCredentialBindings.companyId, args.companyId),
            eq(agentProviderCredentialBindings.agentId, agentId),
            eq(providerCredentials.provider, args.provider),
            isNull(agentProviderCredentialBindings.revokedAt),
          ),
        );
      const now = new Date();
      for (const binding of active) {
        if (credentialIds.includes(binding.credentialId)) continue;
        await txDb
          .update(agentProviderCredentialBindings)
          .set({ revokedAt: now, updatedAt: now })
          .where(eq(agentProviderCredentialBindings.id, binding.id));
      }
      for (const credentialId of credentialIds) {
        const [binding] = await txDb
          .insert(agentProviderCredentialBindings)
          .values({
            companyId: args.companyId,
            agentId,
            credentialId,
            approvedByUserId: args.actorUserId,
            approvedAt: now,
            revokedAt: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              agentProviderCredentialBindings.agentId,
              agentProviderCredentialBindings.credentialId,
            ],
            set: {
              approvedByUserId: args.actorUserId,
              approvedAt: now,
              revokedAt: null,
              updatedAt: now,
            },
          })
          .returning({ id: agentProviderCredentialBindings.id });
        if (binding) bindingIds.push(binding.id);
      }
    }

    await logActivity(txDb, {
      companyId: args.companyId,
      actorType: "user",
      actorId: args.actorUserId,
      action: "commander.subscription.verified",
      entityType: "provider_credential",
      entityId: credentialIds[0]!,
      agentId,
      details: {
        provider: args.provider,
        executionTargetId: args.executionTargetId,
        credentialIds,
        bindingIds,
      },
    });
    return { credentialIds, bindingIds };
  });
}

export async function removeScopedSubscriptionCredentialHome(
  args: ScopedSubscriptionCredential & { env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  const root = path.resolve(
    args.env?.AOA_HOME?.trim() || process.env.AOA_HOME?.trim() || path.join(os.homedir(), ".aoa"),
  );
  const authHome = resolveCredentialHome({ ...args, env: { ...process.env, ...args.env, AOA_HOME: root } });
  const entry = await fs.lstat(authHome).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Credential home is not a regular scoped directory");
  }
  const [realRoot, realHome] = await Promise.all([fs.realpath(root), fs.realpath(authHome)]);
  const expectedParent = path.join(realRoot, "execution-targets");
  if (
    realHome === realRoot ||
    !realHome.startsWith(`${expectedParent}${path.sep}`) ||
    path.basename(realHome) !== args.provider
  ) {
    throw new Error("Credential home escapes the configured AOA data root");
  }
  await fs.rm(realHome, { recursive: true, force: false });
  return true;
}
