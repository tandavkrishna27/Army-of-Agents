import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@armyofagents/db";
import {
  agentProviderCredentialBindings,
  companyMemberships,
  providerCredentials,
} from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import { resolveScopedCliAuthHome, scopedCliAuthEnv } from "./cli-auth-topology.js";

export type CliSubscriptionProvider = "openai" | "anthropic";

export class ProviderCredentialBindingError extends Error {
  constructor(
    public readonly code:
      | "binding_missing"
      | "binding_ambiguous"
      | "binding_not_approved"
      | "credential_unavailable"
      | "credential_target_mismatch"
      | "credential_owner_inactive"
      | "credential_path_invalid"
      | "subscription_disabled_multi_tenant",
    message: string,
  ) {
    super(message);
    this.name = "ProviderCredentialBindingError";
  }
}

export function mayUseLegacySubscriptionHome(
  error: unknown,
  scopedCliAuthRequired: boolean,
): boolean {
  return (
    !scopedCliAuthRequired &&
    error instanceof ProviderCredentialBindingError &&
    error.code === "binding_missing"
  );
}

interface BindingCandidate {
  credentialId: string;
  credentialCompanyId: string;
  provider: string;
  ownerUserId: string;
  executionTargetId: string;
  kind: string;
  state: string;
  approvedAt: Date | null;
  bindingRevokedAt: Date | null;
  ownerMembershipStatus: string | null;
}

export function chooseGovernedSubscriptionBinding(
  candidates: BindingCandidate[],
  expected: {
    companyId: string;
    provider: CliSubscriptionProvider;
    executionTargetId: string;
  },
): BindingCandidate {
  if (candidates.length === 0) {
    throw new ProviderCredentialBindingError(
      "binding_missing",
      "No governed subscription credential is bound to this agent.",
    );
  }
  const approved = candidates.filter((candidate) => candidate.approvedAt && !candidate.bindingRevokedAt);
  if (approved.length === 0) {
    throw new ProviderCredentialBindingError(
      "binding_not_approved",
      "The agent's subscription credential binding is not approved or has been revoked.",
    );
  }
  const eligible = approved.filter(
    (candidate) =>
      candidate.credentialCompanyId === expected.companyId &&
      candidate.provider === expected.provider &&
      candidate.kind === "personal_subscription",
  );
  if (eligible.length === 0) {
    throw new ProviderCredentialBindingError(
      "credential_unavailable",
      "The bound credential does not belong to this company and provider.",
    );
  }
  const targetMatches = eligible.filter(
    (candidate) => candidate.executionTargetId === expected.executionTargetId,
  );
  if (targetMatches.length === 0) {
    throw new ProviderCredentialBindingError(
      "credential_target_mismatch",
      "The bound credential belongs to a different execution target.",
    );
  }
  const active = targetMatches.filter(
    (candidate) =>
      candidate.state === "verified" && candidate.ownerMembershipStatus === "active",
  );
  if (active.length === 0) {
    const inactiveOwner = targetMatches.some(
      (candidate) => candidate.ownerMembershipStatus !== "active",
    );
    throw new ProviderCredentialBindingError(
      inactiveOwner ? "credential_owner_inactive" : "credential_unavailable",
      inactiveOwner
        ? "The credential owner is no longer an active company member."
        : "The bound credential is not verified or has been revoked or suspended.",
    );
  }
  if (active.length !== 1) {
    throw new ProviderCredentialBindingError(
      "binding_ambiguous",
      "More than one active subscription credential is bound to this agent.",
    );
  }
  return active[0]!;
}

async function assertSafeCredentialHome(authHome: string, aoaHome: string): Promise<void> {
  const [resolvedHome, resolvedRoot] = await Promise.all([
    fs.realpath(authHome).catch(() => null),
    fs.realpath(aoaHome).catch(() => null),
  ]);
  if (
    !resolvedHome ||
    !resolvedRoot ||
    (resolvedHome !== resolvedRoot && !resolvedHome.startsWith(`${resolvedRoot}${path.sep}`))
  ) {
    throw new ProviderCredentialBindingError(
      "credential_path_invalid",
      "The bound credential home is missing or escapes the configured AOA data root.",
    );
  }
}

export async function resolveAgentSubscriptionEnvironment(
  db: Db,
  args: {
    companyId: string;
    agentId: string;
    provider: CliSubscriptionProvider;
    executionTargetId: string;
    env?: NodeJS.ProcessEnv;
    verifyPath?: boolean;
    /** Caller's deployment trust boundary. When "multi_tenant" this function fails
     *  closed — a personal subscription is a HOST-tied CLI login and must NEVER be
     *  materialized on a shared host. Optional so self-hosted callers/tests are
     *  unaffected; the two runtime callers (heartbeat legacy closure, resolver deps)
     *  pass their real topology. */
    trustBoundary?: string;
  },
): Promise<NodeJS.ProcessEnv> {
  // Multi-tenant fail-closed CHOKEPOINT (defense-in-depth). This is the sole
  // function that builds a subscription auth-home; enforcing the ban HERE makes
  // "personal_subscription is disabled in multi_tenant" un-bypassable regardless of
  // which caller reaches it (the new-model resolver backstop and the heartbeat
  // legacy closure also gate it upstream — this is the last line).
  if (args.trustBoundary === "multi_tenant") {
    throw new ProviderCredentialBindingError(
      "subscription_disabled_multi_tenant",
      "Personal subscription credentials are disabled on shared multi-tenant hosts.",
    );
  }
  const rows = await db
    .select({
      credentialId: providerCredentials.id,
      credentialCompanyId: providerCredentials.companyId,
      provider: providerCredentials.provider,
      ownerUserId: providerCredentials.ownerUserId,
      executionTargetId: providerCredentials.executionTargetId,
      kind: providerCredentials.kind,
      state: providerCredentials.state,
      approvedAt: agentProviderCredentialBindings.approvedAt,
      bindingRevokedAt: agentProviderCredentialBindings.revokedAt,
      ownerMembershipStatus: companyMemberships.status,
    })
    .from(agentProviderCredentialBindings)
    .innerJoin(
      providerCredentials,
      eq(agentProviderCredentialBindings.credentialId, providerCredentials.id),
    )
    .leftJoin(
      companyMemberships,
      and(
        eq(companyMemberships.companyId, providerCredentials.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, providerCredentials.ownerUserId),
      ),
    )
    .where(
      and(
        eq(agentProviderCredentialBindings.companyId, args.companyId),
        eq(agentProviderCredentialBindings.agentId, args.agentId),
      ),
    );

  const selected = chooseGovernedSubscriptionBinding(rows, args);
  const env = args.env ?? process.env;
  const authHome = resolveScopedCliAuthHome({
    env,
    companyId: args.companyId,
    userId: selected.ownerUserId,
    provider: args.provider,
    executionTargetId: args.executionTargetId,
  });
  if (args.verifyPath !== false) {
    const aoaHome = path.resolve(env.AOA_HOME?.trim() || path.join(os.homedir(), ".aoa"));
    await assertSafeCredentialHome(authHome, aoaHome);
  }
  const scoped = scopedCliAuthEnv(env, authHome, args.provider);
  return args.provider === "openai"
    ? { HOME: scoped.HOME, CODEX_HOME: scoped.CODEX_HOME }
    : { HOME: scoped.HOME, CLAUDE_CONFIG_DIR: scoped.CLAUDE_CONFIG_DIR };
}
