/**
 * MIG-005/006/007 (Lane C) — the shadow port must actually be registered.
 *
 * A CHECK THAT NOTHING RUNS IS NOT A CHECK, and this ticket exists because a shadow
 * comparator sat in production reporting agreement it never computed. The failure mode
 * one level up is just as quiet: three seams call `recordDistributedShadow`, nothing ever
 * calls `setDistributedShadowPort`, every call returns immediately, and the evidence
 * pass reports zero records — which reads as "no traffic" rather than "not wired".
 *
 * Same guard shape as `warm-sandbox-reaper-registration.test.ts`, for the same reason:
 * the composition root is not otherwise reachable from a test.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

describe("Lane C — the composition root registers the shadow port", () => {
  it("calls setDistributedShadowPort exactly once", () => {
    expect(
      SRC.match(/setDistributedShadowPort\(/g) ?? [],
      "the three sinks are inert without this call; a second call would silently replace " +
        "the first recorder",
    ).toHaveLength(1);
  });

  it("registers a real recorder, not a placeholder", () => {
    expect(SRC).toMatch(/setDistributedShadowPort\(\s*createDistributedShadowRecorder\(/);
  });

  it("shares ONE comparator with the heartbeat seam", () => {
    // Two comparators would mean two sinks and two divergence rates for one deployment.
    expect(SRC.match(/createJobShadowComparator\(/g) ?? []).toHaveLength(1);
    expect(SRC).toMatch(/comparator:\s*shadowComparator,/);
  });

  it("sits inside the distributed-execution composition, not at module scope", () => {
    // The opposite of the reaper guard, and deliberately so: the reaper is the only
    // scheduled force-kill and must never be gated, whereas an observability recorder
    // for a default-off platform must NOT arm itself on deployments that never composed
    // distributed execution. Indentation is the marker that it sits inside that block.
    expect(SRC).toMatch(/^[ \t]+setDistributedShadowPort\(/m);
    expect(SRC).not.toMatch(/^setDistributedShadowPort\(/m);
  });
});
