// server/src/services/provider-resolution.ts
import type { AuthMethod, SharingPolicy } from "@armyofagents/shared";

export interface MaterializeInput {
  authMethod: AuthMethod;
  provider: string;
  /** The provider's canonical api-key env var (envVarForProvider). */
  envVar: string;
  /** Resolved secret VALUE for shareable methods; null when none. */
  secretValue: string | null;
  config: Record<string, unknown>;
  /** For personal_subscription only: the home env from resolveAgentSubscriptionEnvironment. */
  subscriptionEnv: Record<string, string> | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// GATEWAY_TOKEN_ENV_ALLOWLIST + DEFAULT_GATEWAY_TOKEN_ENV are the SINGLE source of
// truth in @armyofagents/shared (Task 3) — imported, never re-declared, so the
// create-time validation and this materialization clamp cannot drift.
import {
  DEFAULT_GATEWAY_TOKEN_ENV,
  GATEWAY_TOKEN_ENV_ALLOWLIST,
} from "@armyofagents/shared";

/**
 * Normalize any auth method to an env patch. This is the ONE seam that hides the
 * "api-key value vs subscription auth-home" divergence behind a single shape — a
 * patch merged onto config.env by applyResolvedCredential. Empty secret ⇒ inject
 * nothing (secrets.ts:970-973). The token env var for anthropic gateway is
 * ANTHROPIC_AUTH_TOKEN (a bearer for a proxy), NOT ANTHROPIC_API_KEY.
 */
export function materializeEnvPatch(input: MaterializeInput): Record<string, string> {
  switch (input.authMethod) {
    case "api_key": {
      const v = str(input.secretValue);
      return v ? { [input.envVar]: v } : {};
    }
    case "enterprise_gateway": {
      const base = str(input.config.baseUrl);
      const patch: Record<string, string> = {};
      if (base) patch.ANTHROPIC_BASE_URL = base;
      const token = str(input.secretValue);
      if (token) {
        const requested = str(input.config.tokenEnvVar) ?? DEFAULT_GATEWAY_TOKEN_ENV;
        const tokenEnv = GATEWAY_TOKEN_ENV_ALLOWLIST.has(requested)
          ? requested
          : DEFAULT_GATEWAY_TOKEN_ENV;
        patch[tokenEnv] = token;
      }
      return patch;
    }
    case "personal_subscription": {
      return { ...(input.subscriptionEnv ?? {}) };
    }
  }
}

import type { AssignmentScopeType } from "@armyofagents/shared";

export interface Candidate {
  connectionId: string;
  authMethod: AuthMethod;
  scopeType: AssignmentScopeType;
  priority: number;
  connectionUpdatedAt: number;
}

const SCOPE_RANK: Record<AssignmentScopeType, number> = {
  agent_override: 3,
  personal_execution_default: 2,
  company_default: 1,
  org_default: 0,
};

/** Deterministic precedence order: scope rank, then priority DESC, then recency DESC. */
export function orderCandidates<T extends Candidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (SCOPE_RANK[a.scopeType] !== SCOPE_RANK[b.scopeType]) {
      return SCOPE_RANK[b.scopeType] - SCOPE_RANK[a.scopeType];
    }
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.connectionUpdatedAt - a.connectionUpdatedAt;
  });
}

// `SharingPolicy` is already imported at the top of this file (Task 4); the plan's
// Task-6 block re-imports it, which would be a duplicate identifier — only the new
// value `isShareableAuthMethod` is imported here.
import { isShareableAuthMethod } from "@armyofagents/shared";

export type ProviderResolutionActor = "crew" | "org" | "commander";

export interface GateInput {
  authMethod: AuthMethod;
  scopeType: AssignmentScopeType;
  state: string;
  termsAttestedAt: Date | null;
  sharingPolicy: SharingPolicy;
  actorKind: ProviderResolutionActor;
  connectionCompanyId: string | null;
  requestCompanyId: string;
  connectionOwnerUserId: string | null;
  /** The acting/owner user for this run (Commander user, or the target owner). */
  requestOwnerUserId: string | null;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Static (non-subscription) fail-closed gates. The personal_subscription
 * candidate ALSO runs chooseGovernedSubscriptionBinding downstream (owner-active,
 * target match, exactly-one) — this gate only enforces the rules that need no DB
 * join. A failing candidate is SKIPPED, not fatal (the caller tries the next).
 */
export function candidatePassesStaticGates(input: GateInput): GateResult {
  if (input.state !== "verified") return { ok: false, reason: "state_not_verified" };
  if (!input.termsAttestedAt) return { ok: false, reason: "terms_not_attested" };
  // org/company defaults may only route shareable methods (locked decision).
  if (
    (input.scopeType === "org_default" || input.scopeType === "company_default") &&
    !isShareableAuthMethod(input.authMethod)
  ) {
    return { ok: false, reason: "non_shareable_default" };
  }
  // Sharing policy.
  switch (input.sharingPolicy) {
    case "owner_only":
      if (!input.requestOwnerUserId || input.requestOwnerUserId !== input.connectionOwnerUserId) {
        return { ok: false, reason: "owner_only_mismatch" };
      }
      break;
    case "company_agents":
      if (input.connectionCompanyId && input.connectionCompanyId !== input.requestCompanyId) {
        return { ok: false, reason: "company_scope_mismatch" };
      }
      break;
    case "org_agents":
      // org-scope enforced by the assignment query (organization_id filter); allow here.
      break;
  }
  return { ok: true };
}

import type { Db } from "@armyofagents/db";
import { SecretCandidateUnavailableError } from "../secrets/secret-candidate-errors.js";
import { ProviderCredentialBindingError } from "./provider-credential-bindings.js";
import type { SecretConsumerContext } from "./secrets.js";

export interface ResolveArgs {
  organizationId: string | null;
  companyId: string;
  agentId: string | null;
  actorKind: ProviderResolutionActor;
  adapterType: string;
  provider: string;
  executionTargetId: string;
  currentEnv: Record<string, string>;
  context: Omit<SecretConsumerContext, "configPath">;
}

export interface CandidateRow extends Candidate {
  // Assignment scope target: agents.id for agent_override, owner_user_id for
  // personal_execution_default, NULL for org/company defaults. Selected by
  // loadCandidateRows (Task 8) and read by candidateMatchesScope. (The plan's
  // Task-5 Candidate + Task-7 CandidateRow omitted this field while
  // candidateMatchesScope Picks it — added here so the types match the SQL.)
  scopeId: string | null;
  state: string;
  termsAttestedAt: Date | null;
  sharingPolicy: SharingPolicy;
  connectionCompanyId: string | null;
  connectionOrganizationId: string | null;
  connectionOwnerUserId: string | null;
  executionTargetId: string | null;
  config: Record<string, unknown>;
  secretRef: string | null;
}

/**
 * Per-row scope predicate (pure, unit-testable). The org_default branch is the
 * cross-tenant safety gate (M1): both sides must be present AND equal — NEVER
 * `!args.organizationId`, which admitted every tenant's org_default. Called by
 * buildResolveDeps.loadCandidateRows after the SQL scope filter (defense in depth).
 */
export function candidateMatchesScope(
  row: Pick<CandidateRow, "scopeType" | "scopeId" | "connectionOrganizationId">,
  args: Pick<ResolveArgs, "agentId" | "organizationId">,
): boolean {
  if (row.scopeType === "agent_override") return row.scopeId === args.agentId;
  if (row.scopeType === "personal_execution_default") return true; // owner match in gate
  if (row.scopeType === "org_default") {
    return Boolean(args.organizationId) && row.connectionOrganizationId === args.organizationId;
  }
  return true; // company_default
}

/** Injected so the resolver stays unit-testable and REUSES existing services. */
export interface ResolveDeps {
  loadCandidateRows: (db: Db, args: ResolveArgs) => Promise<CandidateRow[]>;
  resolveSecretValueForConnection: (db: Db, row: CandidateRow, args: ResolveArgs) => Promise<string | null>;
  /** REUSES resolveAgentSubscriptionEnvironment (home safety + owner-hop untouched). */
  resolveSubscriptionEnv: (db: Db, row: CandidateRow, args: ResolveArgs) => Promise<Record<string, string>>;
  envVarForProvider: (provider: string) => string;
  /** LEGACY fallback = secrets.ts resolveAdapterConfigForRuntime output env delta. */
  legacyResolveConfig: (cfg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** LEGACY subscription home (heartbeat block), or null when N/A. Receives the
   *  POST-legacyResolveConfig env (i.e. AFTER the company-key fallback ran) so the
   *  closure can honor the pre-P4 ordering "company key present ⇒ NO subscription-
   *  home redirect". Reading the pre-fallback env here would inject a subscription
   *  home on top of a company key for an unmigrated company (a strangler regression). */
  legacySubscriptionEnv: (postLegacyEnv: Record<string, string>) => Promise<Record<string, string> | null>;
  selfHostedSingleTenant: boolean;
  /** AOA_PROVIDER_RESOLVER=legacy → skip the new-model read (Steps 1-3). */
  bypassNewModel: boolean;
}

export type ResolvedProviderCredential =
  | { source: "agent_env_override" }
  | {
      source: "connection";
      connectionId: string;
      authMethod: AuthMethod;
      sharingScope: SharingPolicy;
      envPatch: Record<string, string>;
      provenance: {
        scopeType: AssignmentScopeType;
        ownerUserId: string | null;
        executionTargetId: string | null;
      };
    }
  | { source: "legacy"; envPatch: Record<string, string> }
  | { source: "host_login_fallback" };

/**
 * P4→P5 SEAM. The NORMALIZED result Phase 5 consumes instead of reading
 * provider_credentials directly (P5 Task 9 references THIS, by name). Maps the
 * three auth methods onto P5's two-value credential kind + the execution-target
 * slug the connection is pinned to.
 *   api_key | enterprise_gateway     → "company_api_key"
 *   personal_subscription            → "personal_subscription"
 *   anything else (override/legacy/host) → null
 */
export interface ExecutionTargetCredentialHint {
  credentialKind: "company_api_key" | "personal_subscription" | null;
  executionTargetSlug: string | null;
}

export function toExecutionTargetHint(
  resolved: ResolvedProviderCredential,
): ExecutionTargetCredentialHint {
  if (resolved.source !== "connection") {
    return { credentialKind: null, executionTargetSlug: null };
  }
  let credentialKind: Exclude<ExecutionTargetCredentialHint["credentialKind"], null>;
  switch (resolved.authMethod) {
    case "api_key":
    case "enterprise_gateway":
      credentialKind = "company_api_key";
      break;
    case "personal_subscription":
      credentialKind = "personal_subscription";
      break;
    default: {
      const unsupported: never = resolved.authMethod;
      throw new Error(`Unsupported provider auth method: ${String(unsupported)}`);
    }
  }
  return { credentialKind, executionTargetSlug: resolved.provenance.executionTargetId };
}

/**
 * Fail-closed error for cloud (multi_tenant) resolution. A rejected assignment or
 * a total miss in multi-tenant NEVER falls through to an ambient host login —
 * cloud runtime has no operator CLI to borrow. Carries the connection id + reason
 * of the last rejection for a crisp founder-facing diagnosis.
 */
export class ProviderUnavailableError extends Error {
  readonly code = "provider_unavailable";
  constructor(
    readonly provider: string,
    readonly reason: string,
    readonly connectionId: string | null,
  ) {
    super(
      `No usable ${provider} provider credential for this run (${reason}` +
        (connectionId ? `, connection ${connectionId}` : "") +
        "). On AoA Cloud, agents and Commander run on a per-company provider key — " +
        "set one for this company in Settings → Providers, then retry.",
    );
    this.name = "ProviderUnavailableError";
  }
}

/**
 * The ONE unified resolver. Reads the new model FIRST (Step 1-3); on no-winner it
 * falls back to the LEGACY ladder (Step 4) so unmigrated companies are unaffected.
 * Step 0 preserves "a per-agent value always wins" (secrets.ts:196 / D4). Tail:
 * host_login_fallback is ONLY for self-hosted single-tenant; multi-tenant fails
 * closed via ProviderUnavailableError (locked decision, item 22).
 */
export async function resolveProviderCredential(
  db: Db,
  args: ResolveArgs,
  deps: ResolveDeps,
): Promise<ResolvedProviderCredential> {
  // Step 0 — agent explicit override (api key already present & non-empty).
  const envVar = deps.envVarForProvider(args.provider);
  const existing = args.currentEnv[envVar];
  if (typeof existing === "string" && existing.trim().length > 0) {
    return { source: "agent_env_override" };
  }

  // Step 1 — assignment lookup (new model), UNLESS the kill-switch is set. When
  // AOA_PROVIDER_RESOLVER=legacy, the new-model read (Steps 1-3) is skipped
  // entirely and resolution falls straight through to the legacy ladder (Step 4),
  // reproducing today's behavior with no redeploy. Step 0 still runs first.
  const rows = deps.bypassNewModel ? [] : await deps.loadCandidateRows(db, args);
  const ordered = orderCandidates(rows);

  // Step 2 — first candidate that passes all gates wins. Track the last rejection
  // so the multi-tenant fail-closed error names a real connection + reason.
  let lastRejection: { connectionId: string; reason: string } | null = null;
  for (const row of ordered) {
    // ── Multi-tenant fail-closed backstop (defense-in-depth over the mint-time
    // assertSubscriptionAllowed gate) ────────────────────────────────────────────
    // A personal_subscription is a HOST-tied on-disk CLI login; it can NEVER be
    // resolved on a shared multi-tenant host, regardless of HOW the connection row
    // was minted. The mint gates (create route / verify() / login-runtime) are the
    // first line, but a self-hosted → multi_tenant data-dir cutover can still revive
    // a legacy subscription into a verified connection via the boot backfill — so
    // this is the last line: any personal_subscription candidate is skipped when the
    // run is NOT self-hosted single-tenant. (selfHostedSingleTenant === false ⇔
    // trustBoundary === "multi_tenant".)
    if (row.authMethod === "personal_subscription" && !deps.selfHostedSingleTenant) {
      lastRejection = {
        connectionId: row.connectionId,
        reason: "subscription_disabled_multi_tenant",
      };
      continue;
    }
    const gate = candidatePassesStaticGates({
      authMethod: row.authMethod,
      scopeType: row.scopeType,
      state: row.state,
      termsAttestedAt: row.termsAttestedAt,
      sharingPolicy: row.sharingPolicy,
      actorKind: args.actorKind,
      connectionCompanyId: row.connectionCompanyId,
      requestCompanyId: args.companyId,
      connectionOwnerUserId: row.connectionOwnerUserId,
      requestOwnerUserId: subscriptionOwnerContext(args, row),
    });
    if (!gate.ok) {
      lastRejection = { connectionId: row.connectionId, reason: gate.reason ?? "gate_failed" };
      continue;
    }

    // Step 3 — materialize.
    let subscriptionEnv: Record<string, string> | null = null;
    let secretValue: string | null = null;
    if (row.authMethod === "personal_subscription") {
      // Delegates to resolveAgentSubscriptionEnvironment (fail-closed on owner
      // inactive / target mismatch / ambiguous / path escape). A throw here is
      // NOT fatal to resolution — skip and try the next candidate.
      try {
        subscriptionEnv = await deps.resolveSubscriptionEnv(db, row, args);
      } catch (err) {
        if (!(err instanceof ProviderCredentialBindingError)) throw err;
        lastRejection = {
          connectionId: row.connectionId,
          reason: err.code,
        };
        continue;
      }
    } else if (row.secretRef) {
      // A throw here (deleted / inactive / rotated-away secret) is NOT fatal to
      // resolution — mirror the personal_subscription branch above: record the
      // rejection and try the NEXT candidate. Without this, one dead higher-
      // priority secretRef aborts the whole resolver, skipping the valid
      // company_default fallback + legacy ladder + guided ProviderUnavailableError
      // — a dead-key lockout (Codex ②).
      try {
        secretValue = await deps.resolveSecretValueForConnection(db, row, args);
      } catch (err) {
        if (!(err instanceof SecretCandidateUnavailableError)) throw err;
        lastRejection = {
          connectionId: row.connectionId,
          reason: err.code,
        };
        continue;
      }
    }

    const envPatch = materializeEnvPatch({
      authMethod: row.authMethod,
      provider: args.provider,
      envVar,
      secretValue,
      config: row.config,
      subscriptionEnv,
    });
    if (Object.keys(envPatch).length === 0) {
      lastRejection = { connectionId: row.connectionId, reason: "empty_credential" };
      continue; // empty ⇒ do not inject (secrets.ts:970)
    }

    return {
      source: "connection",
      connectionId: row.connectionId,
      authMethod: row.authMethod,
      sharingScope: row.sharingPolicy,
      envPatch,
      provenance: {
        scopeType: row.scopeType,
        ownerUserId: row.connectionOwnerUserId,
        executionTargetId: row.executionTargetId, // P4→P5 seam (toExecutionTargetHint)
      },
    };
  }

  // Step 4 — legacy fallback (STRANGLER). When no NEW assignment produced a
  // winner, defer to today's behavior exactly.
  const hadAssignment = rows.length > 0;
  const legacyEnvBefore = { ...args.currentEnv };
  const legacyCfg = await deps.legacyResolveConfig({ env: legacyEnvBefore });
  const legacyEnv = (legacyCfg.env as Record<string, string> | undefined) ?? {};
  const legacyPatch: Record<string, string> = {};
  for (const [k, v] of Object.entries(legacyEnv)) {
    if (legacyEnvBefore[k] !== v) legacyPatch[k] = v;
  }
  // Pass the POST-company-key env so the closure's "api key already present ⇒ skip
  // subscription home" short-circuit sees the company key the legacy fallback just
  // injected (restores the pre-P4 heartbeat ordering).
  const legacySub = await deps.legacySubscriptionEnv(legacyEnv);
  if (legacySub) Object.assign(legacyPatch, legacySub);

  if (Object.keys(legacyPatch).length > 0) return { source: "legacy", envPatch: legacyPatch };

  // Nothing anywhere. Self-hosted single-tenant → keyless host CLI login (D4 tail,
  // reproduces today's behavior). Multi-tenant NEVER borrows a host login — it
  // fails closed whether the miss is a rejected assignment or a total miss
  // (locked decision, item 22).
  if (deps.selfHostedSingleTenant) return { source: "host_login_fallback" };
  throw new ProviderUnavailableError(
    args.provider,
    lastRejection?.reason ?? (hadAssignment ? "assignment_rejected" : "no_assignment"),
    lastRejection?.connectionId ?? null,
  );
}

function subscriptionOwnerContext(args: ResolveArgs, row: CandidateRow): string | null {
  // HONESTY (M2): owner_only only performs *run-time* owner isolation when a TRUE
  // user identity is threaded — today that is Commander (actorType==="user", the
  // signed-in operator in args.context.actorId). For an AGENT run (crew/org,
  // actorType==="agent") there is no dispatching-user on the run context yet, so
  // this returns the connection owner and the owner_only gate compares a value to
  // itself → it PASSES. That is acceptable for beta because personal-subscription
  // isolation for agent runs does NOT rest on this gate — it rests on:
  //   (1) assignment provenance: a personal_subscription may only be an
  //       agent_override / personal_execution_default (never a shared default), so
  //       only agents a founder explicitly bound to it can select it;
  //   (2) chooseGovernedSubscriptionBinding's owner-active + exactly-one gates
  //       (provider-credential-bindings.ts:56) run in resolveSubscriptionEnv; and
  //   (3) personal_subscription is disabled entirely in multi_tenant (Task 9).
  // FOLLOW-UP HARDENING: thread the real dispatching-user id onto agent runs so
  // owner_only becomes a genuine run-time check for crew/org too (tracked, not in
  // this PR).
  return args.context.actorType === "user" ? args.context.actorId ?? null : row.connectionOwnerUserId;
}

/** Merge a resolved patch onto a config's env. No-op for override/host fallback. */
export function applyResolvedCredential(
  config: Record<string, unknown>,
  resolved: ResolvedProviderCredential,
): Record<string, unknown> {
  if (resolved.source === "agent_env_override" || resolved.source === "host_login_fallback") {
    return config;
  }
  const env = { ...((config.env as Record<string, string> | undefined) ?? {}) };
  return { ...config, env: { ...env, ...resolved.envPatch } };
}
