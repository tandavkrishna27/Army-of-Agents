import { beforeEach, describe, expect, it, vi } from "vitest";

const authorityHarness = vi.hoisted(() => ({
  failSharedAcquisition: false,
  state: { proofs: 0, touches: 0, leases: 0, receipts: 0 },
}));

const NOW = new Date("2026-08-10T12:00:00.000Z");
const ORG = "b4000000-0000-4000-8000-000000000001";
const TARGET = "b4000000-0000-4000-8000-000000000002";
const LOGICAL_WORKER = "b4000000-0000-4000-8000-000000000003";
const PHYSICAL_WORKER = "b4000000-0000-4000-8000-000000000004";
const PROFILE_HASH = "a".repeat(64);
const TARGET_PROFILE_HASH = "b".repeat(64);
const THUMBPRINT = "c".repeat(64);

vi.mock("@armyofagents/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@armyofagents/db")>();
  return {
    ...actual,
    configurePlatformTargetAuthorityLockTimeout: async () => {},
    operatorJobLeasingRepository: () => ({
      lockPlatformPhysicalAuthority: async () => ({
        target: {
          id: TARGET,
          scope: "platform",
          organizationId: null,
          ownerUserId: null,
          targetAuthorityKey: "platform",
          status: "active",
          deviceGeneration: 1,
          registeredProfileHash: TARGET_PROFILE_HASH,
          lastSeenAt: NOW,
        },
        worker: {
          id: PHYSICAL_WORKER,
          scope: "platform",
          organizationId: null,
          ownerUserId: null,
          executionTargetId: TARGET,
          targetAuthorityKey: "platform",
          status: "active",
          revokedAt: null,
          deviceGeneration: 1,
          devicePublicKey: "platform-device-key",
          deviceThumbprint: THUMBPRINT,
          profileHash: PROFILE_HASH,
          lastSeenAt: NOW,
        },
      }),
    }),
  };
});

vi.mock("../db/tenant-context.js", () => ({
  runInTenant: async (_appDb: unknown, _organizationId: string, fn: (repos: unknown) => Promise<unknown>) => {
    const snapshot = { ...authorityHarness.state };
    const repos = {
      workerEnrollment: {
        cleanupExpiredProofs: async () => 0,
        recordProof: async () => {
          authorityHarness.state.proofs += 1;
          return true;
        },
      },
      jobControl: {
        currentDatabaseTime: async () => NOW,
        lockWorkerLeaseAuthority: async () => ({
          worker: {
            id: LOGICAL_WORKER,
            scope: "organization",
            organizationId: ORG,
            ownerUserId: null,
            executionTargetId: TARGET,
            targetAuthorityKey: "platform",
            status: "enrolled",
            revokedAt: null,
            deviceGeneration: 1,
            devicePublicKey: "platform-device-key",
            deviceThumbprint: THUMBPRINT,
            profileHash: PROFILE_HASH,
            profileSnapshot: {},
            lastSeenAt: null,
          },
          target: {
            id: TARGET,
            scope: "platform",
            organizationId: null,
            ownerUserId: null,
            targetAuthorityKey: "platform",
            status: "active",
            deviceGeneration: 1,
            registeredProfileHash: TARGET_PROFILE_HASH,
          },
          ownerMembershipActive: true,
        }),
        acquirePlatformTargetAuthorityShared: async () => {
          if (authorityHarness.failSharedAcquisition) {
            throw new Error("operator_connection_lost_while_shared_lock_blocked");
          }
        },
        recheckPlatformTargetAuthority: async () => ({
          id: TARGET,
          slug: "platform-target",
          kind: "desktop",
          trustClass: "trusted",
          status: "active",
          organizationId: null,
          ownerUserId: null,
          scope: "platform",
          targetAuthorityKey: "platform",
          deviceGeneration: 1,
          registeredProfile: null,
          registeredProfileHash: TARGET_PROFILE_HASH,
          providerConstraintProfile: null,
          capabilities: {},
          lastSeenAt: NOW,
        }),
        touchWorkerLeaseProfile: async () => {
          authorityHarness.state.touches += 1;
          return true;
        },
        lockEligibleLeaseCandidates: async () => [],
      },
    };
    try {
      return await fn(repos);
    } catch (error) {
      Object.assign(authorityHarness.state, snapshot);
      throw error;
    }
  },
}));

import { createJobLeasingService, JobLeasingError } from "../services/job-leasing.js";

function operatorDb(phase: "before_callback" | "while_shared" | "after_callback") {
  return {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      if (phase === "before_callback") throw new Error("operator_connection_lost_before_callback");
      authorityHarness.failSharedAcquisition = phase === "while_shared";
      const result = await callback({});
      if (phase === "after_callback") throw new Error("operator_commit_ack_ambiguous");
      return result;
    },
  };
}

function pollInput() {
  return {
    auth: {
      organizationId: ORG,
      workerId: LOGICAL_WORKER,
      targetId: TARGET,
      targetGeneration: 1,
      deviceThumbprint: THUMBPRINT,
      profileHash: PROFILE_HASH,
      publicKey: "platform-device-key",
      proofId: crypto.randomUUID(),
      proofIssuedAt: NOW,
      sessionExpiresAt: new Date(NOW.getTime() + 10 * 60_000),
    },
    request: {
      protocolVersion: 1 as const,
      correlationId: crypto.randomUUID(),
      issuedAt: NOW.toISOString(),
      nonce: crypto.randomUUID(),
      audience: "worker_poll" as const,
      workerId: LOGICAL_WORKER,
      targetId: TARGET,
      deviceGeneration: 1,
      capacity: {
        batchSlots: 1,
        browserSessionSlots: 0,
        serviceSlots: 0,
        freeCpuMillis: 1_000,
        freeMemoryMiB: 1_024,
        freeDiskMiB: 2_048,
      },
    },
  };
}

describe("JOB-003 operator-loss rollback barriers", () => {
  beforeEach(() => {
    authorityHarness.failSharedAcquisition = false;
    Object.assign(authorityHarness.state, { proofs: 0, touches: 0, leases: 0, receipts: 0 });
  });

  for (const phase of ["before_callback", "while_shared", "after_callback"] as const) {
    it(`rolls back the outer tenant transaction on operator loss ${phase}`, async () => {
      const service = createJobLeasingService({
        appDb: {} as never,
        operatorDb: operatorDb(phase) as never,
      });
      await expect(service.poll(pollInput())).rejects.toMatchObject<JobLeasingError>({
        code: "internal_unavailable",
      });
      expect(authorityHarness.state).toEqual({ proofs: 0, touches: 0, leases: 0, receipts: 0 });
    });
  }
});
