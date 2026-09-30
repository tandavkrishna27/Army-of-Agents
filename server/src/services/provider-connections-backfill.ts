// server/src/services/provider-connections-backfill.ts
import type { Db } from "@armyofagents/db";
import {
  agentProviderCredentialBindings,
  companies,
  companySecrets,
  providerAssignments,
  providerConnections,
  providerCredentials,
} from "@armyofagents/db";
import { and, eq, isNotNull, isNull, like } from "drizzle-orm";

export interface CompanyKeySecret {
  organizationId: string;
  companyId: string;
  secretId: string;
  providerId: string;
}
export interface SubscriptionBindingRow {
  organizationId: string;
  companyId: string;
  provider: string;
  ownerUserId: string;
  executionTargetId: string;
  agentId: string;
}

export interface BackfillPlan {
  connections: Array<{
    organizationId: string;
    companyId: string;
    provider: string;
    authMethod: "api_key" | "personal_subscription";
    secretRef: string | null;
    ownerUserId: string | null;
    executionTargetId: string | null;
    sharingPolicy: "company_agents" | "owner_only";
    state: "verified";
  }>;
  assignments: Array<{
    organizationId: string;
    companyId: string;
    provider: string;
    scopeType: "company_default" | "agent_override";
    scopeId: string | null;
  }>;
}

/** Pure planner — deterministic, unit-testable. Execution (below) inserts with
 *  ON CONFLICT DO NOTHING so re-runs are idempotent (identity uniques). */
export function planBackfill(input: {
  companyKeySecrets: CompanyKeySecret[];
  subscriptionBindings: SubscriptionBindingRow[];
}): BackfillPlan {
  const plan: BackfillPlan = { connections: [], assignments: [] };
  for (const s of input.companyKeySecrets) {
    plan.connections.push({
      organizationId: s.organizationId,
      companyId: s.companyId,
      provider: s.providerId,
      authMethod: "api_key",
      secretRef: s.secretId,
      ownerUserId: null,
      executionTargetId: null,
      sharingPolicy: "company_agents",
      state: "verified",
    });
    plan.assignments.push({
      organizationId: s.organizationId,
      companyId: s.companyId,
      provider: s.providerId,
      scopeType: "company_default",
      scopeId: null,
    });
  }
  for (const b of input.subscriptionBindings) {
    plan.connections.push({
      organizationId: b.organizationId,
      companyId: b.companyId,
      provider: b.provider,
      authMethod: "personal_subscription",
      secretRef: null,
      ownerUserId: b.ownerUserId,
      executionTargetId: b.executionTargetId,
      sharingPolicy: "owner_only",
      state: "verified",
    });
    plan.assignments.push({
      organizationId: b.organizationId,
      companyId: b.companyId,
      provider: b.provider,
      scopeType: "agent_override",
      scopeId: b.agentId,
    });
  }
  return plan;
}

/**
 * Idempotent execution: load existing legacy rows, plan, insert-or-ignore. Loads
 * `company_secrets` named `provider:%` and verified personal_subscription
 * provider_credentials + approved bindings. termsAttestedAt + verifiedAt are set
 * to now for backfilled rows (they were already in production use = implicitly
 * attested). Re-runs insert nothing (identity + scope uniques from Task 1).
 */
export interface BackfillSummary {
  inserted: number;
  skipped: number;
  errors: number;
}

export async function runProviderConnectionsBackfill(
  db: Db,
  log: (level: "info" | "warn", msg: string, meta?: Record<string, unknown>) => void = () => {},
  opts: { skipSubscriptions?: boolean } = {},
): Promise<BackfillSummary> {
  // Personal-subscription connections are banned on a shared multi-tenant host —
  // this boot reconciler is a personal_subscription MINT path, so it must honor the
  // same ban (assertSubscriptionAllowed on the create route / verify() / login).
  // A self-hosted → multi_tenant data-dir cutover preserves the founder's legacy
  // verified subscription + binding; without this gate the backfill would revive it
  // into a resolvable connection. (The resolver ALSO refuses to resolve a
  // personal_subscription in multi_tenant — this is the belt to that suspenders.)
  // Resolved from deployment config unless the caller overrides (tests).
  let skipSubscriptions = opts.skipSubscriptions;
  if (skipSubscriptions === undefined) {
    try {
      const { loadConfig } = await import("../config.js");
      const { resolveCliAuthTopology } = await import("./cli-auth-topology.js");
      const cfg = loadConfig();
      const topology = resolveCliAuthTopology({
        deploymentMode: cfg.deploymentMode,
        deploymentExposure: cfg.deploymentExposure,
      });
      skipSubscriptions = topology.trustBoundary === "multi_tenant";
    } catch {
      // Config unavailable (e.g. a minimal test harness) → default to the historical
      // behavior (mint subscriptions). Safe: only multi_tenant needs the ban, and a
      // multi_tenant deployment always has resolvable config.
      skipSubscriptions = false;
    }
  }

  // (1) Company provider API keys → api_key connections. Derive organization_id
  // from the OWNING COMPANY (companies.organization_id is NOT NULL) rather than
  // company_secrets.organization_id — a pre-0189 secret's own column can be NULL,
  // and the identity unique (0195) leads with organization_id, so a NULL org here
  // would break ON CONFLICT arbiter inference / mis-scope the row.
  const keyRows = await db
    .select({
      organizationId: companies.organizationId,
      companyId: companySecrets.companyId,
      secretId: companySecrets.id,
      name: companySecrets.name,
    })
    .from(companySecrets)
    .innerJoin(companies, eq(companies.id, companySecrets.companyId))
    .where(
      and(
        like(companySecrets.name, "provider:%"),
        isNull(companySecrets.deletedAt),
        eq(companySecrets.status, "active"),
      ),
    );
  const companyKeySecrets: CompanyKeySecret[] = keyRows.map((r) => ({
    organizationId: r.organizationId,
    companyId: r.companyId,
    secretId: r.secretId,
    // `provider:<ownerId>` → catalog owner id (the same key the resolver reads).
    providerId: r.name.slice("provider:".length),
  }));

  // (2) Verified personal subscriptions with an approved (unrevoked) binding.
  //
  // NOTE (real-schema adaptation): provider_credentials.owner_user_id AND
  // execution_target_id are BOTH declared NOT NULL (provider_credentials.ts:18,21),
  // so the plan's M4 "verified sub with NULL owner/target" can never exist. The
  // isNotNull() pre-filters below are therefore defensive no-ops kept for
  // defense-in-depth (a future nullable-column migration would silently start
  // relying on them). The real exclusion this WHERE enforces is the binding gate:
  // a verified subscription with no APPROVED, unrevoked binding is excluded.
  const subRows = skipSubscriptions
    ? []
    : await db
        .select({
          // provider_credentials has NO organization_id column → derive it from the
          // owning company (companies.organization_id is NOT NULL). Required for the
          // org-scoped identity unique (0195) ON CONFLICT arbiter.
          organizationId: companies.organizationId,
          companyId: providerCredentials.companyId,
          provider: providerCredentials.provider,
          ownerUserId: providerCredentials.ownerUserId,
          executionTargetId: providerCredentials.executionTargetId,
          agentId: agentProviderCredentialBindings.agentId,
        })
        .from(providerCredentials)
        .innerJoin(companies, eq(companies.id, providerCredentials.companyId))
        .innerJoin(
          agentProviderCredentialBindings,
          eq(agentProviderCredentialBindings.credentialId, providerCredentials.id),
        )
        .where(
          and(
            eq(providerCredentials.kind, "personal_subscription"),
            eq(providerCredentials.state, "verified"),
            // M4: a verified sub with NULL owner/target would violate the connection
            // subscription CHECK (23514) and abort the whole reconciler — pre-filter.
            // (Defensive: both columns are NOT NULL in the real schema today.)
            isNotNull(providerCredentials.ownerUserId),
            isNotNull(providerCredentials.executionTargetId),
            isNotNull(agentProviderCredentialBindings.approvedAt),
            isNull(agentProviderCredentialBindings.revokedAt),
          ),
        );
  const subscriptionBindings: SubscriptionBindingRow[] = subRows.map((r) => ({
    organizationId: r.organizationId,
    companyId: r.companyId,
    provider: r.provider,
    ownerUserId: r.ownerUserId,
    executionTargetId: r.executionTargetId,
    agentId: r.agentId,
  }));

  const plan = planBackfill({ companyKeySecrets, subscriptionBindings });
  const now = new Date();
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < plan.connections.length; i++) {
    const conn = plan.connections[i]!;
    const asn = plan.assignments[i]!;
    // M4: isolate each item. ONE malformed row must never abort the whole
    // reconciler (which is best-effort at boot and would otherwise swallow the
    // error into a silent zero backfill). A conflict is a skip; a real error is
    // counted and logged, and the loop continues.
    try {
      const didInsert = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Insert-or-ignore the connection; capture id (re-select on conflict).
        // The ON CONFLICT arbiter is the identity unique columns (matches the
        // nullsNotDistinct `provider_connections_identity_uq`); the constraint
        // BUILDER (table.identityUq) is not a runtime column ref, so the column
        // target array is used — same form as readiness.ts's scope upsert.
        const insertedConn = await txDb
          .insert(providerConnections)
          .values({
            organizationId: conn.organizationId,
            companyId: conn.companyId,
            provider: conn.provider,
            authMethod: conn.authMethod,
            ownerUserId: conn.ownerUserId,
            executionTargetId: conn.executionTargetId,
            secretRef: conn.secretRef,
            state: "verified",
            sharingPolicy: conn.sharingPolicy,
            termsAttestedAt: now,
            verifiedAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [
              providerConnections.organizationId,
              providerConnections.companyId,
              providerConnections.provider,
              providerConnections.authMethod,
              providerConnections.ownerUserId,
              providerConnections.executionTargetId,
            ],
          })
          .returning({ id: providerConnections.id });
        let connectionId = insertedConn[0]?.id ?? null;
        const created = connectionId !== null;
        if (!connectionId) {
          const [existing] = await txDb
            .select({ id: providerConnections.id })
            .from(providerConnections)
            .where(
              and(
                // organization_id is non-null here (derived from companies.organization_id).
                eq(providerConnections.organizationId, conn.organizationId),
                conn.companyId
                  ? eq(providerConnections.companyId, conn.companyId)
                  : isNull(providerConnections.companyId),
                eq(providerConnections.provider, conn.provider),
                eq(providerConnections.authMethod, conn.authMethod),
                conn.ownerUserId
                  ? eq(providerConnections.ownerUserId, conn.ownerUserId)
                  : isNull(providerConnections.ownerUserId),
                conn.executionTargetId
                  ? eq(providerConnections.executionTargetId, conn.executionTargetId)
                  : isNull(providerConnections.executionTargetId),
              ),
            )
            .limit(1);
          connectionId = existing?.id ?? null;
        }
        if (!connectionId) return false; // unreachable in practice; skip the assignment safely
        // Assignment is upserted on EVERY pass (even when the connection already
        // existed) so a re-run still links a missing assignment; the scope unique
        // makes the re-insert a no-op.
        await txDb
          .insert(providerAssignments)
          .values({
            organizationId: asn.organizationId,
            companyId: asn.companyId,
            provider: asn.provider,
            connectionId,
            scopeType: asn.scopeType,
            scopeId: asn.scopeId,
            state: "active",
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [
              providerAssignments.organizationId,
              providerAssignments.companyId,
              providerAssignments.provider,
              providerAssignments.scopeType,
              providerAssignments.scopeId,
            ],
          });
        return created;
      });
      if (didInsert) inserted++;
      else skipped++;
    } catch (err) {
      // M4: one bad row must not abort the reconciler. Count + log + continue.
      errors++;
      log("warn", "provider-connections backfill: item skipped after error", {
        provider: conn.provider,
        authMethod: conn.authMethod,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log("info", "provider-connections backfill complete", { inserted, skipped, errors });
  return { inserted, skipped, errors };
}
