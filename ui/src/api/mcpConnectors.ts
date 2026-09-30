import type { McpConnectorCatalogEntry } from "@armyofagents/shared";
import { api } from "./client";

/**
 * OUTBOUND MCP connectors — external MCP servers this company's agents call.
 * Sibling of the INBOUND MCP API-keys client (`./mcp.ts`), which is the opposite
 * direction (clients calling AoA). Backed by `server/src/routes/mcp-connectors.ts`.
 *
 * Paths carry NO `/api` prefix — `client.ts` prepends `BASE = "/api"`.
 */
/**
 * Why an ACTIVE connector would not currently reach an intended recipient.
 * Mirrors the server's `ConnectorDeliverabilityReason` (a superset of the two
 * skip vocabularies): connector-global row/D7 reasons plus the per-adapter
 * `secret_unreachable` (codex can't deliver a stdio secret) and
 * `adapter_incapable` (the agent's adapter has no MCP client).
 */
export type ConnectorDeliverabilityReason =
  | "missing_url"
  | "missing_command"
  | "unknown_transport"
  | "malformed_row"
  | "d7_blocked"
  | "unsafe_command"
  | "secret_unreachable"
  | "adapter_incapable"
  | "credential_inactive_or_missing";

export interface BlockedAgentDeliverability {
  agentId: string;
  agentName: string;
  reason: ConnectorDeliverabilityReason;
}

/**
 * Computed "would this connector actually reach agents right now?" summary
 * (FU-1). Present (non-null) only for ACTIVE connectors — a non-active
 * connector's status badge already explains itself, so the server returns
 * `null` there.
 *
 *  - `reason` non-null → a CONNECTOR-GLOBAL block (D7, malformed/incomplete row)
 *    that stops it reaching every recipient.
 *  - `reason` null + `blockedAgents` non-empty → globally fine, but specific
 *    assigned agents can't receive it (e.g. codex + stdio secret).
 *  - `deliverable` true → no global block and every assigned agent gets it.
 */
export interface ConnectorDeliverabilitySummary {
  deliverable: boolean;
  reason: ConnectorDeliverabilityReason | null;
  blockedAgents: BlockedAgentDeliverability[];
}

export type McpConnectorOAuthEligibility =
  | "not_oauth"
  | "supported"
  | "policy_blocked";

export type McpConnectorOAuthCallbackResult = "completed" | "failed";

export type McpConnectorOAuthCallbackReason =
  | "access_denied"
  | "provider_error"
  | "token_exchange_failed"
  | "secret_collision"
  | "connector_changed"
  | "policy_blocked";

export interface McpConnector {
  id: string;
  companyId: string;
  serverName: string;
  displayName: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  headerTemplate: Record<string, string>;
  envTemplate: Record<string, string>;
  secretRef: string | null;
  source: "byo" | "catalog";
  /** Immutable server-owned catalog identity. Never inferred from serverName. */
  catalogEntryId: string | null;
  /** Version of the server policy that authorized this OAuth connector. */
  oauthPolicyVersion: number | null;
  /** Server-derived OAuth capability; clients must not recompute it from catalog data. */
  oauthEligibility: McpConnectorOAuthEligibility;
  oauthUnavailableReason?: string;
  /**
   * `needs_credentials` is PRODUCTION-REACHABLE (P3a-11): a catalog install
   * whose entry declares `requiresSecret` lands here with no bound secret, and
   * stays there until POST …/:id/credentials binds one. Omitting it from this
   * union is what let `StatusBadge` render nothing at all for a freshly
   * installed connector.
   */
  status: "pending_approval" | "needs_credentials" | "active" | "disabled";
  /**
   * Declared by the catalog entry at install time. `true` + `secretRef === null`
   * is exactly the "installed but unusable" state the credential-binding
   * affordance exists to close.
   */
  requiresSecret: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Agents currently opted-in to this connector (the D4 per-agent set). The
   * Settings Agents panel seeds its checkboxes from this so a save (which
   * REPLACES the whole set via PUT …/agents) does not silently wipe agents the
   * founder didn't intend to touch (A34).
   */
  enabledAgentIds: string[];
  /**
   * Computed delivery health (FU-1): whether this ACTIVE connector would
   * currently reach its agents, and if not, the classified reason(s). `null`
   * for a non-active connector (the status badge covers it). Read-only — the
   * server derives it on every list; there is no persisted health column.
   */
  deliverability: ConnectorDeliverabilitySummary | null;
}

export interface CreateConnectorInput {
  serverName: string;
  displayName: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headerTemplate?: Record<string, string>;
  envTemplate?: Record<string, string>;
  secretRef?: string;
}

/**
 * A curated `connectors.json` entry decorated by
 * `GET …/mcp-connectors/catalog` with the deployment's own answers:
 *
 *  - `installable` — a PROJECTION of the server's D7 transport gate. `false`
 *    means this deployment refuses the entry outright (unverified stdio on a
 *    shared host); the shelf renders it greyed WITH the reason rather than
 *    hiding it.
 *  - `consentRequired` — true only for UNVERIFIED stdio, i.e. the one case
 *    where a command runs on the host without a verified publisher vouching
 *    for it.
 *  - `consentToken` / `consentExpiresAt` — present only when consent is
 *    required AND the deployment permits the install AND a signing secret
 *    exists. The token is minted from the SAME catalog read that produced the
 *    command shown here, and lives 15 minutes: the shelf must refetch before
 *    opening a stale install dialog or the install 400s.
 */
export interface McpConnectorShelfEntry extends McpConnectorCatalogEntry {
  installable: boolean;
  /**
   * The refusal message from the server's own D7 gate, present only when
   * `installable` is false. Rendered verbatim: deriving the copy client-side was
   * exact only because the gate has one refusal branch today, and would silently
   * misreport the reason the moment it grows a second.
   */
  unavailableReason?: string;
  consentRequired: boolean;
  consentToken?: string;
  consentExpiresAt?: number;
  /**
   * The OAuth broker path is available for this entry (mirrors the server's
   * `entry.requiresOAuth` projection, reset to `false` if D7 refuses the entry
   * outright). `true` + not-yet-installed is exactly the "Authorize" affordance;
   * once installed the connector still needs the sign-in round trip before it is
   * `active`, so this is orthogonal to `installable`.
   */
  oauthRequired?: boolean;
}

export interface McpConnectorShelf {
  entries: McpConnectorShelfEntry[];
  stale: boolean;
}

export const mcpConnectorsApi = {
  list: (companyId: string) =>
    api.get<McpConnector[]>(`/companies/${companyId}/mcp-connectors`),
  catalog: (companyId: string) =>
    api.get<McpConnectorShelf>(
      `/companies/${companyId}/mcp-connectors/catalog`
    ),
  install: (
    companyId: string,
    body: { entryId: string; consentToken?: string }
  ) =>
    api.post<McpConnector & { approvalId?: string | null }>(
      `/companies/${companyId}/mcp-connectors/install`,
      body
    ),
  /** Starts (or restarts) the OAuth broker round trip for an installed connector.
   *  The returned `authorizeUrl` is where the caller should navigate the browser
   *  next; nothing is bound until the provider redirects back to the callback. */
  oauthStart: (companyId: string, id: string) =>
    api.post<{ authorizeUrl: string }>(
      `/companies/${companyId}/mcp-connectors/${id}/oauth/start`,
      {}
    ),
  bindCredentials: (companyId: string, id: string, secretRef: string) =>
    api.post<McpConnector>(
      `/companies/${companyId}/mcp-connectors/${id}/credentials`,
      {
        secretRef,
      }
    ),
  create: (companyId: string, body: CreateConnectorInput) =>
    api.post<McpConnector & { approvalId?: string | null }>(
      `/companies/${companyId}/mcp-connectors`,
      body
    ),
  update: (
    companyId: string,
    id: string,
    body: { displayName?: string; status?: string }
  ) =>
    api.patch<McpConnector>(
      `/companies/${companyId}/mcp-connectors/${id}`,
      body
    ),
  remove: (companyId: string, id: string) =>
    api.delete<McpConnector>(`/companies/${companyId}/mcp-connectors/${id}`),
  setAgents: (companyId: string, id: string, agentIds: string[]) =>
    api.put<{ connectorId: string; agentIds: string[] }>(
      `/companies/${companyId}/mcp-connectors/${id}/agents`,
      { agentIds }
    ),
};
