// WRK-008 slice 2 / 2b — should this daemon compose a dispatch loop, and if not, why not.
//
// WHY THIS IS A PURE FUNCTION IN ITS OWN FILE. The refusals below are the whole
// operator-facing answer to "why is my worker idle", and each has a different fix in a
// different place (rebuild/repackage, edit env, re-enrol THIS device, ask an admin).
// Deciding them inline in `bootstrapWorkerDaemon` would make them unreachable from a test
// without booting a daemon, and would collapse them into the one shape that helps nobody.
//
// ★ WHY THE FLAG IS NOT REDUNDANT WITH THE PROVIDER CHECK. Dispatch is off by construction
// for the shipped binary: the container root injects no provider, and worker-daemon cannot
// construct one (E4-D01). The moment a composition root exists outside this package (DEP-010),
// the flag is the only thing standing between "a host was written" and "every daemon running
// that build starts taking real leases" — which is why it gates composition GIVEN a provider.
//
// ★ slice 2b — SIX gates now, not four. `no_self_model_reader` is RETIRED: 2a's placeholder
// said this build "cannot read its own self-model yet (WRK-008 slice 2b)"; 2b threads the
// reader, so that sentence is false and a message describing a state the code has left is
// worse than none. In its place, `no_worker_identity` (no OS-custody store + enrolment — a
// build/deploy fact), `no_event_outbox_path` (an env edit on this host), and — split out of
// the read result — `no_session` (re-enrol THIS device) vs `no_self_model` (an admin sets a
// placement profile). Collapsing a dead session into `no_self_model` would print the single
// most misleading message available for the single most likely refusal (§3.2).

import type { SandboxProvider } from "../supervisor/provider.js";
import type { OwnedLabelsCapabilityLike } from "../lease/owned-labels-capability.js";
import type { LeaseHandoff } from "../poll/poll-loop.js";
import type { WorkerSelfModel } from "../poll/capacity.js";

/** DEP-011 Slice 2a — the container worker's per-run networked provider factory type (the impl is
 * supplied by the OUTSIDE composition root, Slice 2b; worker-daemon names only the TYPE). */
export type MakeRunProvider = (input: { handoff: LeaseHandoff; capability?: OwnedLabelsCapabilityLike }) => SandboxProvider;

/** The four coarse outcomes the self-model read collapses to (Step 3). 401/403/404 all fold
 * to `no_profile` so the route is never an oracle; a terminal session is `session_terminal`;
 * anything the build cannot use is `unassemblable`; a transport failure is `unavailable`. */
export type SelfModelReadRefusal = "no_profile" | "unassemblable" | "session_terminal" | "unavailable";

export type SelfModelReadResult =
  | { readonly kind: "ok"; readonly selfModel: WorkerSelfModel }
  | { readonly kind: "refused"; readonly reason: SelfModelReadRefusal };

export type DispatchRefusalReason =
  | "no_provider"
  | "dispatch_disabled"
  | "no_worker_identity"
  | "no_event_outbox_path"
  | "no_session"
  | "no_self_model";

export type DispatchCompositionDecision =
  | { readonly compose: true; readonly selfModel: WorkerSelfModel }
  | {
      readonly compose: false;
      readonly reason: DispatchRefusalReason;
      /** Structured detail for the boot log — the sub-reason the coarse token elides. */
      readonly logPayload?: Readonly<Record<string, unknown>>;
    };

export interface DispatchCompositionInput {
  /** Injected by a composition root outside this package; `undefined` for the shipped binary. */
  readonly provider: SandboxProvider | undefined;
  /**
   * DEP-011 Slice 2a — the CONTAINER worker's alternative to `provider`: a per-run networked
   * driver factory (its impl lives in the outside root, Slice 2b). The provider gate is satisfied
   * by EITHER `provider` OR `makeRunProvider`; `!provider && !makeRunProvider ⇒ no_provider`.
   * `undefined` for the shipped binary (which passes neither ⇒ inert `no_provider`).
   */
  readonly makeRunProvider?: MakeRunProvider;
  /** `AOA_WORKER_DISPATCH_ENABLED`. Default OFF — see the module header. */
  readonly dispatchEnabled: boolean;
  /**
   * Whether a device identity exists (an OS-custody store was injected AND enrolment
   * completed). A BOOLEAN, not the identity: the decision is pure over values, and taking the
   * identity here would force the record load + key derivation ABOVE the branch on every boot,
   * including boots that then refuse — the "zero residue" §10 earns by constructing inside.
   */
  readonly hasWorkerIdentity: boolean;
  /** `AOA_WORKER_EVENT_OUTBOX_PATH` is set. The supervisor's event sink is required, and a
   * no-op sink would silently drop the evidence stream — a fail-open, so this is a refusal. */
  readonly hasEventOutboxPath: boolean;
  /**
   * The self-model read RESULT, or `null` when the read was NOT ATTEMPTED (the cheap gates
   * are decided first, so the bin passes `null` on the first pass — see Step 7). Both
   * read-derived reasons are LAST in the order, so a first answer of exactly `no_self_model`
   * means every earlier gate passed and only the read remains.
   */
  readonly selfModelRead: SelfModelReadResult | null;
}

/**
 * ORDERING IS DELIBERATE, deepest fact first. `no_provider`/`no_worker_identity` are
 * BUILD/deploy facts no env edit fixes. `dispatch_disabled` is an explicit choice.
 * `no_event_outbox_path` is an env edit on this host. `no_session` and `no_self_model` both
 * come out of the same authenticated read and are ordered by causality: the session is what
 * authenticates the read, so a dead session is discovered BEFORE a missing profile — and it
 * is the fixable-here-first order too (re-enrol this device vs ask a different person).
 */
export function decideDispatchComposition(
  input: DispatchCompositionInput,
): DispatchCompositionDecision {
  // DEP-011 Slice 2a — the provider gate is satisfied by EITHER the desktop `provider` OR the
  // container `makeRunProvider` factory. Neither ⇒ the shipped-binary `no_provider` refusal.
  if (!input.provider && !input.makeRunProvider) return { compose: false, reason: "no_provider" };
  if (!input.dispatchEnabled) return { compose: false, reason: "dispatch_disabled" };
  if (!input.hasWorkerIdentity) return { compose: false, reason: "no_worker_identity" };
  if (!input.hasEventOutboxPath) return { compose: false, reason: "no_event_outbox_path" };

  const read = input.selfModelRead;
  if (read === null) {
    return { compose: false, reason: "no_self_model", logPayload: { attempted: false } };
  }
  if (read.kind === "refused") {
    if (read.reason === "session_terminal") {
      return { compose: false, reason: "no_session", logPayload: { readRefusal: "session_terminal" } };
    }
    return { compose: false, reason: "no_self_model", logPayload: { readRefusal: read.reason } };
  }
  return { compose: true, selfModel: read.selfModel };
}

/**
 * WRK-010 slice 2 — should this daemon compose the SESSION LIFECYCLE?
 *
 * ★ DELIBERATELY WEAKER than `decideDispatchComposition`. Acquiring a session is a
 * PREREQUISITE to reading the self-model, so the lifecycle composes on the two hard gates —
 * a provider and the flag — WITHOUT the identity/outbox/read gates the full dispatch decision
 * also needs. Both predicates read the same provider-gate (`provider` OR `makeRunProvider`, DEP-011
 * Slice 2a) + `dispatchEnabled`, so they can never disagree about the first two gates. On the
 * shipped default (neither provider) this is `false`.
 */
export function shouldComposeSession(input: {
  provider: SandboxProvider | undefined;
  makeRunProvider?: MakeRunProvider;
  dispatchEnabled: boolean;
}): boolean {
  return (!!input.provider || !!input.makeRunProvider) && input.dispatchEnabled;
}

/** Operator-facing text for each refusal. Kept beside the decision so a new reason cannot be
 * added without an answer to "what does the operator do about it". */
export const DISPATCH_REFUSAL_MESSAGES: Readonly<Record<DispatchRefusalReason, string>> =
  Object.freeze({
    no_provider:
      "worker-daemon: no sandbox provider injected; this build cannot dispatch work (a composition root must supply one)",
    dispatch_disabled:
      "worker-daemon: dispatch is disabled; set AOA_WORKER_DISPATCH_ENABLED=1 to enable it",
    no_worker_identity:
      "worker-daemon: no device identity; this host has no OS-custody store and enrolment, so it cannot authenticate a self-model read (this is a build/packaging problem, NOT a target-configuration one)",
    no_event_outbox_path:
      "worker-daemon: AOA_WORKER_EVENT_OUTBOX_PATH is not set; the durable event outbox has no home, so dispatch cannot start (set it to a writable path on this host)",
    no_session:
      "worker-daemon: no live session for this device; re-enrol THIS device (its session lapsed past the enrolment code-route boundary — WRK-010 §3.2), and this is NOT a placement-profile problem",
    no_self_model:
      "worker-daemon: this target has no placement profile; an admin must set one before the worker can take work",
  });
