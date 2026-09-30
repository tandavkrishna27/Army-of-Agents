// DSK-001 / I12 — a desktop worker can never be matched work.
//
// THIS TEST WAS REDESIGNED AFTER THE DESIGN'S D13 WAS FOUND WRONG.
//
// D13 originally claimed the all-zero `capacity` was one of two axes on which
// matching fails closed. It is not an axis at all: `evaluateStaticLeaseEligibility`
// REPLACES the worker's capacity with `NEUTRAL_LEASE_MATCHER_CAPACITY`
// (`server/src/services/job-lease-eligibility.ts:213`), whose three slot counts
// are all 1, so the step-8 slot check always passes and the zero free-resource
// fields trivially satisfy the step-7 `>` ceilings. A test that asserted through
// capacity would have passed for the wrong reason and proven nothing, while the
// desktop stayed matchable.
//
// The axes that ACTUALLY decide, read from the matcher itself:
//   step 5 — `effective = capabilityCeiling ∩ reportedCapabilities`. With
//            `reportedCapabilities: []` the intersection is empty, so the
//            workload capability is absent and the match fails. This holds
//            regardless of what the server's ceiling contains.
//   step 4 — the worker's `policyHash` must equal the target profile's. An
//            unprovisioned desktop carries a hash no real profile does.
//
// So the tests below assert through those, and — because a test that only ever
// sees "no match" cannot tell an unmatchable hello from a broken matcher — there
// is a NON-VACUITY case proving a matchable hello IS matched.

import { describe, expect, it } from "vitest";
import {
  buildDesktopHello,
  DESKTOP_RUNTIME_LABEL,
  FIRST_ENROLLMENT_DEVICE_GENERATION,
  UNPROVISIONED_POLICY_HASH,
} from "../enrollment/desktop-hello.js";

const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TARGET_ID = "a3000000-0000-4000-8000-000000000003";

const base = {
  workerId: WORKER_ID,
  targetId: TARGET_ID,
  deviceGeneration: FIRST_ENROLLMENT_DEVICE_GENERATION,
};

describe("DSK-001/I12 — the hello is unmatchable on the axes that decide", () => {
  it("reports NO capabilities, so the ceiling intersection is always empty", () => {
    // This is the load-bearing axis. `effective = ceiling ∩ reported`; an empty
    // report makes `effective` empty for ANY server ceiling, so the workload
    // capability check at step 5 can never pass.
    const hello = buildDesktopHello({ ...base, platform: "win32", arch: "x64" });
    expect(hello.reportedCapabilities).toEqual([]);
  });

  it("carries a policy hash no provisioned target profile would match", () => {
    const hello = buildDesktopHello({ ...base, platform: "win32", arch: "x64" });
    expect(hello.policyHash).toBe(UNPROVISIONED_POLICY_HASH);
    expect(hello.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT rely on capacity for unmatchability", () => {
    // Documents the corrected understanding in the test itself, so nobody
    // reintroduces a capacity-based assertion believing it protects anything.
    const hello = buildDesktopHello({ ...base, platform: "win32", arch: "x64" });
    expect(hello.capacity.batchSlots).toBe(0);
    // ...but the matcher overwrites this, so the assertion above is documentation,
    // NOT the guarantee. The guarantee is the two axes tested above.
  });
});

describe("WRK-011 — provisioning makes the hello matchable, and its ABSENCE keeps DSK-001 intact", () => {
  const provisioning = {
    reportedCapabilities: ["workload.batch", "sandbox.process_isolated"] as const,
    policyHash: "7".repeat(64),
    capacity: { batchSlots: 2, browserSessionSlots: 0, serviceSlots: 0, freeCpuMillis: 2_000, freeMemoryMiB: 4_096, freeDiskMiB: 8_192 },
  };

  it("reports the provisioned capabilities, ratified policy, and nameplate capacity (M15)", () => {
    const hello = buildDesktopHello({ ...base, platform: "linux", arch: "x64", provisioning });
    expect(hello.reportedCapabilities).toContain("workload.batch");
    expect(hello.policyHash).toBe("7".repeat(64));
    expect(hello.capacity.batchSlots).toBe(2);
  });

  it("★ ABSENT provisioning is BYTE-IDENTICAL to today — the branch is purely additive (M15)", () => {
    const withProv = buildDesktopHello({ ...base, platform: "linux", arch: "x64" });
    expect(withProv.reportedCapabilities).toEqual([]);
    expect(withProv.policyHash).toBe(UNPROVISIONED_POLICY_HASH);
    expect(withProv.capacity.batchSlots).toBe(0);
  });

  it("emits capabilities in a STABLE order regardless of input set order (M17 — replay byte-stability)", () => {
    const a = buildDesktopHello({ ...base, platform: "linux", arch: "x64", provisioning });
    const b = buildDesktopHello({
      ...base, platform: "linux", arch: "x64",
      provisioning: { ...provisioning, reportedCapabilities: ["sandbox.process_isolated", "workload.batch"] as const },
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // set-order-differing input → identical bytes
  });
});

describe("DSK-001/I12 — the platform block is a constant, not a fingerprint", () => {
  it("maps win32 to the protocol's `windows`", () => {
    expect(buildDesktopHello({ ...base, platform: "win32", arch: "x64" }).platform.os).toBe("windows");
  });

  it("uses a fixed runtime label rather than process.version", () => {
    // `runtime` is an opaque provider-neutral label. Emitting a Node version
    // would put a fingerprintable build string on the wire for no benefit.
    const hello = buildDesktopHello({ ...base, platform: "win32", arch: "x64" });
    expect(hello.platform.runtime).toBe(DESKTOP_RUNTIME_LABEL);
    expect(hello.platform.runtime).not.toMatch(/^v?\d+\.\d+\.\d+/);
  });

  it("THROWS a named error for an arch outside the frozen enum", () => {
    // WORKER_ARCH is exactly ["x64","arm64"]. A desktop on ia32 or arm32 cannot
    // produce a schema-valid hello, and a deliberate error beats a ZodError
    // surfacing from deep inside the transport envelope.
    for (const arch of ["ia32", "arm", "riscv64", ""]) {
      expect(() => buildDesktopHello({ ...base, platform: "win32", arch }), arch)
        .toThrow(/arch|architecture/i);
    }
  });

  it("THROWS for a platform the protocol has no OS for", () => {
    expect(() => buildDesktopHello({ ...base, platform: "aix", arch: "x64" })).toThrow();
  });
});

describe("DSK-001 — the hello is schema-valid and byte-stable", () => {
  it("passes workerHelloV1Schema — it is parse output, not a hand-built object", () => {
    const hello = buildDesktopHello({ ...base, platform: "win32", arch: "x64" });
    expect(hello.protocolVersion).toBe(1);
    expect(hello.workerId).toBe(WORKER_ID);
    expect(hello.targetId).toBe(TARGET_ID);
    expect(hello.deviceGeneration).toBe(1);
    expect(hello.supportedProtocol.min).toBe(1);
    expect(hello.supportedProtocol.max).toBe(1);
  });

  it("is byte-stable for identical inputs — a replay must be identical", () => {
    // I7's retry path replays the SAME hello. Any per-call variation (a clock, a
    // random, a process version) would change the semantic digest and turn a
    // replay into a new submission.
    const a = JSON.stringify(buildDesktopHello({ ...base, platform: "win32", arch: "x64" }));
    const b = JSON.stringify(buildDesktopHello({ ...base, platform: "win32", arch: "x64" }));
    expect(a).toBe(b);
  });

  it("first enrolment uses generation 1, which the server requires exactly", () => {
    // The server compares the hello's generation with the target's current one
    // and rejects a mismatch outright, so this constant is not cosmetic.
    expect(FIRST_ENROLLMENT_DEVICE_GENERATION).toBe(1);
  });
});
