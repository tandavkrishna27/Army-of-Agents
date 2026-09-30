import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sweep = vi.fn();

// Only the sweep is stubbed. ISOLATED_CLAUDE_CONFIG_MAX_AGE_MS is re-exported
// from the REAL module: the scheduler derives its interval from that constant,
// and a mocked literal would silently pass even if the real value changed to
// something the interval no longer makes sense against (M14).
vi.mock("@armyofagents/adapter-claude-local/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@armyofagents/adapter-claude-local/server")>()),
  sweepOrphanedIsolatedClaudeConfigDirs: (...args: unknown[]) => sweep(...args),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  runClaudeConfigDirSweep,
  scheduleClaudeConfigDirSweeper,
} from "../services/claude-config-dir-sweeper.js";

/**
 * The sweep logic itself lives in the adapter (and is tested there, against a
 * real filesystem). What is proven HERE is the half that only exists in the
 * server: that boot actually FIRES it, and that no failure mode of housekeeping
 * can reach boot.
 */
describe("claude config-dir sweeper registration", () => {
  beforeEach(() => {
    sweep.mockReset();
    sweep.mockResolvedValue({ scanned: 0, removed: 0, failed: 0, live: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The boot pass is the one that matters: it clears whatever a crash or SIGKILL
  // left behind while the server was down. A sweeper that only ran on the
  // interval would leave those credentials on disk for an hour.
  it("sweeps immediately at registration, before the first interval elapses", () => {
    vi.useFakeTimers();
    const timer = scheduleClaudeConfigDirSweeper();
    try {
      expect(sweep).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(timer);
    }
  });

  it("keeps sweeping on the interval", () => {
    vi.useFakeTimers();
    const timer = scheduleClaudeConfigDirSweeper(1_000);
    try {
      vi.advanceTimersByTime(3_000);
      expect(sweep).toHaveBeenCalledTimes(4); // boot + three ticks
    } finally {
      clearInterval(timer);
    }
  });

  // Housekeeping must never be able to fail boot: index.ts calls this
  // synchronously in the startup path, so a rejected sweep has to be absorbed
  // here rather than becoming an unhandled rejection.
  it("absorbs a rejected sweep instead of propagating it", async () => {
    sweep.mockRejectedValue(new Error("tmpdir on fire"));
    await expect(runClaudeConfigDirSweep()).resolves.toBeUndefined();
  });
});

/**
 * 🚨 The sweeper's lifetime must track whatever mints the directories, and that
 * is CREW dispatch — `runExtractionSweep` → `runAoaDispatch`, scheduled
 * unconditionally — NOT the heartbeat scheduler.
 *
 * This was wrong once: the registration sat inside
 * `if (config.heartbeatSchedulerEnabled)`, so with
 * HEARTBEAT_SCHEDULER_ENABLED=false crew runs still wrote the operator's Claude
 * credential to disk and nothing ever reclaimed it — the exact
 * credentials-at-rest state the sweep exists to prevent, with a fully green
 * suite. Behaviour tests above cannot see placement, so this guards it.
 *
 * Source-presence assertion, mirroring extraction-sweeper-wiring.test.ts:
 * index.ts is the process entrypoint and is not unit-bootable.
 */
describe("claude config-dir sweeper is registered unconditionally", () => {
  const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8");

  it("calls the scheduler at module scope, so no runtime flag can skip it", () => {
    // Zero indentation == module top level, which is the only placement that
    // cannot be gated by a config flag.
    expect(src).toMatch(/^scheduleClaudeConfigDirSweeper\(\);$/m);
    expect(
      src,
      "the sweeper must not be indented into a block — if index.ts's startup is being " +
        "refactored into a helper, move this guard with it and assert the new call site " +
        "runs unconditionally",
    ).not.toMatch(/^[ \t]+scheduleClaudeConfigDirSweeper\(\);$/m);
  });

  it("sits outside the heartbeat-scheduler gate, which does not govern crew runs", () => {
    const sweeperAt = src.indexOf("\nscheduleClaudeConfigDirSweeper();");
    const heartbeatGateAt = src.indexOf("if (config.heartbeatSchedulerEnabled) {");
    expect(sweeperAt).toBeGreaterThan(-1);
    expect(heartbeatGateAt).toBeGreaterThan(-1);
    expect(sweeperAt).toBeGreaterThan(heartbeatGateAt);
  });
});
