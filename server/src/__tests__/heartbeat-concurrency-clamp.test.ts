import { describe, it, expect } from "vitest";
import {
  normalizeMaxConcurrentRuns,
  HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT,
  HEARTBEAT_MAX_CONCURRENT_RUNS_MAX,
} from "../services/heartbeat.js";

describe("normalizeMaxConcurrentRuns", () => {
  it("clamps to DEFAULT (1) when value is 0", () => {
    expect(normalizeMaxConcurrentRuns(0)).toBe(1);
  });

  it("clamps to DEFAULT (1) for negative values", () => {
    expect(normalizeMaxConcurrentRuns(-5)).toBe(1);
  });

  it("returns DEFAULT (1) for non-numeric input", () => {
    expect(normalizeMaxConcurrentRuns("abc")).toBe(1);
    expect(normalizeMaxConcurrentRuns(null)).toBe(1);
    expect(normalizeMaxConcurrentRuns(undefined)).toBe(1);
  });

  it("allows values between 1 and MAX inclusive", () => {
    expect(normalizeMaxConcurrentRuns(1)).toBe(1);
    expect(normalizeMaxConcurrentRuns(5)).toBe(5);
    expect(normalizeMaxConcurrentRuns(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX)).toBe(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX);
  });

  it("clamps values above MAX to MAX", () => {
    expect(normalizeMaxConcurrentRuns(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX + 1)).toBe(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX);
    expect(normalizeMaxConcurrentRuns(9999)).toBe(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX);
  });

  it("MAX is 50 (D5: raised from 10 to support founding teams with 3-5 concurrent agents)", () => {
    expect(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX).toBe(50);
  });

  it("DEFAULT is 1 (teaching default — founding teams opt-up per-agent)", () => {
    expect(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT).toBe(1);
  });
});
