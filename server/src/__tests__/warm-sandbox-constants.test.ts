import { describe, expect, it } from "vitest";
import {
  WARM_SANDBOX_IDLE_TTL_MINUTES_DEFAULT,
  WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT,
  normalizeWarmIdleTtlMinutes,
} from "../services/warm-sandbox-constants.js";

describe("warm-sandbox constants", () => {
  it("defaults the per-company warm cap", () => {
    expect(WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT).toBe(5);
  });

  it("defaults the idle TTL constant to 30 minutes", () => {
    expect(WARM_SANDBOX_IDLE_TTL_MINUTES_DEFAULT).toBe(30);
  });
});

describe("normalizeWarmIdleTtlMinutes", () => {
  it("defaults warm idle TTL to 30 minutes when undefined", () => {
    expect(normalizeWarmIdleTtlMinutes(undefined)).toBe(30);
  });

  it("falls back to the default for falsy/zero input", () => {
    expect(normalizeWarmIdleTtlMinutes(0)).toBe(30);
  });

  it("falls back to the default for negative input", () => {
    expect(normalizeWarmIdleTtlMinutes(-5)).toBe(30);
  });

  it("falls back to the default for non-numeric input", () => {
    expect(normalizeWarmIdleTtlMinutes("not-a-number")).toBe(30);
    expect(normalizeWarmIdleTtlMinutes(null)).toBe(30);
  });

  it("clamps to the 24h cap for very large values", () => {
    expect(normalizeWarmIdleTtlMinutes(100000)).toBe(1440);
  });

  it("passes through valid values within range", () => {
    expect(normalizeWarmIdleTtlMinutes(45)).toBe(45);
    expect(normalizeWarmIdleTtlMinutes(1)).toBe(1);
    expect(normalizeWarmIdleTtlMinutes(1440)).toBe(1440);
  });
});
