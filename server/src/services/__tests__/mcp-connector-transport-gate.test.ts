import { describe, it, expect } from "vitest";
import { isTransportAllowed } from "../mcp-connector-transport-gate.js";

describe("isTransportAllowed — sandbox axis (U11)", () => {
  it("admits stdio on cloud_auth ONLY when the run targets a sandbox", () => {
    // baseline (unchanged): stdio refused on a shared host without a sandbox
    expect(isTransportAllowed("stdio", "cloud_auth", "byo", undefined, false)).toBe(false);
    // U11: same connector, but this run executes inside a per-run sandbox
    expect(isTransportAllowed("stdio", "cloud_auth", "byo", undefined, true)).toBe(true);
  });
  it("does NOT weaken http (always allowed) or local_trusted (already allowed)", () => {
    expect(isTransportAllowed("http", "cloud_auth", "byo", undefined, false)).toBe(true);
    expect(isTransportAllowed("stdio", "local_trusted", "byo", undefined, false)).toBe(true);
  });
  it("sandboxTarget is additive, never a denylist — verified catalog still passes without it", () => {
    expect(isTransportAllowed("stdio", "cloud_auth", "catalog", "verified", false)).toBe(true);
  });
});
