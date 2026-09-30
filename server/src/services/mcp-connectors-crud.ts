/**
 * Persistence for founder-registered MCP connectors (Task 11 write path).
 *
 * Deliberately thin — the LOAD-BEARING validation (serverName charset,
 * transport/url/command coherence, template shapes, secretRef existence) lives
 * in the route's zod schema + handler, because the DB enforces none of it (a
 * CHECK on transport would be an enum in disguise, amendment A2). This module
 * only performs I/O once the route has already validated.
 *
 * Split from the pure `mcp-connectors.ts` (spec building / selection) and the
 * read-path `mcp-connectors-loader.ts` so each file carries a single concern.
 */

import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, companyMcpConnectorAgents, companyMcpConnectors } from "@armyofagents/db";
import {
  computeConnectorDeliverability,
  type ConnectorDeliverabilitySummary,
} from "./mcp-connectors.js";
import { loadConfig } from "../config.js";
import { secretService } from "./secrets.js";

export type ConnectorInsert = {
  serverName: string;
  displayName: string;
  transport: string;
  url?: string | null;
  command?: string | null;
  args?: string[];
  headerTemplate?: Record<string, string>;
  envTemplate?: Record<string, string>;
  secretRef?: string | null;
  /**
   * Whether the connector CANNOT function without a bound secret. Comes from the
   * catalog entry at install; false for BYO. Load-bearing downstream:
   * `resolveConnectorStatus` refuses to mark a requiresSecret connector `active`
   * while no secret is bound, so dropping it here would let an approval activate
   * an uncredentialed connector.
   */
  requiresSecret?: boolean;
  source?: string;
  catalogEntryId?: string | null;
  oauthPolicyVersion?: number | null;
  /**
   * Catalog trust tier at install ("verified" | "community" | "unverified"), or
   * null for BYO. Persisted so the FU-19 delivery-time D7 re-check can honor the
   * `catalog + verified` exemption after a mode conversion instead of failing
   * closed for every stdio connector.
   */
  trustTier?: string | null;
  status: string;
  createdByUserId?: string | null;
};

export type ConnectorPatch = {
  displayName?: string;
  status?: string;
  /**
   * The NAME of a company secret, not a secret value — resolved at delivery time
   * (see mcp-connectors-loader.ts). Settable only through
   * `POST …/mcp-connectors/:id/credentials`, which checks the secret exists and
   * re-derives `status` in the same write; `updateConnectorSchema` (PATCH) is
   * `.strict()` on displayName+status and deliberately does NOT accept it, because
   * changing the bound credential without re-deriving status is how a connector
   * ends up `active` with a dangling ref.
   *
   * DELIBERATELY NOT `string | null`. Clearing a binding would break
   * "`active` ∧ `requiresSecret` ⇒ `secretRef`" WITHOUT being a status write at
   * all, so it would slip past every status-keyed guard in this subsystem. No
   * caller needs it. If one ever does, `update` must re-derive `status` whenever
   * `secretRef` changes — do not just widen this type.
   */
  secretRef?: string;
};

/** Shared by `update` and `updateIfStatus` so the two cannot drift. */
function buildConnectorPatchSet(patch: ConnectorPatch): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.secretRef !== undefined) set.secretRef = patch.secretRef;
  return set;
}

export function mcpConnectorService(db: Db) {
  return {
    /**
     * List a company's connectors, each augmented with `enabledAgentIds` — the
     * per-agent opt-in set (D4) — and a computed `deliverability` summary (FU-1).
     *
     * Done as grouped follow-up queries (not N+1): fetch every junction row for
     * the company's connectors in a single `inArray`, then bucket in JS.
     * Returning the current set lets the Settings Agents panel pre-populate its
     * selection so editing is non-destructive (A34): `PUT …/agents` REPLACES the
     * whole set, so a panel that started empty would silently wipe already-enabled
     * agents on save.
     *
     * `deliverability` answers "would this ACTIVE connector actually reach agents
     * right now?" WITHOUT waiting for a run to fail (option A, FU-1). It reuses
     * the delivery pipeline's own primitives via `computeConnectorDeliverability`,
     * so the Settings surface cannot claim a connector is healthy while the
     * delivery path silently drops it. `null` for non-active connectors (their
     * status badge already explains them).
     */
    list: async (companyId: string) => {
      const rows = await db
        .select()
        .from(companyMcpConnectors)
        .where(eq(companyMcpConnectors.companyId, companyId))
        .orderBy(desc(companyMcpConnectors.createdAt));
      if (rows.length === 0) return [];
      const links = await db
        .select({
          connectorId: companyMcpConnectorAgents.connectorId,
          agentId: companyMcpConnectorAgents.agentId,
        })
        .from(companyMcpConnectorAgents)
        .where(
          inArray(
            companyMcpConnectorAgents.connectorId,
            rows.map((r) => r.id),
          ),
        );
      const byConnector = new Map<string, string[]>();
      for (const link of links) {
        const list = byConnector.get(link.connectorId);
        if (list) list.push(link.agentId);
        else byConnector.set(link.connectorId, [link.agentId]);
      }

      // Resolve every assigned agent to { name, adapterType } so deliverability
      // can be evaluated per adapter (codex `secret_unreachable` differs from a
      // claude agent). One grouped query over exactly the referenced agent ids.
      const assignedAgentIds = [...new Set(links.map((l) => l.agentId))];
      const agentInfo = new Map<string, { name: string; adapterType: string }>();
      if (assignedAgentIds.length > 0) {
        const agentRows = await db
          .select({
            id: agents.id,
            name: agents.name,
            adapterType: agents.adapterType,
          })
          .from(agents)
          .where(
            and(eq(agents.companyId, companyId), inArray(agents.id, assignedAgentIds)),
          );
        for (const a of agentRows) {
          agentInfo.set(a.id, { name: a.name, adapterType: a.adapterType });
        }
      }

      const deploymentMode = loadConfig().deploymentMode;
      // F2 — ONE grouped, non-decrypting query so the deliverability preview
      // reflects real resolvability: a connector active with a bound secret that
      // was later deleted/disabled is dropped by every run, but the row stays
      // active. Fetched once here (the sync map below can't await).
      const resolvableSecretNames = await secretService(db).activeSecretNames(companyId);

      return rows.map((r) => {
        const enabledAgentIds = byConnector.get(r.id) ?? [];
        const deliverability: ConnectorDeliverabilitySummary | null =
          computeConnectorDeliverability({
            connector: {
              status: r.status,
              transport: r.transport,
              source: r.source,
              trustTier: r.trustTier,
              url: r.url,
              command: r.command,
              args: r.args,
              headerTemplate: r.headerTemplate,
              envTemplate: r.envTemplate,
              secretRef: r.secretRef,
            },
            deploymentMode,
            secretResolvable: r.secretRef ? resolvableSecretNames.has(r.secretRef) : undefined,
            assignedAgents: enabledAgentIds.map((agentId) => {
              const info = agentInfo.get(agentId);
              return {
                agentId,
                // An assigned agent that no longer resolves (deleted between the
                // link read and here) is named generically rather than dropped —
                // it still cannot receive the connector.
                agentName: info?.name ?? "Unknown agent",
                adapterType: info?.adapterType,
              };
            }),
          });
        return { ...r, enabledAgentIds, deliverability };
      });
    },

    getById: (id: string) =>
      db
        .select()
        .from(companyMcpConnectors)
        .where(eq(companyMcpConnectors.id, id))
        .then((rows) => rows[0] ?? null),

    getByName: (companyId: string, serverName: string) =>
      db
        .select()
        .from(companyMcpConnectors)
        .where(
          and(
            eq(companyMcpConnectors.companyId, companyId),
            eq(companyMcpConnectors.serverName, serverName),
          ),
        )
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, input: ConnectorInsert) =>
      db
        .insert(companyMcpConnectors)
        .values({
          companyId,
          serverName: input.serverName,
          displayName: input.displayName,
          transport: input.transport,
          url: input.url ?? null,
          command: input.command ?? null,
          args: input.args ?? [],
          headerTemplate: input.headerTemplate ?? {},
          envTemplate: input.envTemplate ?? {},
          secretRef: input.secretRef ?? null,
          requiresSecret: input.requiresSecret ?? false,
          source: input.source ?? "byo",
          catalogEntryId: input.catalogEntryId ?? null,
          oauthPolicyVersion: input.oauthPolicyVersion ?? null,
          trustTier: input.trustTier ?? null,
          status: input.status,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, patch: ConnectorPatch) => {
      const set = buildConnectorPatchSet(patch);
      return db
        .update(companyMcpConnectors)
        .set(set)
        .where(eq(companyMcpConnectors.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /**
     * `update`, but only if the row is STILL in `expectedStatus` — a guarded
     * UPDATE in the sense of Codex #267 P2 (the crew_dispatch precedent in
     * services/approvals.ts). Returns `null` when the precondition failed.
     *
     * WHY: the two callers that derive a status (approve, credential-binding)
     * both read the row, compute the next status from what they read, then write.
     * That read-compute-write is a TOCTOU: if a founder binds a secret while the
     * board approves, the loser's stale derivation overwrites the winner's. The
     * damaging interleave is bind-lands-last in `authenticated` — the connector
     * ends `pending_approval` with the approval already closed, and there is NO
     * recovery (re-binding re-derives `pending_approval`, PATCH→active is refused
     * by the C2 gate, and the approval cannot be re-approved).
     *
     * Both callers fail CLOSED on a lost race (no activation / a 409 the founder
     * can retry), which is why this is safe to apply there. It is deliberately
     * NOT used by `applyConnectorRejection`: that write is a blind `disabled`,
     * and guarding it would fail OPEN — a connector the board just rejected would
     * stay enabled because someone touched it concurrently.
     */
    updateIfStatus: (id: string, expectedStatus: string, patch: ConnectorPatch) => {
      const set = buildConnectorPatchSet(patch);
      return db
        .update(companyMcpConnectors)
        .set(set)
        .where(
          and(
            eq(companyMcpConnectors.id, id),
            eq(companyMcpConnectors.status, expectedStatus),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /**
     * `updateIfStatus`, but the guard ALSO re-checks whether a secret is bound —
     * for the approve path (Finding 6), whose derived status depends on BOTH the
     * connector's approval status AND its secret-boundness (`hasSecret`).
     *
     * WHY status alone is insufficient here: a concurrent credential-bind can add
     * `secretRef` while status stays `pending_approval`. Approve, having read the
     * pre-bind snapshot, would derive `needs_credentials` and — guarding on status
     * only — overwrite the just-bound secret's row, stranding the connector at
     * `needs_credentials` with a secret bound and the approval already closed (no
     * recovery in `authenticated`). Guarding on secret-boundness too makes that a
     * 0-row no-op the caller re-derives from.
     *
     * `expectSecretBound` maps to `secretRef IS [NOT] NULL`. An empty-string
     * secretRef (which the status derivation treats as UNBOUND) is a schema-level
     * non-case — `secretRef` is null or a validated non-empty name everywhere it
     * is set — and a mismatch there merely fails the guard (fail-closed), never
     * activates.
     */
    updateIfStatusAndSecret: (
      id: string,
      expectedStatus: string,
      expectSecretBound: boolean,
      patch: ConnectorPatch,
    ) => {
      const set = buildConnectorPatchSet(patch);
      return db
        .update(companyMcpConnectors)
        .set(set)
        .where(
          and(
            eq(companyMcpConnectors.id, id),
            eq(companyMcpConnectors.status, expectedStatus),
            expectSecretBound
              ? isNotNull(companyMcpConnectors.secretRef)
              : isNull(companyMcpConnectors.secretRef),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (id: string) =>
      db
        .delete(companyMcpConnectors)
        .where(eq(companyMcpConnectors.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listAgentIds: (connectorId: string) =>
      db
        .select({ agentId: companyMcpConnectorAgents.agentId })
        .from(companyMcpConnectorAgents)
        .where(eq(companyMcpConnectorAgents.connectorId, connectorId))
        .then((rows) => rows.map((r) => r.agentId)),

    /**
     * Of the supplied agentIds, return those that actually belong to `companyId`.
     * The route rejects the request when this set is smaller than the request —
     * a connector must never be granted to an agent from another tenant.
     */
    agentIdsInCompany: async (companyId: string, agentIds: string[]): Promise<string[]> => {
      if (agentIds.length === 0) return [];
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
      return rows.map((r) => r.id);
    },

    /**
     * Replace the enabled-agent set for a connector atomically: delete all
     * existing links, then insert the new set. Deduped so a repeated agentId in
     * the request cannot trip the (connector, agent) unique index.
     */
    replaceAgents: (companyId: string, connectorId: string, agentIds: string[]) =>
      db.transaction(async (tx) => {
        await tx
          .delete(companyMcpConnectorAgents)
          .where(eq(companyMcpConnectorAgents.connectorId, connectorId));
        const unique = [...new Set(agentIds)];
        if (unique.length > 0) {
          await tx.insert(companyMcpConnectorAgents).values(
            unique.map((agentId) => ({ companyId, connectorId, agentId })),
          );
        }
      }),
  };
}
