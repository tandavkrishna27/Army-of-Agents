// server/src/services/worker-session-denial-audit.ts
//
// DE-18 + DE-04, session/heartbeat arms — the durable record a worker-SESSION
// authority refusal leaves behind. `createWorkerSessionAuthenticator`'s
// per-request rechecks and `registerProofBoundHeartbeat`'s refusal branches
// refuse for several reasons (disabled target, revoked worker, lost owner
// membership, credential/profile drift, and a device-generation bump). The
// CROSSING is derived per-row from the ACTUAL failed conjunct(s): a
// device-generation bump on the authoritative DB row is DE-18's generation
// cutoff; every OTHER authority-currency failure is recorded under DE-04's
// worker-authority-currency arm (register amendment 2026-09-13 — the
// `revocation` crossing-class home the DE-18 clause previously named as "a
// documented follow-on needing a new/extended crossing").
//
// ★ WIRED REFUSAL SITES feed this recorder, each passing a `details.failed`
// disjunct list (the crossing is derived from that list — see
// `deriveWorkerSessionCrossing`):
//   `session_authority_revoked`  — `verifyCurrent`'s current-authority recheck
//                                  (the per-request gate).
//   `session_credential_drift`   — `verifyCurrent`'s post-authority credential
//                                  recheck (org/scope/thumbprint/pubkey/profile).
//   `platform_authority_revoked` — the shared-platform physical-authority recheck
//                                  for a platform-scope target.
//   `heartbeat_authority_revoked` — `registerProofBoundHeartbeat`'s refusal
//                                  branches, classified by a per-branch
//                                  generation RE-READ of the same authority row
//                                  the failing boolean write predicates on
//                                  (`details.branch` names which of the six).
// A refusal whose re-read cannot name ANY failed conjunct (the authority looks
// current again — a lost race between the write and the re-read) writes NO row
// rather than a guessed one; that transient window is the register's documented
// residual gap on the heartbeat arm.
//
// ★ ATTRIBUTION. WHO = the presented worker (`actorType: "system"`,
// `actorId` = the session's `sub` — token-attested, HMAC-verified). TENANT =
// the ORGANIZATION axis only (`workers`/`execution_targets` carry no company),
// and for a PLATFORM-scope session the organization is null too: that row is
// DOUBLY NULL, which the reserved `security.denied.` namespace admits by the
// partial CHECK (E0-F013 Decision 2 (a2)) and which is the honest ceiling, not
// an oversight — the device thumbprint in `details` is what remains.
// RESOURCE = the execution target the session is pinned to.
//
// ★ WRITE PLACEMENT. The session refusals THROW out of `runInTenant` / the
// operator transaction and the heartbeat refusals mostly RETURN false out of a
// committing one; either way the recorder is called by the OWNING function
// AFTER the transaction promise has settled (catch/finally → record on the POOL
// `appDb` → propagate unchanged), so nothing here runs inside a transaction
// that is unwinding. ★ AMPLIFICATION, WEIGHED: `authenticate` runs per request, so a
// revoked-but-still-polling worker writes one row per refused request. That is
// the founder-ruled per-refusal reading (E0-F013 Decision 1.2c, the DE-27
// precedent), the request is already HMAC-verified device traffic (not
// anonymous), and the class-wide retention bound is E0-F018 — not a deviation
// here. ★ NEVER THROWS, inherited from `recordSecurityDenial`.

import type { Db } from "@armyofagents/db";
import { recordSecurityDenial } from "./security-denial-audit.js";

/** The reserved `surface` slug → the action `security.denied.worker_session`. */
export const WORKER_SESSION_DENIAL_SURFACE = "worker_session";

/** The crossing whose `audit` clause ("… generation changes are audited") a
 * GENERATION-cutoff row serves. */
export const WORKER_SESSION_DENIAL_CROSSING = "DE-18";
/** The crossing whose worker-authority-currency arm (register amendment
 * 2026-09-13) a NON-generation authority-currency row serves. */
export const WORKER_AUTHORITY_CURRENCY_CROSSING = "DE-04";

export const WORKER_SESSION_DENIAL_REASONS = [
  "session_authority_revoked",
  "session_credential_drift",
  "platform_authority_revoked",
  "heartbeat_authority_revoked",
] as const;

export type WorkerSessionDenialReason = (typeof WORKER_SESSION_DENIAL_REASONS)[number];

/** The `details.failed` conjunct name that marks a genuine generation cutoff — the
 * ONLY session-denial condition that is DE-18's target-generation replacement. */
export const SESSION_GENERATION_CONJUNCT = "generation_drift";

/**
 * Derive the crossing from the ACTUAL failed conjunct list, never from a
 * composite boolean or the caller's payload claim: `generation_drift` (an
 * authoritative DB-row generation change) ⇒ DE-18; any other named
 * authority-currency conjunct ⇒ DE-04's worker-authority-currency arm; an EMPTY
 * list ⇒ null — nothing classifiable, so nothing recorded (the documented
 * transient-re-read gap), a guess being worse than a gap.
 */
export function deriveWorkerSessionCrossing(failed: string[] | undefined): string | null {
  if (!failed || failed.length === 0) return null;
  if (failed.includes(SESSION_GENERATION_CONJUNCT)) return WORKER_SESSION_DENIAL_CROSSING;
  return WORKER_AUTHORITY_CURRENCY_CROSSING;
}

/**
 * Record ONE worker-session authority refusal. `db` MUST be a pool handle — the
 * caller invokes this after its transaction has unwound (or committed), never
 * inside it.
 *
 * ★ THE CROSSING IS DERIVED, per row, by `deriveWorkerSessionCrossing`: a
 * `generation_drift` conjunct (authoritative worker/target `device_generation`
 * drift, never a caller-payload claim) files under DE-18's "generation changes
 * … are audited" clause; every other named authority-currency conjunct
 * (disabled target, revoked worker, lost owner membership, missing authority
 * row, credential/profile drift) files under DE-04's worker-authority-currency
 * arm (register amendment 2026-09-13). When `failed` is empty or absent this is
 * a NO-OP (returns null) rather than a guessed row. Never throws.
 */
export async function recordWorkerSessionDenial(
  db: Db,
  input: {
    reason: WorkerSessionDenialReason;
    /** Token-attested (session claims) or DB-resolved; null for a platform-scope
     * session, which is the doubly-null case the header names. */
    organizationId: string | null;
    workerId: string;
    targetId: string;
    targetGeneration: number;
    deviceThumbprint: string;
    /** The disjuncts that failed, naming the enforcing predicate(s). The
     * crossing is derived from this list; when it is empty or absent, nothing
     * classifiable failed and NO row is written. */
    failed?: string[];
    /** For `heartbeat_authority_revoked` only: which of the six
     * `registerProofBoundHeartbeat` refusal branches refused. */
    branch?: string;
    control: string;
  },
): Promise<string | null> {
  const crossing = deriveWorkerSessionCrossing(input.failed);
  // Nothing classifiable failed ⇒ no crossing to serve ⇒ no row (never a guess).
  if (crossing === null) return null;
  return recordSecurityDenial(db, {
    companyId: null,
    organizationId: input.organizationId,
    crossing,
    surface: WORKER_SESSION_DENIAL_SURFACE,
    reason: input.reason,
    actorType: "system",
    actorId: input.workerId,
    entityType: "execution_target",
    entityId: input.targetId,
    control: input.control,
    details: {
      workerId: input.workerId,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
      deviceThumbprint: input.deviceThumbprint,
      ...(input.failed && input.failed.length > 0 ? { failed: input.failed } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    },
  });
}
