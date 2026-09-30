// server/src/__tests__/cli-008-staged-input-contract.test.ts
//
// CLI-008 Unit B — the staged-input POINTER contract, across the E4-D01 boundary.
//
// The control plane WRITES the pointer (`server/src/services/job-input-staging.ts`) and the
// worker daemon READS it (`packages/worker-daemon/src/lease/staged-input.ts`). Neither may
// import the other's runtime code, so the encoding is agreed by two independent
// implementations of the same shape — exactly the drift class this repo already handles by
// value-importing both sides in a test and asserting they agree
// (`task-run-batch-workload.test.ts` does the same for the worker's deadline bounds).
//
// ★ Without this, a rename on either side is silent: the daemon would read no pointer, stage
// nothing, and every run would go on succeeding — with the agent missing its files.

import { describe, expect, it } from "vitest";
import {
  STAGED_INPUT_EXTENSION_NAMESPACE as DAEMON_NAMESPACE,
  readStagedInputPointers,
} from "@armyofagents/worker-daemon";
import { jobEnvelopeV1Schema } from "@armyofagents/worker-protocol";

import {
  STAGED_INPUT_EXTENSION_NAMESPACE as SERVER_NAMESPACE,
  stagedInputExtension,
  type StagedInputPointer,
} from "../services/job-input-staging.js";

const POINTERS: StagedInputPointer[] = [
  {
    artifactId: "00000000-0000-4000-8000-0000000000a1",
    path: "/home/user/.aoa/mcp.json",
    objectKey: "organizations/org-1/jobs/job-1/attempts/1/00000000-0000-4000-8000-0000000000a1",
    sha256: "a".repeat(64),
    sizeBytes: 246,
  },
  {
    artifactId: "00000000-0000-4000-8000-0000000000a2",
    path: "/home/user/.aoa/AGENTS.md",
    objectKey: "organizations/org-1/jobs/job-1/attempts/1/00000000-0000-4000-8000-0000000000a2",
    sha256: "b".repeat(64),
    sizeBytes: 26_568,
  },
];

describe("CLI-008 Unit B — the staged-input pointer crosses the E4-D01 boundary intact", () => {
  it("★ the two independent namespace constants AGREE", () => {
    // A rename on either side is otherwise silent: the daemon reads no pointer, stages
    // nothing, and every run keeps succeeding without its files.
    expect(SERVER_NAMESPACE).toBe(DAEMON_NAMESPACE);
    expect(SERVER_NAMESPACE).toBe("com.armyofagents.job/staged-input");
  });

  it("★ what the control plane WRITES is exactly what the daemon READS", () => {
    const extension = stagedInputExtension(POINTERS);
    expect(readStagedInputPointers([extension])).toEqual(POINTERS);
  });

  it("the extension the control plane writes survives the FROZEN envelope refiner", () => {
    // The pointer must be wire-legal, not merely mutually understood. `critical: false` is
    // load-bearing: an unknown `critical: true` extension fails closed at every worker.
    const extension = stagedInputExtension(POINTERS);
    expect(extension.critical).toBe(false);
    const parsed = jobEnvelopeV1Schema.safeParse(envelopeWith([extension]));
    expect(parsed.success).toBe(true);
  });

  it("an ABSENT or unrelated extension reads as no staged input, never an error", () => {
    // This is what makes staging optional for every worker built before it existed.
    expect(readStagedInputPointers([])).toEqual([]);
    expect(readStagedInputPointers(undefined)).toEqual([]);
    expect(
      readStagedInputPointers([{ namespace: "com.other.thing/x", schemaVersion: 1, critical: false, value: {} }]),
    ).toEqual([]);
  });

  it("★ a PARTLY malformed pointer THROWS — it does not read as 'nothing staged'", () => {
    // ★ THE ASYMMETRY IS THE POINT. An absent extension is "no staged input"; a PRESENT but
    // unreadable one is "the control plane staged something this worker cannot read", and
    // returning [] for that would let the agent run without its files, terminalize cleanly and
    // satisfy every gate downstream — the exact fail-open the digest check exists to prevent.
    // Throwing for the whole extension rather than staging a subset mirrors the provider's
    // all-or-nothing rule: an agent cannot tell which files it is missing.
    const extension = stagedInputExtension(POINTERS);
    const damaged = {
      ...extension,
      value: { files: [extension.value.files[0], { ...extension.value.files[1], sha256: "not-a-digest" }] },
    };
    expect(() => readStagedInputPointers([damaged])).toThrow(/unreadable/);
  });

  it("a relative in-sandbox path is refused — staged paths are absolute", () => {
    const extension = stagedInputExtension([{ ...POINTERS[0]!, path: "relative/x.md" }]);
    expect(() => readStagedInputPointers([extension])).toThrow(/unreadable/);
  });
});

/** The batch envelope shape `buildJobEnvelope` emits, with `extensions` under test. */
function envelopeWith(extensions: readonly unknown[]) {
  return {
    protocolVersion: 1,
    jobId: "00000000-0000-4000-8000-000000000010",
    attempt: 1,
    organizationId: "00000000-0000-4000-8000-000000000011",
    companyId: "00000000-0000-4000-8000-000000000012",
    source: {
      kind: "task_run",
      runId: "00000000-0000-4000-8000-000000000013",
      issueId: "00000000-0000-4000-8000-000000000014",
      requestedBy: { principalType: "user", principalId: "u-17" },
      executionPrincipal: { principalType: "agent", principalId: "00000000-0000-4000-8000-000000000017" },
      assigneeAgentId: "00000000-0000-4000-8000-000000000017",
    },
    createdAt: "2026-09-03T00:00:00.000Z",
    notBefore: null,
    deadline: "2026-09-03T01:00:00.000Z",
    inputHash: "a".repeat(64),
    policyHash: "b".repeat(64),
    placement: {
      policyId: "job-placement",
      version: 1,
      digest: "d".repeat(64),
      targetRequirements: {
        allowedTargetClasses: ["managed_cloud"],
        allowedTrustClasses: ["shared_isolated"],
        requiredOwnerPrincipalId: null,
        credentialKind: "platform_brokered",
        dataLocality: "transfer_allowed",
        fallback: { mode: "ordered_explicit", orderedTargetClasses: ["managed_cloud"] },
        providerConstraints: { profileId: "standard", version: 1, digest: "e".repeat(64) },
      },
    },
    adapter: { type: "aoa_job_control", version: "1", configArtifactId: null },
    requiredCapabilities: ["workload.batch", "sandbox.process_isolated"],
    workspace: null,
    secretHandles: [],
    resourceLimits: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 10240 },
    networkPolicy: { policyId: "job-default-deny", version: 1, digest: "c".repeat(64) },
    offlinePolicy: "cancel",
    extensions,
    workloadType: "batch",
    workload: { command: "claude", args: ["--print", "hi"], stdinArtifactId: null, maxRuntimeSeconds: 240 },
  };
}
