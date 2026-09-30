import type { DeploymentMode } from "@armyofagents/shared";

export const DISTRIBUTED_EXECUTION_ENABLED_ENV = "AOA_DISTRIBUTED_EXECUTION_ENABLED";
export const APP_DATABASE_URL_ENV = "AOA_APP_DATABASE_URL";
export const OPERATOR_DATABASE_URL_ENV = "AOA_OPERATOR_DATABASE_URL";
export const DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENV =
  "AOA_DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENABLED";
export const DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENV =
  "AOA_DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENABLED";
export const UNSANDBOXED_MULTITENANT_OPT_IN_ENV = "AOA_ALLOW_UNSANDBOXED_MULTITENANT";

/**
 * MIG-006 — the SEPARATE, off-by-default gate for CREW distributed execution, deliberately
 * INDEPENDENT of the task_run rollout dial. Arming an org's task_run canary must NOT auto-arm
 * crew: a distributed crew agent runs without its `aoa` MCP tools (CLI-008 Unit C, unbuilt), on
 * which crew work leans far more than a one-shot task run, so crew is opted in on its own. Off
 * unless explicitly enabled.
 */
export const DISTRIBUTED_CREW_ROLLOUT_ENABLED_ENV = "AOA_DISTRIBUTED_CREW_ROLLOUT_ENABLED";

type Env = Record<string, string | undefined>;

function parseBooleanEnv(env: Env, name: string, defaultValue: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name}=${JSON.stringify(env[name])} is not a boolean flag`);
}

export function readDistributedExecutionDeploymentFlag(env: Env): boolean {
  return parseBooleanEnv(env, DISTRIBUTED_EXECUTION_ENABLED_ENV, false);
}

/** MIG-006 — read the separate, off-by-default crew rollout gate (see the env const above). */
export function readDistributedCrewRolloutFlag(env: Env): boolean {
  return parseBooleanEnv(env, DISTRIBUTED_CREW_ROLLOUT_ENABLED_ENV, false);
}

export interface DistributedExecutionRolloutInput {
  deploymentMode: DeploymentMode;
  deploymentEnabled: boolean;
  organizationEnabled: boolean;
  workloadEnabled: boolean;
}

export type DistributedExecutionRolloutDecision =
  | { enabled: true; reason: "enabled" }
  | { enabled: false; reason: "deployment_disabled" | "organization_disabled" | "workload_disabled" };

export function resolveDistributedExecutionRollout(
  input: DistributedExecutionRolloutInput,
): DistributedExecutionRolloutDecision {
  if (!input.deploymentEnabled) return { enabled: false, reason: "deployment_disabled" };
  if (!input.organizationEnabled) return { enabled: false, reason: "organization_disabled" };
  if (!input.workloadEnabled) return { enabled: false, reason: "workload_disabled" };
  return { enabled: true, reason: "enabled" };
}

/**
 * The control this module is, named once so every record that cites it cites a
 * SYMBOL and not a line. DE-11's register row shipped a stale line number four
 * times over the same five citations; a symbol does not move when an unrelated
 * edit above it does.
 */
export const HOSTED_EXECUTION_STARTUP_SAFETY_CONTROL =
  "server/src/config/distributed-execution.ts assertHostedExecutionStartupSafe";

/**
 * WHY the assertion refused, as a stable machine code and never free prose.
 * Each code corresponds to exactly one BRANCH of
 * `assertHostedExecutionStartupSafe`, so a reader can tell a missing database
 * URL from a forbidden multi-tenant override without parsing a message.
 */
export type HostedExecutionStartupRefusalReason =
  /** The distributed flag is on and one of the two required database URLs is blank. */
  | "distributed_database_url_missing"
  /** A surface excluded from this release (public ingress / cloud plugin) is enabled. */
  | "excluded_surface_enabled"
  /** The process-wide unsandboxed-multitenant override is set in `cloud_auth`. */
  | "unsandboxed_multitenant_in_cloud_auth"
  /** One of the flags this assertion reads is not a boolean, so it fails closed. */
  | "env_flag_unparseable";

/** The PASS outcome. Returned, so a caller records what the assertion decided
 * rather than re-deriving it from the same inputs — a re-derived record is a
 * record that can disagree with its own code. */
export interface HostedExecutionStartupSafetyOutcome {
  outcome: "passed";
  deploymentMode: DeploymentMode;
  /** The resolved value of `AOA_DISTRIBUTED_EXECUTION_ENABLED` the assertion read. */
  distributedExecutionEnabled: boolean;
  control: typeof HOSTED_EXECUTION_STARTUP_SAFETY_CONTROL;
}

/**
 * The REFUSE outcome, carried on the throw.
 *
 * ★ THE MESSAGE IS DELIBERATELY UNCHANGED from the plain `Error` this replaced,
 * and `instanceof Error` still holds, so every existing caller, test and crash
 * trace behaves exactly as before. What is new is that the refusal now names its
 * own branch, which is what lets the entrypoint log WHY without string-matching.
 */
export class HostedExecutionStartupUnsafeError extends Error {
  readonly outcome = "refused" as const;
  readonly reason: HostedExecutionStartupRefusalReason;
  /** The environment variable whose value caused the refusal. Its VALUE is never
   * carried: these are boolean flags and database URLs, and a refusal record must
   * not become the leak it exists to report. */
  readonly envName: string;
  readonly deploymentMode: DeploymentMode;
  readonly control = HOSTED_EXECUTION_STARTUP_SAFETY_CONTROL;

  constructor(input: {
    message: string;
    reason: HostedExecutionStartupRefusalReason;
    envName: string;
    deploymentMode: DeploymentMode;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "HostedExecutionStartupUnsafeError";
    this.reason = input.reason;
    this.envName = input.envName;
    this.deploymentMode = input.deploymentMode;
  }
}

/**
 * Refuse to start when a hosted deployment is configured unsafely, and RETURN
 * what was decided when it is not.
 *
 * ★ DE-14's `audit` clause is "the startup safety-assertion outcome is logged",
 * and until now NEITHER outcome was recorded: this module imports no logger, so
 * a refusal surfaced only as an unhandled module-eval crash trace and a pass was
 * never noted at all (`E0-F010`). This function still writes nothing — it stays
 * logger-free ON PURPOSE, because this module is a STATIC import of
 * `job-submission.ts`, `job-placement.ts`, the five job bridges,
 * `worker-control.ts` and `adapter-manager-control.ts`, and pulling
 * `middleware/logger.js` into that graph would bind pino's sink for every early
 * importer (see the note at `server/src/services/job-submission.ts` above its
 * own dynamic import, which exists for exactly this reason). The
 * outcome is instead RETURNED on the pass and CARRIED on the throw, and
 * `loadConfigWithStartupSafetyAudit` (config/hosted-execution-startup-audit.ts)
 * is the one production caller that turns both into log lines.
 *
 * ★ SCOPE, STATED NARROWLY. `loadConfig()` has thirty-plus callers and is not
 * memoised, so this assertion re-runs on request paths. Those runs are NOT
 * logged and are not meant to be: the clause is about the STARTUP outcome, and
 * the entrypoint's single call is where it is recorded.
 */
export function assertHostedExecutionStartupSafe(input: {
  deploymentMode: DeploymentMode;
  env: Env;
}): HostedExecutionStartupSafetyOutcome {
  let distributedExecutionEnabled: boolean;
  try {
    distributedExecutionEnabled = readDistributedExecutionDeploymentFlag(input.env);
  } catch (err) {
    throw unparseableFlag(err, DISTRIBUTED_EXECUTION_ENABLED_ENV, input.deploymentMode);
  }
  if (distributedExecutionEnabled) {
    for (const name of [APP_DATABASE_URL_ENV, OPERATOR_DATABASE_URL_ENV]) {
      if (!input.env[name]?.trim()) {
        throw new HostedExecutionStartupUnsafeError({
          message:
            `${name} is required when ${DISTRIBUTED_EXECUTION_ENABLED_ENV}=true; ` +
            "the distributed path never falls back to the owner database pool",
          reason: "distributed_database_url_missing",
          envName: name,
          deploymentMode: input.deploymentMode,
        });
      }
    }
  }
  for (const name of [
    DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENV,
    DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENV,
  ]) {
    let enabled: boolean;
    try {
      enabled = parseBooleanEnv(input.env, name, false);
    } catch (err) {
      throw unparseableFlag(err, name, input.deploymentMode);
    }
    if (enabled) {
      throw new HostedExecutionStartupUnsafeError({
        message: `${name} is excluded from this replatform release and cannot be enabled`,
        reason: "excluded_surface_enabled",
        envName: name,
        deploymentMode: input.deploymentMode,
      });
    }
  }
  if (input.deploymentMode === "cloud_auth") {
    let optedIn: boolean;
    try {
      optedIn = parseBooleanEnv(input.env, UNSANDBOXED_MULTITENANT_OPT_IN_ENV, false);
    } catch (err) {
      throw unparseableFlag(err, UNSANDBOXED_MULTITENANT_OPT_IN_ENV, input.deploymentMode);
    }
    if (optedIn) {
      throw new HostedExecutionStartupUnsafeError({
        message:
          `${UNSANDBOXED_MULTITENANT_OPT_IN_ENV} is forbidden in cloud_auth; ` +
          "tenant workloads must use an isolated worker/provider boundary",
        reason: "unsandboxed_multitenant_in_cloud_auth",
        envName: UNSANDBOXED_MULTITENANT_OPT_IN_ENV,
        deploymentMode: input.deploymentMode,
      });
    }
  }
  return {
    outcome: "passed",
    deploymentMode: input.deploymentMode,
    distributedExecutionEnabled,
    control: HOSTED_EXECUTION_STARTUP_SAFETY_CONTROL,
  };
}

/**
 * Classify a `parseBooleanEnv` refusal WITHOUT changing what the caller sees.
 * The original message is preserved verbatim (it names the variable and the
 * offending value, which is what an operator needs), the original error rides
 * `cause`, and the refusal joins the same closed set of reasons as the other
 * three branches so the entrypoint can record every way this assertion can say
 * no. `readDistributedExecutionDeploymentFlag` keeps throwing a plain `Error`
 * at every OTHER production call site — only the startup assertion's own
 * refusals are classified.
 */
function unparseableFlag(
  err: unknown,
  envName: string,
  deploymentMode: DeploymentMode,
): HostedExecutionStartupUnsafeError {
  return new HostedExecutionStartupUnsafeError({
    message: err instanceof Error ? err.message : String(err),
    reason: "env_flag_unparseable",
    envName,
    deploymentMode,
    cause: err,
  });
}
