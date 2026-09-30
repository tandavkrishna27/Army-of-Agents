/**
 * Shared builders for the WRK-002 enroll/session component tests. Boundary-clean
 * (Node builtins + frozen worker-protocol only); imported by `*.test.ts` files.
 */

import { randomUUID } from "node:crypto";

import {
  workerHelloV1Schema,
  providerConstraintRefV1Schema,
  type ProviderConstraintRefV1,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

const SAMPLE_HASH = "a".repeat(64);
const SAMPLE_DIGEST = "b".repeat(64);

export function sampleProviderConstraints(): ProviderConstraintRefV1 {
  return providerConstraintRefV1Schema.parse({
    profileId: "default-profile",
    version: 1,
    digest: SAMPLE_DIGEST,
  });
}

export interface HelloOverrides {
  workerId?: string;
  targetId?: string;
  deviceGeneration?: number;
  agentVersion?: string;
  policyHash?: string;
}

export function buildHello(overrides: HelloOverrides = {}): WorkerHelloV1 {
  return workerHelloV1Schema.parse({
    protocolVersion: 1,
    workerId: overrides.workerId ?? randomUUID(),
    targetId: overrides.targetId ?? randomUUID(),
    deviceGeneration: overrides.deviceGeneration ?? 1,
    agentVersion: overrides.agentVersion ?? "0.1.0",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "node" },
    reportedCapabilities: ["workload.batch"],
    capacity: {
      batchSlots: 1,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 1_000,
      freeMemoryMiB: 1_024,
      freeDiskMiB: 1_024,
    },
    policyHash: overrides.policyHash ?? SAMPLE_HASH,
  });
}
