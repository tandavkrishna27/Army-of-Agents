// server/src/services/execution-secret-handle-mint-runner.ts
//
// DAT-008 slice 1 — the IMPURE half of the mint: gather the decision's inputs from
// the locked placement context, ask the pure `decideExecutionSecretHandle`, and write
// the row. Split from the decision so the guards stay directly unit- and
// mutation-testable without a database (`execution-secret-handle-mint.ts`).
//
// It runs INSIDE the placement transaction, under the same lock that just decided
// the placement, because the handle is pinned to the placed target generation. A
// refusal is not an error: most jobs legitimately mint nothing (self-hosted, a
// non-agent executor, an adapter outside the v1 scope), so the caller records the
// reason and carries on. Placement must never fail because a credential could not
// be bound — that would take out the legacy path too.

import { randomUUID } from "node:crypto";
import { getDeploymentMode } from "../config/deployment-mode.js";
import { canonicalizeBinding, companyKeyTargetForAdapter } from "./secrets.js";
import {
  decideExecutionSecretHandle,
  decideRunJwtHandle,
  isAgentBackedExecutorKind,
  type CanonicalProviderBinding,
  type ExecutionSecretMintDecision,
} from "./execution-secret-handle-mint.js";
import type { EnvBinding } from "@armyofagents/shared";

/** The repository surface this runner needs — the two DAT-008 methods only, so a
 * unit test can supply a pair of functions instead of a whole tenant repo. */
export interface ExecutionSecretMintRepo {
  loadAgentAdapterBinding(input: { companyId: string; agentId: string }):
    Promise<{ adapterType: string; adapterConfig: Record<string, unknown> } | null>;
  insertExecutionSecretHandle(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    handle: string;
    refKind: "provider_key" | "company_secret" | "run_jwt";
    refId: string;
    materialization: "env";
    usePolicy: "sandbox_local_only";
    envTarget: string;
    refVersion: string | null;
    boundTargetGeneration: number | null;
    ownerPrincipalKind: string | null;
    ownerPrincipalId: string | null;
  }): Promise<{ handle: string; minted: boolean }>;
}

export interface MintExecutionSecretHandleInput {
  readonly organizationId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly executorPrincipalKind: string;
  readonly executorPrincipalId: string;
  readonly placementOwner: string | null;
  readonly credentialKind: string | null;
  readonly targetGeneration: number | null;
  /** Injected in tests; production reads the process deployment mode. */
  readonly deploymentMode?: string;
  readonly newHandleId?: () => string;
}

export type MintExecutionSecretHandleOutcome =
  | { readonly minted: true; readonly handle: string; readonly refKind: string; readonly deduped: boolean }
  | { readonly minted: false; readonly reason: string };

/** Pull the canonical binding for ONE env var out of an agent's adapterConfig.
 * Returns null when the agent sets no value for it — the `needsCompanyKeyFallback`
 * condition. A malformed binding is treated as PRESENT-but-unusable (`plain`) rather
 * than absent: falling back to the company key on a binding we failed to parse would
 * substitute a credential precisely where the agent's intent is unclear. */
export function providerBindingForEnvVar(
  adapterConfig: Record<string, unknown>,
  envVar: string,
): CanonicalProviderBinding | null {
  const env = adapterConfig.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  const raw = (env as Record<string, unknown>)[envVar];
  if (raw === undefined) return null;
  let canonical;
  try {
    canonical = canonicalizeBinding(raw as EnvBinding);
  } catch {
    return { type: "plain" };
  }
  if (canonical.type !== "secret_ref") return { type: "plain" };
  // `canonicalizeBinding` does NOT validate: a malformed non-string binding (a
  // number, `{}`, `{type:"bogus"}`) falls through to its secret_ref arm and yields
  // `secretId: undefined`. Trusting that would mint a `company_secret` handle
  // pointing at nothing, and the failure would surface much later as an opaque
  // resolve denial. An unusable reference is treated as an override we cannot
  // represent — refuse, never substitute the company key.
  if (typeof canonical.secretId !== "string" || canonical.secretId.length === 0) return { type: "plain" };
  return { type: "secret_ref", secretId: canonical.secretId, version: canonical.version };
}

export async function mintExecutionSecretHandleForPlacement(
  repo: ExecutionSecretMintRepo,
  input: MintExecutionSecretHandleInput,
): Promise<MintExecutionSecretHandleOutcome> {
  const deploymentMode = input.deploymentMode ?? getDeploymentMode();

  // The agent lookup is deliberately AFTER nothing and BEFORE the decision, but the
  // decision re-checks the executor kind itself: this runner must not become a second
  // place where "is this an agent run?" is answered. An agent-owned coding run executes
  // as `worker`/`sandbox` (Decision #121, never `agent`), and its `executorPrincipalId`
  // IS the agent id (`taskSourceIsAdmitted` → `{kind:"worker", id: agentId}`); so we load
  // the binding for those kinds too and let the load result + guard 3 decide coding-ness.
  const agent = isAgentBackedExecutorKind(input.executorPrincipalKind)
    ? await repo.loadAgentAdapterBinding({ companyId: input.companyId, agentId: input.executorPrincipalId })
    : null;

  const target = agent ? companyKeyTargetForAdapter(agent.adapterType) : null;

  const decision: ExecutionSecretMintDecision = decideExecutionSecretHandle({
    deploymentMode,
    adapterType: agent?.adapterType ?? "",
    executorPrincipalKind: input.executorPrincipalKind,
    providerKeyTarget: target,
    providerBinding: agent && target
      ? providerBindingForEnvVar(agent.adapterConfig, target.envVar)
      : null,
    placementOwner: input.placementOwner,
    credentialKind: input.credentialKind,
    targetGeneration: input.targetGeneration,
  });

  if (!decision.mint) return { minted: false, reason: decision.reason };

  // The frozen wire demands a branded UUID handle id (`secretHandleIdSchema`) while the
  // column is untyped text. A slug here mints an envelope that fails validation and the
  // job silently never leases — so the id is generated, never derived from a name.
  const handle = (input.newHandleId ?? randomUUID)();
  const written = await repo.insertExecutionSecretHandle({
    organizationId: input.organizationId,
    companyId: input.companyId,
    jobId: input.jobId,
    handle,
    refKind: decision.refKind,
    refId: decision.refId,
    materialization: "env",
    usePolicy: "sandbox_local_only",
    envTarget: decision.envTarget,
    // `null` = latest. A pinned agent secret keeps the version it pinned; the company
    // key is unpinned by design so rotation is picked up on the next lease.
    refVersion: decision.secretVersion === null ? null : String(decision.secretVersion),
    boundTargetGeneration: decision.boundTargetGeneration,
    // Denormalized from the job's executing principal, so `resolveExecutionSecret` can
    // re-derive the owner from the LOCKED job row rather than trusting a request.
    ownerPrincipalKind: input.executorPrincipalKind,
    ownerPrincipalId: input.executorPrincipalId,
  });

  return { minted: true, handle: written.handle, refKind: decision.refKind, deduped: !written.minted };
}

// -----------------------------------------------------------------------------
// DAT-007 / CLI-008 — the SECOND placement mint: the run_jwt (AOA_API_KEY) tool-surface
// bearer. A separate runner from the provider-key mint so the existing single-handle
// contract (and its tests) are untouched. Both run inside the SAME placement lock; this
// one is a NO-OP while the tool surface is off — it short-circuits before any agent load
// or insert, so an inert deployment pays zero placement overhead.
// -----------------------------------------------------------------------------

export interface MintRunJwtHandleInput {
  readonly organizationId: string;
  readonly companyId: string;
  readonly jobId: string;
  readonly executorPrincipalKind: string;
  readonly executorPrincipalId: string;
  readonly targetGeneration: number | null;
  /** The AOA_DISTRIBUTED_TOOL_SURFACE_ENABLED gate. `false` (default until S4) mints nothing. */
  readonly toolSurfaceAuthorized: boolean;
  readonly deploymentMode?: string;
  readonly newHandleId?: () => string;
}

export type MintRunJwtHandleOutcome =
  | { readonly minted: true; readonly handle: string; readonly deduped: boolean }
  | { readonly minted: false; readonly reason: string };

export async function mintRunJwtHandleForPlacement(
  repo: ExecutionSecretMintRepo,
  input: MintRunJwtHandleInput,
): Promise<MintRunJwtHandleOutcome> {
  // Short-circuit while the tool surface is off (the default until S4): no agent load, no
  // decision, no insert. This is what keeps the whole slice inert AND zero-overhead — the
  // run_jwt mint never touches the DB until a dispatch actually authorizes the tool surface.
  if (!input.toolSurfaceAuthorized) return { minted: false, reason: "tool_surface_not_authorized" };

  const deploymentMode = input.deploymentMode ?? getDeploymentMode();
  // Same load as the provider-key mint (an agent-owned coding run executes as worker/sandbox
  // with executorPrincipalId = the agent id); the decision needs the agent's adapter_type.
  const agent = isAgentBackedExecutorKind(input.executorPrincipalKind)
    ? await repo.loadAgentAdapterBinding({ companyId: input.companyId, agentId: input.executorPrincipalId })
    : null;

  const decision = decideRunJwtHandle({
    deploymentMode,
    adapterType: agent?.adapterType ?? "",
    executorPrincipalKind: input.executorPrincipalKind,
    toolSurfaceAuthorized: input.toolSurfaceAuthorized,
  });
  if (!decision.mint) return { minted: false, reason: decision.reason };

  const handle = (input.newHandleId ?? randomUUID)();
  const written = await repo.insertExecutionSecretHandle({
    organizationId: input.organizationId,
    companyId: input.companyId,
    jobId: input.jobId,
    handle,
    refKind: "run_jwt",
    // ★ refId = jobId (Correction 4 option B). The run_jwt handle carries NO run id; the
    // broker (resolveRunJwt) re-derives the run id from heartbeat_runs by distributed_job_id
    // at resolve, so the minted run_id is exactly the row DAT-007's currency gate probes.
    refId: input.jobId,
    materialization: "env",
    usePolicy: "sandbox_local_only",
    envTarget: decision.envTarget,
    refVersion: null,
    boundTargetGeneration: input.targetGeneration,
    // Owner-bound to the executing agent (worker/sandbox + agentId), like the provider-key
    // handle: resolveExecutionSecret re-checks owner==executor under the fence at resolve.
    ownerPrincipalKind: input.executorPrincipalKind,
    ownerPrincipalId: input.executorPrincipalId,
  });
  return { minted: true, handle: written.handle, deduped: !written.minted };
}
