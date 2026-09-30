// server/src/realtime/live-events-tenantless-denial-audit.ts
//
// DE-21, audit clause — the operator-only sink for the SIX refused-upgrade
// branches that resolve NO actor tenant. E0-F013 Decision 3.2, founder-ruled
// 2026-09-11 (option (c), with the write bound).
//
// ★ WHY A SECOND DE-21 WRITER. `live-events-denial-audit.ts` (`recordUpgradeDenial`)
// records the FIVE agent-key branches that have a DB-resolved, FK-valid tenant —
// the row is filed under the KEY's own company (Class 1, shipped). The remaining
// six `return null` branches of `authorizeUpgrade` resolve no tenant at all:
//
//   :297  mode has no session resolver          — caller-supplied path segment only
//   :308  untrusted / missing Origin            — caller-supplied path segment only
//   :315  session resolved, no userId           — caller-supplied path segment only
//   :326  cloud_auth, no active membership       — a userId, but a user is not a tenant
//   :372  authenticated, no admin + no membership — a userId, but no refusing tenant
//   :400  `!key` — token matched no key row      — the dominant probe case
//
// The founder ruled these to the operator-only sink: `company_id NULL`, the
// caller-supplied requested company in `entity_id` (evidence, NEVER attribution —
// it is unvalidated free text a prober picks), readable only through
// `GET /instance/security-denials`. Slice 1 (`notDenialNamespace()`) already hides
// every `security.denied.*` row from tenant-facing readers, so this row is
// operator-visible and tenant-invisible by construction.
//
// ★ DISTINCT SURFACE FROM THE ATTRIBUTED WRITER, DELIBERATELY. Class 1's rows use
// `security.denied.live_events_upgrade`; these use
// `security.denied.live_events_upgrade_unattributed`. Both are in the reserved
// namespace (both hidden from tenants, both shown to the operator), but the split
// lets an operator tell an attributed cross-tenant key refusal from an
// unattributable board/anonymous probe, and it keeps the Class-1 DE-21 suite's
// "the tenant-less branches write no ATTRIBUTED row" assertions true and
// meaningful — this writer files elsewhere, it does not fabricate a Class-1 row.
//
// ★ THE WRITE BOUND IS NOT OPTIONAL HERE. Every one of these branches is reachable
// without a credential, so an unbounded recorder call would let a prober flood the
// operator's only evidence table. All writes go through
// `sharedBoundedDenialRecorder`, which caps rows per `(surface, source-key)` window
// and collapses the rest into a suppressed count. The source key is the remote
// address (coarse, hashed inside the recorder) — NEVER the caller-supplied
// company id.

import type { Db } from "@armyofagents/db";
import type { ActivityActorType } from "@armyofagents/shared";
import { sharedBoundedDenialRecorder } from "../services/bounded-denial-recorder.js";

/** The reserved `surface` slug → `security.denied.live_events_upgrade_unattributed`. */
export const LIVE_EVENTS_UPGRADE_UNATTRIBUTED_SURFACE =
  "live_events_upgrade_unattributed";

/**
 * One reason code per tenant-less refusing branch, so an operator can tell an
 * anonymous board probe from a cloud member with no membership from an unknown
 * token. Kept separate from the Class-1 (`LIVE_EVENTS_UPGRADE_DENIAL_REASONS`)
 * vocabulary because these branches share no shape with the agent-key ones.
 */
export const LIVE_EVENTS_UPGRADE_UNATTRIBUTED_REASONS = [
  /** `:297` — a multi-user mode with no session resolver wired. */
  "board_no_session_resolver",
  /** `:308` — a cookie upgrade with a missing or untrusted Origin (CSWSH defense). */
  "board_untrusted_origin",
  /** `:315` — a resolved session that carries no user id. */
  "board_no_user",
  /** `:326` — cloud_auth: a user with no active org+company membership. */
  "board_no_cloud_membership",
  /** `:372` — authenticated: a user with no instance_admin row and no membership. */
  "board_no_membership",
  /** `:400` — a bearer/query token that matched no `agent_api_keys` row. */
  "agent_key_unknown",
] as const;

export type LiveEventsUpgradeUnattributedReason =
  (typeof LIVE_EVENTS_UPGRADE_UNATTRIBUTED_REASONS)[number];

/**
 * Record one refused upgrade that resolved no actor tenant, into the operator-only
 * sink. Never throws (the bounded recorder swallows and logs), so a broken
 * recorder cannot turn a 403 into a 500 or a DoS lever on the refusal path.
 *
 * `requestedCompanyId` is the caller-supplied path segment and rides BOTH
 * `entity_id` (the abuse surface) and `details` — it is evidence, never the
 * tenant the row is attributed to (there is none: `company_id` is NULL).
 */
export async function recordTenantlessUpgradeDenial(
  db: Db,
  input: {
    reason: LiveEventsUpgradeUnattributedReason;
    /** The caller-supplied company path segment that was reached for. */
    requestedCompanyId: string;
    /** Best-known principal kind; anonymous branches use `"user"`/`"agent"`. */
    actorType: ActivityActorType;
    /** Best-known actor id; `"anonymous"` / `"unknown"` where none resolved. */
    actorId: string;
    /** The coarse client identifier (remote address). NEVER the company id. */
    sourceKey: string | null;
    control: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await sharedBoundedDenialRecorder.record(db, {
    companyId: null,
    organizationId: null,
    crossing: "DE-21",
    surface: LIVE_EVENTS_UPGRADE_UNATTRIBUTED_SURFACE,
    reason: input.reason,
    actorType: input.actorType,
    actorId: input.actorId,
    entityType: "live_events_stream",
    entityId: input.requestedCompanyId,
    control: input.control,
    sourceKey: input.sourceKey,
    details: {
      ...(input.details ?? {}),
      requestedCompanyId: input.requestedCompanyId,
      transport: "websocket",
    },
  });
}
