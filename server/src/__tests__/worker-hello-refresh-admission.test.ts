// server/src/__tests__/worker-hello-refresh-admission.test.ts
//
// WRK-011 (Sprint 2.75) — the pure hello-refresh admission decision.
//
// ★ POSITIVE CONTROL FIRST (E1-F008 precedent). Five placement guards once passed
// their own named tests while DELETED, because every fixture refused earlier for an
// unrelated reason and each test asserted a bare `admit:false`. So this suite OPENS by
// proving the shared fixture ADMITS with `changed:true` and a SPECIFIC profileHash, and
// every refusal case below asserts its SPECIFIC reason — never a bare `admit:false`.

import { describe, expect, it } from "vitest";
import { workerHelloV1Schema, type WorkerHelloV1 } from "@armyofagents/worker-protocol";
import {
  admitHelloRefresh,
  helloRefreshRefusalWireCode,
  type HelloRefusalReason,
} from "../services/worker-hello-refresh-admission.js";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const RATIFIED_POLICY_HASH = "a".repeat(64);
const INJECTED_DIGEST = "b".repeat(64);

/** A valid, parsed hello inside the ratified ceiling (a STRICT subset), at the
 * principal's identity and generation, echoing the ratified policy. The positive
 * control must ADMIT this before any refusal case is built on it. */
function hello(overrides: Partial<WorkerHelloV1> = {}): WorkerHelloV1 {
  return workerHelloV1Schema.parse({
    protocolVersion: 1,
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    deviceGeneration: 3,
    agentVersion: "1.0.0",
    supportedProtocol: { min: 1, max: 1 },
    platform: { os: "linux", arch: "x64", runtime: "desktop" },
    reportedCapabilities: ["workload.batch"],
    capacity: {
      batchSlots: 1,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 1000,
      freeMemoryMiB: 512,
      freeDiskMiB: 1024,
    },
    policyHash: RATIFIED_POLICY_HASH,
    ...overrides,
  });
}

function input(overrides: Partial<Parameters<typeof admitHelloRefresh>[0]> = {}) {
  return {
    principal: { workerId: WORKER_ID, targetId: TARGET_ID, targetGeneration: 3 },
    hello: hello(),
    ratified: { capabilityCeiling: ["workload.batch", "workload.service"], policyHash: RATIFIED_POLICY_HASH },
    currentProfileHash: null,
    digestOf: () => INJECTED_DIGEST,
    ...overrides,
  } satisfies Parameters<typeof admitHelloRefresh>[0];
}

describe("admitHelloRefresh — positive control", () => {
  it("ADMITS a provisioned worker with changed:true and the injected digest", () => {
    const decision = admitHelloRefresh(input());
    expect(decision).toEqual({ admit: true, changed: true, profileHash: INJECTED_DIGEST });
  });

  it("ADMITS with changed:false when the computed digest equals the current hash (idempotent no-op)", () => {
    const decision = admitHelloRefresh(input({ currentProfileHash: INJECTED_DIGEST }));
    expect(decision).toEqual({ admit: true, changed: false });
  });

  it("ADMITS a strict SUBSET of the ceiling (anti-vacuity for G2 — a subset must not be refused)", () => {
    const decision = admitHelloRefresh(
      input({
        ratified: { capabilityCeiling: ["workload.batch", "workload.service", "sandbox.process_isolated"], policyHash: RATIFIED_POLICY_HASH },
        hello: hello({ reportedCapabilities: ["workload.batch"] }),
      }),
    );
    expect(decision).toEqual({ admit: true, changed: true, profileHash: INJECTED_DIGEST });
  });
});

describe("admitHelloRefresh — the four guards, each with its SPECIFIC reason", () => {
  it("profile_unratified when no admin has ratified a profile", () => {
    expect(admitHelloRefresh(input({ ratified: null }))).toEqual({ admit: false, reason: "profile_unratified" });
  });

  // G1 identity — three arms, each with the OTHER two fields CORRECT so the case cannot
  // pass for the wrong reason (design §7 Step 1).
  it("G1 arm A — identity_mismatch on workerId (targetId + generation correct)", () => {
    expect(
      admitHelloRefresh(input({ hello: hello({ workerId: "33333333-3333-4333-8333-333333333333" }) })),
    ).toEqual({ admit: false, reason: "identity_mismatch" });
  });
  it("G1 arm B — identity_mismatch on targetId (workerId + generation correct)", () => {
    expect(
      admitHelloRefresh(input({ hello: hello({ targetId: "44444444-4444-4444-8444-444444444444" }) })),
    ).toEqual({ admit: false, reason: "identity_mismatch" });
  });
  it("G1 arm C — identity_mismatch on deviceGeneration (workerId + targetId correct)", () => {
    expect(
      admitHelloRefresh(input({ hello: hello({ deviceGeneration: 4 }) })),
    ).toEqual({ admit: false, reason: "identity_mismatch" });
  });

  // G2 ceiling — one ungranted capability among several granted ones.
  it("G2 — capability_not_granted for a capability outside the ceiling", () => {
    expect(
      admitHelloRefresh(
        input({
          ratified: { capabilityCeiling: ["workload.batch", "workload.service"], policyHash: RATIFIED_POLICY_HASH },
          hello: hello({ reportedCapabilities: ["workload.batch", "sandbox.process_isolated"] }),
        }),
      ),
    ).toEqual({ admit: false, reason: "capability_not_granted" });
  });

  // G3 policy — a hash differing by one nibble.
  it("G3 — policy_stale when the hello policy hash differs from the ratified one", () => {
    expect(
      admitHelloRefresh(input({ hello: hello({ policyHash: "b" + "a".repeat(63) }) })),
    ).toEqual({ admit: false, reason: "policy_stale" });
  });
});

describe("helloRefreshRefusalWireCode — exhaustiveness (every reason is coarse `unauthorized`)", () => {
  it.each<HelloRefusalReason>([
    "identity_mismatch",
    "capability_not_granted",
    "policy_stale",
    "profile_unratified",
  ])("maps %s to unauthorized on the wire", (reason) => {
    expect(helloRefreshRefusalWireCode(reason)).toBe("unauthorized");
  });
});
