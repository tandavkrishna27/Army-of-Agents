// BRW-001 — acceptance clause 1 (unit-shaped; runs on Windows, DEC-03).
//
//   "Old workers reject browser jobs by capability without seeing sensitive inputs."
//
// This clause is ALREADY IMPLEMENTED, in the frozen `workerSatisfiesRequirements` matcher.
// BRW-001 does not build it — BRW-001 proves it is REACHABLE and correctly ordered, because
// a correct mechanism nothing exercises is this programme's signature defect. These tests
// are the named executable artifact for that clause.
//
// The second half of the clause — "without seeing sensitive inputs" — is proven
// STRUCTURALLY rather than by observation: the matcher's inputs are the registered target
// profile, the verified provider profile, the worker hello, and the capability
// requirements. `jobCapabilityRequirementsSchema` is `.strict()` and has no workload field
// at all, so a browser session's configuration CANNOT be part of the matching decision. The
// rejection happens control-plane-side, before any envelope is handed to a worker.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalProviderConstraintProfileDigestInputV1,
  jobCapabilityRequirementsSchema,
  verifyAndBrandProviderConstraintProfileV1,
  workerSatisfiesRequirements,
  type JobCapabilityRequirementsV1,
  type RegisteredTargetProfileV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const ID = {
  target: "00000000-0000-4000-8000-0000000000b0",
  worker: "00000000-0000-4000-8000-0000000000b1",
};
const POLICY = "c".repeat(64);

const baseProfile = {
  profileId: "browser-standard",
  version: 1,
  digest: "0".repeat(64),
  maxContinuousRuntimeSeconds: 3600,
  maxIdleSeconds: 300,
  resourceCeiling: { cpuMillis: 4000, memoryMiB: 8192, pids: 1024, diskMiB: 20480 },
  maxConcurrentOperations: 4,
  supportedOperations: ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup"],
  localityTags: ["transfer_allowed"],
  checkpointMode: "none",
  healthMode: "none",
};

/** The server-owned ceiling INCLUDES the browser capability — so a rejection below can only
 * come from the worker's own report, never from a mis-specified ceiling. */
const BROWSER_CEILING = [
  "workload.browser_session",
  "provider.lifecycle_v1",
  "sandbox.filesystem_isolated",
  "sandbox.filtered_egress",
  "artifact.direct_upload",
  "secret.proxy",
];

/** A worker that predates browser support: it reports the batch workload and no browser
 * capability, and advertises zero browser session slots. */
const OLD_WORKER_CAPABILITIES = [
  "workload.batch",
  "provider.lifecycle_v1",
  "sandbox.filesystem_isolated",
  "sandbox.filtered_egress",
];

async function makeBrowserPair(
  opts: {
    target?: Record<string, unknown>;
    worker?: Record<string, unknown>;
    requirements?: Record<string, unknown>;
  } = {},
) {
  const profile: Record<string, unknown> = { ...clone(baseProfile) };
  profile.digest = sha256hex(canonicalProviderConstraintProfileDigestInputV1(profile));
  const ref = { profileId: profile.profileId, version: profile.version, digest: profile.digest };

  const target: Record<string, unknown> = {
    protocolVersion: 1,
    targetId: ID.target,
    targetClass: "managed_cloud",
    scope: "platform",
    organizationId: null,
    ownerPrincipalId: null,
    trustCeiling: "shared_isolated",
    credentialCeiling: "platform_brokered",
    dataLocalityCeiling: "transfer_allowed",
    providerConstraints: clone(ref),
    capabilityCeiling: clone(BROWSER_CEILING),
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: POLICY,
    ...clone(opts.target ?? {}),
  };

  const worker: Record<string, unknown> = {
    protocolVersion: 1,
    workerId: ID.worker,
    targetId: ID.target,
    deviceGeneration: 1,
    agentVersion: "1.0.0",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "e2b-firecracker" },
    reportedCapabilities: clone(BROWSER_CEILING),
    capacity: {
      batchSlots: 0,
      browserSessionSlots: 1,
      serviceSlots: 0,
      freeCpuMillis: 4000,
      freeMemoryMiB: 8192,
      freeDiskMiB: 20480,
    },
    policyHash: POLICY,
    ...clone(opts.worker ?? {}),
  };

  const requirements: Record<string, unknown> = {
    protocol: { min: 1, max: 1 },
    capabilities: ["provider.lifecycle_v1", "sandbox.filtered_egress"],
    workloadType: "browser_session",
    targetRequirements: {
      allowedTargetClasses: ["managed_cloud"],
      allowedTrustClasses: ["shared_isolated"],
      requiredOwnerPrincipalId: null,
      credentialKind: "platform_brokered",
      dataLocality: "transfer_allowed",
      fallback: { mode: "forbidden", orderedTargetClasses: [] },
      providerConstraints: clone(ref),
    },
    policyHash: POLICY,
    // Required by the frozen `.strict()` schema. Omitting it does NOT make the matcher
    // return false — it makes step 5's must-understand loop THROW on undefined, which five
    // of the rejection tests below would never reach because they return false earlier.
    // The positive control is what surfaced that; a rejection test that passes because the
    // fixture is broken proves nothing.
    mustUnderstand: [],
    ...clone(opts.requirements ?? {}),
  };

  const verified = await verifyAndBrandProviderConstraintProfileV1(profile, sha256hex);
  if (!verified) throw new Error("fixture provider profile failed to verify");
  return {
    verified,
    target: target as unknown as RegisteredTargetProfileV1,
    worker: worker as unknown as WorkerHelloV1,
    requirements: requirements as unknown as JobCapabilityRequirementsV1,
  };
}

describe("BRW-001 — a browser-capable worker is matched (the positive control)", () => {
  // Without this, every rejection below could pass for the wrong reason — a fixture that
  // never matches anything proves nothing about capability.
  it("accepts a worker reporting workload.browser_session with a free slot", async () => {
    const { verified, target, worker, requirements } = await makeBrowserPair();
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(true);
  });
});

describe("BRW-001 — old workers reject browser jobs BY CAPABILITY", () => {
  it("rejects a worker that does not report workload.browser_session", async () => {
    const { verified, target, worker, requirements } = await makeBrowserPair({
      worker: {
        reportedCapabilities: clone(OLD_WORKER_CAPABILITIES),
        capacity: {
          batchSlots: 1,
          browserSessionSlots: 1, // a slot is free; ONLY the capability is missing
          serviceSlots: 0,
          freeCpuMillis: 4000,
          freeMemoryMiB: 8192,
          freeDiskMiB: 20480,
        },
      },
    });
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(false);
  });

  it("rejects a worker that reports the capability but has no free browser slot", async () => {
    const { verified, target, worker, requirements } = await makeBrowserPair({
      worker: {
        capacity: {
          batchSlots: 4,
          browserSessionSlots: 0, // capability present; ONLY the slot is missing
          serviceSlots: 0,
          freeCpuMillis: 4000,
          freeMemoryMiB: 8192,
          freeDiskMiB: 20480,
        },
      },
    });
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(false);
  });

  it("rejects a worker that advertises browser support the server ceiling does not grant", async () => {
    // The intersection is server-ceiling-first: a worker cannot advertise its way into a
    // capability its registered target was never granted.
    const { verified, target, worker, requirements } = await makeBrowserPair({
      target: {
        capabilityCeiling: ["workload.batch", "provider.lifecycle_v1", "sandbox.filtered_egress"],
      },
    });
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(false);
  });
});

describe("BRW-001 — N-1 compatibility", () => {
  it("rejects an N-1 worker whose protocol range does not overlap", async () => {
    const { verified, target, worker, requirements } = await makeBrowserPair({
      worker: { supportedProtocol: { min: 2, max: 2 } },
    });
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(false);
  });

  it("rejects an N-1 worker on a stale policy hash", async () => {
    const { verified, target, worker, requirements } = await makeBrowserPair({
      worker: { policyHash: "d".repeat(64) },
    });
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(false);
  });

  it("rejects a revoked target even when the worker is fully browser-capable", async () => {
    const { verified, target, worker, requirements } = await makeBrowserPair({
      target: { revokedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(false);
  });

  it("rejects an unknown must-understand token rather than ignoring it", async () => {
    const { verified, target, worker, requirements } = await makeBrowserPair({
      requirements: { mustUnderstand: ["browser.some_future_capability"] },
    });
    expect(workerSatisfiesRequirements(target, verified, worker, requirements)).toBe(false);
  });
});

describe("BRW-001 — the matcher structurally CANNOT see the browser configuration", () => {
  // This is the "without seeing sensitive inputs" half of the clause, proven by the shape of
  // the contract rather than by observing a log. `jobCapabilityRequirementsSchema` is
  // `.strict()`, so a browser workload cannot ride along with the matching decision.
  it("refuses a workload payload on the capability requirements", async () => {
    const { requirements } = await makeBrowserPair();
    const withWorkload = {
      ...(requirements as unknown as Record<string, unknown>),
      workload: { engine: "chromium", locale: "en-US", maxSessionSeconds: 900 },
    };
    expect(jobCapabilityRequirementsSchema.safeParse(withWorkload).success).toBe(false);
  });

  it("refuses a secret handle on the capability requirements", async () => {
    const { requirements } = await makeBrowserPair();
    const withSecrets = {
      ...(requirements as unknown as Record<string, unknown>),
      secretHandles: [],
    };
    expect(jobCapabilityRequirementsSchema.safeParse(withSecrets).success).toBe(false);
  });

  it("accepts the requirements the matcher actually receives", async () => {
    // Proves the two rejections above are about the ADDED key, not a broken fixture.
    const { requirements } = await makeBrowserPair();
    expect(jobCapabilityRequirementsSchema.safeParse(requirements).success).toBe(true);
  });
});
