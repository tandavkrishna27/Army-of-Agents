import type { DeploymentMode } from "@armyofagents/shared";

let deploymentMode: DeploymentMode = "local_trusted";

export function setDeploymentMode(mode: DeploymentMode): void {
  deploymentMode = mode;
}
export function getDeploymentMode(): DeploymentMode {
  return deploymentMode;
}
/** THE single static enforcement source. Read by authz/rbac/access — never req.tenant. */
export function tenantIsolationEnforced(): boolean {
  return deploymentMode === "cloud_auth";
}
