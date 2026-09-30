import {
  HOSTED_EXECUTION_STARTUP_SAFETY_CONTROL,
  HostedExecutionStartupUnsafeError,
  type HostedExecutionStartupSafetyOutcome,
} from "./distributed-execution.js";

/**
 * DE-14's audit clause — "the startup safety-assertion outcome is logged" — and
 * the ONE production path that satisfies it.
 *
 * ★ THE PROBLEM THIS EXISTS FOR. `assertHostedExecutionStartupSafe` is the
 * refusal that stops a `cloud_auth` deployment booting with the process-wide
 * unsandboxed-multitenant override, with an excluded surface enabled, or with
 * the distributed flag on and no separate database URLs. It was measured DENYING
 * over a seven-case matrix. What was absent was any record IN EITHER DIRECTION:
 * `config/distributed-execution.ts` imports no logger and contains no `logger`
 * or `console` call at all, so a refusal surfaced only as an unhandled
 * module-eval crash trace and a PASS was never noted anywhere (`E0-F010`,
 * DE-14). An operator could not answer "did this deployment's safety assertion
 * run, and what did it decide" from the system's own memory.
 *
 * ★ WHY A LOG AND NOT A DURABLE ROW, stated so nobody reads this as the same
 * kind of record `recordSecurityDenial` writes. DE-14's clause asks for a LOG
 * and that is all it can ask for: the assertion fires inside `loadConfig()` at
 * the server entrypoint's module top level, BEFORE any database pool exists, so
 * a durable row is structurally impossible here. This closes DE-14's audit
 * clause and proves nothing about the sixteen crossings whose clauses say
 * "audited".
 *
 * ★ WHY THE LOGGER IS INJECTED. `config/distributed-execution.ts` and
 * `config.ts` are both deliberately logger-free — they are static imports of
 * `job-submission.ts` and a dozen other modules, and binding pino's sink from
 * that graph is a known hazard in this tree. `server/src/index.ts` already
 * imports the logger statically and is where the entrypoint's single
 * `loadConfig()` call lives, so the recording belongs there and the sink arrives
 * as a parameter. Keeping it a parameter is also what makes BOTH directions
 * provable without importing the entrypoint.
 */

/** The narrow slice of the pino logger this recorder needs. */
export interface StartupSafetyAuditLog {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const HOSTED_EXECUTION_STARTUP_SAFETY_PASSED_EVENT =
  "distributed_execution.startup_safety.passed";
export const HOSTED_EXECUTION_STARTUP_SAFETY_REFUSED_EVENT =
  "distributed_execution.startup_safety.refused";

/**
 * Load the server config, recording the startup safety assertion's outcome in
 * BOTH directions, and change nothing else about it.
 *
 * ★ IT NEVER SWALLOWS. A refusal is logged and then RETHROWN unchanged, so the
 * process still dies before serving. Recording a refusal must not convert a
 * startup refusal into a startup.
 *
 * ★ IT IS PRECISE ABOUT WHAT IT CLAIMS. `loadConfig()` throws for many reasons
 * that have nothing to do with this assertion — a malformed port, an unreadable
 * config file. Only a `HostedExecutionStartupUnsafeError` is recorded as a
 * safety refusal; anything else is rethrown with no record, because a refusal
 * line for an unrelated crash is a false claim of enforcement. That precision is
 * asserted by its own arm.
 */
export function loadConfigWithStartupSafetyAudit<
  C extends { hostedExecutionStartupSafety: HostedExecutionStartupSafetyOutcome },
>(deps: { load: () => C; log: StartupSafetyAuditLog }): C {
  let config: C;
  try {
    config = deps.load();
  } catch (err) {
    if (err instanceof HostedExecutionStartupUnsafeError) {
      deps.log.error(
        {
          service: "hosted-execution-startup-audit",
          event: HOSTED_EXECUTION_STARTUP_SAFETY_REFUSED_EVENT,
          crossing: "DE-14",
          outcome: err.outcome,
          reason: err.reason,
          // The variable's NAME, never its value: these are boolean flags and
          // database URLs, and a refusal record must not become the leak it
          // exists to report.
          envName: err.envName,
          deploymentMode: err.deploymentMode,
          control: err.control,
        },
        "hosted-execution startup safety assertion REFUSED — the process will not serve",
      );
    }
    throw err;
  }
  const outcome = config.hostedExecutionStartupSafety;
  deps.log.info(
    {
      service: "hosted-execution-startup-audit",
      event: HOSTED_EXECUTION_STARTUP_SAFETY_PASSED_EVENT,
      crossing: "DE-14",
      // Read off the assertion's OWN return value, not re-derived from the same
      // env: a re-derived record is a record that can disagree with its code.
      outcome: outcome.outcome,
      deploymentMode: outcome.deploymentMode,
      distributedExecutionEnabled: outcome.distributedExecutionEnabled,
      control: outcome.control,
    },
    "hosted-execution startup safety assertion PASSED",
  );
  return config;
}

export { HOSTED_EXECUTION_STARTUP_SAFETY_CONTROL };
