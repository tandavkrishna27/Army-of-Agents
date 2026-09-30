import type { HealthStatus } from "@/api/health";

/**
 * A Google-backed local_trusted install still requires a real board session.
 * Older local servers did not expose authReady, so keep their trusted behavior.
 */
export function requiresBoardSession(health: HealthStatus | undefined): boolean {
  return health?.deploymentMode === "authenticated" || health?.authReady === true;
}
