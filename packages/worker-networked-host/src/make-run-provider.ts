// packages/worker-networked-host/src/make-run-provider.ts
//
// DEP-011 Slice 2b-ii — build the container worker's per-run networked provider factory.
//
// `makeRunProvider` is invoked by worker-daemon's supervisor ONCE PER RUN, AFTER the run's
// owned-labels capability has been redeemed. It returns a `NetworkedProviderDriver` bound to
// that run's capability, which dials the adapter-manager over the gated wire. The factory type
// (`MakeRunProvider`) is defined in worker-daemon (the daemon names only the TYPE; the impl
// lives out here, downstream of everything — a LEAF consumer, so no `pnpm -r build` cycle).
//
// ★ THE TYPE BRIDGE — RE-VALIDATE, DO NOT BLIND-CAST (DEP-011 §2b.3 F-cast).
//
// `MakeRunProvider`'s `capability` is worker-daemon's WIDER `OwnedLabelsCapabilityLike`
// (`v: number`, `audience: string`) — the daemon carries the token OPAQUE. But
// `NetworkedProviderDriverOptions.capability` is the LEAF `OwnedLabelsCapability`
// (`v: 1`, `audience: "adapter-manager"` LITERALS). `capability as OwnedLabelsCapability`
// would be an UNCHECKED down-cast: the upstream shape guard (`isOwnedLabelsCapabilityShape`)
// validated only `typeof v === "number"`, NOT the `v:1` literal — so a future `v:2`
// (planned, `capability.ts` §R4) would be silently re-labelled `v:1`, erasing the compiler's
// forward-compat guard. Instead we RE-VALIDATE the literals here and narrow WITHOUT a cast:
// after the guard, TypeScript narrows `v: number → 1` and `audience: string → "adapter-manager"`,
// making the value structurally assignable to `OwnedLabelsCapability`.
//
// A mismatch (or an absent capability) FAILS CLOSED by throwing: the throw lands in the
// supervisor's `accept` catch as a coarse `lifecycle_error` terminal (NOT the diagnosable
// `no_run_capability`; building that finer terminal is a supervisor-internal concern). A junk
// or wrong-version capability must never reach the wire as if valid.
//
// ★ WHY WE RECONSTRUCT rather than pass `capability` through. TypeScript narrows the ACCESSED
// property `capability.v` after the `!==` guard, but that narrowing does NOT re-type the whole
// `capability` object (it is a single interface, not a discriminated union), so passing the
// object as-is still sees `v: number`. So — having PROVEN `v`/`audience` equal at runtime — we
// rebuild the leaf `OwnedLabelsCapability` from the PINNED literal consts + the validated
// fields. Behaviourally a no-op (the values are equal); type-wise the honest, cast-free bridge.

import {
  NetworkedProviderDriver,
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
} from "@armyofagents/provider-wire";
import type { OwnedLabelsCapability } from "@armyofagents/provider-wire";
import type { MakeRunProvider } from "@armyofagents/worker-daemon";

/** Fail-closed: the run's capability is absent or does not match the pinned version/audience.
 * Carries NO capability fields (labels are the caller's own, but a codec must never log `sig`). */
export class NetworkedProviderCapabilityError extends Error {
  constructor(detail: string) {
    super(`worker-networked-host: refusing to build a run provider — ${detail}`);
    this.name = "NetworkedProviderCapabilityError";
  }
}

/**
 * Build the per-run networked provider factory for a container worker.
 *
 * The returned `MakeRunProvider` is written as an annotated-return arrow so the inline
 * `({ capability }) => …` gets its parameter type from the annotation (satisfying
 * `noImplicitAny` without naming the worker-daemon-local `OwnedLabelsCapabilityLike`).
 *
 * @param baseUrl  the adapter-manager base URL (e.g. `http://adapter-manager:PORT`).
 * @param fetchImpl  injectable fetch (default: the global) — tests spy on the network hop.
 */
export function makeNetworkedRunProvider(baseUrl: string, fetchImpl: typeof fetch = fetch): MakeRunProvider {
  return ({ capability }) => {
    if (capability === undefined) {
      throw new NetworkedProviderCapabilityError("no owned-labels capability was minted for this run");
    }
    if (capability.v !== OWNED_LABELS_CAPABILITY_VERSION) {
      throw new NetworkedProviderCapabilityError(
        `unexpected capability version (expected ${OWNED_LABELS_CAPABILITY_VERSION})`,
      );
    }
    if (capability.audience !== OWNED_LABELS_CAPABILITY_AUDIENCE) {
      throw new NetworkedProviderCapabilityError(
        `unexpected capability audience (expected ${JSON.stringify(OWNED_LABELS_CAPABILITY_AUDIENCE)})`,
      );
    }
    // Rebuild from the pinned literal consts (proven equal above) — no cast, forward-compat intact.
    const validated: OwnedLabelsCapability = {
      v: OWNED_LABELS_CAPABILITY_VERSION,
      audience: OWNED_LABELS_CAPABILITY_AUDIENCE,
      ownedLabels: capability.ownedLabels,
      expiresAt: capability.expiresAt,
      sig: capability.sig,
    };
    return new NetworkedProviderDriver({ baseUrl, capability: validated, fetch: fetchImpl });
  };
}
