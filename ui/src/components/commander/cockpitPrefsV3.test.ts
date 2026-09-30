import { describe, expect, it } from "vitest";
import {
  DEFAULT_COCKPIT_PREFS_V3,
  isCockpitSourceVisible,
  migrateLegacyCockpitPrefs,
  parseCockpitPrefsV3,
} from "./cockpitPrefsV3";

describe("Cockpit preference v3 migration", () => {
  it("maps old card order into fixed sections without making section order editable", () => {
    const prefs = migrateLegacyCockpitPrefs({
      hidden: ["review", "memory"],
      enabled: ["budgetPulse"],
      order: ["memory", "myTasks", "budgetPulse", "discussions", "review"],
    });

    expect(prefs).toEqual({
      version: 3,
      sourceVisibility: { review: false, memory: false, budgetPulse: true },
      orderBySection: {
        my_work: ["myTasks", "review"],
        conversations: ["discussions"],
        company_overview: ["budgetPulse"],
        context: ["memory"],
      },
    });
  });

  it("is idempotent for valid v3 preferences", () => {
    const value = {
      version: 3 as const,
      sourceVisibility: { memory: false },
      orderBySection: { context: ["pinned", "memory"] },
    };
    expect(parseCockpitPrefsV3(value)).toEqual({ prefs: value, migrated: false, valid: true });
  });

  it("falls back safely without overwriting unknown or malformed versions", () => {
    expect(parseCockpitPrefsV3({ version: 99, hidden: ["memory"] })).toEqual({
      prefs: DEFAULT_COCKPIT_PREFS_V3,
      migrated: false,
      valid: false,
    });
    expect(parseCockpitPrefsV3("bad").valid).toBe(false);
  });

  it("never lets a saved preference suppress a required action", () => {
    const prefs = migrateLegacyCockpitPrefs({ hidden: ["inbox"] });
    expect(isCockpitSourceVisible(prefs, "inbox", true, false)).toBe(false);
    expect(isCockpitSourceVisible(prefs, "inbox", true, true)).toBe(true);
  });
});
