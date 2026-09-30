// server/src/services/execution-secret-handle-mint.ts
//
// DAT-008 slice 1 — the execution-secret-handle MINT decision.
//
// CM-013's target state: keep model-credential resolution/rotation authority in the
// control plane, and issue only job/attempt/lease/fence/Company/principal-scoped
// SANDBOX MATERIALIZATION authority. A handle is that authority in row form: an
// opaque reference the frozen wire can carry (`secretHandleRefSchema`), resolved to
// a value only behind an active fence by `resolveExecutionSecret`.
//
// This module decides WHETHER to mint and WHAT to point at. It is PURE — no db, no
// clock, no randomness (the uuid is minted by the caller) — so every guard below is
// directly unit- and mutation-testable. The caller performs the insert inside the
// placement transaction, where the target generation is known.
//
//   deployment mode ──┐
//   executor kind ────┤
//   adapter v1 scope ─┼──> decideExecutionSecretHandle ──> mint {refKind, refId, envTarget}
//   provider target ──┤                                └─> refuse {reason}
//   agent binding ────┤
//   owner authorities ┘
//
// The per-agent split (design revision 1, R2) is the load-bearing part. Today a
// per-agent provider key ALWAYS wins over the company key (`needsCompanyKeyFallback`
// in secrets.ts: "Per-agent overrides always win and are never rewritten"). The
// cutover must not quietly reverse that, so the binding decides the ref:
//
//   secret_ref  -> company_secret handle pointing at the AGENT's own secret
//   plain       -> refuse; the job stays on the legacy executor
//   absent      -> provider_key handle pointing at the Company key
//
// A `plain` literal is the one shape with no handle representation: the wire carries
// references, never values. Refusing is the only honest answer — substituting the
// company key would silently re-attribute the work to a different credential.

import { gateCodingAdapterDispatch, isCloudSandboxMode } from "./sandbox-coding-disposition.js";
import type { ProviderKeyTarget } from "./providers/provider-key.js";

/** A per-agent env binding for the provider var, already canonicalized by the
 * caller (`canonicalizeBinding`), with the VALUE deliberately dropped: the mint
 * decides a reference and must never be able to read a secret. `null` = the agent
 * sets no value for that env var, which is exactly `needsCompanyKeyFallback`. */
export type CanonicalProviderBinding =
  | { readonly type: "plain" }
  | { readonly type: "secret_ref"; readonly secretId: string; readonly version: number | "latest" };

export interface ExecutionSecretMintInput {
  readonly deploymentMode: string;
  readonly adapterType: string;
  /** `jobs.executor_principal_kind` — only an agent-owned run stages a model credential;
   * per Decision #121 that is a `worker`/`sandbox` executor, never `agent`
   * (see `isAgentBackedExecutorKind`). */
  readonly executorPrincipalKind: string;
  /** `companyKeyTargetForAdapter(adapterType)`; null when the adapter has no company key. */
  readonly providerKeyTarget: ProviderKeyTarget | null;
  readonly providerBinding: CanonicalProviderBinding | null;
  /** Authority A — the placement decision's owner class. */
  readonly placementOwner: string | null;
  /** Authority B — the job's own resolved credential binding kind. Independent of A. */
  readonly credentialKind: string | null;
  /** The placed target generation to pin the handle to; null = unpinned. */
  readonly targetGeneration: number | null;
}

export type ExecutionSecretMintRefusal =
  | "not_cloud_deployment"
  | "executor_not_agent"
  | "adapter_not_v1_scope"
  | "adapter_has_no_company_key"
  | "agent_plain_literal_override"
  | "owner_desktop_target"
  | "owner_authority_disagreement";

export type ExecutionSecretMintDecision =
  | {
      readonly mint: true;
      readonly refKind: "provider_key" | "company_secret";
      /** `provider:<id>` secret NAME for a company key, or the agent's `secretId`. */
      readonly refId: string;
      /** The env var NAME the worker will set. Never a value. */
      readonly envTarget: string;
      /** Pinned version for an agent secret_ref; null for a company key. */
      readonly secretVersion: number | "latest" | null;
      readonly boundTargetGeneration: number | null;
    }
  | { readonly mint: false; readonly reason: ExecutionSecretMintRefusal };

const refuse = (reason: ExecutionSecretMintRefusal): ExecutionSecretMintDecision => ({ mint: false, reason });

/**
 * Which refusals an operator can DO something about.
 *
 * Most refusals are the normal, expected answer for the overwhelming majority of jobs
 * — a self-hosted deployment stages no key at all, a non-agent executor needs none, an
 * adapter outside the v1 scope is not being cut over yet. Reporting those would emit a
 * line per job per placement and bury the two that matter.
 *
 * These two matter:
 *   * `agent_plain_literal_override` — this agent CANNOT be cut over. Its provider key
 *     is a plain literal, which the wire has no reference form for, so it stays on the
 *     legacy executor indefinitely. Silent, it is a partial migration nobody notices.
 *   * `owner_authority_disagreement` — two independently-derived owner authorities
 *     disagree. That should be impossible; if it happens, something upstream is wrong
 *     and the credential decision is the wrong place to find out about it quietly.
 */
export function isActionableMintRefusal(reason: ExecutionSecretMintRefusal): boolean {
  return reason === "agent_plain_literal_override" || reason === "owner_authority_disagreement";
}

/**
 * The executor-principal kinds that back an agent-owned run which stages a model
 * credential (CLI-007, correcting E7-F001's guard-2 misdiagnosis).
 *
 * A coding-agent run does NOT execute as `executorPrincipalKind: "agent"` — the FROZEN
 * executor authority (Decision #121, `distributed-execution-legacy-parity.json`) declares
 * `task_run`/`crew_run`/`one_shot` executors as `worker`/`sandbox`; `"agent"` is only ever
 * a *requester* kind (`job-control.ts` `taskSourceIsAdmitted` → `{kind:"worker", id: agentId}`).
 * The original guard checked `=== "agent"`, so it refused EVERY real run — the mint never
 * fired on any source. This admits the real agent-backed execution kinds and lets the REAL
 * coding gate run downstream: guard 3 (the v1 adapter scope) plus the agent binding lookup
 * keyed on `executorPrincipalId`. A `worker`/`sandbox` run whose principal is not a v1 coding
 * agent (e.g. a `commander_turn` sandbox carrying a run id, a `service`/`browser` run, a
 * `system` job) loads no binding → adapter `""` → guard 3 refuses. The legacy literal `agent`
 * is kept admitted so the gate stays a superset of the historical assumption; no production
 * source stamps it today.
 */
export function isAgentBackedExecutorKind(kind: string): boolean {
  return kind === "agent" || kind === "worker" || kind === "sandbox";
}

/**
 * Deferral #3 — the owner check must not be tautological.
 *
 * The inherited deferral records that `credentialOwnerId` and
 * `requiredOwnerPrincipalId` both read from the routed target's profile, so the
 * existing check compares a value with a copy of itself and safety rests instead on
 * the structural exclusion of `owner_desktop` routing.
 *
 * These two inputs are derived independently: `placementOwner` comes from the
 * placement decision over the candidate registry, `credentialKind` from the job's
 * own authority resolution. Requiring them to AGREE makes the check falsifiable — a
 * disagreement is a real signal that one of the two derivations is wrong, and
 * neither may then be trusted to authorize staging a Company credential.
 */
function ownerAuthoritiesAgree(placementOwner: string | null, credentialKind: string | null): boolean {
  if (placementOwner === null || credentialKind === null) return false;
  const desktopByOwner = placementOwner === "owner_desktop";
  const desktopByCredential = credentialKind === "personal_subscription";
  return desktopByOwner === desktopByCredential;
}

export function decideExecutionSecretHandle(input: ExecutionSecretMintInput): ExecutionSecretMintDecision {
  // 1. Deployment mode FIRST, and deliberately before every other reason: a
  //    self-hosted deployment has no hosted key at all (Rule #11 / Decision #104),
  //    so reporting it as an adapter or owner problem would send an operator
  //    hunting for a misconfiguration that does not exist.
  if (!isCloudSandboxMode(input.deploymentMode)) return refuse("not_cloud_deployment");

  // 2. Only an agent-owned run stages a model credential. Per Decision #121 that run
  //    executes as `worker`/`sandbox` (never `agent`); the REAL coding gate is guard 3
  //    plus the binding lookup, so a non-coding worker/sandbox still refuses below.
  if (!isAgentBackedExecutorKind(input.executorPrincipalKind)) return refuse("executor_not_agent");

  // 3. The v1 sandboxed-coding adapter scope (`claude_local` + `codex_local`).
  //    NOTE this gate admits on the adapter's disposition bucket and does NOT read
  //    the deployment mode — step 1 is not redundant with it.
  if (!gateCodingAdapterDispatch(input.adapterType, input.deploymentMode).admitted) {
    return refuse("adapter_not_v1_scope");
  }

  // 4. Deferral #3 — both owner authorities must exist and agree, BEFORE any
  //    binding is considered. An agent's own secret does not license staging into
  //    a target whose ownership we cannot establish.
  if (!ownerAuthoritiesAgree(input.placementOwner, input.credentialKind)) {
    return refuse("owner_authority_disagreement");
  }
  if (input.placementOwner === "owner_desktop") return refuse("owner_desktop_target");

  // 5. The adapter must map to a company key target. `null` is the mint-nothing
  //    signal `companyKeyTargetForAdapter` already returns, not a new list.
  const target = input.providerKeyTarget;
  if (!target) return refuse("adapter_has_no_company_key");

  // 6. The three-way per-agent split. `plain` has no reference form, so it refuses.
  if (input.providerBinding?.type === "plain") return refuse("agent_plain_literal_override");

  if (input.providerBinding?.type === "secret_ref") {
    return {
      mint: true,
      refKind: "company_secret",
      refId: input.providerBinding.secretId,
      envTarget: target.envVar,
      secretVersion: input.providerBinding.version,
      boundTargetGeneration: input.targetGeneration,
    };
  }

  return {
    mint: true,
    refKind: "provider_key",
    refId: target.secretName,
    envTarget: target.envVar,
    secretVersion: null,
    boundTargetGeneration: input.targetGeneration,
  };
}

// -----------------------------------------------------------------------------
// DAT-007 / CLI-008 — the run_jwt (AOA_API_KEY) tool-surface handle mint decision.
//
// A SIBLING of decideExecutionSecretHandle, deliberately separate: it stages the
// distributed TOOL SURFACE bearer, not a model-provider credential, so its shape and
// its refusal vocabulary differ. It mints ONLY for a cloud, agent-backed, claude_local
// run whose tool surface has been authorized (the AOA_DISTRIBUTED_TOOL_SURFACE_ENABLED
// gate, computed once at dispatch and threaded here as `toolSurfaceAuthorized`).
// codex_local mints NO run_jwt handle — it has no aoa MCP tool surface (R6). PURE
// (no db/clock/uuid) so every arm is directly unit- and mutation-testable.
// -----------------------------------------------------------------------------

/** The env var NAME the worker materializes the minted run JWT into. The frozen wire
 * never carries the value; the broker MINTS it at resolve (secret-broker resolveRunJwt). */
export const RUN_JWT_ENV_TARGET = "AOA_API_KEY" as const;

export interface RunJwtHandleMintInput {
  readonly deploymentMode: string;
  /** `agents.adapter_type` — run_jwt is `claude_local` ONLY. */
  readonly adapterType: string;
  /** `jobs.executor_principal_kind` — an agent-backed run (worker/sandbox; never system). */
  readonly executorPrincipalKind: string;
  /** The AOA_DISTRIBUTED_TOOL_SURFACE_ENABLED gate, threaded from dispatch. `false`
   * (the default until Unit C S4) mints nothing → the whole tool-surface slice is inert. */
  readonly toolSurfaceAuthorized: boolean;
}

export type RunJwtHandleMintRefusal =
  | "not_cloud_deployment"
  | "executor_not_agent"
  | "adapter_not_claude_local"
  | "tool_surface_not_authorized";

export type RunJwtHandleMintDecision =
  | { readonly mint: true; readonly envTarget: typeof RUN_JWT_ENV_TARGET }
  | { readonly mint: false; readonly reason: RunJwtHandleMintRefusal };

export function decideRunJwtHandle(input: RunJwtHandleMintInput): RunJwtHandleMintDecision {
  // 1. Cloud only — a self-hosted run executes the CLI locally and needs no brokered
  //    tool surface (Rule #11 / Decision #104), so it never stages a run_jwt bearer.
  if (!isCloudSandboxMode(input.deploymentMode)) return { mint: false, reason: "not_cloud_deployment" };
  // 2. Only an agent-owned run stages a tool-surface bearer. Per Decision #121 that run
  //    executes as worker/sandbox (never `agent`); a system/service run mints nothing.
  if (!isAgentBackedExecutorKind(input.executorPrincipalKind)) return { mint: false, reason: "executor_not_agent" };
  // 3. claude_local ONLY — codex has no aoa MCP tool surface, so it never gets a run JWT (R6).
  if (input.adapterType !== "claude_local") return { mint: false, reason: "adapter_not_claude_local" };
  // 4. The tool-surface flag, computed once at dispatch. `false` until S4 → inert by default.
  if (!input.toolSurfaceAuthorized) return { mint: false, reason: "tool_surface_not_authorized" };
  return { mint: true, envTarget: RUN_JWT_ENV_TARGET };
}
