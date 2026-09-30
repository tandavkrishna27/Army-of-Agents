// server/src/__tests__/heartbeat-execution-target-routing.test.ts
import { describe, expect, it } from "vitest";
import { mergeResolvedExecutionTarget } from "../services/heartbeat-execution-target.js";

describe("mergeResolvedExecutionTarget", () => {
  it("overrides config.executionTarget when a routed target maps to an adapter config", () => {
    const merged = mergeResolvedExecutionTarget({ env: { X: "1" } }, {
      type: "sandbox-docker", image: "aoa/agent-base:latest", runtime: "runsc", network: "none", isolation: {},
    });
    expect((merged.executionTarget as Record<string, unknown>).runtime).toBe("runsc");
    expect(merged.env).toEqual({ X: "1" });
  });
  it("leaves config untouched when routed target is null (local fallback)", () => {
    const cfg = { env: {}, executionTarget: { type: "local" } };
    expect(mergeResolvedExecutionTarget(cfg, null)).toBe(cfg);
  });
});
