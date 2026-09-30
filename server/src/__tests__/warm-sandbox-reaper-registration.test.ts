/**
 * REL-004 Lane D (D1/J11) — the only scheduled force-kill must not be gated on routines.
 *
 * `scheduleWarmSandboxReaper` was registered inside `if (config.heartbeatSchedulerEnabled)`.
 * That knob is documented and operator-facing (`docs/guides/board-operator/routines.md`), and it
 * advertises itself as governing SCHEDULE TICKS — nothing tells an operator it also disables the
 * only thing that reclaims sandboxes.
 *
 * Meanwhile minting is NOT gated: a Commander turn acquires a warm lease on the HTTP path
 * (`commander-sandbox.ts`), and org wakeups dispatch in-process from routes. So with
 * HEARTBEAT_SCHEDULER_ENABLED=false the system kept creating E2B sandboxes and stopped reclaiming
 * them — and once Lane D makes this sweep the incident-response path for a killed provider, an
 * operator who turned off routines would also have turned off the kill switch's teeth.
 *
 * This is the same argument, and the same guard shape, as `claude-config-dir-sweeper.test.ts`:
 * the repo already made this mistake once and pinned the fix.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");

describe("REL-004 Lane D/J11 — the warm-sandbox reaper is registered unconditionally", () => {
  it("calls the scheduler at module scope, so no runtime flag can skip it", () => {
    // Zero indentation == module top level, the only placement no config flag can gate.
    expect(SRC).toMatch(/^scheduleWarmSandboxReaper\(/m);
    expect(
      SRC,
      "the reaper must not be indented into a block — it is the only scheduled force-kill, and " +
        "Lane D makes it the reclaim path for a killed provider. If index.ts's startup is being " +
        "refactored into a helper, move this guard with it.",
    ).not.toMatch(/^[ \t]+scheduleWarmSandboxReaper\(/m);
  });

  it("sits outside the heartbeat-scheduler gate, which does not govern sandbox minting", () => {
    const reaperAt = SRC.indexOf("\nscheduleWarmSandboxReaper(");
    const gateAt = SRC.indexOf("if (config.heartbeatSchedulerEnabled) {");
    expect(reaperAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(reaperAt).toBeGreaterThan(gateAt);
  });

  it("still registers exactly once", () => {
    // A move that accidentally duplicates the registration would double every sweep.
    expect(SRC.match(/scheduleWarmSandboxReaper\(/g) ?? []).toHaveLength(1);
  });
});
