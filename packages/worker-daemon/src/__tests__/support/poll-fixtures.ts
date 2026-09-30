/**
 * Shared builders for the WRK-003 poll/ACK component tests. Boundary-clean (Node
 * builtins + frozen worker-protocol + the worker's own relative modules), so the
 * `check:worker-daemon-boundary` scan of `src` passes.
 *
 * It assembles a CONSISTENT tuple — a sealed provider-constraint profile, the
 * registered target profile that references it, the worker's dynamic report, and
 * lease offers whose job envelope matches (compatible) or exceeds (incompatible)
 * the worker's capability intersection — mirroring the frozen `capabilities.test.ts`
 * `makePair` construction so `offerSatisfiesWorker` returns a meaningful boolean.
 */

import { createHash } from "node:crypto";

import {
  canonicalProviderConstraintProfileDigestInputV1,
  registeredTargetProfileV1Schema,
  verifyAndBrandProviderConstraintProfileV1,
  workerHelloV1Schema,
  type RegisteredTargetProfileV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

import type { WorkerSelfModel, CapacityProbes, ResourceCeiling } from "../../poll/capacity.js";
import type { DeviceKey } from "../../identity/device-key.js";
import { InMemoryKeyStore } from "../../identity/key-store.js";
import { createEnroller, type WorkerSession } from "../../enrollment/enroll.js";
import { createControlPlaneClient, type ControlPlaneClient, type ControlPlaneClientOptions } from "../../transport/client.js";
import type { FakeControlPlane, FakeEnrollmentCodeConfig } from "./fake-control-plane.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const POLL_FIXTURE_IDS = {
  target: "00000000-0000-4000-8000-0000000000a0",
  worker: "00000000-0000-4000-8000-0000000000a1",
  org: "00000000-0000-4000-8000-0000000000a2",
  job: "00000000-0000-4000-8000-0000000000a3",
  company: "00000000-0000-4000-8000-0000000000a4",
  lease: "00000000-0000-4000-8000-0000000000a5",
  runId: "00000000-0000-4000-8000-0000000000a6",
  issueId: "00000000-0000-4000-8000-0000000000a7",
  agentId: "00000000-0000-4000-8000-0000000000a8",
  manifestArtifact: "00000000-0000-4000-8000-0000000000a9",
  secretHandle: "00000000-0000-4000-8000-0000000000aa",
} as const;

export const POLICY_HASH = "b".repeat(64);
export const FENCE_TOKEN = "g".repeat(43);

/** The full provider-constraint ceiling; free capacity clamps to `resourceCeiling`. */
const baseProviderProfile = {
  profileId: "standard",
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

/** The sealed provider profile whose `digest` is the real hash of its canonical input. */
export function sealedProviderProfile(): Record<string, unknown> {
  const profile = clone(baseProviderProfile);
  profile.digest = sha256hex(canonicalProviderConstraintProfileDigestInputV1(profile));
  return profile;
}

export function providerConstraintRef(): { profileId: string; version: number; digest: string } {
  const profile = sealedProviderProfile();
  return { profileId: profile.profileId as string, version: profile.version as number, digest: profile.digest as string };
}

/** The provider-neutral capabilities in the target's ceiling. `secret.proxy` is
 * in the ceiling but deliberately NOT reported by the worker (drives the
 * incompatible case). */
const CEILING_CAPABILITIES = [
  "workload.batch",
  "provider.lifecycle_v1",
  "sandbox.filesystem_isolated",
  "sandbox.filtered_egress",
  "secret.proxy",
];
const REPORTED_CAPABILITIES = [
  "workload.batch",
  "provider.lifecycle_v1",
  "sandbox.filesystem_isolated",
  "sandbox.filtered_egress",
];

export function registeredTargetProfile(): RegisteredTargetProfileV1 {
  return registeredTargetProfileV1Schema.parse({
    protocolVersion: 1,
    targetId: POLL_FIXTURE_IDS.target,
    targetClass: "managed_cloud",
    scope: "platform",
    organizationId: null,
    ownerPrincipalId: null,
    trustCeiling: "shared_isolated",
    credentialCeiling: "platform_brokered",
    dataLocalityCeiling: "transfer_allowed",
    providerConstraints: providerConstraintRef(),
    capabilityCeiling: CEILING_CAPABILITIES,
    deviceGeneration: 1,
    revokedAt: null,
    policyHash: POLICY_HASH,
  });
}

/** The worker's dynamic self-report (identity + capabilities + a placeholder
 * capacity; the loop overrides `capacity` with the current measurement). */
export function buildWorkerHello(overrides: Partial<Record<string, unknown>> = {}): WorkerHelloV1 {
  return workerHelloV1Schema.parse({
    protocolVersion: 1,
    workerId: POLL_FIXTURE_IDS.worker,
    targetId: POLL_FIXTURE_IDS.target,
    deviceGeneration: 1,
    agentVersion: "0.1.0",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "node" },
    reportedCapabilities: REPORTED_CAPABILITIES,
    capacity: {
      batchSlots: 1,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 4000,
      freeMemoryMiB: 8192,
      freeDiskMiB: 20480,
    },
    policyHash: POLICY_HASH,
    ...overrides,
  });
}

/** Enrollment code config so the fake binds the SAME target/generation the
 * self-model expects. */
export function enrollmentCodeConfig(code: string): FakeEnrollmentCodeConfig {
  return {
    code,
    targetId: POLL_FIXTURE_IDS.target,
    deviceGeneration: 1,
    providerConstraints: providerConstraintRef(),
  };
}

/** Assemble the worker self-model with a digest-verified (branded) provider profile. */
export async function makeSelfModel(): Promise<WorkerSelfModel> {
  const verified = await verifyAndBrandProviderConstraintProfileV1(sealedProviderProfile(), sha256hex);
  if (verified === null) throw new Error("fixture provider profile failed to verify");
  return {
    registeredTargetProfile: registeredTargetProfile(),
    verifiedProviderConstraints: verified,
    report: buildWorkerHello(),
  };
}

export function fixtureProbes(): CapacityProbes {
  return {
    freeCpuMillis: () => 4000,
    freeMemoryMiB: () => 8192,
    freeDiskMiB: () => 20480,
  };
}

export function fixtureCeiling(): ResourceCeiling {
  return { cpuMillis: 4000, memoryMiB: 8192, diskMiB: 20480 };
}

function baseJob(requiredCapabilities: string[]): Record<string, unknown> {
  return {
    protocolVersion: 1,
    jobId: POLL_FIXTURE_IDS.job,
    attempt: 1,
    organizationId: POLL_FIXTURE_IDS.org,
    companyId: POLL_FIXTURE_IDS.company,
    source: {
      kind: "task_run",
      runId: POLL_FIXTURE_IDS.runId,
      issueId: POLL_FIXTURE_IDS.issueId,
      requestedBy: { principalType: "user", principalId: "better-auth-user-a1" },
      executionPrincipal: { principalType: "agent", principalId: POLL_FIXTURE_IDS.agentId },
      assigneeAgentId: POLL_FIXTURE_IDS.agentId,
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    notBefore: null,
    deadline: "2026-08-13T01:00:00.000Z",
    inputHash: "a".repeat(64),
    policyHash: POLICY_HASH,
    placement: {
      policyId: "managed-only",
      version: 1,
      digest: "d".repeat(64),
      targetRequirements: {
        allowedTargetClasses: ["managed_cloud"],
        allowedTrustClasses: ["shared_isolated"],
        requiredOwnerPrincipalId: null,
        credentialKind: "platform_brokered",
        dataLocality: "transfer_allowed",
        fallback: { mode: "forbidden", orderedTargetClasses: [] },
        providerConstraints: providerConstraintRef(),
      },
    },
    adapter: { type: "codex_local", version: "0.2.7", configArtifactId: null },
    requiredCapabilities,
    workspace: null,
    secretHandles: [],
    resourceLimits: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 10240 },
    networkPolicy: { policyId: "provider-only", version: 1, digest: "c".repeat(64) },
    offlinePolicy: "cancel",
    extensions: [],
    workloadType: "batch",
    workload: { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 3600 },
  };
}

function offerWrapping(job: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    workerId: POLL_FIXTURE_IDS.worker,
    leaseId: POLL_FIXTURE_IDS.lease,
    fenceToken: FENCE_TOKEN,
    ackDeadline: "2026-08-13T00:05:00.000Z",
    expiresAt: "2026-08-13T00:10:00.000Z",
    job,
    extensions: [],
    ...overrides,
  };
}

/** A lease offer whose required capabilities sit inside the worker's intersection. */
export function compatibleOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return offerWrapping(baseJob([...REPORTED_CAPABILITIES]), overrides);
}

/** A lease offer requiring `secret.proxy` — in the ceiling but NOT reported, so
 * the worker's intersection self-check must reject it. */
export function incompatibleOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return offerWrapping(baseJob([...REPORTED_CAPABILITIES, "secret.proxy"]), overrides);
}

export interface EnrolledFixtureWorker {
  readonly session: WorkerSession;
  readonly key: DeviceKey;
  readonly client: ControlPlaneClient;
}

/**
 * Drive a real enrollment against the fake to obtain a live session + the device
 * key + a client — the exact inputs `pollOnce`/`ackLease` consume. `clientOptions`
 * lets a test inject a short poll timeout to provoke an outage.
 */
export async function enrollFixtureWorker(
  fake: FakeControlPlane,
  code: string,
  clientOptions: Partial<ControlPlaneClientOptions> = {},
): Promise<EnrolledFixtureWorker> {
  const keyStore = new InMemoryKeyStore();
  const client = createControlPlaneClient({ baseUrl: fake.baseUrl, path: fake.enrollPath, ...clientOptions });
  const enroller = createEnroller({ keyStore, client });
  const result = await enroller.enroll({ hello: buildWorkerHello(), code });
  const key = keyStore.load();
  if (key === null) throw new Error("enrolled worker key was not persisted");
  return { session: result.session, key, client };
}
