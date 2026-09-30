// packages/worker-daemon/src/enrollment/hello-provisioning.ts
//
// WRK-011 — fold a self-model read RESPONSE into the `HelloProvisioning` a provisioned
// desktop reports. The self-model route (execution-targets.ts:379) is the daemon's source
// of the admin-ratified ceiling + policy; this derives, from that ceiling and what the device
// can actually provide, the capabilities the device is entitled AND able to advertise.
//
// D4 — FAIL TOWARD ABSENT. A malformed or missing registered profile returns `null` (never
// throws): a device that cannot read a valid self-model reports NO provisioning and stays
// unmatchable, which only costs placement opportunity. The intersection below is the same
// rule applied to capabilities — a device never reports a capability merely because the
// ceiling permits it.

import {
  registeredTargetProfileV1Schema,
  type WorkerCapability,
  type WorkerCapacity,
} from "@armyofagents/worker-protocol";
import { capabilitiesForIsolation, type IsolationMechanism } from "./isolation-capabilities.js";
import type { HelloProvisioning } from "./desktop-hello.js";

/**
 * The workload capabilities THIS daemon can actually supervise today. The supervisor for
 * browser_session composes in a later sprint, and D4 forbids reporting a workload the daemon
 * cannot run. Widening this is a deliberate edit, not a config.
 *
 * ★★★ SVC-008b ADDED `workload.service`, and it lands IN THE SAME COMMIT as the supervisor
 * branch that makes it true — never before it. (The original wording here, "the last line of
 * its diff", read like a checkable property and is not one: SVC-008b is a single commit and
 * this file is not last in its file order. The ordering that actually matters is the one
 * stated: same commit, not a separate earlier one.) Splitting the advertisement from the
 * supervisor would open a window in which the daemon reports a workload nothing supervises.
 * That window is SVC-008 §1.2's harm: a service job flowed through the BATCH body with no type
 * error and no branch, `execute` returned when the startup script exited, and a long-running
 * service was reported `succeeded`. Advertising
 * before the branch existed would have shipped that deliberately.
 *
 * ★ WHAT BECOMES REACHABLE, enumerated, because a widening is exactly the shape that silently
 * enables things:
 *   - A daemon whose ADMIN-RATIFIED ceiling grants `workload.service` now REPORTS it (the
 *     derivation below intersects the ceiling with this set), so `workerSatisfiesRequirements`
 *     step 5 stops refusing service candidates and placement can lease a service job to it. A
 *     daemon whose ceiling does NOT grant it is unaffected — the intersection still removes it.
 *   - Nothing else. `workload.browser_session` remains absent and is still filtered out.
 *
 * ★ WHAT IS NOT CHANGED HERE, and was already true before this ticket: the slot default
 * (`config/config.ts` `service: {defaultValue: 1}`) and the provisioned hello that reports it
 * (`bin/worker-daemon.ts` `serviceSlots: config.concurrency.service`). The UNPROVISIONED path's
 * hardcoded `serviceSlots: 0` (`desktop-hello.ts`) also stays — an unprovisioned daemon
 * advertising service slots would be a second false claim one field over.
 *
 * ★ THE RESIDUAL THE ADVERTISEMENT CARRIES. A service supervised by this daemon runs for at
 * most `RUN_OP_DEADLINE_CEILING_MS` (240 s): the run's owned-labels capability is minted with a
 * 5-minute TTL on exactly one route and is NEVER re-minted, so the supervise loop stops on the
 * teardown headroom rather than continue past its own authority and leak a billable sandbox.
 * Whether a four-minute service is worth advertising is SVC-008 §9.1, which is UNRULED. What is
 * advertised is true; what it is worth is a founder call.
 */
export const SUPERVISABLE_WORKLOAD_CAPABILITIES: readonly WorkerCapability[] = [
  "workload.batch",
  "workload.service",
];

export function deriveHelloProvisioning(input: {
  /** The self-model read response body (`{ registeredProfile, providerConstraintProfile, … }`). */
  readonly selfModelResponse: unknown;
  /** The already-detected isolation mechanism (`none` until DSK-003 lands the per-OS probes). */
  readonly isolation: IsolationMechanism;
  /** The nameplate capacity to advertise (Math.min'd against the poll capacity server-side). */
  readonly capacity: WorkerCapacity;
}): HelloProvisioning | null {
  const response = input.selfModelResponse;
  if (response === null || typeof response !== "object") return null;
  const parsed = registeredTargetProfileV1Schema.safeParse(
    (response as { registeredProfile?: unknown }).registeredProfile,
  );
  if (!parsed.success) return null; // fail toward absent

  const deviceCanProvide = new Set<string>([
    ...SUPERVISABLE_WORKLOAD_CAPABILITIES,
    ...capabilitiesForIsolation(input.isolation),
  ]);
  // ★ INTERSECT the admin ceiling with what the device can provide (M16). Reporting the
  // ceiling verbatim would advertise, e.g., `sandbox.*` on a device whose isolation is `none`.
  const reportedCapabilities = parsed.data.capabilityCeiling.filter((cap) => deviceCanProvide.has(cap));

  return { reportedCapabilities, policyHash: parsed.data.policyHash, capacity: input.capacity };
}
