import { describe, expect, it } from "vitest";
import {
  ADAPTER_SESSION_MANAGEMENT,
  LEGACY_SESSIONED_ADAPTER_TYPES,
  getAdapterSessionManagement,
  hasSessionCompactionThresholds,
  readSessionCompactionOverride,
  resolveSessionCompactionPolicy,
} from "@armyofagents/adapter-utils";

describe("getAdapterSessionManagement", () => {
  it("returns null for null or unknown adapter", () => {
    expect(getAdapterSessionManagement(null)).toBeNull();
    expect(getAdapterSessionManagement(undefined)).toBeNull();
    expect(getAdapterSessionManagement("process")).toBeNull();
  });

  it("returns declared management for known adapter", () => {
    const mgmt = getAdapterSessionManagement("claude_local");
    expect(mgmt).not.toBeNull();
    expect(mgmt?.supportsSessionResume).toBe(true);
    expect(mgmt?.nativeContextManagement).toBe("confirmed");
  });
});

describe("readSessionCompactionOverride", () => {
  it("returns empty when no override present", () => {
    expect(readSessionCompactionOverride(undefined)).toEqual({});
    expect(readSessionCompactionOverride(null)).toEqual({});
    expect(readSessionCompactionOverride({})).toEqual({});
  });

  it("reads nested runtime.heartbeat.sessionCompaction", () => {
    const override = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: 42 } },
    });
    expect(override).toEqual({ maxSessionRuns: 42 });
  });

  it("falls back to legacy runtime.heartbeat.sessionRotation key", () => {
    const override = readSessionCompactionOverride({
      heartbeat: { sessionRotation: { maxRawInputTokens: 1_500_000 } },
    });
    expect(override).toEqual({ maxRawInputTokens: 1_500_000 });
  });

  it("reads top-level runtime.sessionCompaction", () => {
    const override = readSessionCompactionOverride({
      sessionCompaction: { maxSessionAgeHours: 24, enabled: false },
    });
    expect(override).toEqual({ maxSessionAgeHours: 24, enabled: false });
  });

  it("coerces stringified numbers and booleans", () => {
    const override = readSessionCompactionOverride({
      heartbeat: {
        sessionCompaction: {
          enabled: "true",
          maxSessionRuns: "50",
          maxRawInputTokens: "1000000",
          maxSessionAgeHours: "12",
        },
      },
    });
    expect(override).toEqual({
      enabled: true,
      maxSessionRuns: 50,
      maxRawInputTokens: 1_000_000,
      maxSessionAgeHours: 12,
    });
  });

  it("ignores invalid values rather than raising", () => {
    const override = readSessionCompactionOverride({
      heartbeat: { sessionCompaction: { maxSessionRuns: "not-a-number" } },
    });
    expect(override).toEqual({});
  });
});

describe("resolveSessionCompactionPolicy", () => {
  it("returns disabled legacy_fallback for non-sessioned adapter", () => {
    const resolved = resolveSessionCompactionPolicy("process", {});
    expect(resolved.policy.enabled).toBe(false);
    expect(resolved.source).toBe("legacy_fallback");
    expect(resolved.adapterSessionManagement).toBeNull();
  });

  it("returns enabled + native-managed zeros for claude_local default", () => {
    const resolved = resolveSessionCompactionPolicy("claude_local", {});
    expect(resolved.policy.enabled).toBe(true);
    expect(resolved.policy.maxSessionRuns).toBe(0);
    expect(resolved.policy.maxRawInputTokens).toBe(0);
    expect(resolved.policy.maxSessionAgeHours).toBe(0);
    expect(resolved.source).toBe("adapter_default");
    expect(resolved.adapterSessionManagement?.nativeContextManagement).toBe("confirmed");
    // Native-managed adapters set thresholds to 0 so AoA never rotates them.
    expect(hasSessionCompactionThresholds(resolved.policy)).toBe(false);
  });

  it("returns non-zero thresholds for gemini_local default", () => {
    const resolved = resolveSessionCompactionPolicy("gemini_local", {});
    expect(resolved.policy.enabled).toBe(true);
    expect(resolved.policy.maxSessionRuns).toBe(200);
    expect(resolved.policy.maxRawInputTokens).toBe(2_000_000);
    expect(resolved.policy.maxSessionAgeHours).toBe(72);
    expect(resolved.source).toBe("adapter_default");
    expect(hasSessionCompactionThresholds(resolved.policy)).toBe(true);
  });

  it("respects runtimeConfig overrides and reports agent_override", () => {
    const resolved = resolveSessionCompactionPolicy("gemini_local", {
      heartbeat: { sessionCompaction: { maxSessionRuns: 42 } },
    });
    expect(resolved.policy.maxSessionRuns).toBe(42);
    expect(resolved.policy.maxRawInputTokens).toBe(2_000_000); // inherited
    expect(resolved.source).toBe("agent_override");
    expect(resolved.explicitOverride).toEqual({ maxSessionRuns: 42 });
  });

  it("override can disable a native-managed adapter", () => {
    const resolved = resolveSessionCompactionPolicy("claude_local", {
      heartbeat: { sessionCompaction: { enabled: false } },
    });
    expect(resolved.policy.enabled).toBe(false);
    expect(resolved.source).toBe("agent_override");
  });
});

describe("hasSessionCompactionThresholds", () => {
  it("returns false when all thresholds are zero", () => {
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      }),
    ).toBe(false);
  });

  it("returns true when any threshold is positive", () => {
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 1,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 0,
      }),
    ).toBe(true);
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 1,
        maxSessionAgeHours: 0,
      }),
    ).toBe(true);
    expect(
      hasSessionCompactionThresholds({
        maxSessionRuns: 0,
        maxRawInputTokens: 0,
        maxSessionAgeHours: 1,
      }),
    ).toBe(true);
  });
});

describe("ADAPTER_SESSION_MANAGEMENT + LEGACY_SESSIONED_ADAPTER_TYPES", () => {
  it("every LEGACY_SESSIONED_ADAPTER_TYPES entry is declared or intentionally absent", () => {
    // These constants share adapter identifiers; they can drift when new
    // adapters are added. This test pins current state so a future rename
    // is intentional.
    expect(LEGACY_SESSIONED_ADAPTER_TYPES).toContain("claude_local");
    expect(LEGACY_SESSIONED_ADAPTER_TYPES).toContain("gemini_local");
    expect(LEGACY_SESSIONED_ADAPTER_TYPES).toContain("opencode_local");
    expect(ADAPTER_SESSION_MANAGEMENT.claude_local).toBeDefined();
    expect(ADAPTER_SESSION_MANAGEMENT.gemini_local).toBeDefined();
    expect(ADAPTER_SESSION_MANAGEMENT.opencode_local).toBeDefined();
  });
});
