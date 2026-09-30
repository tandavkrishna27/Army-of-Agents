import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIVERSE_PREFERENCES,
  UNIVERSE_PREFERENCE_SECTIONS,
  resolveUniversePreferences,
  universePreferencePatchSchema,
  universePreferenceResetSchema,
  universePreferencesSchema,
} from "../validators/universe-preferences.js";

const preferenceKeys = [
  "theme", "density", "motion", "dockPlacement", "dockHiding", "commanderPlacement",
  "conversationPresentation", "blobVisibility", "chatVisibility", "captions", "captionSize",
  "captionPlacement", "restoreWorkspace", "openPanelPreviews", "attentionPreviews", "accent",
  "blobStyle", "blobColor", "grid", "gridIntensity", "snapToGrid", "arrangement",
  "voiceConnectionId", "voiceId", "language", "spokenLength", "personalVoiceInstructions",
  "soundEffects", "spokenAnnouncements", "browserViewQuality",
] as const;

describe("universePreferencesSchema", () => {
  it("accepts the complete default contract and rejects unknown fields", () => {
    expect(universePreferencesSchema.safeParse(DEFAULT_UNIVERSE_PREFERENCES).success).toBe(true);
    expect(universePreferencesSchema.safeParse({ ...DEFAULT_UNIVERSE_PREFERENCES, future: true }).success).toBe(false);
  });

  it("enforces UUID, text length, and finite grid intensity boundaries", () => {
    expect(universePreferencesSchema.safeParse({ ...DEFAULT_UNIVERSE_PREFERENCES, voiceConnectionId: "not-a-uuid" }).success).toBe(false);
    expect(universePreferencesSchema.safeParse({ ...DEFAULT_UNIVERSE_PREFERENCES, voiceId: "v".repeat(101) }).success).toBe(false);
    expect(universePreferencesSchema.safeParse({ ...DEFAULT_UNIVERSE_PREFERENCES, language: "l".repeat(101) }).success).toBe(false);
    expect(universePreferencesSchema.safeParse({ ...DEFAULT_UNIVERSE_PREFERENCES, personalVoiceInstructions: "i".repeat(2001) }).success).toBe(false);
    for (const gridIntensity of [Number.NaN, Number.POSITIVE_INFINITY, -0.001, 0.301]) {
      expect(universePreferencesSchema.safeParse({ ...DEFAULT_UNIVERSE_PREFERENCES, gridIntensity }).success).toBe(false);
    }
    for (const gridIntensity of [0, 0.3]) {
      expect(universePreferencesSchema.safeParse({ ...DEFAULT_UNIVERSE_PREFERENCES, gridIntensity }).success).toBe(true);
    }
  });
});

describe("preference write schemas", () => {
  it("accepts a strict non-empty patch with a safe nonnegative revision", () => {
    expect(universePreferencePatchSchema.safeParse({ schemaVersion: 1, baseRevision: 0, patch: { theme: "dark" } }).success).toBe(true);
    for (const baseRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(universePreferencePatchSchema.safeParse({ schemaVersion: 1, baseRevision, patch: { theme: "dark" } }).success).toBe(false);
    }
    expect(universePreferencePatchSchema.safeParse({ schemaVersion: 1, baseRevision: 0, patch: {} }).success).toBe(false);
    expect(universePreferencePatchSchema.safeParse({ schemaVersion: 1, baseRevision: 0, patch: { theme: undefined } }).success).toBe(false);
    expect(universePreferencePatchSchema.safeParse({ schemaVersion: 1, baseRevision: 0, patch: { theme: "dark", future: true } }).success).toBe(false);
    expect(universePreferencePatchSchema.safeParse({ schemaVersion: 1, baseRevision: 0, patch: { theme: "dark" }, future: true }).success).toBe(false);
  });

  it("accepts only strict resets with a safe revision and known section", () => {
    expect(universePreferenceResetSchema.safeParse({ baseRevision: 4, section: "voice" }).success).toBe(true);
    expect(universePreferenceResetSchema.safeParse({ baseRevision: Number.MAX_SAFE_INTEGER, section: "browser" }).success).toBe(true);
    expect(universePreferenceResetSchema.safeParse({ baseRevision: Number.MAX_SAFE_INTEGER + 1, section: "browser" }).success).toBe(false);
    expect(universePreferenceResetSchema.safeParse({ baseRevision: 4, section: "other" }).success).toBe(false);
    expect(universePreferenceResetSchema.safeParse({ baseRevision: 4, section: "voice", extra: true }).success).toBe(false);
  });
});

describe("preference resolution and sections", () => {
  it("returns fresh resolved values and validates the runtime boundary", () => {
    const first = resolveUniversePreferences({ theme: "dark" });
    const second = resolveUniversePreferences({ theme: "dark" });
    expect(first).toEqual({ ...DEFAULT_UNIVERSE_PREFERENCES, theme: "dark" });
    expect(first).not.toBe(second);
    expect(Object.isFrozen(DEFAULT_UNIVERSE_PREFERENCES)).toBe(true);
    expect(() => resolveUniversePreferences({ theme: undefined } as never)).toThrow();
    expect(() => resolveUniversePreferences({ future: true } as never)).toThrow();
  });

  it("assigns every preference key to exactly one exact section", () => {
    expect(UNIVERSE_PREFERENCE_SECTIONS).toEqual({
      appearance: ["theme", "density", "motion", "accent", "blobStyle", "blobColor", "grid", "gridIntensity"],
      workspace: ["dockPlacement", "dockHiding", "commanderPlacement", "conversationPresentation", "blobVisibility", "chatVisibility", "captions", "captionSize", "captionPlacement", "restoreWorkspace", "openPanelPreviews", "attentionPreviews", "snapToGrid", "arrangement"],
      voice: ["voiceConnectionId", "voiceId", "language", "spokenLength", "personalVoiceInstructions", "soundEffects", "spokenAnnouncements"],
      browser: ["browserViewQuality"],
    });
    const memberships = Object.values(UNIVERSE_PREFERENCE_SECTIONS).flat();
    expect(memberships.sort()).toEqual([...preferenceKeys].sort());
    expect(new Set(memberships).size).toBe(preferenceKeys.length);
  });

  it("supports resetting only the keys in the selected section", () => {
    const overrides = Object.fromEntries(preferenceKeys.map((key) => [key, DEFAULT_UNIVERSE_PREFERENCES[key]]));
    for (const keys of Object.values(UNIVERSE_PREFERENCE_SECTIONS)) {
      const reset = { ...overrides };
      for (const key of keys) delete reset[key];
      expect(Object.keys(reset).sort()).toEqual(preferenceKeys.filter((key) => !keys.includes(key)).sort());
    }
  });
});
