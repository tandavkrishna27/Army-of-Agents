/**
 * @fileoverview THE single creation path for an MCP connector.
 *
 * WHY THIS EXISTS: `mcpConnectorService.create()` is a bare INSERT — that
 * module's own header says the load-bearing validation lives in the caller. All
 * of the actual governance previously sat inline in the founder-facing POST
 * handler: the (companyId, serverName) 409, the secretRef-existence check, the
 * status derivation, the `install_mcp_connector` approval, and the activity-log
 * entry. A second caller (the catalog install route) reaching for `svc.create()`
 * would silently fork every one of those into an untested copy — D6/D7 would
 * then exist in two places and the marketplace copy would be the untested one.
 * Both callers now share this function.
 *
 * WHAT IS DELIBERATELY *NOT* HERE — the D7 transport gate
 * (`assertTransportAllowed`). It needs the CATALOG TRUST TIER, which only the
 * caller knows (a BYO connector has no tier at all), and it must run BEFORE any
 * write. So each caller asserts it itself, ahead of calling this function. There
 * is a test pinning this absence; do not "helpfully" move the gate in here.
 *
 * STATUS: on THIS PATH, `resolveConnectorStatus` is the only thing that decides
 * the status — this function does not branch on deployment mode itself, it hands
 * the axes to that resolver and persists the answer. The approve path
 * (`applyConnectorApproval`) and the credential-binding route now do the same;
 * PATCH → "active" stays deliberately open in `local_trusted` only. See the
 * SCOPE note in mcp-connector-status.ts before relying on it more broadly.
 *
 * DEPENDENCIES ARE INJECTED so the governance above is unit-testable with no DB.
 */

import { RESERVED_MCP_SERVER_NAMES } from "@armyofagents/adapter-utils";
import { badRequest, conflict, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  ConnectorCommandUnsafeError,
  assertStdioCommandSafe,
} from "./mcp-connector-command-safety.js";
import { resolveConnectorStatus } from "./mcp-connector-status.js";
import { isMcpConnectorBlocked } from "./mcp-connector-emergency-policy.js";
import { assertNotMcpOAuthManaged } from "./secrets.js";
import type { LogActivityInput } from "./activity-log.js";
import type { ConnectorInsert } from "./mcp-connectors-crud.js";
// TYPE-ONLY, and it must stay that way: these imports are erased at build time,
// so this module pulls in neither drizzle nor a DB handle at runtime — which is
// what lets the governance above be unit-tested with plain object mocks.
import type { approvals } from "@armyofagents/db";

// Matches the founder-facing route's original check: an actorId that is not a
// UUID (e.g. the synthetic "board"/"mcp-user" ids) is NOT a foreign key into
// users, so it must be stored as null rather than corrupting provenance.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The unique index behind the (companyId, serverName) uniqueness rule
// (packages/db/src/schema/company_mcp_connectors.ts). FINDING 4 — the pre-check
// (getByName) still handles the common case with a friendly early 409, but two
// concurrent creates can both pass it and race to the INSERT; the loser used to
// surface a raw 23505 as a 500. Catching THIS constraint (narrowly, never a bare
// 23505 that could belong to the approval insert) turns that race into the same
// clean 409.
const CONNECTOR_NAME_CONSTRAINT = "company_mcp_connectors_company_name_uq";
const CONNECTOR_CATALOG_CONSTRAINT = "company_mcp_connectors_company_catalog_entry_uq";
function isConnectorNameUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code !== "23505") return false;
  // `constraint` is populated by node-postgres; `message` is the fallback for
  // wrappers that carry only the text.
  return [e.constraint, e.message].some(
    (field) => typeof field === "string" && field.includes(CONNECTOR_NAME_CONSTRAINT),
  );
}

function isConnectorCatalogUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  return e.code === "23505" && [e.constraint, e.message].some(
    (field) => typeof field === "string" && field.includes(CONNECTOR_CATALOG_CONSTRAINT),
  );
}

type ApprovalInsert = Omit<typeof approvals.$inferInsert, "companyId">;

/** The slice of each service this function actually uses. */
export type CreateConnectorDeps = {
  svc: {
    getByName: (companyId: string, serverName: string) => Promise<unknown>;
    create: (companyId: string, input: ConnectorInsert) => Promise<any>;
  };
  secretsSvc: {
    getByName: (companyId: string, name: string) => Promise<unknown>;
  };
  approvalsSvc: {
    create: (companyId: string, data: ApprovalInsert) => Promise<{ id: string } | null | undefined>;
  };
  /**
   * FINDING 4 — runs the connector-insert + approval-insert ATOMICALLY. The
   * callback receives tx-bound `svc` + `approvalsSvc`, so a failure in EITHER
   * insert rolls back BOTH: an approval-create failure can no longer strand a
   * `pending_approval` connector with no approval row (unactivatable). The route
   * wraps a real `db.transaction`; unit tests inject a pass-through that calls
   * `run` with the plain mocks (no DB), still exercising ordering + throw-rollback.
   */
  withInsertTransaction: <T>(
    run: (tx: {
      svc: { create: CreateConnectorDeps["svc"]["create"] };
      approvalsSvc: CreateConnectorDeps["approvalsSvc"];
    }) => Promise<T>,
  ) => Promise<T>;
  /**
   * Pre-bound to the caller's `db` — this module never touches a Db handle, which
   * is what keeps it unit-testable. Runs AFTER commit and is best-effort: a
   * logging failure must NOT 500 a request whose connector already committed.
   */
  logActivity: (input: LogActivityInput) => Promise<void>;
};

export type CreateConnectorInput = {
  companyId: string;
  serverName: string;
  displayName: string;
  /**
   * Narrow on purpose: this is the field the D7 gate keys on, and the future
   * catalog caller is exactly who a widened `string` would fail to protect.
   */
  transport: "http" | "stdio";
  url?: string | null;
  command?: string | null;
  args?: string[];
  headerTemplate?: Record<string, string>;
  envTemplate?: Record<string, string>;
  secretRef?: string | null;
  /** Does this connector refuse to function without a bound secret? BYO = false. */
  requiresSecret: boolean;
  /** Forced by the caller, never taken from a client body. */
  source: "byo" | "catalog";
  /** Immutable server-owned catalog identity; null for BYO connectors. */
  catalogEntryId?: string | null;
  /** Pinned server OAuth policy version; null for non-OAuth/BYO connectors. */
  oauthPolicyVersion?: number | null;
  /**
   * Catalog trust tier at install ("verified" | "community" | "unverified"), or
   * null for BYO (no catalog provenance). Persisted so the FU-19 delivery-time D7
   * re-check keeps the `catalog + verified` exemption after a mode conversion.
   */
  trustTier?: string | null;
  deploymentMode: string;
  actor: { actorType: "user" | "agent"; actorId: string; agentId: string | null };
};

export async function createConnector(
  deps: CreateConnectorDeps,
  input: CreateConnectorInput,
): Promise<{ connector: any; approvalId: string | null }> {
  const { svc, secretsSvc, withInsertTransaction, logActivity } = deps;
  const { companyId, actor } = input;

  // The emergency policy is a write barrier as well as a delivery filter.
  // Otherwise a founder could stage a connector while it is revoked and have
  // it spring live when an operator later lifts the incident control.
  if (isMcpConnectorBlocked(input.serverName)) {
    throw forbidden(
      `Connector "${input.serverName}" is disabled by the operator's MCP connector policy`,
    );
  }

  // Uniqueness (companyId, serverName) — friendly early 409 for the common case.
  // NOT the sole guard: two concurrent creates can both pass this and race to the
  // INSERT, so the atomic write below ALSO catches the constraint violation and
  // answers the race with the same 409 (rather than a raw 500).
  const existing = await svc.getByName(companyId, input.serverName);
  if (existing) {
    throw conflict(`A connector named "${input.serverName}" already exists`);
  }

  // P2 (Codex): reserved AoA-owned names ("aoa"/"playwright") must never become a
  // connector. The BYO route's Zod already rejects them (FU-28), but the CATALOG
  // install path builds its input straight from the entry and reaches this shared
  // chokepoint without that Zod — so a reserved-name catalog entry would install,
  // then get silently removed by `stripReservedMcpServerNames` at every adapter
  // merge, leaving a permanently dead connector the shelf still shows as valid.
  // Guarding here covers BOTH callers.
  if ((RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(input.serverName)) {
    throw badRequest(
      `"${input.serverName}" is a reserved AoA server name and cannot be used for a connector`,
    );
  }

  // Decision #116 clause 7 — command safety. Unlike D7 (which needs a caller-only
  // trust tier), this gate needs nothing the caller has to supply, so it lives
  // HERE and covers BOTH the BYO and catalog callers in EVERY deployment mode. It
  // authorizes a package IDENTITY + shape (launcher allowlist, exact pin, closed
  // grammar, no shell metachars, only the own `${TOKEN}`); it does NOT sandbox the
  // package's code (separate layer). Delivery re-checks the same predicate so
  // legacy/imported/direct-DB rows fail closed. http carries no command → skipped.
  if (input.transport === "stdio") {
    try {
      assertStdioCommandSafe(input.command, input.args);
    } catch (e) {
      if (e instanceof ConnectorCommandUnsafeError) throw badRequest(e.message);
      throw e;
    }
  }

  // secretRef must point at an existing company secret (A19/A20): reject the
  // dangling-ref state at write time rather than letting the delivery path
  // silently drop the connector later. Read-only, so it stays outside the tx.
  if (input.secretRef) {
    const secret = await secretsSvc.getByName(companyId, input.secretRef);
    if (!secret) {
      throw badRequest(`secretRef "${input.secretRef}" does not reference an existing secret`);
    }
    assertNotMcpOAuthManaged(
      (secret as { providerMetadata?: unknown }).providerMetadata,
    );
  }

  // Governance and credential axes are orthogonal; one resolver owns both.
  // local_trusted is a loopback trust boundary, so creation there is implicitly
  // approved — everywhere else a connector starts unapproved.
  const status = resolveConnectorStatus({
    deploymentMode: input.deploymentMode,
    approved: input.deploymentMode === "local_trusted",
    requiresSecret: input.requiresSecret,
    hasSecret: Boolean(input.secretRef),
  });

  const createdByUserId = UUID_RE.test(actor.actorId) ? actor.actorId : null;

  // FINDING 4 — connector-insert + approval-insert in ONE transaction. A failure
  // in the approval insert now rolls the connector back too, so we can never
  // commit a `pending_approval` connector that has no approval row (which would be
  // unactivatable). The activity log is deliberately OUTSIDE, after commit.
  let created: { id: string; serverName: string; transport: string; [k: string]: unknown };
  let approvalId: string | null = null;
  try {
    ({ connector: created, approvalId } = await withInsertTransaction(async (tx) => {
      const createdRow = await tx.svc.create(companyId, {
        serverName: input.serverName,
        displayName: input.displayName,
        transport: input.transport,
        url: input.url ?? null,
        command: input.command ?? null,
        args: input.args ?? [],
        headerTemplate: input.headerTemplate ?? {},
        envTemplate: input.envTemplate ?? {},
        secretRef: input.secretRef ?? null,
        requiresSecret: input.requiresSecret,
        source: input.source,
        catalogEntryId: input.catalogEntryId ?? null,
        oauthPolicyVersion: input.oauthPolicyVersion ?? null,
        trustTier: input.trustTier ?? null,
        status,
        createdByUserId,
      });

      let apId: string | null = null;
      if (status === "pending_approval") {
        const approval = await tx.approvalsSvc.create(companyId, {
          type: "install_mcp_connector",
          requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
          status: "pending",
          payload: { connectorId: createdRow.id, serverName: createdRow.serverName },
        });
        apId = approval?.id ?? null;
      }
      return { connector: createdRow, approvalId: apId };
    }));
  } catch (err) {
    // The race the pre-check above cannot close: another create committed the same
    // (companyId, serverName) between our pre-check and our INSERT. Narrowly keyed
    // on the connector-name constraint so an unrelated 23505 still surfaces as 500.
    if (isConnectorNameUniqueViolation(err)) {
      throw conflict(`A connector named "${input.serverName}" already exists`);
    }
    if (isConnectorCatalogUniqueViolation(err)) {
      throw conflict("This catalog connector is already installed for the company");
    }
    throw err;
  }

  // Best-effort AFTER commit (FINDING 4): the connector already exists, so a
  // logging failure must NOT 500 the request — a retry would then hit the 409
  // above. The connector row itself is the durable record; warn and move on.
  try {
    await logActivity({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "mcp_connector.created",
      entityType: "mcp_connector",
      entityId: created.id,
      details: { serverName: created.serverName, transport: created.transport, status },
    });
  } catch (err) {
    logger.warn(
      { err, connectorId: created.id, companyId },
      "mcp_connector.created activity log failed (connector already committed)",
    );
  }

  return { connector: created, approvalId };
}
