/**
 * DB loader for MCP connectors: reads a company's connector rows, applies the
 * per-agent selection rule, and resolves each surviving connector's secret into
 * the shape `buildConnectorSpecs` consumes.
 *
 * Deliberately split from `mcp-connectors.ts` (amendment A24): that module stays
 * pure — no `drizzle-orm`, no `@armyofagents/db` — so the spec-building and
 * selection logic is testable with plain objects and carries zero runtime
 * dependencies. All I/O lives here.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  companyMcpConnectorAgents,
  companyMcpConnectors,
} from "@armyofagents/db";
import type { McpServerSpec } from "@armyofagents/adapter-utils";
import { logger } from "../middleware/logger.js";
import {
  adapterSupportsConnectors,
  buildConnectorSpecs,
  parseConnectorServerName,
  selectConnectorRowsForAgent,
  type LoadedConnectorRow,
} from "./mcp-connectors.js";
import { secretService, type SecretConsumerContext } from "./secrets.js";
import { logActivity } from "./activity-log.js";
import { buildConnectorEgressHosts } from "./mcp-connectors-env.js";
import { loadConfig } from "../config.js";
import { mcpConnectorService } from "./mcp-connectors-crud.js";
import {
  createDbRefreshLeaseStore,
  createDbRefreshCommitter,
  resolveConnectorToken,
  OAuthRefreshError,
} from "./mcp-connector-token-refresh.js";
import { deriveOAuthBundleKey } from "./mcp-connector-oauth-bundle.js";
import { refreshOAuthToken } from "./mcp-connector-oauth.js";
import { requireOAuthProviderPolicy } from "./mcp-connector-oauth-policy.js";
import { resolveConsentSecret } from "./mcp-connector-consent.js";
import {
  isMcpConnectorBlocked,
  readMcpConnectorEmergencyPolicy,
} from "./mcp-connector-emergency-policy.js";

export interface LoadEnabledConnectorRowsOptions {
  companyId: string;
  /** Explicit integration-test seam; production uses connection-pinned HTTPS. */
  oauthFetch?: typeof fetch;
  /**
   * The agent this run belongs to, or `null` for Commander. Commander is not
   * represented in `company_mcp_connector_agents` and receives every ACTIVE
   * company connector (D3).
   */
  agentId: string | null;
  /**
   * U11: true when THIS run resolved a per-run E2B sandbox execution target.
   * Forwarded to `selectConnectorRowsForAgent`'s D7 re-gate. Additive —
   * omitted/`false` is byte-identical to pre-U11 behaviour.
   */
  sandboxTarget?: boolean;
}

/**
 * Consumer identity for connector secret reads. `consumerType: "system"` is
 * load-bearing: `shouldEnforceSecretBinding` exempts system consumers from
 * requiring a `company_secret_bindings` row (secrets.ts), matching how the
 * GitHub PAT and provider keys resolve. The access is still audited, and
 * `configPath` names the individual connector so the audit trail distinguishes
 * them.
 */
function consumerContextFor(
  serverName: string,
  mcpOAuthOwner?: SecretConsumerContext["mcpOAuthOwner"],
): SecretConsumerContext {
  return {
    consumerType: "system",
    consumerId: "mcp-connectors",
    actorType: "system",
    configPath: `mcp.connector.${serverName}`,
    ...(mcpOAuthOwner ? { mcpOAuthOwner } : {}),
  };
}

const CONNECTOR_RESOLUTION_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await worker(values[index]!);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

/**
 * Load the connectors an agent run should receive, with secrets resolved.
 *
 * FAILURE ISOLATION (amendment A19): `resolveByName` THROWS when the referenced
 * secret is missing, soft-deleted, or inactive — a state trivially reached by
 * deleting a secret while a connector still points at it. Letting that
 * propagate would abort the whole load and hand the run NO connectors,
 * including every healthy one, with no visible cause. So each secret read is
 * isolated: a failure drops that ONE connector and logs a warning naming it.
 * One broken connector must degrade to "that connector is unavailable", never
 * "no connectors at all".
 */
export async function loadEnabledConnectorRows(
  db: Db,
  { companyId, agentId, oauthFetch, sandboxTarget }: LoadEnabledConnectorRowsOptions,
): Promise<LoadedConnectorRow[]> {
  // Fetch ALL of the company's connectors and let the pure selector apply the
  // status rule. Pre-filtering `status = 'active'` in SQL would put a
  // security-relevant predicate in two places, and the SQL copy is the one no
  // unit test covers.
  const connectors = await db
    .select()
    .from(companyMcpConnectors)
    .where(eq(companyMcpConnectors.companyId, companyId));

  const isCommander = agentId === null;

  // Commander is exempt from the per-agent opt-in, so the join table holds no
  // rows for it and querying it would be a pointless round-trip.
  let enabledConnectorIds = new Set<string>();
  if (agentId !== null) {
    const links = await db
      .select()
      .from(companyMcpConnectorAgents)
      .where(
        and(
          eq(companyMcpConnectorAgents.companyId, companyId),
          eq(companyMcpConnectorAgents.agentId, agentId),
        ),
      );
    enabledConnectorIds = new Set(links.map((link) => link.connectorId));
  }

  // FU-19: re-assert D7 against the host's CURRENT deployment mode. A connector
  // admissible at CREATE time (e.g. stdio/byo under local_trusted) but not under
  // the mode the host runs in NOW is dropped here rather than executed on a
  // shared host. The skip is logged (never silent) so an operator can see why a
  // connector stopped being delivered after a mode conversion.
  const deploymentMode = loadConfig().deploymentMode;
  const selected = selectConnectorRowsForAgent({
    connectors,
    enabledConnectorIds,
    isCommander,
    deploymentMode,
    sandboxTarget,
    onSkip: (connector, reason) => {
      logger.warn(
        {
          companyId,
          connectorId: connector.id,
          serverName: connector.serverName,
          transport: connector.transport,
          source: connector.source,
          deploymentMode,
          reason,
        },
        // Two delivery-time drop reasons now flow through here: `d7_blocked` (no
        // longer admissible under the current deployment mode) and `unsafe_command`
        // (a stdio command the create chokepoint would now refuse — a legacy/
        // imported/direct-DB row failing closed). `reason` distinguishes them.
        "MCP connector skipped at delivery (see `reason`: d7_blocked = deployment-mode re-gate; unsafe_command = command safety)",
      );
    },
  });
  const emergencyPolicy = readMcpConnectorEmergencyPolicy();
  const allowed = selected.filter((connector) => {
    if (!isMcpConnectorBlocked(connector.serverName, emergencyPolicy)) {
      return true;
    }
    logger.warn(
      {
        companyId,
        connectorId: connector.id,
        serverName: connector.serverName,
        policyEnabled: emergencyPolicy.enabled,
      },
      "MCP connector skipped at delivery by emergency policy",
    );
    return false;
  });
  if (allowed.length === 0) return [];

  const secrets = secretService(db);
  const resolved = await mapWithConcurrency(allowed, CONNECTOR_RESOLUTION_CONCURRENCY, async (connector) => {
    let secretValue: string | null = null;

    // A connector with no secretRef is an unauthenticated server — a legitimate
    // configuration, not a failure. Do not call the secrets service for it.
    if (connector.secretRef) {
      try {
        // `oauthPolicyVersion` is the true OAuth signal — it is set ONLY for
        // requiresOAuth catalog entries. `catalogEntryId` is set for EVERY
        // catalog connector (incl. plain-secret ones like notion-http), so
        // keying on it here misclassified non-OAuth catalog connectors as OAuth
        // and dropped them from delivery (returned [] instead of ['notion']).
        const hasOAuthIdentity = connector.oauthPolicyVersion != null;
        if (hasOAuthIdentity) {
          if (!connector.catalogEntryId || !connector.oauthPolicyVersion || connector.source !== "catalog") {
            throw new OAuthRefreshError(
              "OAuth connector identity is incomplete",
              "policy",
              "oauth_policy_blocked",
            );
          }
          const policy = requireOAuthProviderPolicy(
            connector.catalogEntryId,
            connector.oauthPolicyVersion,
          );
          const expectedSecretName = `mcp:oauth:${connector.id}`;
          const mcpOAuthOwner = {
            connectorId: connector.id,
            catalogEntryId: policy.entryId,
            oauthPolicyVersion: policy.version,
          };
          if (connector.secretRef !== expectedSecretName) {
            throw new OAuthRefreshError(
              "OAuth connector credential binding does not match its immutable identity",
              "policy",
              "oauth_secret_binding_mismatch",
            );
          }
          const assertRefreshAllowed = async () => {
            const current = await db
              .select({
                companyId: companyMcpConnectors.companyId,
                source: companyMcpConnectors.source,
                status: companyMcpConnectors.status,
                catalogEntryId: companyMcpConnectors.catalogEntryId,
                oauthPolicyVersion: companyMcpConnectors.oauthPolicyVersion,
                serverName: companyMcpConnectors.serverName,
                secretRef: companyMcpConnectors.secretRef,
              })
              .from(companyMcpConnectors)
              .where(eq(companyMcpConnectors.id, connector.id))
              .limit(1)
              .then((rows) => rows[0]);
            if (
              !current ||
              current.companyId !== companyId ||
              current.source !== "catalog" ||
              current.status !== "active" ||
              current.catalogEntryId !== policy.entryId ||
              current.oauthPolicyVersion !== policy.version ||
              current.serverName !== connector.serverName ||
              current.secretRef !== expectedSecretName ||
              isMcpConnectorBlocked(current.serverName)
            ) {
              throw new OAuthRefreshError(
                "OAuth connector changed during refresh",
                "policy",
                "oauth_policy_blocked",
              );
            }
            requireOAuthProviderPolicy(current.catalogEntryId, current.oauthPolicyVersion);
          };
          // All policy/identity/name checks happen before decrypting the secret.
          await assertRefreshAllowed();
          const raw = await secrets.resolveByName(
            companyId,
            expectedSecretName,
            consumerContextFor(connector.serverName, mcpOAuthOwner),
          );
          const context = {
            companyId,
            connectorId: connector.id,
            catalogEntryId: policy.entryId,
            oauthPolicyVersion: policy.version,
            secretName: expectedSecretName,
            bundleKey: deriveOAuthBundleKey(resolveConsentSecret()),
            serverName: connector.serverName,
          };
          secretValue = await resolveConnectorToken(
            {
              secrets: {
                getByName: (c, n) => secrets.getByName(c, n),
                resolveByName: (c, n) =>
                  secrets.resolveByName(
                    c,
                    n,
                    consumerContextFor(connector.serverName, mcpOAuthOwner),
                  ),
              },
              leases: createDbRefreshLeaseStore(db),
              refreshOAuthToken: oauthFetch
                ? (params) => refreshOAuthToken(params, oauthFetch)
                : undefined,
              commitRefresh: createDbRefreshCommitter(db, context),
              assertRefreshAllowed,
            },
            context,
            raw,
          );
        } else {
          secretValue = await secrets.resolveByName(
            companyId,
            connector.secretRef,
            consumerContextFor(connector.serverName),
          );
        }
      } catch (err) {
        // Never log `secretValue` here — resolution failed, but keep the habit
        // explicit so a future edit does not add it.
        if (err instanceof OAuthRefreshError && err.kind === "permanent") {
          // Task 13: a dead refresh token (or a refresh request the AS rejects)
          // must not fail the run — flip the connector to `needs_credentials` so
          // the founder gets a re-authorize prompt (Task 16), and drop it from
          // this load like any other unresolvable secret.
          await mcpConnectorService(db)
            .updateIfStatus(connector.id, "active", { status: "needs_credentials" })
            .catch(() => {});
          logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "oauth-broker",
            agentId: null,
            action: "mcp_connector.oauth_refresh_failed",
            entityType: "mcp_connector",
            entityId: connector.id,
            details: { serverName: connector.serverName },
          }).catch(() => {});
        }
        logger.warn(
          {
            err,
            companyId,
            connectorId: connector.id,
            serverName: connector.serverName,
            secretRef: connector.secretRef,
          },
          "MCP connector skipped: secret could not be resolved/refreshed",
        );
        return null; // failure isolation: drop THIS connector only
      }
    }

    return {
      connectorId: connector.id,
      serverName: connector.serverName,
      transport: connector.transport,
      url: connector.url,
      command: connector.command,
      args: connector.args,
      headerTemplate: connector.headerTemplate,
      envTemplate: connector.envTemplate,
      trustTier: connector.trustTier ?? null,
      secretValue,
    } satisfies LoadedConnectorRow;
  });

  // The `mcp_connector.delivered` audit (Decision #116 clause 7) is emitted by
  // `resolveAgentConnectors` AFTER `buildConnectorSpecs`, NOT here — a row can
  // pass the selector + resolve its secret yet still be dropped by the spec
  // builder (a stdio row with no command → `missing_command`, an unknown
  // transport, a malformed jsonb column). Auditing here would claim a connector
  // was delivered that never reached the CLI (Codex review). The row now carries
  // `connectorId`/`trustTier` so the caller can audit only the survivors.
  return resolved.filter((row): row is LoadedConnectorRow => row !== null);
}

export interface ConnectorToolAutoAllowInput {
  companyId: string;
  /** Trusted run agent id, or `null` for Commander (all-active, D3). */
  agentId: string | null;
  /** The run's adapter type — only connector-capable adapters can host MCP servers. */
  adapterType: string | null | undefined;
  /** The raw PreToolUse tool name, expected shape `mcp__<serverName>__<tool>`. */
  toolName: string | null | undefined;
  /**
   * U11: true when THIS run resolved a per-run E2B sandbox execution target.
   * Forwarded to `selectConnectorRowsForAgent` so the auto-allow verdict
   * agrees with delivery — a stdio connector's tool is only auto-allowed when
   * the run is sandboxed. Additive — omitted/`false` preserves pre-U11
   * behaviour.
   */
  sandboxTarget?: boolean;
}

/**
 * FU-25: decide whether a runtime PreToolUse permission request is for a tool
 * that belongs to a connector THIS run is allowed to use — and may therefore be
 * auto-allowed without a human. Returns `true` ONLY when every scoping rule
 * holds:
 *
 *  1. The tool name parses to a non-reserved connector serverName
 *     (`parseConnectorServerName` — reserved `aoa`/`playwright` and malformed
 *     names return null → false here). Only the connector's OWN tools qualify.
 *  2. The adapter is connector-capable (a non-MCP adapter has no connector tools;
 *     a query would be wasted and the answer is trivially no).
 *  3. There is a company connector with that exact serverName that survives the
 *     SAME delivery selector `selectConnectorRowsForAgent` — status === "active"
 *     AND (assigned to this agent via `company_mcp_connector_agents`, OR
 *     Commander) AND admissible under the host's CURRENT deployment mode (D7).
 *
 * This is intentionally a THIN wrapper over the exact query + selector the
 * delivery path uses (`loadEnabledConnectorRows`), minus secret resolution: a
 * broken secret is a delivery failure, not an authorization one, and the
 * permission grant is still correctly scoped to an active, assigned connector.
 * Reusing `selectConnectorRowsForAgent` keeps the security predicate in ONE
 * place — it cannot drift from what actually gets delivered.
 *
 * Company + agent scope come from the run's VERIFIED context (the caller passes
 * the broker's own companyId/agentId), never from the hook request body.
 */
export async function isConnectorToolAutoAllowed(
  db: Db,
  input: ConnectorToolAutoAllowInput,
): Promise<boolean> {
  const serverName = parseConnectorServerName(input.toolName);
  if (serverName === null) return false;
  if (!adapterSupportsConnectors(input.adapterType)) return false;
  if (isMcpConnectorBlocked(serverName)) return false;

  const isCommander = input.agentId === null;

  const connectors = await db
    .select()
    .from(companyMcpConnectors)
    .where(eq(companyMcpConnectors.companyId, input.companyId));

  let enabledConnectorIds = new Set<string>();
  if (input.agentId !== null) {
    const links = await db
      .select()
      .from(companyMcpConnectorAgents)
      .where(
        and(
          eq(companyMcpConnectorAgents.companyId, input.companyId),
          eq(companyMcpConnectorAgents.agentId, input.agentId),
        ),
      );
    enabledConnectorIds = new Set(links.map((link) => link.connectorId));
  }

  const deploymentMode = loadConfig().deploymentMode;
  const selected = selectConnectorRowsForAgent({
    connectors,
    enabledConnectorIds,
    isCommander,
    deploymentMode,
    sandboxTarget: input.sandboxTarget,
  });

  return selected.some((connector) => connector.serverName === serverName);
}

/** Minimal logger surface `resolveAgentConnectors` needs — matches pino's `.warn(meta, msg)` shape. */
export interface ConnectorLogger {
  warn: (meta: Record<string, unknown>, msg: string) => void;
}

export interface ResolveAgentConnectorsInput {
  companyId: string;
  /** Real agent id for per-agent opt-in (D4); null for Commander/all-active (D3). */
  agentId: string | null;
  runId?: string;
  logger?: ConnectorLogger;
  /**
   * U11: true when THIS run resolved a per-run E2B sandbox execution target
   * (`acquisition.environment.driver === "sandbox"`, S5 — never a top-level
   * `acquisition.driver`). Forwarded to `loadEnabledConnectorRows` so a stdio
   * connector is delivered in-VM but still dropped on an unsandboxed host.
   * Additive — omitted/`false` is byte-identical to pre-U11 behaviour.
   */
  sandboxTarget?: boolean;
}

export interface ResolveAgentConnectorsResult {
  extraMcpServers: Record<string, McpServerSpec>;
  connectorEnv: Record<string, string>;
  /**
   * U11: the bare-host egress list for the connectors ACTUALLY delivered by
   * this call (post real `sandboxTarget`/D7/command-safety gating) — additive,
   * existing callers ignore it. This is the ACCURATE picture; it is NOT what
   * feeds the sandbox's own `egressAllowlist` at acquire time, because the
   * sandbox lease is acquired BEFORE this function can run (its `sandboxTarget`
   * input itself comes from the already-resolved acquisition — see heartbeat.ts
   * / runner.ts). The PRE-acquire estimate that actually populates the
   * provider's `egressAllowlist` is `loadConnectorEgressHosts` below.
   */
  egressHosts: string[];
}

/**
 * Single place all three delivery paths (heartbeat, crew, Commander) resolve a
 * company's enabled connectors into `{ extraMcpServers, connectorEnv }`.
 *
 * Lives here (not in the pure `mcp-connectors.ts`) deliberately: it needs BOTH
 * `loadEnabledConnectorRows` (this file, DB I/O) and `buildConnectorSpecs` (the
 * pure module, which this file already imports one-way). Putting this in the
 * pure module and importing the loader back would create a
 * `mcp-connectors.ts ⇄ mcp-connectors-loader.ts` cycle.
 *
 * Skipped connectors are logged HERE (a silently vanishing connector is the
 * worst failure mode — A8/A19) rather than left for callers to remember, so
 * the skip-log has one unit-testable seam instead of three call-site copies.
 */
export async function resolveAgentConnectors(
  db: Db,
  input: ResolveAgentConnectorsInput,
): Promise<ResolveAgentConnectorsResult> {
  const rows = await loadEnabledConnectorRows(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    sandboxTarget: input.sandboxTarget,
  });
  const { specs, env, skipped } = buildConnectorSpecs(rows);
  if (skipped.length > 0 && input.logger) {
    input.logger.warn(
      {
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        skipped,
      },
      "mcp connectors skipped for agent run",
    );
  }

  // Decision #116 clause 7 — audit each connector actually DELIVERED to the run,
  // i.e. one that produced a spec. Emitting this AFTER buildConnectorSpecs (not
  // in the loader) is deliberate: a row that passed the selector + resolved its
  // secret can still be dropped here (`missing_command`, `unknown_transport`,
  // `malformed_row`) and never reach the CLI — auditing it as delivered would be
  // a false entry in a security trail (Codex review). Best-effort: an audit
  // failure must never break a delivery that already succeeded.
  //
  // SCOPE (Codex F5): this is the SERVER-SIDE resolution point — the connector
  // was resolved into the run's connector set and handed to the adapter. A
  // downstream ADAPTER writer can still drop it (codex → `secret_unreachable` for
  // a secret-bearing stdio spec; sandbox-docker → all MCP skipped); those drops
  // are separately reported by the writers (McpWriterSkipReason) and surfaced in
  // the deliverability preview. Auditing the exact adapter-written set needs each
  // writer to report its survivors — tracked as a follow-up; this event errs
  // toward recording that AoA MADE the connector available to the run.
  const skippedNames = new Set(skipped.map((s) => s.serverName));
  for (const row of rows) {
    if (skippedNames.has(row.serverName)) continue;
    try {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "mcp-connectors",
        agentId: input.agentId,
        runId: input.runId ?? null,
        action: "mcp_connector.delivered",
        entityType: "mcp_connector",
        entityId: row.connectorId,
        details: {
          serverName: row.serverName,
          transport: row.transport,
          trustTier: row.trustTier,
          ...(row.transport === "stdio" ? { command: row.command ?? null } : {}),
        },
      });
    } catch (err) {
      logger.warn(
        { err, companyId: input.companyId, connectorId: row.connectorId, serverName: row.serverName },
        "mcp_connector.delivered audit failed (delivery unaffected)",
      );
    }
  }

  return { extraMcpServers: specs, connectorEnv: env, egressHosts: buildConnectorEgressHosts(rows) };
}

/**
 * U11 — PRE-acquire estimate of the external hosts this run's connectors
 * might need, for populating the sandbox provider's best-effort
 * `egressAllowlist` (U6.2's `SandboxProviderAcquireInput.egressAllowlist` seam)
 * at the acquire call itself. Necessary because of a real ordering constraint:
 * at every current call site (heartbeat.ts, runner.ts), the sandbox is
 * acquired BEFORE `resolveAgentConnectors` runs — `resolveAgentConnectors`'s
 * own `sandboxTarget` argument comes FROM that already-resolved acquisition,
 * so this run's final connector set genuinely cannot be known before the
 * acquire. Deliberately OPTIMISTIC: computed with `sandboxTarget: true` (we
 * are estimating hosts for the sandbox we are ABOUT to request), so a stdio
 * connector that would only become admissible once inside the VM IS counted
 * here even though the D7 gate has not really cleared it yet. Safe to be
 * optimistic — this list is advisory/best-effort only (never a security
 * boundary; `isTransportAllowed`/`isStdioCommandSafe` independently gate the
 * REAL delivery, unaffected by this estimate) and the U6.2 provider layer
 * never enforces it strictly (managed E2B "MUST NOT throw when it cannot lock
 * egress down").
 *
 * Deliberately skips secret resolution (unlike `loadEnabledConnectorRows`) —
 * only `transport`/`url`/`command` are needed to compute hosts, so this reads
 * the same two tables and reuses the same `selectConnectorRowsForAgent` gate,
 * but never touches the secrets service. Never throws: a DB hiccup here must
 * not block the sandbox from being acquired at all — it degrades to an empty
 * allowlist, which the provider layer already treats as "no restriction
 * recorded" (harmless).
 */
export async function loadConnectorEgressHosts(
  db: Db,
  { companyId, agentId }: { companyId: string; agentId: string | null },
): Promise<string[]> {
  try {
    const connectors = await db
      .select()
      .from(companyMcpConnectors)
      .where(eq(companyMcpConnectors.companyId, companyId));
    if (connectors.length === 0) return [];

    const isCommander = agentId === null;
    let enabledConnectorIds = new Set<string>();
    if (agentId !== null) {
      const links = await db
        .select()
        .from(companyMcpConnectorAgents)
        .where(
          and(
            eq(companyMcpConnectorAgents.companyId, companyId),
            eq(companyMcpConnectorAgents.agentId, agentId),
          ),
        );
      enabledConnectorIds = new Set(links.map((link) => link.connectorId));
    }

    const deploymentMode = loadConfig().deploymentMode;
    const selected = selectConnectorRowsForAgent({
      connectors,
      enabledConnectorIds,
      isCommander,
      deploymentMode,
      // Optimistic (see doc-comment above): estimating for the sandbox this
      // run is ABOUT to acquire, not the (not-yet-known) real verdict.
      sandboxTarget: true,
    });
    return buildConnectorEgressHosts(
      selected as unknown as Array<{ transport: string; url: string | null; command: string | null }>,
    );
  } catch (err) {
    logger.warn(
      { err, companyId, agentId },
      "loadConnectorEgressHosts failed (best-effort, sandbox egressAllowlist stays empty)",
    );
    return [];
  }
}
