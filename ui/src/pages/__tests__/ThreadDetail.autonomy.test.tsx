/**
 * ThreadDetail autonomy pill label resolution test.
 *
 * This focuses on verifying that:
 * 1. The shared autonomyLabel function resolves 0→"Manual", 1→"Assist", 2→"Drive", null→"Off"
 * 2. ThreadDetail.tsx imports from "@armyofagents/shared" rather than a local 1/2/3 map
 *
 * A full mount of ThreadDetail is expensive (many providers). We test the label
 * resolution contract directly via the shared function, and then verify the import
 * structure in the source by checking that the legacy mislabels are absent from the
 * module's export surface.
 */
import { describe, it, expect } from "vitest";
import { autonomyLabel, AUTONOMY_LEVELS } from "@armyofagents/shared";

describe("autonomyLabel — canonical 0-2 scale", () => {
  it("0 → 'Manual'", () => {
    expect(autonomyLabel(0)).toBe("Manual");
  });
  it("1 → 'Assist'", () => {
    expect(autonomyLabel(1)).toBe("Assist");
  });
  it("2 → 'Drive'", () => {
    expect(autonomyLabel(2)).toBe("Drive");
  });
  it("null → 'Off'", () => {
    expect(autonomyLabel(null)).toBe("Off");
  });
  it("undefined → 'Off'", () => {
    expect(autonomyLabel(undefined)).toBe("Off");
  });
  it("3 → 'Off' (not 'Semi', not 'Auto' — unknown value)", () => {
    // DB value 3 was the old bug-triggering input; should gracefully degrade to "Off"
    expect(autonomyLabel(3)).toBe("Off");
  });
});

describe("AUTONOMY_LEVELS — canonical shape", () => {
  it("has exactly 3 levels", () => {
    expect(AUTONOMY_LEVELS.length).toBe(3);
  });
  it("values are 0, 1, 2", () => {
    expect(AUTONOMY_LEVELS.map((l) => l.value)).toEqual([0, 1, 2]);
  });
  it("names are Manual, Assist, Drive (NOT Semi/Auto/L1/L2/L3)", () => {
    expect(AUTONOMY_LEVELS.map((l) => l.name)).toEqual(["Manual", "Assist", "Drive"]);
    // Explicitly assert that the old buggy labels are absent
    const names = AUTONOMY_LEVELS.map((l) => l.name);
    expect(names).not.toContain("Semi");
    expect(names).not.toContain("Auto");
  });
});

describe("ThreadDetail.tsx — no legacy 1/2/3 local map", () => {
  it("ThreadDetail module does not export or use the legacy labels 'Semi' or level-3 'Auto'", async () => {
    // Dynamically import the source to verify no forbidden label literals survive
    // We read the raw source text to check for the banned 1/2/3→Semi/Auto mapping.
    // This is intentionally a structural/lint-style assertion baked into the test suite
    // so any reintroduction of the bug fails CI.
    const fs = await import("fs");
    const path = await import("path");
    const srcPath = path.resolve(
      __dirname,
      "../../pages/ThreadDetail.tsx"
    );
    const src = fs.readFileSync(srcPath, "utf-8");

    // The old mapping had `2: { label: "Semi"` and `3: { label: "Auto"` in the AUTONOMY const.
    // Also the picker literal had `[2, "Semi", ...]` and `[3, "Auto", ...]`.
    // All of these must be gone.
    expect(src).not.toMatch(/label:\s*["']Semi["']/);
    expect(src).not.toMatch(/\[\s*2\s*,\s*["']Semi["']/);
    expect(src).not.toMatch(/\[\s*3\s*,\s*["']Auto["']/);
    // The old AUTONOMY const keyed on 1/2/3 — verify the keys 2: and 3: in that context are gone
    // (We look for the old numeric key pattern that indicated a 1-based map)
    expect(src).not.toMatch(/const AUTONOMY[^=]*=\s*\{[^}]*3\s*:/);
  });
});
