import { describe, it, expect, vi } from "vitest";
import {
  terminateByPid,
  terminateByPidIfMatches,
  parseProcessStartTime,
} from "../utils/terminate-process.js";

describe("terminateByPid (Plan 3 T4)", () => {
  it("on win32 runs `taskkill /PID <pid> /T /F` and does not signal a group", () => {
    const runTaskkill = vi.fn();
    const kill = vi.fn();
    terminateByPid(1234, 1234, { platform: "win32", runTaskkill, kill });
    expect(runTaskkill).toHaveBeenCalledWith("taskkill", ["/PID", "1234", "/T", "/F"]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("on POSIX SIGKILLs the process GROUP (negative pgid) when pgid is known", () => {
    const runTaskkill = vi.fn();
    const kill = vi.fn();
    terminateByPid(4242, 4242, { platform: "linux", runTaskkill, kill });
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("on POSIX falls back to the bare pid when pgid is null", () => {
    const kill = vi.fn();
    terminateByPid(99, null, { platform: "linux", kill });
    expect(kill).toHaveBeenCalledWith(99, "SIGKILL");
  });

  it("swallows ESRCH / already-dead errors (never throws)", () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(() => terminateByPid(7, 7, { platform: "linux", kill })).not.toThrow();
  });

  it("no-ops on a non-finite pid", () => {
    const kill = vi.fn();
    const runTaskkill = vi.fn();
    terminateByPid(Number.NaN, null, { platform: "linux", kill, runTaskkill });
    terminateByPid(0, null, { platform: "linux", kill, runTaskkill });
    expect(kill).not.toHaveBeenCalled();
    expect(runTaskkill).not.toHaveBeenCalled();
  });
});

describe("terminateByPidIfMatches (Codex P1 round 6 — PID reuse)", () => {
  // Deterministic recorded challenge start. Injected start times are relative to
  // it so nothing depends on the wall clock.
  const startedAt = new Date("2026-07-17T10:00:00.000Z");

  it("SKIPS the kill when the target started materially AFTER startedAt (reused pid) — POSIX", () => {
    const kill = vi.fn();
    // Same pid, but the process now running started 60s later → a different,
    // reused-pid process. Never kill it.
    const queryStartTime = vi.fn(() => new Date(startedAt.getTime() + 60_000));
    const killed = terminateByPidIfMatches(
      4242,
      4242,
      { startedAt },
      { platform: "linux", kill, queryStartTime },
    );
    expect(killed).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(queryStartTime).toHaveBeenCalledWith(4242);
  });

  it("SKIPS the kill when the target started later (reused pid) — win32 taskkill", () => {
    const runTaskkill = vi.fn();
    const queryStartTime = vi.fn(() => new Date(startedAt.getTime() + 60_000));
    const killed = terminateByPidIfMatches(
      1234,
      1234,
      { startedAt },
      { platform: "win32", runTaskkill, queryStartTime },
    );
    expect(killed).toBe(false);
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("KILLS the process GROUP when the target start time matches startedAt — POSIX", () => {
    const kill = vi.fn();
    // The genuine child starts a hair after startedAt (within tolerance).
    const queryStartTime = vi.fn(() => new Date(startedAt.getTime() + 200));
    const killed = terminateByPidIfMatches(
      4242,
      4242,
      { startedAt },
      { platform: "linux", kill, queryStartTime },
    );
    expect(killed).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it("KILLS when the queried start time is slightly EARLIER than startedAt (coarse 1s granularity)", () => {
    const kill = vi.fn();
    // `ps -o lstart` truncates to the second, so the genuine child can report a
    // start time just before the sub-second `startedAt` — still our process.
    const queryStartTime = vi.fn(() => new Date(startedAt.getTime() - 800));
    const killed = terminateByPidIfMatches(
      99,
      null,
      { startedAt },
      { platform: "linux", kill, queryStartTime },
    );
    expect(killed).toBe(true);
    expect(kill).toHaveBeenCalledWith(99, "SIGKILL"); // bare pid when pgid is null
  });

  it("KILLS on win32 when the start time matches", () => {
    const runTaskkill = vi.fn();
    const queryStartTime = vi.fn(() => new Date(startedAt.getTime() + 200));
    const killed = terminateByPidIfMatches(
      1234,
      1234,
      { startedAt },
      { platform: "win32", runTaskkill, queryStartTime },
    );
    expect(killed).toBe(true);
    expect(runTaskkill).toHaveBeenCalledWith("taskkill", ["/PID", "1234", "/T", "/F"]);
  });

  it("CONSERVATIVE: does NOT kill when the start time cannot be established (query returns null)", () => {
    const kill = vi.fn();
    const runTaskkill = vi.fn();
    const queryStartTime = vi.fn(() => null); // process gone / access denied / unparseable
    const killed = terminateByPidIfMatches(
      4242,
      4242,
      { startedAt },
      { platform: "linux", kill, runTaskkill, queryStartTime },
    );
    expect(killed).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("CONSERVATIVE: does NOT kill (and never throws) when the query itself throws", () => {
    const kill = vi.fn();
    const queryStartTime = vi.fn(() => {
      throw new Error("ps unavailable");
    });
    let killed: boolean;
    expect(() => {
      killed = terminateByPidIfMatches(
        4242,
        4242,
        { startedAt },
        { platform: "linux", kill, queryStartTime },
      );
    }).not.toThrow();
    expect(killed!).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("honors a custom toleranceMs boundary (≤ tolerance kills, just over skips)", () => {
    const killWithin = vi.fn();
    // Exactly at the tolerance edge → treated as the same process.
    expect(
      terminateByPidIfMatches(
        7,
        7,
        { startedAt },
        {
          platform: "linux",
          kill: killWithin,
          toleranceMs: 1_000,
          queryStartTime: () => new Date(startedAt.getTime() + 1_000),
        },
      ),
    ).toBe(true);
    expect(killWithin).toHaveBeenCalledWith(-7, "SIGKILL");

    const killOver = vi.fn();
    // One ms past the tolerance edge → a different process → skip.
    expect(
      terminateByPidIfMatches(
        7,
        7,
        { startedAt },
        {
          platform: "linux",
          kill: killOver,
          toleranceMs: 1_000,
          queryStartTime: () => new Date(startedAt.getTime() + 1_001),
        },
      ),
    ).toBe(false);
    expect(killOver).not.toHaveBeenCalled();
  });

  it("no-ops on a non-finite pid without querying or killing", () => {
    const kill = vi.fn();
    const queryStartTime = vi.fn(() => new Date());
    expect(
      terminateByPidIfMatches(Number.NaN, null, { startedAt }, { platform: "linux", kill, queryStartTime }),
    ).toBe(false);
    expect(
      terminateByPidIfMatches(0, null, { startedAt }, { platform: "linux", kill, queryStartTime }),
    ).toBe(false);
    expect(queryStartTime).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("parseProcessStartTime (start-time query output parser)", () => {
  it("parses the POSIX `ps -o lstart=` form (weekday ignored)", () => {
    const d = parseProcessStartTime("Wed Jul 17 10:23:45 2026\n");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
  });

  it("parses the PowerShell ISO-8601 round-trip (UTC) form", () => {
    const d = parseProcessStartTime("2026-07-17T10:23:45.1234567Z\n");
    expect(d?.toISOString()).toBe("2026-07-17T10:23:45.123Z");
  });

  it("returns null on empty / whitespace-only output (exited or access-denied pid)", () => {
    expect(parseProcessStartTime("")).toBeNull();
    expect(parseProcessStartTime("   \n  ")).toBeNull();
  });

  it("returns null on unparseable garbage", () => {
    expect(parseProcessStartTime("not-a-date")).toBeNull();
  });
});
