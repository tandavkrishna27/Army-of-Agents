import { describe, expect, it } from "vitest";

import { workerCapacitySchema } from "@armyofagents/worker-protocol";

import { createHostCapacityProbes, type HostProbeReaders } from "../poll/host-probes.js";
import { measureCapacity, type CapacityReservation } from "../poll/capacity.js";

const NO_RESERVATION: CapacityReservation = { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 };
const SLOTS = { batch: 1, browser_session: 0, service: 0 } as const;

function readers(over: Partial<HostProbeReaders>): HostProbeReaders {
  return {
    cpuCount: () => 4,
    freeMemoryBytes: () => 2048 * 1024 * 1024,
    diskFree: () => 10 * 1024 * 1024 * 1024,
    ...over,
  };
}

describe("createHostCapacityProbes", () => {
  it("POSITIVE CONTROL: working readers report the real numbers", () => {
    const probes = createHostCapacityProbes(readers({}));
    // 4 cores × 1000 millis/core.
    expect(probes.freeCpuMillis()).toBe(4000); // 4 cores x 1000 millis (LITERAL, not the constant)
    // 2048 MiB of free memory in bytes → 2048 MiB.
    expect(probes.freeMemoryMiB()).toBe(2048);
    // 10 GiB free → 10240 MiB.
    expect(probes.freeDiskMiB()).toBe(10 * 1024);
  });

  it("the measured capacity satisfies the frozen workerCapacitySchema through measureCapacity", () => {
    const probes = createHostCapacityProbes(readers({}));
    const capacity = measureCapacity({ probes, reserved: NO_RESERVATION, slots: SLOTS });
    // measureCapacity parses through workerCapacitySchema; re-parse to prove the shape.
    expect(() => workerCapacitySchema.parse(capacity)).not.toThrow();
    expect(capacity.freeCpuMillis).toBe(4000);
  });

  it("a THROWING reader fails to ZERO, never propagates and never invents a number", () => {
    const boom = () => {
      throw new Error("no statfsSync on this host");
    };
    const probes = createHostCapacityProbes(readers({ diskFree: boom }));
    // Killed by: delete the try (would throw), catch returns 1 (would be 1 not 0).
    expect(probes.freeDiskMiB()).toBe(0);
    // The other probes are unaffected.
    expect(probes.freeCpuMillis()).toBe(4000); // 4 cores x 1000 millis (LITERAL, not the constant)
  });

  it("a NEGATIVE reader clamps to ZERO (never advertises negative capacity)", () => {
    const probes = createHostCapacityProbes(
      readers({ freeMemoryBytes: () => -5 * 1024 * 1024 }),
    );
    // Killed by: delete the `<= 0 → 0` clamp.
    expect(probes.freeMemoryMiB()).toBe(0);
  });
});
