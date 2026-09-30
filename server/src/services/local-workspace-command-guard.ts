import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { assertUnsandboxedMultitenantAllowed } from "./unsandboxed-multitenant-guard.js";

/** Fail closed before any tenant-controlled workspace command reaches the API host. */
export function assertLocalWorkspaceCommandAllowed(sink: string): void {
  assertUnsandboxedMultitenantAllowed(
    { type: "local" },
    { tenantIsolationEnforced: tenantIsolationEnforced(), sink },
  );
}

/**
 * Distinct guard sink for AoA-authored git run against a HOST-side clone
 * (clone/diff-base/commit/push) — never a tenant CLI shell. Permitted on
 * cloud_auth via the `host_orchestration_git` carve-out in
 * `unsandboxed-multitenant-guard.ts` (U6.1); the tenant-command sink above
 * (`assertLocalWorkspaceCommandAllowed`) stays refused on cloud unchanged.
 */
export function assertHostOrchestrationGitAllowed(sink: string): void {
  assertUnsandboxedMultitenantAllowed(
    { type: "host_orchestration_git" } as never,
    { tenantIsolationEnforced: tenantIsolationEnforced(), sink },
  );
}
