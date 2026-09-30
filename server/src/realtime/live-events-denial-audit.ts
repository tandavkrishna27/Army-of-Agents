// server/src/realtime/live-events-denial-audit.ts
//
// DE-21, audit clause — the durable record a REFUSED WebSocket upgrade leaves
// behind, for the deny branches that have a DB-resolved, FK-valid tenant.
//
// ★ WHAT DE-21 ASSERTS AND WHAT WAS THERE. The crossing reads "subscribe, replay
// and denial events are audited". A refused upgrade calls `rejectUpgrade`, whose
// whole body writes an HTTP status line to the socket and destroys it — no row,
// no metric, no log line. The same file logs at eight sites, including
// `logger.error` on the path where the authorization function THREW, so an
// internal fault was loud and a cross-tenant probe was silent. That is `E0-F010`.
//
// ★ THE UNIT OF CORRECTION IS THE DISJUNCT, NOT THE BRANCH. `authorizeUpgrade`
// has SEVEN `return null` branches and they do not share a shape. Measured at the
// line, in `docs/replatform/DECISION-REQUEST-unattributable-denial-sink.md` §1.2
// and re-verified here:
//
//   `:376` `key.companyId !== companyId`  — `agent_api_keys.company_id` is
//        NOT NULL with an FK to `companies`. RECORDED.
//   `:395` agent missing / foreign / terminated / pending_approval — control only
//        reaches this `if` when `key` is non-null (`:376` already returned), so
//        `key.companyId` is DB-resolved on EVERY disjunct. RECORDED, one code per
//        disjunct.
//
//   `:376` `!key` — an unknown, revoked or malformed token. The SELECT returned
//        NO ROW, so there is no `key.companyId` at all and the only company in
//        hand is the caller-supplied path segment. This is the DOMINANT probe
//        case and it is NOT recorded here: it is `E0-F013`'s Decision 3 (whose
//        log does a cross-tenant probe land in), together with branches 1-4.
//        Splitting the `||` is the entire point — half a branch is not the
//        branch.
//
//   `:358` the `authenticated` board branch — MEASURED FOR THIS UNIT AND
//        EXCLUDED, with the measurement stated rather than the verdict inherited.
//        The Decision 2 paper flagged it as possibly holding an FK-valid company
//        because `memberships[]` (the actor's own active company ids, already
//        SELECTed at `:343-352` for the authorization decision itself) is in
//        scope. It does not hold, for two independent reasons.
//        (a) NOT ALWAYS PRESENT: the branch fires when the actor has no
//            `instance_admin` row AND no membership for the requested company. A
//            session-holder with ZERO company memberships — the shape a probe
//            actually takes — reaches it with `memberships.length === 0` and
//            therefore with no FK-valid company whatsoever.
//        (b) NOT SINGULAR, AND NOT THE REFUSING TENANT: when the array is
//            non-empty its ids are the actor's OTHER tenants, none of which was
//            asked for anything and none of which refused anything. Attributing
//            the refusal to an arbitrary one of them is the same category error
//            §1.3 of the paper names for DE-15. Which of N, and on what rule, is
//            an attribution decision, not a wiring gap.
//        So `:358` stays open under Decision 3's attribution question. It is not
//        recorded, and DE-21 does not close.
//
// ★ WHICH TENANT THE ROW LANDS IN. `key.companyId` — the tenant that OWNS the
// credential presented, i.e. the tenant whose control refused. NEVER the
// requested path segment. Writing a cross-tenant probe into the PROBED tenant's
// own activity stream would turn the audit record into the disclosure channel it
// exists to avoid; that is the DE-19 precedent and it is asserted by test.
//
// ★ NON-DISCLOSURE IS UNCHANGED ON THE WIRE. Every branch below still answers the
// same opaque `403 Forbidden`. The distinction between "your key is for another
// tenant", "the agent is gone" and "the agent is not approved yet" lives only in
// the durable row.

import type { Db } from "@armyofagents/db";
import { recordSecurityDenial } from "../services/security-denial-audit.js";

/** The reserved `surface` slug → `security.denied.live_events_upgrade`. */
export const LIVE_EVENTS_UPGRADE_DENIAL_SURFACE = "live_events_upgrade";

/**
 * The reason vocabulary, one code per refusing DISJUNCT. Closed at four because
 * four disjuncts have a DB-resolved company; the `!key` arm and the board/session
 * branches are deliberately absent (see the header).
 */
export const LIVE_EVENTS_UPGRADE_DENIAL_REASONS = [
  /** `:376` — a live agent key presented against a company it does not belong to. */
  "agent_key_tenant_mismatch",
  /** `:395` — the key resolves but its `agent_id` has no row (revocation desync). */
  "agent_missing",
  /** `:395` — the agent row exists but belongs to a different company than the key. */
  "agent_key_company_drift",
  /** `:395` — the agent is `terminated`; the key outlived it. */
  "agent_terminated",
  /** `:395` — the agent is `pending_approval` (the D6 board-approval gate). */
  "agent_pending_approval",
] as const;

export type LiveEventsUpgradeDenialReason =
  (typeof LIVE_EVENTS_UPGRADE_DENIAL_REASONS)[number];

/**
 * Record one refused upgrade. Never throws (`recordSecurityDenial` swallows and
 * logs), so a broken recorder cannot turn a 403 into a 500 and cannot become a
 * denial-of-service lever on the refusal path.
 *
 * `companyId` MUST be the DB-resolved owning tenant of the presented credential.
 * `requestedCompanyId` is the caller-supplied path segment and rides `details`,
 * where it is evidence rather than attribution.
 */
export async function recordUpgradeDenial(
  db: Db,
  input: {
    companyId: string;
    reason: LiveEventsUpgradeDenialReason;
    /** The agent the key names. `actor_id` is plain text with no FK. */
    agentId: string;
    keyId: string;
    requestedCompanyId: string;
    control: string;
    details?: Record<string, unknown>;
  },
): Promise<string | null> {
  return recordSecurityDenial(db, {
    companyId: input.companyId,
    crossing: "DE-21",
    surface: LIVE_EVENTS_UPGRADE_DENIAL_SURFACE,
    reason: input.reason,
    actorType: "agent",
    actorId: input.agentId,
    // The refused RESOURCE is the company's live-event stream, named by the
    // company the caller asked for — which on the cross-tenant arm is NOT the
    // company this row is filed under, and that difference is the finding.
    entityType: "live_events_stream",
    entityId: input.requestedCompanyId,
    control: input.control,
    details: {
      ...(input.details ?? {}),
      requestedCompanyId: input.requestedCompanyId,
      keyId: input.keyId,
      transport: "websocket",
    },
  });
}
