import { describe, expect, it } from "vitest";
import {
  ADAPTER_SESSION_MANAGEMENT,
  getAdapterSessionManagement,
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
} from "../session-compaction.js";

describe("adapter-utils session compaction", () => {
  it("returns null for unknown or non-sessioned adapters", () => {
    expect(getAdapterSessionManagement(null)).toBeNull();
    expect(getAdapterSessionManagement(undefined)).toBeNull();
    expect(getAdapterSessionManagement("process")).toBeNull();
  });

  it("returns declared defaults for sessioned built-ins", () => {
    expect(getAdapterSessionManagement("claude_local")?.supportsSessionResume).toBe(true);
    expect(getAdapterSessionManagement("gemini_local")?.supportsSessionResume).toBe(true);
    expect(getAdapterSessionManagement("opencode_local")?.supportsSessionResume).toBe(true);
  });

  it("resolves runtime overrides without losing adapter defaults", () => {
    const resolved = resolveSessionCompactionPolicy("gemini_local", {
      heartbeat: { sessionCompaction: { maxSessionRuns: 42 } },
    });
    expect(resolved.source).toBe("agent_override");
    expect(resolved.policy.maxSessionRuns).toBe(42);
    expect(resolved.policy.maxRawInputTokens).toBe(2_000_000);
  });

  it("keeps native-managed adapters threshold-free by default", () => {
    const resolved = resolveSessionCompactionPolicy("claude_local", {});
    expect(resolved.source).toBe("adapter_default");
    expect(hasSessionCompactionThresholds(resolved.policy)).toBe(false);
  });

  it("pins known session-management map entries", () => {
    expect(ADAPTER_SESSION_MANAGEMENT.claude_local).toBeDefined();
    expect(ADAPTER_SESSION_MANAGEMENT.gemini_local).toBeDefined();
    expect(ADAPTER_SESSION_MANAGEMENT.opencode_local).toBeDefined();
  });
});
