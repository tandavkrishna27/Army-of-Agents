import { describe, it, expect, vi } from "vitest";
import { startParentWatchdog, createInFlightCounter } from "../bridge-lifecycle.js";

describe("parent watchdog", () => {
  it("never terminates while inFlight > 0", () => {
    vi.useFakeTimers();
    const inFlight = createInFlightCounter();
    inFlight.enter();
    const onDead = vi.fn();
    // On Windows, process.kill(999999999, 0) may throw EPERM (process exists but
    // no permission) rather than ESRCH (no such process). The watchdog treats
    // EPERM as "alive", which would mean onDead never fires. Stub process.kill to
    // always throw ESRCH so the dead-parent branch is reliably exercised on Windows.
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((...args: any[]) => {
        const pid = args[0];
        // Only fake out the sentinel pid — let the alive-parent test use self pid
        if (pid === 999999999) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        // For any other pid (e.g. self pid) use the real implementation
        return (process.kill as any).__original?.(...args) ?? true;
      });

    startParentWatchdog({
      getInFlight: () => inFlight.count,
      onDead,
      ppid: 999999999,
      graceFailures: 1,
      intervalMs: 10,
    });
    vi.advanceTimersByTime(100);
    expect(onDead).not.toHaveBeenCalled(); // in flight -> never kill

    inFlight.leave();
    vi.advanceTimersByTime(100);
    expect(onDead).toHaveBeenCalled(); // now idle + dead parent

    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it("treats a single failed probe as unknown (graceFailures)", () => {
    vi.useFakeTimers();
    const onDead = vi.fn();
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((...args: any[]) => {
        const pid = args[0];
        if (pid === 999999999) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      });

    startParentWatchdog({
      getInFlight: () => 0,
      onDead,
      ppid: 999999999,
      graceFailures: 3,
      intervalMs: 10,
    });
    vi.advanceTimersByTime(10);
    expect(onDead).not.toHaveBeenCalled(); // 1 fail
    vi.advanceTimersByTime(10);
    expect(onDead).not.toHaveBeenCalled(); // 2 fails
    vi.advanceTimersByTime(10);
    expect(onDead).toHaveBeenCalled(); // 3rd -> dead

    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it("stays alive while the parent is alive", () => {
    vi.useFakeTimers();
    const onDead = vi.fn();
    // Use process.pid (self) — process.kill(self, 0) succeeds on all platforms,
    // confirming the pid is alive. No stub needed for this case.
    startParentWatchdog({
      getInFlight: () => 0,
      onDead,
      ppid: process.pid,
      graceFailures: 1,
      intervalMs: 10,
    });
    vi.advanceTimersByTime(100);
    expect(onDead).not.toHaveBeenCalled(); // self pid is alive

    vi.useRealTimers();
  });
});
