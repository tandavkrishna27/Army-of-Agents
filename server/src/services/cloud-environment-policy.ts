import type { DeploymentMode } from "@armyofagents/shared";
import { unprocessable } from "../errors.js";

export const CLOUD_ENVIRONMENT_TARGET_UNAVAILABLE = "cloud_environment_target_unavailable";

/**
 * Reserved for Scenario 2 (a tenant-operated, tenant-hosted isolated runner —
 * spec §14 `tenant_hosted`). This driver name is DOCUMENTED and reserved so a
 * future runner plane is a NEW clearly-labelled allowed cloud shape, never a
 * carve-out of the existing E2B check. It is intentionally NOT admitted in v1:
 * an environment whose `driver === RESERVED_TENANT_RUNNER_DRIVER` still rejects
 * on cloud today (allow-check byte-identical to before this constant existed).
 */
export const RESERVED_TENANT_RUNNER_DRIVER = "remote-runner";

type EnvironmentRuntimeShape = {
  driver?: unknown;
  config?: unknown;
  target?: unknown;
  executionTargetId?: unknown;
};

export function assertEnvironmentRuntimeSupportedForDeployment(
  mode: DeploymentMode,
  input: EnvironmentRuntimeShape,
): void {
  if (mode !== "cloud_auth") return;
  const config = input.config && typeof input.config === "object" && !Array.isArray(input.config)
    ? input.config as Record<string, unknown>
    : null;
  // Allowed cloud shape #1 (v1): an unpinned managed/self-hosted E2B sandbox.
  const isE2b = input.driver === "sandbox"
    && config?.provider === "e2b"
    && input.target == null
    && input.executionTargetId == null;
  // Allowed cloud shape #2 (RESERVED, Scenario 2 — see spec §14 `tenant_hosted`):
  // `driver === RESERVED_TENANT_RUNNER_DRIVER`. A comment + exported constant
  // only — intentionally NOT admitted in v1, so this stays byte-identical: a
  // `remote-runner` env falls through and rejects below exactly like any other
  // non-E2B shape until the isolated worker plane ships.
  if (isE2b) return;

  throw unprocessable(
    "AoA Cloud currently supports E2B environments without raw targets or execution-target pins. " +
      "Local, Docker, gVisor, and worker-pool routing remain unavailable until the isolated worker plane ships.",
    { code: CLOUD_ENVIRONMENT_TARGET_UNAVAILABLE },
  );
}
