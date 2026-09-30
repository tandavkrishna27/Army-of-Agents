import type { DeploymentMode } from "@armyofagents/shared";

type MutableEnvironment = Record<string, string | undefined>;

/**
 * Keep the documented no-login local quickstart bootable. The server still
 * owns the fail-closed auth-provider check; the CLI only supplies the local
 * identity hatch when the operator made no explicit identity choice and a
 * complete Google configuration is absent.
 */
export function ensureLocalTrustedQuickstartIdentity(
  deploymentMode: DeploymentMode,
  env: MutableEnvironment = process.env,
): boolean {
  if (deploymentMode !== "local_trusted") return false;
  if (env.AOA_DEV_LOCAL_IDENTITY?.trim().length) return false;

  const hasGoogle = Boolean(
    env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim(),
  );
  if (hasGoogle) return false;

  env.AOA_DEV_LOCAL_IDENTITY = "1";
  return true;
}
