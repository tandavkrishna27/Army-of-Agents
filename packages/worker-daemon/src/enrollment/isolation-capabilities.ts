// packages/worker-daemon/src/enrollment/isolation-capabilities.ts
//
// DSK-002 Lane B (D3/D4) — what isolation this desktop can actually provide, expressed in
// the FROZEN capability vocabulary.
//
// NO FROZEN-PROTOCOL CHANGE IS NEEDED. `KNOWN_WORKER_CAPABILITIES` already carries
// `sandbox.filesystem_isolated`, `sandbox.process_isolated` and `sandbox.filtered_egress`.
// The ticket's "none / Docker / OS isolation" maps onto those three as INDEPENDENT
// booleans, not as a tier ladder — a Docker-backed desktop isolates filesystem and
// processes but does NOT filter egress (Docker's default bridge is wide open), so a ladder
// would have to claim something false to keep its ordering.
//
// D4 — FAIL TOWARD ABSENT. A probe that errors, times out, or is merely unimplemented
// reports the capability as ABSENT. Over-reporting places jobs on a device that cannot
// contain them; under-reporting only costs placement opportunities. Every default here
// points at `none`.
//
// THE REPLAY TRAP, which is why detection does not live inside the hello builder.
// `buildDesktopHello` takes no clock, no random and no `process`, deliberately: I7's
// retry path REPLAYS the same hello, and any per-call variation changes the semantic
// digest and turns a replay into a new submission — the double-mint the enrolment path
// exists to prevent. Probing Docker is exactly such a variation: if the daemon went down
// between the first attempt and the retry, a re-probed hello would differ in bytes. So
// detection happens ONCE, outside, and the resulting mechanism is passed in and REUSED
// across every retry of that enrolment.

import type { WorkerCapability } from "@armyofagents/worker-protocol";

/**
 * The isolation mechanism this desktop can put between a job and the host.
 *
 * `os_native` covers the per-platform primitives (bubblewrap / user namespaces on Linux,
 * `sandbox-exec` on macOS, AppContainer / Job Objects on Windows). DSK-002 defines the
 * vocabulary and the mapping; the per-OS PROBES belong to DSK-003, which owns the host
 * and the installer. Until then a desktop that cannot prove Docker reports `none`, which
 * is the correct fail-closed answer rather than a placeholder.
 */
export const ISOLATION_MECHANISMS = ["none", "docker", "os_native"] as const;
export type IsolationMechanism = (typeof ISOLATION_MECHANISMS)[number];

/**
 * Mechanism → the frozen capabilities it justifies.
 *
 * `sandbox.filtered_egress` is absent from EVERY row, and that is a decision rather than
 * an omission: neither Docker's default bridge nor a bare OS sandbox filters egress. The
 * capability becomes reportable when something actually filters — the fence-aware egress
 * path of Lane D — and claiming it earlier would be the precise over-report D4 forbids.
 */
const CAPABILITIES_BY_MECHANISM: Record<IsolationMechanism, readonly WorkerCapability[]> = {
  none: [],
  docker: ["sandbox.filesystem_isolated", "sandbox.process_isolated"],
  os_native: ["sandbox.filesystem_isolated", "sandbox.process_isolated"],
};

/**
 * The capabilities to report for a mechanism, in a STABLE order.
 *
 * Order matters beyond tidiness: the hello is replayed byte-for-byte on retry, so a set
 * iterated in a nondeterministic order would change the semantic digest between attempts.
 */
export function capabilitiesForIsolation(mechanism: IsolationMechanism): readonly WorkerCapability[] {
  return CAPABILITIES_BY_MECHANISM[mechanism] ?? [];
}

/** An injected probe. Returns true only when the mechanism is PROVEN usable. */
export type IsolationProbe = () => boolean | Promise<boolean>;

export interface IsolationProbes {
  /** Proves a responsive container runtime, not merely an installed binary. */
  readonly docker?: IsolationProbe;
  /** Per-OS native sandbox. Unimplemented in DSK-002 — see the type doc above. */
  readonly osNative?: IsolationProbe;
}

/**
 * Detect the isolation mechanism, failing toward `none` on ANY doubt.
 *
 * A probe that throws, rejects, or is absent counts as "not proven", never as an error to
 * surface: enrolment must not be blocked by an isolation probe, and a desktop that cannot
 * demonstrate isolation is a perfectly valid desktop that simply gets less work.
 *
 * Docker is preferred over `os_native` when both probe true — it is the stronger and far
 * more uniform boundary across the advertised OS matrix, and picking deterministically
 * matters for the replay stability described in the header.
 */
export async function detectIsolationMechanism(probes: IsolationProbes = {}): Promise<IsolationMechanism> {
  if (await proven(probes.docker)) return "docker";
  if (await proven(probes.osNative)) return "os_native";
  return "none";
}

async function proven(probe: IsolationProbe | undefined): Promise<boolean> {
  if (!probe) return false;
  try {
    return (await probe()) === true; // strictly true — a truthy string is not a proof
  } catch {
    return false;
  }
}
