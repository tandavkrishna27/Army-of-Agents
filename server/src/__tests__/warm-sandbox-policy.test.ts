import { describe, expect, it } from "vitest";
import { readAgentWarmOverride, resolveWarmSandboxPreference } from "../services/warm-sandbox-policy.js";

/**
 * Full truth table from spec §7 for the warm-sandbox decision. This resolver
 * is the ONLY place org/crew/Commander are allowed to decide warm-vs-ephemeral
 * so the three call sites cannot drift. Crew and Commander are hard-wired
 * ephemeral — no input combination may flip them warm (Wave 6 design invariant).
 */
describe("resolveWarmSandboxPreference", () => {
  const base = { instanceDefaultWarmForSoftwareDev: true };

  it("org software_development defaults warm", () => {
    expect(
      resolveWarmSandboxPreference({
        ...base,
        runType: "org",
        functionType: "software_development",
        agentWarmOverride: null,
      }).warm,
    ).toBe(true);
  });

  it("org non-software_development is ephemeral", () => {
    expect(
      resolveWarmSandboxPreference({
        ...base,
        runType: "org",
        functionType: "marketing",
        agentWarmOverride: null,
      }).warm,
    ).toBe(false);
  });

  it("per-agent override forces warm off for a software_development org agent", () => {
    expect(
      resolveWarmSandboxPreference({
        ...base,
        runType: "org",
        functionType: "software_development",
        agentWarmOverride: false,
      }).warm,
    ).toBe(false);
  });

  it("per-agent override forces warm on for a non-software_development org agent", () => {
    expect(
      resolveWarmSandboxPreference({
        ...base,
        runType: "org",
        functionType: "marketing",
        agentWarmOverride: true,
      }).warm,
    ).toBe(true);
  });

  it("instance default off suppresses the type default", () => {
    expect(
      resolveWarmSandboxPreference({
        instanceDefaultWarmForSoftwareDev: false,
        runType: "org",
        functionType: "software_development",
        agentWarmOverride: null,
      }).warm,
    ).toBe(false);
  });

  it("CREW is ALWAYS ephemeral — override cannot make it warm", () => {
    const r = resolveWarmSandboxPreference({
      ...base,
      runType: "crew",
      functionType: "software_development",
      agentWarmOverride: true,
    });
    expect(r.warm).toBe(false);
    expect(r.reason).toBe("crew_always_ephemeral");
  });

  it("Commander is warm when warmCommanderConversations is true (default)", () => {
    expect(
      resolveWarmSandboxPreference({
        runType: "commander",
        functionType: null,
        agentWarmOverride: null,
        instanceDefaultWarmForSoftwareDev: true,
        warmCommanderConversations: true,
      }),
    ).toEqual({ warm: true, reason: "commander_warm_conversation" });
  });

  it("Commander is warm by default when the toggle is omitted (default-true on cloud)", () => {
    expect(
      resolveWarmSandboxPreference({
        runType: "commander",
        functionType: null,
        agentWarmOverride: null,
        instanceDefaultWarmForSoftwareDev: true,
      }).warm,
    ).toBe(true);
  });

  it("Commander is ephemeral when warmCommanderConversations is false", () => {
    expect(
      resolveWarmSandboxPreference({
        runType: "commander",
        functionType: null,
        agentWarmOverride: null,
        instanceDefaultWarmForSoftwareDev: true,
        warmCommanderConversations: false,
      }),
    ).toEqual({ warm: false, reason: "commander_warm_disabled" });
  });

  it("CREW stays ALWAYS ephemeral — the commander toggle cannot flip it", () => {
    expect(
      resolveWarmSandboxPreference({
        runType: "crew",
        functionType: "software_development",
        agentWarmOverride: true,
        instanceDefaultWarmForSoftwareDev: true,
        warmCommanderConversations: true,
      }),
    ).toEqual({ warm: false, reason: "crew_always_ephemeral" });
  });
});

describe("readAgentWarmOverride", () => {
  it("reads a true override from runtimeConfig.warmWorkspace", () => {
    expect(readAgentWarmOverride({ warmWorkspace: true })).toBe(true);
  });

  it("reads a false override from runtimeConfig.warmWorkspace", () => {
    expect(readAgentWarmOverride({ warmWorkspace: false })).toBe(false);
  });

  it("returns null when unset", () => {
    expect(readAgentWarmOverride({})).toBeNull();
  });

  it("returns null for non-object runtimeConfig", () => {
    expect(readAgentWarmOverride(null)).toBeNull();
    expect(readAgentWarmOverride(undefined)).toBeNull();
  });

  it("returns null when the field is present but not a boolean", () => {
    expect(readAgentWarmOverride({ warmWorkspace: "yes" })).toBeNull();
  });
});
