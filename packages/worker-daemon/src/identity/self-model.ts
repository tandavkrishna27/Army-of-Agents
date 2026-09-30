// WRK-008 slice 2 — assemble the worker's own self-model from the control plane's answer.
//
// The self-model is what the poll loop advertises capacity AGAINST. So the only two
// outcomes here are a fully branded model or `null`: a partially-assembled one would let
// a worker advertise ceilings no authority granted, which is precisely what slice 1's
// route refuses to serve. There is deliberately no "degraded" middle state.
//
// ★ NOTHING HERE THROWS. A daemon that throws on a malformed server response dies instead
// of staying up inert, which is the half-started state the design (Q3) refuses.
//
// ★ THIS FILE IS DELIBERATELY THIN, and mutation testing is why. The first draft also
// null-checked `registeredProfile` and `providerConstraintProfile` before parsing them,
// rejected arrays in `fieldOf`, and wrapped the branding call in a try/catch with a
// confident comment about a caller-supplied hash function that throws. FOUR mutants
// removing those survived, and every one of them was dead code:
//   - `safeParse(null/undefined)` already fails, so the pre-checks decided nothing;
//   - an array has no such property, so it already reads `undefined`;
//   - `verifyAndBrandProviderConstraintProfileV1` ALREADY catches a throwing `sha256Fn`
//     and returns null (`capabilities.ts:258-262`), so that catch was unreachable and its
//     comment described a case that could not arrive here.
// Defensive code that cannot fire is not free: it states an invariant that isn't this
// file's, and it hides which line is actually load-bearing. Every line below is.

import {
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

import type { WorkerSelfModel } from "../poll/capacity.js";

export interface AssembleSelfModelInput {
  /** The parsed 200 body from the self-model read. Untrusted: typed `unknown`. */
  readonly response: unknown;
  /** The worker's own hello — its report of itself, carried through verbatim. */
  readonly report: WorkerHelloV1;
  readonly sha256Fn: (bytes: Uint8Array) => string | Promise<string>;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

export async function assembleWorkerSelfModel(
  input: AssembleSelfModelInput,
): Promise<WorkerSelfModel | null> {
  const registered = registeredTargetProfileV1Schema.safeParse(
    fieldOf(input.response, "registeredProfile"),
  );
  if (!registered.success) return null;

  // The branding function is the ONE authority on whether these bytes are the bytes an
  // operator signed. It recomputes the digest over every field except `digest` itself, so
  // a dropped, added or coerced field fails here rather than surfacing later as a worker
  // quietly advertising the wrong ceilings.
  const verified = await verifyAndBrandProviderConstraintProfileV1(
    fieldOf(input.response, "providerConstraintProfile"),
    input.sha256Fn,
  );
  if (!verified) return null;

  return {
    registeredTargetProfile: registered.data,
    verifiedProviderConstraints: verified,
    report: input.report,
  };
}
