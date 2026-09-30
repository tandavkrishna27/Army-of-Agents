import type { Db } from "@armyofagents/db";
import {
  environmentRunOrchestrator,
  EnvironmentRunError,
  type EnvironmentAcquisitionResult,
} from "./environment-run-orchestrator.js";

export interface AcquireExecutionContextInput {
  runIdentity: { companyId: string; agentId: string | null; runId: string; adapterType: string };
  functionType: string | null;                 // null (Commander) → always ephemeral
  // U7.5 — resolved warm-reuse decision for THIS run. The org call site computes
  // it via `resolveWarmSandboxPreference`; crew/Commander ALWAYS pass `false`
  // (they can never be warm — spec §7). Forwarded, with `runIdentity.agentId`,
  // into the orchestrator's acquire so the driver can resume/create a warm lease.
  warmPreference: boolean;
  /** W7.5c — Commander's warm key. Commander passes this (agentId is null); the
   *  driver resumes/creates a conversation-keyed warm lease when warmPreference
   *  is also set. Org/crew leave it undefined ⇒ byte-identical. */
  commanderConversationId?: string | null;
  worktree: { id: string; mode: string } | null;
  environmentId: string | null;                 // pinned task/agent/company env, else null → platform default (U1)
  issueId?: string | null;
  heartbeatRunId?: string | null;
  /**
   * U11 (S4 egress seam) — best-effort connector-host egress allowlist for
   * THIS run, forwarded verbatim to `orchestrator.acquireForRun` ->
   * `runtime.acquireRunLease` -> the sandbox provider's
   * `SandboxProviderAcquireInput.egressAllowlist`. Ignored by the local
   * driver (never reaches a provider). Optional and additive — omitted is
   * byte-identical to pre-U11 behaviour (an empty allowlist).
   */
  egressAllowlist?: string[];
}

export interface AcquiredExecutionContext {
  sandbox: EnvironmentAcquisitionResult | null;
  lease: EnvironmentAcquisitionResult["lease"] | null; // EnvironmentLease (S6)
  warmResolved: boolean;                         // U7.5 — mirrors the forwarded warmPreference
}

interface Deps {
  orchestrator?: ReturnType<typeof environmentRunOrchestrator>;
}

/**
 * Single sandbox-lease acquisition entry point shared by org (heartbeat), crew
 * (`runAoaAgent`), and Commander (U4). Owns "acquire sandbox lease -> produce
 * the config patch" so the three call sites cannot drift.
 *
 * S1: does NO default-id resolution of its own. `input.environmentId ?? null`
 * is passed STRAIGHT into `environmentRunOrchestrator(db).acquireForRun` — the
 * orchestrator's `resolveEnvironment` (patched by U1) turns a null into the
 * platform default on cloud, or throws `environment_not_found` on
 * desktop/local_trusted (no platform default there). A `environment_not_found`
 * throw is therefore the local-execution signal -> `{ sandbox: null }`. Any
 * OTHER EnvironmentRunError (`environment_inactive`,
 * `environment_target_unavailable`, `lease_acquire_failed`) re-throws — a
 * cloud misconfiguration must fail loud, never silently fall back to local.
 */
export async function acquireExecutionContext(
  db: Db | Deps,
  input: AcquireExecutionContextInput,
): Promise<AcquiredExecutionContext> {
  const deps = "orchestrator" in (db as Deps) ? (db as Deps) : {};
  const orchestrator = deps.orchestrator ?? environmentRunOrchestrator(db as Db);

  let sandbox: EnvironmentAcquisitionResult;
  try {
    sandbox = await orchestrator.acquireForRun({
      companyId: input.runIdentity.companyId,
      environmentId: input.environmentId ?? null,
      adapterType: input.runIdentity.adapterType,
      issueId: input.issueId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      persistedExecutionWorkspace: input.worktree,
      egressAllowlist: input.egressAllowlist,
      // U7.5 / W7.5c — forward the resolved warm decision + the warm key. The
      // driver's acquire path only resumes/creates a warm lease when
      // warmPreference AND a key are set; org agents key on agentId, Commander
      // on commanderConversationId. Crew passes warmPreference:false so it can
      // never resume a warm VM.
      warmPreference: input.warmPreference,
      agentId: input.runIdentity.agentId,
      commanderConversationId: input.commanderConversationId ?? null,
    });
  } catch (err) {
    if (err instanceof EnvironmentRunError && err.code === "environment_not_found") {
      return { sandbox: null, lease: null, warmResolved: false };
    }
    throw err;
  }
  return { sandbox, lease: sandbox.lease, warmResolved: input.warmPreference };
}
