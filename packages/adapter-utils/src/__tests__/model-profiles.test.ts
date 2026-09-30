import { describe, expect, it } from "vitest";
import { findAdapterModelProfile, normalizeAdapterModelProfiles } from "../model-profiles.js";

describe("model profiles", () => {
  it("normalizes duplicate/empty profiles safely", () => {
    const profiles = normalizeAdapterModelProfiles([
      { id: "sonnet", label: "Sonnet", contextWindowTokens: 200_000 },
      { id: "sonnet", label: "Duplicate" },
      { id: "", label: "Empty" },
    ]);
    expect(profiles).toEqual([{ id: "sonnet", label: "Sonnet", contextWindowTokens: 200_000 }]);
  });

  it("finds a profile by id", () => {
    const profiles = normalizeAdapterModelProfiles([{ id: "pro", label: "Pro" }]);
    expect(findAdapterModelProfile(profiles, "pro")?.label).toBe("Pro");
    expect(findAdapterModelProfile(profiles, "missing")).toBeNull();
  });
});
