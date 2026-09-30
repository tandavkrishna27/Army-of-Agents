// packages/worker-daemon/src/enrollment/desktop-hello.ts
//
// DSK-001 (I12) — the production `WorkerHelloV1` builder.
//
// Nothing in `packages/worker-daemon/src` built a hello before this: `enroll.ts`
// and `poll/capacity.ts` only ever CONSUME one, and the only constructions were
// in tests. So this is the first producer, and it exists to emit a desktop that
// **can never be matched work**.
//
// WHICH AXES ACTUALLY MAKE IT UNMATCHABLE — this was corrected after the design's
// D13 was found wrong. D13 claimed the all-zero `capacity` was one of two axes.
// It is not an axis at all: `evaluateStaticLeaseEligibility` REPLACES the
// worker's capacity with `NEUTRAL_LEASE_MATCHER_CAPACITY`
// (`server/src/services/job-lease-eligibility.ts:213`), whose three slot counts
// are all 1, so the step-8 slot check always passes and the zero free-resource
// fields trivially satisfy the step-7 `>` ceilings. Relying on capacity would
// have produced a green test over a matchable desktop.
//
// The real axes, read from `workerSatisfiesRequirements` itself:
//
//   step 5 — `effective = capabilityCeiling ∩ reportedCapabilities`. An EMPTY
//            report makes the intersection empty for ANY server ceiling, so the
//            `workload.<type>` capability is absent and the match fails. This is
//            the primary guarantee and it depends on nothing the server does.
//   step 4 — the worker's `policyHash` must equal the target profile's committed
//            hash. An unprovisioned desktop carries one no real profile does.
//
// The all-zero capacity is kept for byte-stability, not for safety.

import {
  KNOWN_WORKER_CAPABILITIES,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  workerHelloV1Schema,
  type WorkerCapability,
  type WorkerCapacity,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

import { WORKER_VERSION } from "../config/config.js";
import { capabilitiesForIsolation, type IsolationMechanism } from "./isolation-capabilities.js";

/**
 * WRK-011 — the facts a PROVISIONED desktop reports once an admin has ratified a placement
 * profile for its target: the capabilities it can actually provide (already intersected with
 * the ratified ceiling by `deriveHelloProvisioning`), the ratified policy hash it has synced,
 * and its nameplate capacity. Absent ⇒ the hello is byte-identical to an unprovisioned one.
 */
export interface HelloProvisioning {
  readonly reportedCapabilities: readonly WorkerCapability[];
  readonly policyHash: string;
  readonly capacity: WorkerCapacity;
}

/** Emit capabilities in a STABLE order (KNOWN_WORKER_CAPABILITIES order) so a replayed hello
 * is byte-identical regardless of the set order the caller passed. */
function sortedCapabilities(capabilities: readonly WorkerCapability[]): WorkerCapability[] {
  const order = new Map(KNOWN_WORKER_CAPABILITIES.map((cap, i) => [cap, i] as const));
  return [...capabilities].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * The opaque runtime label. A CONSTANT, never `process.version`: `runtime` is a
 * provider-neutral tag, and emitting a Node build string would put a
 * fingerprintable value on the wire for no benefit — and would break the
 * byte-stability a replayed enrolment depends on.
 */
export const DESKTOP_RUNTIME_LABEL = "desktop";

/**
 * The policy hash of a desktop that has synced no policy. All zeros is a valid
 * sha256 digest shape that no provisioned target profile carries, so step 4 of
 * the matcher rejects it.
 */
export const UNPROVISIONED_POLICY_HASH = "0".repeat(64);

/**
 * The server requires the hello's generation to EQUAL the target's current one on
 * a first enrolment and rejects any mismatch outright, so this is a contract
 * value rather than a default.
 */
export const FIRST_ENROLLMENT_DEVICE_GENERATION = 1;

/** `process.platform` → the protocol's OS enum. Anything else is unsupported. */
const OS_BY_PLATFORM: Record<string, "linux" | "darwin" | "windows"> = {
  win32: "windows",
  darwin: "darwin",
  linux: "linux",
};

/** The frozen arch enum (`capabilities.ts:102`). Not extensible from here. */
const SUPPORTED_ARCH = new Set(["x64", "arm64"]);

export class DesktopHelloError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopHelloError";
  }
}

/**
 * Build the enrolment hello for a desktop.
 *
 * Deliberately takes NO clock, NO random, and NO `process`: the same inputs must
 * produce byte-identical output, because I7's retry path replays the same hello
 * and any per-call variation would change the semantic digest and turn a replay
 * into a new submission — the double-mint this whole area exists to prevent.
 */
export function buildDesktopHello(input: {
  workerId: string;
  targetId: string;
  deviceGeneration: number;
  platform: string;
  arch: string;
  /**
   * DSK-002 Lane B. The ALREADY-DETECTED isolation mechanism, passed in rather than
   * probed here — this function must stay free of clock, random and `process` so a
   * replayed enrolment produces byte-identical output. Probing Docker inside would be
   * exactly such a variation: a daemon that stopped between the first attempt and the
   * retry would yield a different hello, and a replay would become a new submission.
   *
   * Defaults to `none`, which is both the pre-DSK-002 behaviour and the fail-closed
   * answer (D4).
   */
  isolation?: IsolationMechanism;
  /**
   * WRK-011. When PRESENT, this hello reports the provisioned capabilities/policy/capacity
   * (a device that an admin's ratified profile now makes matchable). When ABSENT, the hello
   * is BYTE-IDENTICAL to the unprovisioned one DSK-001 shipped — the branch is purely
   * additive, which is what keeps the DSK-001/I12 unmatchability guarantee true by default
   * (design §6.1, §8 M15). Same replay discipline as `isolation`: passed in, never probed.
   */
  provisioning?: HelloProvisioning;
}): WorkerHelloV1 {
  const os = OS_BY_PLATFORM[input.platform];
  if (!os) {
    throw new DesktopHelloError(
      `desktop hello: platform ${JSON.stringify(input.platform)} has no protocol OS mapping`,
    );
  }
  if (!SUPPORTED_ARCH.has(input.arch)) {
    // Fail here with a named error rather than letting a ZodError surface from
    // deep inside the transport envelope, where it reads as a protocol bug
    // rather than an unsupported machine.
    throw new DesktopHelloError(
      `desktop hello: arch ${JSON.stringify(input.arch)} is not one of x64, arm64`,
    );
  }

  return workerHelloV1Schema.parse({
    protocolVersion: 1,
    workerId: input.workerId,
    targetId: input.targetId,
    deviceGeneration: input.deviceGeneration,
    agentVersion: WORKER_VERSION,
    supportedProtocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    platform: { os, arch: input.arch, runtime: DESKTOP_RUNTIME_LABEL },
    // Unmatchability (step 5), restated after DSK-002 Lane B made this list non-empty.
    //
    // The old argument was "empty ∩ anything = empty". Reporting isolation capabilities
    // retires that phrasing, so here is the argument that actually holds, read from
    // `workerSatisfiesRequirements` rather than from a comment:
    //
    //     const workloadCapability = `workload.${requirements.workloadType}`;
    //     if (!effective.has(workloadCapability)) return false;
    //
    // The match REQUIRES a `workload.*` capability in `ceiling ∩ reported`. This list
    // contains only `sandbox.*` names, so no `workload.*` can be in the intersection
    // however generous the server's ceiling is, and the match still fails. Step 4's
    // unprovisioned `policyHash` remains the second, independent axis.
    //
    // `desktop-hello.test.ts` asserts this directly, so the guarantee is a test rather
    // than a paragraph: if any `workload.*` name ever appears here, that test fails.
    reportedCapabilities: input.provisioning
      ? sortedCapabilities(input.provisioning.reportedCapabilities)
      : [...capabilitiesForIsolation(input.isolation ?? "none")],
    // Kept for byte-stability. NOT a safety property — the matcher overwrites it.
    capacity: input.provisioning
      ? input.provisioning.capacity
      : {
          batchSlots: 0,
          browserSessionSlots: 0,
          serviceSlots: 0,
          freeCpuMillis: 0,
          freeMemoryMiB: 0,
          freeDiskMiB: 0,
        },
    policyHash: input.provisioning ? input.provisioning.policyHash : UNPROVISIONED_POLICY_HASH,
  });
}
