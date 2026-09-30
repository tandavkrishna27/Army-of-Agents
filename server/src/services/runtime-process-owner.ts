import { createHash } from "node:crypto";
import os from "node:os";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { resolveAoaInstanceId } from "../home-paths.js";

export const RUNTIME_PROCESS_OWNER_ID_ENV = "AOA_RUNTIME_PROCESS_OWNER_ID";

const OWNER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/;

/**
 * Identify the OS PID namespace that owns locally spawned runtime services.
 * Cloud replicas must provide an explicit, unique value. Local installs use a
 * stable host + AoA-instance fingerprint so a restarted server can reap its
 * own detached children without trusting another machine's PID namespace.
 */
export function resolveRuntimeProcessOwnerId(input: {
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  requireExplicitInCloud?: boolean;
} = {}): string | null {
  const env = input.env ?? process.env;
  const explicit = env[RUNTIME_PROCESS_OWNER_ID_ENV]?.trim();
  if (explicit) {
    if (!OWNER_ID_RE.test(explicit)) {
      throw new Error(
        `Invalid ${RUNTIME_PROCESS_OWNER_ID_ENV}; use 1-128 letters, digits, '.', '_', ':', '@', or '-'.`,
      );
    }
    return explicit;
  }

  if (tenantIsolationEnforced()) {
    if (input.requireExplicitInCloud) {
      throw new Error(
        `${RUNTIME_PROCESS_OWNER_ID_ENV} is required before starting a local runtime service in cloud_auth. ` +
        "Set it to a stable value unique to this replica's OS PID namespace.",
      );
    }
    return null;
  }

  const fingerprint = createHash("sha256")
    .update(input.hostname ?? os.hostname())
    .update("\0")
    .update(resolveAoaInstanceId())
    .digest("hex")
    .slice(0, 32);
  return `local-${fingerprint}`;
}

export function isRuntimeProcessOwnedByCurrentReplica(input: {
  provider: string;
  processOwnerId?: string | null;
}, currentOwnerId = resolveRuntimeProcessOwnerId()): boolean {
  if (input.provider === "local_process") {
    return Boolean(currentOwnerId) && input.processOwnerId === currentOwnerId;
  }
  // Adapter reports do not carry host/provider routing provenance. In cloud,
  // their loopback URLs name the control-plane replica, not the tenant's E2B
  // sandbox, so treating them as replica-local would create a loopback SSRF.
  if (input.provider === "adapter_managed" && tenantIsolationEnforced()) {
    return false;
  }
  return true;
}
