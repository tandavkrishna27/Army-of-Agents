// server/src/services/cloud-plugin-dispatch-denial-audit.ts
//
// DE-16, `audit` clause — the DISPATCH conjunct's MCP-agent i-GAP. A durable,
// attributable record of an agent's plugin tool-call refused by the `cloud_auth`
// execution block at the MCP broker.
//
// ★ THE GAP THIS CLOSES. DE-16's audit clause is a conjunction: "blocked plugin
// routes, dispatch, and reconciliations are audited." Two of the three were
// delivered — the board-route half by `recordCloudPluginDenial`
// (`security.denied.cloud_plugin_execution`, an operator-only per-IP bounded sink)
// and the reconciliation half by `recordCloudPluginReconcileToBlocked`. But the
// AGENT dispatch path was not: `dispatchPluginToolCall`
// (`server/src/mcp/tools/plugin-broker-tools.ts`, sole prod caller
// `server/src/mcp/server.ts` tools/call) returns `forbidden` on the cloud block
// with NO durable row. On `cloud_auth` the host-process plugin worker is never
// composed, so EVERY agent plugin tool-call is blocked there — and left the same
// trace as none. This module is the writer for that third conjunct.
//
// ★ A THIRD SHAPE, DELIBERATELY DISTINCT FROM THE OTHER TWO.
//   - NOT the board-route sink (`cloud-plugin-denial-audit.ts`): that sink files
//     `company_id NULL` under a per-IP bounded recorder because its company is
//     CALLER-SUPPLIED and untrusted and its routes have no rate limit. Here the
//     company is FK-valid and trustworthy — the MCP broker validated the URL
//     `:companyId` against the run-JWT and `getById`'d it in
//     `ensureProtocolAccess` before tools/call runs — so this is a normal
//     real-tenant audit row, not an operator abuse-surface row.
//   - NOT the boot reconcile row (`cloud-plugin-reconcile-audit.ts`): that has no
//     principal (a boot pass) so it is `actorType:"system"`. Here there IS a
//     principal — a VERIFIED agent run — so the truthful actor is `agent`.
//
// ★ SCOPE: THE AGENT-RUN CASE ONLY. The cloud block in `dispatchPluginToolCall`
// fires BEFORE the actor/run gate, so a board/mcp caller passing a plugin-tool
// name also hits it — but that caller is immediately the actor-gate refusal too
// ("not available for <actor>" / "requires an active agent run"), which is this
// service's OWN refusal with no recorder (the `not_found` shape). Only the
// fully-attributable agent-run case is recorded here — real company + `agent`
// actor + live run — which is exactly the i-GAP the register names. A non-agent
// or run-less blocked call records nothing rather than a row with no id to stand
// on (the discipline learned on DE-18: do not record what cannot be cleanly
// attributed to a crossing).
//
// ★ ATTRIBUTION.
//   - `companyId` = the broker-validated, FK-valid tenant (NOT NULL). Satisfies
//     the partial CHECK's NOT NULL arm directly.
//   - `organizationId` = null. The broker holds no control-plane-attested
//     organization token at this seam; the company is the tenant axis. Null is
//     the honest answer, matching the reconcile recorder.
//   - `actorType` = "agent", `actorId` = the verified `agentId` (the `agents`
//     row id from the run-JWT). `agent_id`/`run_id` FK columns stay null per the
//     `recordSecurityDenial` convention; the run id rides `details`.
//   - `entityType`/`entityId` = the refused plugin tool (`plugin_tool` + the
//     namespaced tool name). The name is the caller's own claim, recorded inside
//     the caller's OWN tenant, so it discloses nothing across a boundary; it is
//     the resource that was refused.
//
// ★ PER-REFUSAL, AMPLIFICATION WEIGHED. One row per blocked dispatch. On
// `cloud_auth` an agent looping plugin calls writes one row each — the
// founder-ruled per-refusal reading (E0-F013 Decision 1.2c), bounded by the
// authenticated MCP request path and `activity_log` retention (E0-F018, a
// class-wide property), and it is HMAC-verified agent-run traffic, not anonymous.
//
// ★ NEVER THROWS, inherited from `recordSecurityDenial`. A failed insert is
// logged at error and swallowed, so the recorder cannot convert the 403 block
// into a 500 or a DoS lever on the deny path.

import type { Db } from "@armyofagents/db";
import { recordSecurityDenial } from "./security-denial-audit.js";

/** The reserved `surface` slug → the action `security.denied.cloud_plugin_dispatch`.
 * Distinct from the board-route sink's `cloud_plugin_execution`, so "how many
 * AGENT dispatches were cloud-blocked" is its own `action` predicate. */
export const CLOUD_PLUGIN_DISPATCH_DENIAL_SURFACE = "cloud_plugin_dispatch";

/** The crossing whose `audit` clause this row serves. */
export const CLOUD_PLUGIN_DISPATCH_DENIAL_CROSSING = "DE-16";

/** The refusing branch: the `cloud_auth` execution block. */
export const CLOUD_PLUGIN_DISPATCH_DENIAL_REASON = "cloud_plugin_execution_blocked";

/**
 * Record ONE agent plugin tool-call refused by the `cloud_auth` execution block.
 * `db` MUST be a pool handle (the MCP tools/call route runs no tenant
 * transaction). Returns the row id, or `null` when nothing could be written
 * (logged at error by `recordSecurityDenial`). Never throws.
 */
export async function recordCloudPluginDispatchDenial(
  db: Db,
  input: {
    /** The broker-validated, FK-valid tenant (never caller-supplied here). */
    companyId: string;
    /** The verified agent (agents row id) from the run-JWT. */
    agentId: string;
    /** The live run id from the run-JWT. */
    runId: string;
    /** The namespaced plugin tool name the agent tried to call. */
    toolName: string;
    control: string;
  },
): Promise<string | null> {
  return recordSecurityDenial(db, {
    companyId: input.companyId,
    organizationId: null,
    crossing: CLOUD_PLUGIN_DISPATCH_DENIAL_CROSSING,
    surface: CLOUD_PLUGIN_DISPATCH_DENIAL_SURFACE,
    reason: CLOUD_PLUGIN_DISPATCH_DENIAL_REASON,
    actorType: "agent",
    actorId: input.agentId,
    entityType: "plugin_tool",
    entityId: input.toolName,
    control: input.control,
    details: {
      runId: input.runId,
      toolName: input.toolName,
    },
  });
}
