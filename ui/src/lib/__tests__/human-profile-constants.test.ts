import { describe, it, expect } from "vitest";
import {
  HUMAN_TITLE_OPTIONS,
  FALLBACK_TIMEZONE_OPTIONS,
  getTimezoneOptions,
} from "../human-profile-constants";

describe("human-profile-constants (shared between HumanDetail + onboarding)", () => {
  it("keeps the curated title options", () => {
    expect(HUMAN_TITLE_OPTIONS).toContain("Founder");
    expect(HUMAN_TITLE_OPTIONS).toContain("Engineer");
    expect(HUMAN_TITLE_OPTIONS).toContain("Advisor");
    expect(HUMAN_TITLE_OPTIONS.length).toBeGreaterThanOrEqual(28);
  });

  it("getTimezoneOptions is the full IANA set unioned with fallbacks, sorted + deduped", () => {
    const options = getTimezoneOptions();
    expect(options).toContain("UTC");
    for (const tz of FALLBACK_TIMEZONE_OPTIONS) expect(options).toContain(tz);
    expect(new Set(options).size).toBe(options.length); // deduped
    const sorted = [...options].sort((a, b) => a.localeCompare(b));
    expect(options).toEqual(sorted);
  });
});
