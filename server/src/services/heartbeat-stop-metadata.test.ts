import { describe, expect, it } from "vitest";

import {
  buildHeartbeatRunStopMetadata,
  inferHeartbeatRunStopReason,
  mergeHeartbeatRunStopMetadata,
  normalizeMaxTurnStopReason,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  it("normalizes max-turn stop reasons", () => {
    expect(normalizeMaxTurnStopReason("max_turns_exhausted")).toBe("max_turns_exhausted");
    expect(normalizeMaxTurnStopReason("turn_limit_exhausted")).toBe("max_turns_exhausted");
    expect(normalizeMaxTurnStopReason("adapter_failed")).toBeNull();
  });

  it("infers stop reasons from run outcomes", () => {
    expect(inferHeartbeatRunStopReason({ outcome: "succeeded" })).toBe("completed");
    expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: "adapter_failed" })).toBe("adapter_failed");
    expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: "max_turns_exhausted" })).toBe(
      "max_turns_exhausted",
    );
    expect(inferHeartbeatRunStopReason({ outcome: "cancelled", errorMessage: "Cancelled due to budget hard-stop" })).toBe(
      "budget_paused",
    );
  });

  it("keeps AoA adapters without default timeout unless configured", () => {
    expect(resolveHeartbeatRunTimeoutPolicy("claude-local", {})).toEqual({
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutSource: "default",
    });
    expect(resolveHeartbeatRunTimeoutPolicy("claude-local", { timeoutSec: 45 })).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
    });
  });

  it("merges stop metadata while preserving adapter max-turn classification", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "claude-local",
      adapterConfig: {},
      outcome: "failed",
      errorCode: "adapter_failed",
    });

    expect(mergeHeartbeatRunStopMetadata({ stopReason: "turn_limit_exhausted", result: "needs more work" }, metadata)).toEqual({
      stopReason: "max_turns_exhausted",
      result: "needs more work",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});
