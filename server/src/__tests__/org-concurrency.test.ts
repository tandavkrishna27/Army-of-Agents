import { describe, expect, it } from "vitest";
import {
  orgAvailableSlots,
  normalizeOrgConcurrencyCap,
  runClaimMirrorsBestEffort,
} from "../services/org-concurrency.js";
import { ORG_MAX_CONCURRENT_RUNS_DEFAULT, ORG_MAX_CONCURRENT_RUNS_MAX } from "@armyofagents/shared";

describe("org concurrency clamp", () => {
  it("clamps the cap into [1, MAX] and defaults on garbage", () => {
    expect(normalizeOrgConcurrencyCap(null)).toBe(ORG_MAX_CONCURRENT_RUNS_DEFAULT);
    expect(normalizeOrgConcurrencyCap(0)).toBe(1);
    expect(normalizeOrgConcurrencyCap(99999)).toBe(ORG_MAX_CONCURRENT_RUNS_MAX);
    expect(normalizeOrgConcurrencyCap(12)).toBe(12);
  });
  it("computes available slots like the heartbeat per-agent clamp", () => {
    expect(orgAvailableSlots({ cap: 8, running: 3 })).toBe(5);
    expect(orgAvailableSlots({ cap: 8, running: 8 })).toBe(0);
    expect(orgAvailableSlots({ cap: 8, running: 20 })).toBe(0);
  });

  it("isolates post-commit mirror failures so every committed claim can launch", async () => {
    const mirrored: string[] = [];
    const errors: string[] = [];
    await runClaimMirrorsBestEffort(
      ["run-1", "run-2", "run-3"],
      async (runId) => {
        mirrored.push(runId);
        if (runId === "run-1") throw new Error("event listener failed");
        if (runId === "run-2") throw new Error("wakeup update failed");
      },
      (error, runId) => {
        errors.push(`${runId}:${(error as Error).message}`);
      },
    );

    expect(mirrored).toEqual(["run-1", "run-2", "run-3"]);
    expect(errors).toEqual([
      "run-1:event listener failed",
      "run-2:wakeup update failed",
    ]);
  });
});
