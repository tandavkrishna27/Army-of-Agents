import { describe, expect, it } from "vitest";

import { workerCapacitySchema } from "@armyofagents/worker-protocol";

import {
  measureCapacity,
  sumReservations,
  type CapacityReservation,
} from "../poll/capacity.js";
import { ConcurrencyLimiter } from "../poll/concurrency.js";

const NO_RESERVATION: CapacityReservation = { cpuMillis: 0, memoryMiB: 0, diskMiB: 0 };

function probes(free: { cpu: number; mem: number; disk: number }) {
  return {
    freeCpuMillis: () => free.cpu,
    freeMemoryMiB: () => free.mem,
    freeDiskMiB: () => free.disk,
  };
}

describe("measureCapacity", () => {
  it("reports free resources and per-workload slot counts, validated against the frozen schema", () => {
    const limiter = new ConcurrencyLimiter({ batch: 2, browser_session: 1, service: 0 });
    const capacity = measureCapacity({
      probes: probes({ cpu: 4_000, mem: 8_192, disk: 20_480 }),
      reserved: NO_RESERVATION,
      slots: limiter.snapshot(),
    });
    expect(capacity).toEqual({
      batchSlots: 2,
      browserSessionSlots: 1,
      serviceSlots: 0,
      freeCpuMillis: 4_000,
      freeMemoryMiB: 8_192,
      freeDiskMiB: 20_480,
    });
    expect(workerCapacitySchema.safeParse(capacity).success).toBe(true);
  });

  it("subtracts in-flight reservations from the measured free resources", () => {
    const capacity = measureCapacity({
      probes: probes({ cpu: 4_000, mem: 8_192, disk: 20_480 }),
      reserved: { cpuMillis: 1_500, memoryMiB: 2_048, diskMiB: 4_096 },
      slots: { batch: 1, browser_session: 0, service: 0 },
    });
    expect(capacity.freeCpuMillis).toBe(2_500);
    expect(capacity.freeMemoryMiB).toBe(6_144);
    expect(capacity.freeDiskMiB).toBe(16_384);
  });

  it("clamps free resources to the provider ceiling so the worker never over-advertises", () => {
    const capacity = measureCapacity({
      probes: probes({ cpu: 128_000, mem: 1_000_000, disk: 5_000_000 }),
      reserved: NO_RESERVATION,
      slots: { batch: 1, browser_session: 0, service: 0 },
      ceiling: { cpuMillis: 4_000, memoryMiB: 8_192, diskMiB: 20_480 },
    });
    expect(capacity.freeCpuMillis).toBe(4_000);
    expect(capacity.freeMemoryMiB).toBe(8_192);
    expect(capacity.freeDiskMiB).toBe(20_480);
  });

  it("floors negative free resources at zero (reservations exceed measured free)", () => {
    const capacity = measureCapacity({
      probes: probes({ cpu: 1_000, mem: 512, disk: 256 }),
      reserved: { cpuMillis: 4_000, memoryMiB: 8_192, diskMiB: 20_480 },
      slots: { batch: 1, browser_session: 0, service: 0 },
    });
    expect(capacity.freeCpuMillis).toBe(0);
    expect(capacity.freeMemoryMiB).toBe(0);
    expect(capacity.freeDiskMiB).toBe(0);
  });

  it("reports zero free slots for an exhausted (saturated) workload class", () => {
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    limiter.tryAcquire("batch");
    const capacity = measureCapacity({
      probes: probes({ cpu: 4_000, mem: 8_192, disk: 20_480 }),
      reserved: NO_RESERVATION,
      slots: limiter.snapshot(),
    });
    expect(capacity.batchSlots).toBe(0);
  });

  it("floors fractional/rounded resource readings to non-negative integers the schema accepts", () => {
    const capacity = measureCapacity({
      probes: probes({ cpu: 4_000.7, mem: 8_192.9, disk: 20_480.4 }),
      reserved: NO_RESERVATION,
      slots: { batch: 1, browser_session: 0, service: 0 },
    });
    expect(Number.isInteger(capacity.freeCpuMillis)).toBe(true);
    expect(Number.isInteger(capacity.freeMemoryMiB)).toBe(true);
    expect(Number.isInteger(capacity.freeDiskMiB)).toBe(true);
    expect(workerCapacitySchema.safeParse(capacity).success).toBe(true);
  });
});

describe("sumReservations", () => {
  it("adds the per-lease resource reservations into a single reservation total", () => {
    const total = sumReservations([
      { cpuMillis: 1_000, memoryMiB: 2_048, diskMiB: 4_096 },
      { cpuMillis: 500, memoryMiB: 1_024, diskMiB: 2_048 },
    ]);
    expect(total).toEqual({ cpuMillis: 1_500, memoryMiB: 3_072, diskMiB: 6_144 });
  });

  it("returns a zero reservation for an empty in-flight set", () => {
    expect(sumReservations([])).toEqual({ cpuMillis: 0, memoryMiB: 0, diskMiB: 0 });
  });
});
