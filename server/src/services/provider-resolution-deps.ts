// server/src/services/provider-resolution-deps.ts
import type { Db } from "@armyofagents/db";
import { providerAssignments, providerConnections } from "@armyofagents/db";
import { and, eq, isNull, or } from "drizzle-orm";
import type { CliAuthTopology } from "./cli-auth-topology.js";
import { secretService } from "./secrets.js";
import { companyKeyTargetForAdapter } from "./secrets.js";
import { envVarForProvider } from "./providers/provider-key.js";
import {
  resolveAgentSubscriptionEnvironment,
  type CliSubscriptionProvider,
} from "./provider-credential-bindings.js";
import { candidateMatchesScope } from "./provider-resolution.js";
import type {
  CandidateRow,
  ResolveArgs,
  ResolveDeps,
} from "./provider-resolution.js";

/**
 * Live wiring. Every credential read REUSES an existing service:
 *   - secret_ref value  → secretService.resolveSecretValue (owner-hop respected upstream)
 *   - subscription home → resolveAgentSubscriptionEnvironment (home-safety untouched)
 *   - legacy fallback   → secretService.resolveAdapterConfigForRuntime
 */
export function buildResolveDeps(db: Db, topology: CliAuthTopology): ResolveDeps {
  const secrets = secretService(db);
  return {
    async loadCandidateRows(_db: Db, args: ResolveArgs): Promise<CandidateRow[]> {
      const query = db
        .select({
          connectionId: providerConnections.id,
          authMethod: providerConnections.authMethod,
          scopeType: providerAssignments.scopeType,
          scopeId: providerAssignments.scopeId,
          priority: providerAssignments.priority,
          connectionUpdatedAt: providerConnections.updatedAt,
          state: providerConnections.state,
          termsAttestedAt: providerConnections.termsAttestedAt,
          sharingPolicy: providerConnections.sharingPolicy,
          connectionCompanyId: providerConnections.companyId,
          connectionOrganizationId: providerConnections.organizationId,
          connectionOwnerUserId: providerConnections.ownerUserId,
          executionTargetId: providerConnections.executionTargetId,
          config: providerConnections.config,
          secretRef: providerConnections.secretRef,
        })
        .from(providerAssignments)
        .innerJoin(providerConnections, eq(providerAssignments.connectionId, providerConnections.id));

      // Cross-tenant safety (M1): an org_default row is included ONLY when its
      // organization_id equals the run's organization_id. When the run has no
      // organization_id (pre-P1 company), org_default is skipped entirely — never
      // "include every org_default". Company rows are always scoped by company_id.
      const orgDefaultClause = args.organizationId
        ? and(
            isNull(providerAssignments.companyId),
            eq(providerAssignments.scopeType, "org_default"),
            eq(providerAssignments.organizationId, args.organizationId),
          )
        : null;
      const scopeClause = orgDefaultClause
        ? or(eq(providerAssignments.companyId, args.companyId), orgDefaultClause)
        : eq(providerAssignments.companyId, args.companyId);
      const rowsQuery = query.where(
        and(
          eq(providerAssignments.provider, args.provider),
          eq(providerAssignments.state, "active"),
          scopeClause,
        ),
      );
      const rows = await rowsQuery;

      // Filter scoped rows to THIS agent / owner + defense-in-depth org gate.
      // The org-scope decision is the pure candidateMatchesScope (M1 cross-tenant
      // safety), unit-tested independently in Task 15.
      return rows
        .filter((r) => candidateMatchesScope(r, args))
        .map((r) => ({
          ...r,
          connectionUpdatedAt: r.connectionUpdatedAt ? new Date(r.connectionUpdatedAt).getTime() : 0,
          config: (r.config as Record<string, unknown>) ?? {},
        })) as CandidateRow[];
    },

    async resolveSecretValueForConnection(_db, row, args) {
      if (!row.secretRef) return null;
      return secrets.resolveSecretValue(args.companyId, row.secretRef, "latest", {
        ...args.context,
        configPath: `provider_connection.${row.connectionId}`,
      });
    },

    async resolveSubscriptionEnv(_db, row, args) {
      const provider = args.provider as CliSubscriptionProvider;
      const env = await resolveAgentSubscriptionEnvironment(db, {
        companyId: args.companyId,
        agentId: args.agentId ?? "",
        provider,
        executionTargetId: row.executionTargetId ?? args.executionTargetId,
        // Chokepoint consistency: the resolver's Layer-1 backstop already skips
        // personal_subscription candidates in multi_tenant before this runs, so this
        // is never reached there — but pass the real topology so the invariant holds
        // if that guard is ever bypassed.
        trustBoundary: topology.trustBoundary,
      });
      // Narrow NodeJS.ProcessEnv → Record<string,string>.
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
      return out;
    },

    envVarForProvider: (provider: string) => {
      // Reuse the same env var the api-key ladder uses (owner-hopped internally).
      try {
        return envVarForProvider(provider);
      } catch {
        const target = companyKeyTargetForAdapter(`${provider}_local`);
        return target?.envVar ?? "ANTHROPIC_API_KEY";
      }
    },

    async legacyResolveConfig(cfg) {
      // Caller passes adapterType-specific closure; here we can't know it, so this
      // default is replaced by the call-site wiring (Tasks 11-13) which binds the
      // real adapterType. Kept as identity so unit tests exercise the seam.
      return cfg;
    },

    async legacySubscriptionEnv(_postLegacyEnv) {
      return null;
    },

    selfHostedSingleTenant: topology.trustBoundary !== "multi_tenant",

    // Dark-launch kill-switch: AOA_PROVIDER_RESOLVER=legacy skips the new-model
    // candidate read so every run resolves exactly as it does today (legacy
    // ladder only) with no redeploy.
    bypassNewModel: (process.env.AOA_PROVIDER_RESOLVER?.trim().toLowerCase() ?? "") === "legacy",
  };
}
