/**
 * DSK-002 Lane B / I5 + I6 — isolation capability detection and reporting.
 *
 * Three properties, and the third is the one a careless Lane B would break:
 *
 *   I5  detection fails toward ABSENT — a probe that throws, rejects, returns a
 *       non-`true` truthy value, or does not exist means "not proven";
 *   I6  every reported name is in the FROZEN vocabulary; and
 *       the desktop remains UNMATCHABLE even though its capability list is no longer
 *       empty, and the hello stays byte-stable across a replay.
 */

import { describe, expect, it } from "vitest";

import { KNOWN_WORKER_CAPABILITIES } from "@armyofagents/worker-protocol";

import {
  ISOLATION_MECHANISMS,
  capabilitiesForIsolation,
  detectIsolationMechanism,
} from "../enrollment/isolation-capabilities.js";
import { buildDesktopHello } from "../enrollment/desktop-hello.js";

const HELLO_INPUT = {
  workerId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  deviceGeneration: 1,
  platform: "linux",
  arch: "x64",
};

describe("DSK-002/I5 — detection fails toward absent", () => {
  it("reports none when no probe is supplied", async () => {
    expect(await detectIsolationMechanism()).toBe("none");
    expect(await detectIsolationMechanism({})).toBe("none");
  });

  it("reports none when a probe THROWS", async () => {
    expect(await detectIsolationMechanism({ docker: () => { throw new Error("no daemon"); } }))
      .toBe("none");
  });

  it("reports none when a probe REJECTS", async () => {
    expect(await detectIsolationMechanism({ docker: async () => { throw new Error("timeout"); } }))
      .toBe("none");
  });

  it("requires strictly true — a truthy value is not a proof", async () => {
    // A probe that returns a docker version STRING is reporting information, not proof.
    // `=== true` is what stops `"Docker version 27.0"` from enabling isolation.
    const truthy = [() => "yes" as never, () => 1 as never, () => ({}) as never];
    for (const docker of truthy) {
      expect(await detectIsolationMechanism({ docker })).toBe("none");
    }
  });

  it("detects docker when the probe PROVES it", async () => {
    // Non-vacuity: without this, every assertion above would pass for a function that
    // always returns "none".
    expect(await detectIsolationMechanism({ docker: () => true })).toBe("docker");
    expect(await detectIsolationMechanism({ docker: async () => true })).toBe("docker");
  });

  it("prefers docker over os_native deterministically when both prove", async () => {
    // Determinism matters here for the same reason the hello is byte-stable: an
    // enrolment retry must reach the same answer.
    expect(await detectIsolationMechanism({ docker: () => true, osNative: () => true }))
      .toBe("docker");
  });

  it("falls through to os_native only when docker is not proven", async () => {
    expect(await detectIsolationMechanism({ docker: () => false, osNative: () => true }))
      .toBe("os_native");
  });
});

describe("DSK-002/I6 — every reported name is in the frozen vocabulary", () => {
  it("maps every mechanism to frozen capability names only", () => {
    const known = new Set<string>(KNOWN_WORKER_CAPABILITIES);
    for (const mechanism of ISOLATION_MECHANISMS) {
      for (const cap of capabilitiesForIsolation(mechanism)) {
        expect(known.has(cap), `${mechanism} reports unknown capability ${cap}`).toBe(true);
      }
    }
  });

  it("reports nothing at all for none", () => {
    expect(capabilitiesForIsolation("none")).toEqual([]);
  });

  it("never claims filtered egress — nothing filters egress yet", () => {
    // Docker's default bridge is wide open and a bare OS sandbox filters nothing. The
    // capability becomes reportable when Lane D's fence-aware egress path exists; until
    // then claiming it is the exact over-report D4 forbids.
    for (const mechanism of ISOLATION_MECHANISMS) {
      expect(capabilitiesForIsolation(mechanism)).not.toContain("sandbox.filtered_egress");
    }
  });

  it("reports real isolation for docker — non-vacuity for the checks above", () => {
    expect([...capabilitiesForIsolation("docker")].sort())
      .toEqual(["sandbox.filesystem_isolated", "sandbox.process_isolated"]);
  });
});

describe("DSK-002 Lane B — the DSK-001 unmatchability guarantee still holds", () => {
  // DSK-001 made the desktop unmatchable via "empty ∩ anything = empty". Lane B makes
  // the list non-empty, which RETIRES that phrasing — so the guarantee is re-proven here
  // on the argument that actually holds, read out of `workerSatisfiesRequirements`:
  //
  //     if (!effective.has(`workload.${requirements.workloadType}`)) return false;

  it("reports NO workload.* capability, whatever the isolation mechanism", () => {
    for (const isolation of ISOLATION_MECHANISMS) {
      const hello = buildDesktopHello({ ...HELLO_INPUT, isolation });
      const workloadNames = hello.reportedCapabilities.filter((c) => String(c).startsWith("workload."));
      expect(workloadNames, `${isolation} would become matchable`).toEqual([]);
    }
  });

  it("keeps the unprovisioned policyHash — the second, independent axis", () => {
    const hello = buildDesktopHello({ ...HELLO_INPUT, isolation: "docker" });
    expect(hello.policyHash).toBe("0".repeat(64));
  });

  it("still reports an empty list when no mechanism is given", () => {
    // The pre-DSK-002 behaviour is the DEFAULT, so a caller that never heard of
    // isolation cannot accidentally widen the report.
    expect(buildDesktopHello(HELLO_INPUT).reportedCapabilities).toEqual([]);
  });
});

describe("DSK-002 Lane B — the hello stays byte-stable across a replay", () => {
  it("produces identical bytes for identical input", () => {
    // I7's retry replays the same hello; any per-call variation would change the
    // semantic digest and turn a replay into a NEW submission — the double-mint the
    // enrolment path exists to prevent. This is why the mechanism is passed in rather
    // than probed inside the builder.
    const a = buildDesktopHello({ ...HELLO_INPUT, isolation: "docker" });
    const b = buildDesktopHello({ ...HELLO_INPUT, isolation: "docker" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("orders the capability list stably", () => {
    const runs = Array.from({ length: 5 }, () =>
      JSON.stringify(buildDesktopHello({ ...HELLO_INPUT, isolation: "docker" }).reportedCapabilities));
    expect(new Set(runs).size).toBe(1);
  });

  it("changes the bytes when the mechanism genuinely differs — non-vacuity", () => {
    const none = JSON.stringify(buildDesktopHello({ ...HELLO_INPUT, isolation: "none" }));
    const docker = JSON.stringify(buildDesktopHello({ ...HELLO_INPUT, isolation: "docker" }));
    expect(none).not.toBe(docker);
  });
});
