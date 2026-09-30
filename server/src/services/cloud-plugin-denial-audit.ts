// server/src/services/cloud-plugin-denial-audit.ts
//
// DE-16, audit clause — the operator-only sink for the EIGHT plugin-cloud-gate
// deny sites that hold only a CALLER-SUPPLIED company. E0-F013 Decision 3.2,
// founder-ruled 2026-09-11 (option (c), with the write bound).
//
// ★ WHAT WAS THERE. `recordCloudPluginBlock` (`cloud-plugin-execution.ts`)
// increments process-local counters and emits one `logger.warn` — nothing
// durable. A restart erases the counters, so a burst of blocked cloud-plugin
// executions left the same trace as none: `E0-F010`.
//
// ★ THE COHORT. Seven sites in `routes/plugins.ts` (the `rejectBlockedCloudExecution`
// helper's `companyId`-bearing call sites: ui-contributions, tool-dispatch,
// four `:pluginId` body routes, one `:pluginId` query route) plus
// `routes/company-plugins.ts` rollback. All eight sit behind `assertBoard`, so a
// board actor exists, but NO tenant is resolved for that actor at the sink and the
// `companyId` in hand is the one the caller NAMED — and on several it is checked
// (`assertCompanyAccess`) only AFTER this point. So it is untrusted: the row is
// filed `company_id NULL` with that caller-supplied id in `entity_id` as the abuse
// surface, never as attribution. The nine no-company residue sites are Decision 2's
// already-ruled remainder and are NOT wired here.
//
// ★ THE WRITE BOUND. These routes have no rate limit, and `entity_id` is
// caller-supplied, so an unbounded recorder call would let a board caller flood the
// operator's only evidence table. All writes go through
// `sharedBoundedDenialRecorder`, capped per `(surface, source-key)` window with the
// remainder aggregated. The source key is the request's remote IP (coarse) — NEVER
// the caller-supplied company id, which a caller varies at will.

import type { Db } from "@armyofagents/db";
import { sharedBoundedDenialRecorder } from "./bounded-denial-recorder.js";

/** The reserved `surface` slug → `security.denied.cloud_plugin_execution`. */
export const CLOUD_PLUGIN_EXECUTION_DENIAL_SURFACE = "cloud_plugin_execution";

/** The refusing branch, one code for the shared cloud gate. */
export const CLOUD_PLUGIN_EXECUTION_DENIAL_REASON = "cloud_plugin_execution_blocked";

/**
 * Record one blocked cloud-plugin execution that held only a caller-supplied
 * company, into the operator-only sink. Never throws (the bounded recorder
 * swallows and logs), so a broken recorder cannot turn a 503 into a 500 or a DoS
 * lever on the deny path.
 */
export async function recordCloudPluginDenial(
  db: Db,
  input: {
    /** The caller-supplied company id the request named (query/body/params). */
    requestedCompanyId: string;
    pluginId: string;
    sink: string;
    source: string;
    /** The board actor that reached the gate. */
    actorId: string;
    /** The coarse client identifier (remote IP). NEVER the company id. */
    sourceKey: string | null;
    control: string;
  },
): Promise<void> {
  await sharedBoundedDenialRecorder.record(db, {
    companyId: null,
    organizationId: null,
    crossing: "DE-16",
    surface: CLOUD_PLUGIN_EXECUTION_DENIAL_SURFACE,
    reason: CLOUD_PLUGIN_EXECUTION_DENIAL_REASON,
    actorType: "user",
    actorId: input.actorId,
    entityType: "cloud_plugin_execution",
    entityId: input.requestedCompanyId,
    control: input.control,
    sourceKey: input.sourceKey,
    details: {
      requestedCompanyId: input.requestedCompanyId,
      pluginId: input.pluginId,
      sink: input.sink,
      source: input.source,
    },
  });
}
