import type { McpConnectorCatalogEntry } from "@armyofagents/shared";

/**
 * Security policy for an OAuth connector. The remote connector catalog is a
 * distribution/display document; it is not trusted to choose OAuth endpoints,
 * scopes, or protocol behavior.
 */
export interface McpOAuthProviderPolicy {
  version: number;
  entryId: string;
  resourceUrl: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopes: readonly string[];
  allowDynamicClientRegistration: boolean;
}

const NOTION_HOSTED_POLICY = Object.freeze({
  version: 1,
  entryId: "notion-hosted",
  resourceUrl: "https://mcp.notion.com/mcp",
  issuer: "https://mcp.notion.com",
  authorizationEndpoint: "https://mcp.notion.com/authorize",
  tokenEndpoint: "https://mcp.notion.com/token",
  registrationEndpoint: "https://mcp.notion.com/register",
  scopes: Object.freeze(["default"] as const),
  allowDynamicClientRegistration: true,
}) satisfies McpOAuthProviderPolicy;

export const MCP_OAUTH_PROVIDER_POLICIES: ReadonlyMap<string, McpOAuthProviderPolicy> = new Map([
  [NOTION_HOSTED_POLICY.entryId, NOTION_HOSTED_POLICY],
]);

export class OAuthProviderPolicyError extends Error {
  constructor(message = "OAuth connector is not supported by server policy") {
    super(message);
    this.name = "OAuthProviderPolicyError";
  }
}

export function isOAuthCatalogEntrySupported(entryId: string, version?: number): boolean {
  const policy = MCP_OAUTH_PROVIDER_POLICIES.get(entryId);
  return Boolean(policy && (version === undefined || policy.version === version));
}

export function requireOAuthProviderPolicy(entryId: string, version?: number): McpOAuthProviderPolicy {
  const policy = MCP_OAUTH_PROVIDER_POLICIES.get(entryId);
  if (!policy || (version !== undefined && policy.version !== version)) {
    throw new OAuthProviderPolicyError();
  }
  return policy;
}

/** Validate the only security-relevant catalog fields accepted at install. */
export function assertCatalogEntryMatchesOAuthPolicy(
  entry: Pick<McpConnectorCatalogEntry, "id" | "transport" | "url" | "requiresOAuth">,
  policy: McpOAuthProviderPolicy = requireOAuthProviderPolicy(entry.id),
): void {
  if (
    entry.id !== policy.entryId ||
    entry.transport !== "http" ||
    entry.requiresOAuth !== true ||
    entry.url !== policy.resourceUrl
  ) {
    throw new OAuthProviderPolicyError("OAuth catalog entry does not match server policy");
  }
}

export interface OAuthDiscoveryPolicyView {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

/** Prevent same-ID catalog or discovery drift from changing OAuth authority. */
export function assertDiscoveredOAuthMatchesPolicy(
  discovered: OAuthDiscoveryPolicyView,
  policy: McpOAuthProviderPolicy,
): void {
  if (
    discovered.issuer !== policy.issuer ||
    discovered.authorizationEndpoint !== policy.authorizationEndpoint ||
    discovered.tokenEndpoint !== policy.tokenEndpoint ||
    discovered.registrationEndpoint !== policy.registrationEndpoint
  ) {
    throw new OAuthProviderPolicyError("Discovered OAuth metadata does not match server policy");
  }
}
