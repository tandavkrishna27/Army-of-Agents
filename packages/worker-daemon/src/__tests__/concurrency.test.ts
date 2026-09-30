import { describe, expect, it } from "vitest";

import { ConcurrencyLimiter, WORKLOAD_CLASSES } from "../poll/concurrency.js";

describe("ConcurrencyLimiter", () => {
  it("reports the configured limit as free when nothing is in flight", () => {
    const limiter = new ConcurrencyLimiter({ batch: 3, browser_session: 1, service: 0 });
    expect(limiter.freeSlots("batch")).toBe(3);
    expect(limiter.freeSlots("browser_session")).toBe(1);
    expect(limiter.freeSlots("service")).toBe(0);
    expect(limiter.snapshot()).toEqual({ batch: 3, browser_session: 1, service: 0 });
  });

  it("decrements free slots on acquire and restores them on release", () => {
    const limiter = new ConcurrencyLimiter({ batch: 2, browser_session: 0, service: 0 });
    expect(limiter.tryAcquire("batch")).toBe(true);
    expect(limiter.freeSlots("batch")).toBe(1);
    expect(limiter.inFlight("batch")).toBe(1);
    expect(limiter.tryAcquire("batch")).toBe(true);
    expect(limiter.freeSlots("batch")).toBe(0);
    limiter.release("batch");
    expect(limiter.freeSlots("batch")).toBe(1);
  });

  it("blocks acquisition for a saturated workload class (zero free slots = backpressure)", () => {
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    expect(limiter.tryAcquire("batch")).toBe(true);
    expect(limiter.isSaturated("batch")).toBe(true);
    // A saturated class refuses further acquisition.
    expect(limiter.tryAcquire("batch")).toBe(false);
    expect(limiter.freeSlots("batch")).toBe(0);
    // A zero-limit class is saturated from the start.
    expect(limiter.isSaturated("service")).toBe(true);
    expect(limiter.tryAcquire("service")).toBe(false);
  });

  it("releasing a completed lease re-opens the slot for polling", () => {
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    expect(limiter.tryAcquire("batch")).toBe(true);
    expect(limiter.hasAnyFreeSlot()).toBe(false);
    limiter.release("batch");
    expect(limiter.hasAnyFreeSlot()).toBe(true);
    expect(limiter.tryAcquire("batch")).toBe(true);
  });

  it("never drives in-flight below zero on an over-release", () => {
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 0, service: 0 });
    limiter.release("batch");
    expect(limiter.inFlight("batch")).toBe(0);
    expect(limiter.freeSlots("batch")).toBe(1);
  });

  it("hasAnyFreeSlot is false only when every class is saturated", () => {
    const limiter = new ConcurrencyLimiter({ batch: 1, browser_session: 1, service: 0 });
    expect(limiter.hasAnyFreeSlot()).toBe(true);
    limiter.tryAcquire("batch");
    expect(limiter.hasAnyFreeSlot()).toBe(true); // browser_session still free
    limiter.tryAcquire("browser_session");
    expect(limiter.hasAnyFreeSlot()).toBe(false);
  });

  it("exposes the three closed workload classes", () => {
    expect([...WORKLOAD_CLASSES].sort()).toEqual(["batch", "browser_session", "service"]);
  });
});
