import { describe, expect, it, vi } from "vitest";
import {
  commanderManifestRequirements,
  runCommanderGateSteps,
  validateCommanderExecutionManifest,
  type CommanderTestExecutionManifest,
} from "../testing/commander-execution.js";

describe("runCommanderGateSteps", () => {
  it.each([0, 1, 2])("preserves a failure at child position %i and stops later work", async (failureIndex) => {
    const calls: number[] = [];
    const result = await runCommanderGateSteps(
      [0, 1, 2].map((index) => ({
        id: `step-${index}`,
        layer: "unit",
        run: async () => {
          calls.push(index);
          return index === failureIndex ? 7 : 0;
        },
      })),
      async () => 0,
    );

    expect(result.exitCode).toBe(7);
    expect(calls).toEqual([0, 1, 2].slice(0, failureIndex + 1));
    expect(result.entries.find((entry) => entry.id === `step-${failureIndex}`)?.result).toBe("FAIL");
    expect(result.entries.filter((entry) => entry.result === "NOT_RUN")).toHaveLength(2 - failureIndex);
  });

  it("runs cleanup without letting successful cleanup replace the first failure", async () => {
    const cleanup = vi.fn(async () => 0);
    const result = await runCommanderGateSteps([
      { id: "failed", layer: "unit", run: async () => 23 },
    ], cleanup);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(23);
  });

  it("fails when cleanup is the first failure", async () => {
    const result = await runCommanderGateSteps([
      { id: "passed", layer: "unit", run: async () => 0 },
    ], async () => 9);
    expect(result.exitCode).toBe(9);
  });
});

describe("validateCommanderExecutionManifest", () => {
  const base: CommanderTestExecutionManifest = {
    version: 1,
    campaignId: "wave-0",
    mode: "targeted",
    startedAt: "2026-07-12T12:00:00.000Z",
    finishedAt: "2026-07-12T12:01:00.000Z",
    entries: [{ id: "D01", layer: "e2e", result: "PASS", durationMs: 10 }],
  };

  it("rejects missing, skipped, blocked, not-run, and zero-test manifests", () => {
    expect(validateCommanderExecutionManifest(base, { expectedIds: ["D01", "D02"] }))
      .toContain("missing expected test id: D02");
    for (const result of ["SKIPPED", "BLOCKED", "NOT_RUN"] as const) {
      expect(validateCommanderExecutionManifest({
        ...base,
        entries: [{ ...base.entries[0]!, result }],
      }, { expectedIds: ["D01"] })).toContain(`D01 is ${result}, expected PASS`);
    }
    expect(validateCommanderExecutionManifest({ ...base, entries: [] }, { expectedIds: [] }))
      .toContain("manifest contains zero test entries");
  });

  it("requires provenance and evidence for live qualification", () => {
    expect(validateCommanderExecutionManifest({
      ...base,
      mode: "live",
    }, { expectedIds: ["D01"], requireLiveProvenance: true, requireEvidence: true })).toEqual([
      "D01 has no live provenance links",
      "D01 has no evidence paths",
    ]);
  });

  it("freezes required ids per qualification mode", () => {
    expect(commanderManifestRequirements("authenticated").expectedIds).toEqual([
      "A01", "A02", "A03", "A04", "A05", "A06", "A07",
    ]);
    expect(commanderManifestRequirements("live")).toMatchObject({
      requireLiveProvenance: true,
      requireEvidence: true,
    });
    expect(commanderManifestRequirements("live").expectedIds).toContain("R14");
    expect(commanderManifestRequirements("live").expectedIds).toContain("Q5");
  });
});
