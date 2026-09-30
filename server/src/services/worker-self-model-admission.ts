// server/src/services/worker-self-model-admission.ts
//
// WRK-008 slice 1 — may this caller read its own execution target's SELF-MODEL?
//
// The self-model is the registered target profile + the provider-constraint profile:
// the two artefacts `WorkerSelfModel` needs before a worker can advertise capacity,
// self-check an offer and take a lease. It is therefore the artefact that turns an
// enrolled worker into one that executes tenant work, and every refusal below is the
// fail-closed direction of a real question rather than defensive noise.
//
// PURE: no database, no clock, no request. The route resolves the facts; this decides.
// That keeps all four guards directly unit- and mutation-testable.
//
// The tenancy question is deliberately ABSENT from this function, and that is not an
// omission. The route carries no target identifier at all — it reads the caller's own
// target from the authenticated principal, on a URL with no org id and no slug, so
// "could this caller reach another tenant's profile?" is answered by construction at
// the middleware rather than by a check here that could drift out of agreement with it.

export type SelfModelReadRefusal =
  | "legacy_authority_refused"
  | "generation_stale"
  | "target_revoked"
  | "target_disabled"
  | "profile_absent";

export interface SelfModelReadInput {
  /** Which of the two credentials `requireWorkerHeartbeatAuthority` admitted. */
  readonly authorityKind: "legacy" | "session";
  /** `VerifiedTargetPrincipal.targetGeneration` — the generation the caller PROVED. */
  readonly principalTargetGeneration: number | null;
  /** `registeredTargetProfile.deviceGeneration` — the target's CURRENT generation. */
  readonly profileDeviceGeneration: number | null;
  readonly revokedAt: string | null;
  /** `execution_targets.status`: active | draining | offline | disabled. */
  readonly targetStatus: string;
  readonly hasRegisteredProfile: boolean;
  readonly hasProviderConstraintProfile: boolean;
}

export type SelfModelReadDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: SelfModelReadRefusal };

const refuse = (reason: SelfModelReadRefusal): SelfModelReadDecision => ({ admit: false, reason });

/**
 * Map a refusal onto the wire, and it is a TWO-WAY branch on purpose.
 *
 * The first cut of this route collapsed all five refusals into a single coarse
 * `unauthorized`, on a non-disclosure argument. That argument does not apply here and
 * applying it cost the caller the one thing it needs: `unauthorized` is NON-RETRYABLE
 * on the wire (only `throttled`/`internal_unavailable` may carry `retryAfterMs`), so a
 * worker whose operator simply has not configured its placement profile yet was told,
 * in effect, "stop forever".
 *
 * Non-disclosure protects against a FOREIGN caller probing for a resource it does not
 * own. This route accepts NO identifier — the target is taken from the authenticated
 * principal — so the caller has already proven ownership of the only row it can ask
 * about. Telling it a fact about ITSELF discloses nothing to anyone.
 *
 * So:
 *   profile_absent  -> `internal_unavailable` (503, retryable): an operator has not run
 *                      `PUT .../placement-profile` yet. WAIT. This is a normal state on
 *                      a freshly enrolled worker, not a fault.
 *   everything else -> `unauthorized` (401, terminal): a credential, generation or
 *                      lifecycle problem a human must resolve. STOP.
 *
 * That is exactly the branch the poll loop's own vocabulary already names
 * (`reenrollment_required` vs a transient backoff), and without it a daemon cannot
 * distinguish "not provisioned yet" from "revoked" — which is the question the whole
 * fail-closed-on-boot decision depends on.
 */
export function selfModelRefusalWireCode(
  reason: SelfModelReadRefusal,
): "unauthorized" | "internal_unavailable" {
  return reason === "profile_absent" ? "internal_unavailable" : "unauthorized";
}

export function admitSelfModelRead(input: SelfModelReadInput): SelfModelReadDecision {
  // 1. Credential strength FIRST, before any property of the target is consulted.
  //
  //    `requireWorkerHeartbeatAuthority` admits two identities: a legacy bearer worker
  //    token, and the device-proof-bound session. A distributed worker always holds the
  //    latter. Admitting the former here would make the self-model reachable by the
  //    weaker of two credentials purely because a shared middleware tolerates it — the
  //    route would inherit an authorization decision it never made.
  //
  //    Ordering matters: a weak credential must never be reported as a generation or
  //    revocation problem, which would send an operator to the wrong place.
  if (input.authorityKind !== "session") return refuse("legacy_authority_refused");

  // 2. The generation the caller PROVED must equal the target's CURRENT generation.
  //
  //    Behind means the session predates a device-generation bump: the worker is asking
  //    for a self-model it is no longer entitled to act on. Ahead should be impossible —
  //    if it happens, one of the two independently-derived authorities is wrong and
  //    neither may be trusted. A null on either side is not a match; it is an unanswered
  //    question, and the answer to an unanswered question here is no.
  if (input.principalTargetGeneration === null
    || input.profileDeviceGeneration === null
    || input.principalTargetGeneration !== input.profileDeviceGeneration) {
    return refuse("generation_stale");
  }

  // 3. A revoked target serves nothing. Checked BEFORE absence so a revoked target is
  //    never reported as merely unconfigured — those call for opposite operator actions.
  if (input.revokedAt !== null) return refuse("target_revoked");

  // 3b. `disabled` is the operator saying "do not use this target". Refuse it.
  //
  //     The other non-active statuses deliberately do NOT refuse, and the reasoning
  //     matters more than the rule:
  //       * `draining` must still serve. Drain means "take no NEW work"; that is the
  //         poll response's job, and withholding the self-model would break the drain
  //         semantics of a worker that is legitimately finishing in-flight work.
  //       * `offline` is a LIVENESS observation, not an authorization one. A worker
  //         that was unreachable and came back must be able to recover; refusing here
  //         would turn a transient outage into a permanent one.
  if (input.targetStatus === "disabled") return refuse("target_disabled");

  // 4. Both halves must exist. `PUT .../placement-profile` is admin-guarded and is the
  //    only writer, so this is a genuine product state: ENROLMENT ALONE DOES NOT PRODUCE
  //    A DISPATCHABLE WORKER. "Enrolled" and "can take work" are two different things.
  if (!input.hasRegisteredProfile || !input.hasProviderConstraintProfile) {
    return refuse("profile_absent");
  }

  return { admit: true };
}
