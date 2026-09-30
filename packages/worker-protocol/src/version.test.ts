import { describe, expect, it } from "vitest";
import { negotiateProtocolVersion } from "./version.js";

describe("protocol version negotiation", () => {
  it("chooses the highest overlapping version", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 3 }, { min: 2, max: 4 })).toBe(3);
  });
  it("negotiates an N-1 range for a safe additive rollout (not the frozen-consumer proof)", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 2 }, { min: 1, max: 1 })).toBe(1);
  });
  it("returns null without overlap", () => {
    expect(negotiateProtocolVersion({ min: 2, max: 3 }, { min: 1, max: 1 })).toBeNull();
  });
  it("returns the single common version when ranges touch at one point", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 2 }, { min: 2, max: 3 })).toBe(2);
  });
  it("returns the shared max for identical ranges", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 1 }, { min: 1, max: 1 })).toBe(1);
  });
  it("returns null when the worker is strictly below the control plane", () => {
    expect(negotiateProtocolVersion({ min: 3, max: 5 }, { min: 1, max: 2 })).toBeNull();
  });
});
