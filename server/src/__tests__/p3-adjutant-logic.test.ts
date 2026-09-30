import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/onboarding-assets/adjutant",
);

describe("Adjutant instruction bundle (P3.6)", () => {
  it("HEARTBEAT.md contains advance criteria (pendingItemCount)", async () => {
    const content = await readFile(join(BUNDLE_DIR, "HEARTBEAT.md"), "utf-8");
    expect(content).toContain("pending");
    expect(content).toContain("advance_phase");
    expect(content).toContain("notify_owner");
  });

  it("HEARTBEAT.md documents autonomy branching (≥ 2 / < 2)", async () => {
    const content = await readFile(join(BUNDLE_DIR, "HEARTBEAT.md"), "utf-8");
    expect(content).toContain("autonomy");
    // Both branches must be documented
    expect(content.includes("≥ 2") || content.includes(">= 2")).toBe(true);
    expect(content.includes("< 2")).toBe(true);
  });

  it("AGENTS.md documents allowlist tools including advance_phase and notify_owner", async () => {
    const content = await readFile(join(BUNDLE_DIR, "AGENTS.md"), "utf-8");
    expect(content).toContain("advance_phase");
    expect(content).toContain("notify_owner");
  });

  it("SOUL.md documents quiet-shepherd posture", async () => {
    const content = await readFile(join(BUNDLE_DIR, "SOUL.md"), "utf-8");
    // Must convey "act once and be silent" principle
    expect(content.toLowerCase()).toMatch(/once|silent|quiet/);
    // Must convey autonomy respect
    expect(content.toLowerCase()).toContain("autonomy");
  });
});
