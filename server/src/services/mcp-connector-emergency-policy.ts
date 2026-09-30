const SERVER_NAME_RE = /^[a-z0-9-]+$/;

export interface McpConnectorEmergencyPolicy {
  enabled: boolean;
  deniedServerNames: ReadonlySet<string>;
}

/**
 * Runtime revocation controls for external MCP connectors.
 *
 * - unset `AOA_MCP_CONNECTORS_ENABLED` keeps the shipped default enabled;
 * - any explicit value other than 1/true/yes/on fails closed;
 * - invalid denylist names are ignored because they cannot match a valid
 *   connector server name.
 */
export function readMcpConnectorEmergencyPolicy(
  env: NodeJS.ProcessEnv = process.env,
): McpConnectorEmergencyPolicy {
  const rawEnabled = env.AOA_MCP_CONNECTORS_ENABLED?.trim().toLowerCase();
  const enabled =
    rawEnabled === undefined ||
    ["1", "true", "yes", "on"].includes(rawEnabled);
  const deniedServerNames = new Set(
    (env.AOA_MCP_CONNECTOR_DENYLIST ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => SERVER_NAME_RE.test(value)),
  );
  return { enabled, deniedServerNames };
}

export function isMcpConnectorBlocked(
  serverName: string,
  policy: McpConnectorEmergencyPolicy = readMcpConnectorEmergencyPolicy(),
): boolean {
  return !policy.enabled || policy.deniedServerNames.has(serverName);
}
