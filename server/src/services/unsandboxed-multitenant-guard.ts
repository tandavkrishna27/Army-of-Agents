import type { AdapterExecutionTarget } from "@armyofagents/adapter-utils";
import { logger } from "../middleware/logger.js";
import { UNSANDBOXED_MULTITENANT_OPT_IN_ENV } from "../config/distributed-execution.js";

/**
 * Documented opt-in env (see docs/deploy/environment-variables.md). Canonical
 * declaration lives in `../config/distributed-execution.ts`; re-exported here so
 * existing importers of this module keep the same symbol. `assertHostedExecution
 * StartupSafe` (config.ts) rejects this override earlier for real `cloud_auth`
 * startup, but this guard's runtime behavior is unchanged.
 */
export { UNSANDBOXED_MULTITENANT_OPT_IN_ENV } from "../config/distributed-execution.js";

/** True when the resolved target executes directly on the unsandboxed host. */
export function isUnsandboxedLocalTarget(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  return !target || target.type === "local";
}

// Match defensive aliases so a future rename cannot silently reopen this gate.
const DOCKER_FAMILY_TARGET_TYPES: ReadonlySet<string> = new Set([
  "sandbox-docker",
  "docker",
  "local-docker",
]);

/**
 * Sentinel target for AoA-authored git run against a HOST-side clone
 * (clone/diff-base/commit/push) — never a tenant CLI shell. This is host-
 * controlled AoA code operating on a host clone, not tenant model output
 * executing in an unsandboxed context, so it is permitted on cloud_auth
 * (spec §9 blast-radius reframe). U6.1.
 */
export type HostOrchestrationTarget = { type: "host_orchestration_git" };

export function isHostOrchestrationGitTarget(
  t: AdapterExecutionTarget | HostOrchestrationTarget | null | undefined,
): boolean {
  return !!t && (t as { type?: string }).type === "host_orchestration_git";
}

/**
 * Cloud isolation cannot be established by a tenant-authored `runtime` string.
 * Until the validated worker plane exists, every local Docker-family target is
 * refused just like the control-plane host. Provider sandboxes establish their
 * boundary outside this local dispatch path and are allowed. Host-orchestration
 * git (U6.1) is likewise carved out — it is AoA's own code, not tenant input.
 *
 * EXTENSIBILITY (Scenario 2 — tenant-operated isolated runner, spec §13 hook #2):
 * this predicate is a CLOSED REFUSE-ENUMERATION — it refuses ONLY local (via
 * `isUnsandboxedLocalTarget`) + the docker-family types (`DOCKER_FAMILY_TARGET_TYPES`)
 * and PERMITS everything else. A future `remote-tenant-runner` execution-target
 * type is therefore an ALLOWED category BY CONSTRUCTION — do NOT invert this to
 * an allow-list of only `provider-sandbox`, which would refuse the future remote
 * runner. This mirrors the acquisition-level isolation seam (S5): a
 * `type:"provider-sandbox"` target is exactly what the orchestrator emits when
 * `acquisition.environment.driver === "sandbox"` + `isProviderSandboxLease(lease)`
 * (`environment-run-orchestrator.ts:163`); the reserved driver name for that
 * future category is `RESERVED_TENANT_RUNNER_DRIVER` (`cloud-environment-policy.ts`).
 * Commander is just another sink passing a resolved `provider-sandbox` target
 * through this same enumeration (W7.5d/W7.5f) — it neither widens nor narrows it.
 */
function requiresSandboxRefusal(
  target: AdapterExecutionTarget | null | undefined,
): boolean {
  if (isHostOrchestrationGitTarget(target)) return false;
  if (isUnsandboxedLocalTarget(target)) return true;
  return Boolean(target && DOCKER_FAMILY_TARGET_TYPES.has(target.type));
}

function optInEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes)$/i.test(env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV]?.trim() ?? "");
}

let hasWarnedUnsandboxedMultitenant = false;

/** Test-only: reset the per-process warn-once latch. */
export function resetUnsandboxedMultitenantWarning(): void {
  hasWarnedUnsandboxedMultitenant = false;
}

export interface UnsandboxedMultitenantGuardOptions {
  /** Pass `tenantIsolationEnforced()`; do not derive this from trust boundary. */
  tenantIsolationEnforced: boolean;
  /** Human label for the run kind (for example, "org agent"). */
  sink: string;
  env?: NodeJS.ProcessEnv;
  log?: Pick<typeof logger, "warn">;
}

/**
 * Refuse local execution on cloud_auth unless the operator explicitly accepts
 * the process-wide risk. Self-hosted deployments and provider sandboxes remain
 * unaffected. A claimed `runtime: "runsc"` is not worker-plane provenance.
 */
export function assertUnsandboxedMultitenantAllowed(
  target: AdapterExecutionTarget | null | undefined,
  opts: UnsandboxedMultitenantGuardOptions,
): void {
  if (!opts.tenantIsolationEnforced || !requiresSandboxRefusal(target)) return;

  const env = opts.env ?? process.env;
  if (!optInEnabled(env)) {
    throw new Error(
      `Refusing to dispatch a ${opts.sink} run without genuine per-tenant isolation ` +
        `(the unsandboxed control-plane host, or a local Docker target) under ` +
        `enforced tenant isolation (cloud_auth). Per-tenant execution isolation is not ` +
        `yet implemented; set ${UNSANDBOXED_MULTITENANT_OPT_IN_ENV}=1 to explicitly allow ` +
        `unsandboxed runs on this shared deployment, or configure a provider-sandbox ` +
        `execution target. A tenant-authored runtime name is not proof of worker isolation.`,
    );
  }

  if (!hasWarnedUnsandboxedMultitenant) {
    hasWarnedUnsandboxedMultitenant = true;
    (opts.log ?? logger).warn(
      { sink: opts.sink, optIn: UNSANDBOXED_MULTITENANT_OPT_IN_ENV },
      `SECURITY: ${UNSANDBOXED_MULTITENANT_OPT_IN_ENV} is set - executing ${opts.sink} ` +
        `runs UNSANDBOXED on the shared cloud_auth host. Tenant code runs directly on the ` +
        `control-plane host with NO per-tenant isolation. This override is process-wide: it ` +
        `permits ALL agent, crew, AND Commander runs to execute unsandboxed on this host - ` +
        `not only the ${opts.sink} run that first tripped this one-time warning. This is an ` +
        `explicit operator override; do not use it in production multi-tenant deployments.`,
    );
  }
}
