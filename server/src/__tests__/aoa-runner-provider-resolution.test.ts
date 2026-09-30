// server/src/__tests__/aoa-runner-provider-resolution.test.ts
import { describe, it, expect } from "vitest";
import { applyResolvedCredential } from "../services/provider-resolution.js";

describe("crew applies resolved credential onto config.env", () => {
  it("connection patch merges over resolved base env", () => {
    const cfg = { env: { FOO: "bar" }, model: "opus" };
    const out = applyResolvedCredential(cfg, {
      source: "connection",
      connectionId: "c1",
      authMethod: "personal_subscription",
      sharingScope: "owner_only",
      envPatch: { HOME: "/h", CLAUDE_CONFIG_DIR: "/h/anthropic" },
      provenance: { scopeType: "agent_override", ownerUserId: "u1", executionTargetId: "t1" },
    });
    expect(out).toEqual({
      env: { FOO: "bar", HOME: "/h", CLAUDE_CONFIG_DIR: "/h/anthropic" },
      model: "opus",
    });
  });
  it("agent_env_override is a no-op", () => {
    const cfg = { env: { ANTHROPIC_API_KEY: "sk" } };
    expect(applyResolvedCredential(cfg, { source: "agent_env_override" })).toBe(cfg);
  });
});
