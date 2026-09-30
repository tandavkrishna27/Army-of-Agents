import { describe, it, expect } from "vitest";
import {
  PLUGIN_CAPABILITIES,
  CAPABILITY_DESCRIPTIONS,
  LIVE_EVENT_TYPES,
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_DIGEST_CADENCES,
} from "../constants.js";
import type { PluginCapability } from "../constants.js";

describe("CAPABILITY_DESCRIPTIONS", () => {
  it("has a description for every capability in PLUGIN_CAPABILITIES", () => {
    for (const cap of PLUGIN_CAPABILITIES) {
      expect(
        CAPABILITY_DESCRIPTIONS[cap],
        `Missing description for capability: ${cap}`
      ).toBeTruthy();
    }
  });

  it("has no extra keys beyond PLUGIN_CAPABILITIES", () => {
    const capSet = new Set<string>(PLUGIN_CAPABILITIES);
    for (const key of Object.keys(CAPABILITY_DESCRIPTIONS)) {
      expect(capSet.has(key), `Unexpected key in CAPABILITY_DESCRIPTIONS: ${key}`).toBe(true);
    }
  });
});

describe("W2-L3 notification contracts", () => {
  it("includes metadata-only hub live event types", () => {
    expect(LIVE_EVENT_TYPES).toContain("hub.item.changed");
    expect(LIVE_EVENT_TYPES).toContain("hub.counts.changed");
    expect(LIVE_EVENT_TYPES).toContain("hub.digest.changed");
  });

  it("exposes notification preference modes and digest cadences", () => {
    expect(NOTIFICATION_PREFERENCES).toEqual(["silent", "digest", "realtime"]);
    expect(NOTIFICATION_DIGEST_CADENCES).toEqual(["daily"]);
  });
});
