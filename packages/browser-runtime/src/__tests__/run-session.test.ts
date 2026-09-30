// BRW-002 — session orchestration (unit-shaped; runs on every OS, no browser needed).
//
// The orchestrator takes an injected driver so the ORDER of operations is testable without a
// browser. That matters because the two most dangerous requirements in this ticket are
// mutually constrained and neither is visible from a screenshot:
//
//   * video is only written when the context CLOSES;
//   * closing the context DELETES the downloads staging area.
//
// So a download must be persisted BEFORE close, and close must still happen. Get the order
// wrong and you silently lose the downloads or the video. Design v1 stated neither, and a
// comment cannot fail. These tests can.
import { describe, expect, it } from "vitest";
import { runBrowserSession, type BrowserDriver, type SessionConfig } from "../run-session.js";

const CONFIG: SessionConfig = {
  downloadRoot: "/job/downloads",
  steps: [{ action: "navigate", url: "https://site.test/" }],
  launch: { headless: true, chromiumSandbox: true, args: [] },
};

/** Records every driver interaction in order, so ordering is an assertion, not a comment. */
function recordingDriver(overrides: Partial<RecordingOptions> = {}) {
  const calls: string[] = [];
  const downloads = overrides.downloads ?? [];
  let releaseVideo: () => void = () => {};
  const videoReleased = new Promise<void>((resolve) => { releaseVideo = resolve; });
  const driver: BrowserDriver = {
    async launch(options) {
      calls.push(`launch(sandbox=${String(options.chromiumSandbox)})`);
      if (overrides.launchThrows) throw new Error("launch failed");
      return {
        async navigate(url) {
          calls.push(`navigate(${url})`);
          if (overrides.navigateThrows) throw new Error("navigation failed");
        },
        async collectDownloads() {
          calls.push("collectDownloads");
          return downloads.map((name) => ({
            suggestedFilename: () => name,
            async saveAs(target: string) {
              calls.push(`saveAs(${target})`);
            },
          }));
        },
        async close() {
          calls.push("close");
          releaseVideo();
        },
        stopTracing: overrides.trace === undefined ? undefined : async (target: string) => {
          calls.push(`stopTracing(${target})`);
        },
        video: overrides.video === undefined ? undefined : {
          // ★ MODELS PLAYWRIGHT'S REAL SEMANTICS, which is what makes the deadlock testable
          // without a browser. `Artifact.saveAs` pushes onto `_saveCallbacks` whenever the
          // artifact is not finished and is drained ONLY by `reportFinished()` — and for a
          // video that happens DURING `context.close()`. So awaiting saveAs before close
          // never resolves. Here the promise is gated on the same event.
          async saveAs(target: string) {
            calls.push(`video.saveAs(${target})`);
            await videoReleased;
            calls.push(`video.saved(${target})`);
          },
        },
      };
    },
  };
  return { driver, calls };
}

interface RecordingOptions {
  downloads: string[];
  launchThrows: boolean;
  navigateThrows: boolean;
  /** Present when the session recorded video. */
  video: boolean;
  /** Present when the session recorded a trace. */
  trace: boolean;
}

/** Ports measured before/after launch. Empty delta = contained. */
function ports(before: number[], after: number[]) {
  let call = 0;
  return async () => (call++ === 0 ? before : after);
}

const resolvePath = (root: string, name: string) => ({ ok: true as const, path: `${root}/${name}` });

describe("BRW-002 session — the guard runs BEFORE the browser starts", () => {
  it("refuses an unsafe launch without ever calling the driver", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession(
      { ...CONFIG, launch: { ...CONFIG.launch, cdpPort: 9222 } },
      { driver, measurePorts: ports([], []), resolvePath, env: {} },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cdp_port_requested");
    // The point: a refused launch must not have started anything.
    expect(calls).toEqual([]);
  });

  it("refuses when chromiumSandbox is not enabled", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession(
      { ...CONFIG, launch: { headless: true, args: [] } },
      { driver, measurePorts: ports([], []), resolvePath, env: {} },
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("BRW-002 session — containment is measured across the launch", () => {
  it("passes when the browser opens no port", async () => {
    const { driver } = recordingDriver();
    const result = await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([49983], [49983]),
      resolvePath,
      env: {},
    });
    expect(result.ok).toBe(true);
  });

  it("FAILS when the browser opened a port, and still closes the context", async () => {
    const { driver, calls } = recordingDriver();
    const result = await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([49983], [49983, 9222]),
      resolvePath,
      env: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("port_opened");
    expect(result.detail).toContain("9222");
    // A containment failure must not also leak the browser.
    expect(calls).toContain("close");
  });

  it("tolerates an infrastructure port that closed during the run", async () => {
    // One-directional delta: envd going away is not a containment failure.
    const { driver } = recordingDriver();
    const result = await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([49983, 8080], [8080]),
      resolvePath,
      env: {},
    });
    expect(result.ok).toBe(true);
  });
});

describe("BRW-002 session — THE ORDERING INVARIANT", () => {
  it("persists every download BEFORE closing the context", async () => {
    const { driver, calls } = recordingDriver({ downloads: ["a.pdf", "b.csv"] });
    const result = await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([], []),
      resolvePath,
      env: {},
    });
    expect(result.ok).toBe(true);

    const closeAt = calls.indexOf("close");
    const saveAts = calls
      .map((c, i) => (c.startsWith("saveAs(") ? i : -1))
      .filter((i) => i >= 0);
    expect(saveAts.length).toBe(2);
    expect(closeAt).toBeGreaterThan(-1);
    // Closing first would delete the staging area and lose every download, silently.
    for (const at of saveAts) expect(at).toBeLessThan(closeAt);
  });

  it("still closes the context so video is flushed", async () => {
    const { driver, calls } = recordingDriver({ downloads: ["a.pdf"] });
    await runBrowserSession(CONFIG, { driver, measurePorts: ports([], []), resolvePath, env: {} });
    // Skipping close to "protect" downloads would silently lose video instead.
    //
    // BRW-003b: this used to assert close was the LAST call. That is still true for a
    // session with no video, and this fixture has none — but the invariant it was really
    // encoding is "close always happens, after the downloads". Asserted that way now, so
    // the video phase does not have to weaken it.
    expect(calls).toContain("close");
    expect(calls.indexOf("close")).toBeGreaterThan(calls.indexOf("collectDownloads"));
    expect(calls.some((c) => c.startsWith("video."))).toBe(false);
  });

  // ---- BRW-003b: video is the OPPOSITE of everything else in this file --------
  //
  // Downloads and trace must be handled BEFORE close (close unlinks the download staging
  // files and discards an unstopped trace). Video is the reverse: `saveAs` only resolves
  // once `reportFinished()` runs, and for a video that happens DURING close. So the phases
  // are: flushBeforeClose -> close -> collectAfterClose.
  //
  // A wrong order here is not a missing artifact, it is a HUNG SESSION — the worker waits
  // forever on a promise that close would have resolved. That is why this is the
  // highest-value test in the ticket and why it is written against a fake that models the
  // real drain semantics rather than against a live browser.

  it("BRW-003b: saves video AFTER close — the ordering that does not deadlock", async () => {
    const { driver, calls } = recordingDriver({ video: true });
    await runBrowserSession(CONFIG, { driver, measurePorts: ports([], []), resolvePath, env: {} });

    const closeAt = calls.indexOf("close");
    const askAt = calls.findIndex((c) => c.startsWith("video.saveAs("));
    const savedAt = calls.findIndex((c) => c.startsWith("video.saved("));

    expect(closeAt).toBeGreaterThan(-1);
    expect(askAt).toBeGreaterThan(-1);
    // The save must RESOLVE, and it can only resolve after close has run.
    expect(savedAt).toBeGreaterThan(closeAt);
  });

  it("BRW-003b: a session recording video still terminates — it does not hang", async () => {
    // The deadlock, stated as the property that actually matters. If the implementation
    // awaits video.saveAs BEFORE close, this promise never settles and the test times out
    // rather than failing an assertion — which is exactly what a hung worker looks like.
    const { driver } = recordingDriver({ video: true });
    const settled = await Promise.race([
      runBrowserSession(CONFIG, { driver, measurePorts: ports([], []), resolvePath, env: {} })
        .then(() => "settled" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(settled).toBe("settled");
  });

  it("BRW-003b: downloads are still persisted BEFORE close, with video after", async () => {
    // Both invariants at once, because they point in opposite directions and a change that
    // fixes one by breaking the other would otherwise pass.
    const { driver, calls } = recordingDriver({ downloads: ["a.pdf"], video: true });
    await runBrowserSession(CONFIG, { driver, measurePorts: ports([], []), resolvePath, env: {} });

    const closeAt = calls.indexOf("close");
    for (const at of calls.map((c, i) => (c.startsWith("saveAs(") ? i : -1)).filter((i) => i >= 0)) {
      expect(at).toBeLessThan(closeAt);
    }
    expect(calls.findIndex((c) => c.startsWith("video.saved("))).toBeGreaterThan(closeAt);
  });

  it("BRW-003b: stops the trace BEFORE close — an unstopped trace is silently discarded", async () => {
    // Playwright's `tracing.flush()` during close is `abort()` + an fs sync with NO ZIP
    // (tracing.js:269-272). A trace that was not `stop({path})`-ed first is thrown away
    // without an error — the silent-loss shape, so the ordering is asserted not assumed.
    const { driver, calls } = recordingDriver({ trace: true });
    await runBrowserSession(CONFIG, { driver, measurePorts: ports([], []), resolvePath, env: {} });

    const stopAt = calls.findIndex((c) => c.startsWith("stopTracing("));
    const closeAt = calls.indexOf("close");
    expect(stopAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(closeAt);
  });

  it("BRW-003b: a session that did NOT record a trace makes no tracing calls", async () => {
    // The other half. `recordTrace` is a REQUIRED field on the frozen workload, so "off"
    // has to mean off rather than "we called stop on nothing".
    const { driver, calls } = recordingDriver({ downloads: ["a.pdf"] });
    await runBrowserSession(CONFIG, { driver, measurePorts: ports([], []), resolvePath, env: {} });
    expect(calls.some((c) => c.startsWith("stopTracing("))).toBe(false);
  });

  it("BRW-003b: trace and video sit on OPPOSITE sides of close", async () => {
    // The whole reason the phase split exists, in one assertion: stop the trace before,
    // save the video after. A change that moved either to the other side would pass every
    // single-artifact test above and still lose evidence or hang the session.
    const { driver, calls } = recordingDriver({ trace: true, video: true });
    await runBrowserSession(CONFIG, { driver, measurePorts: ports([], []), resolvePath, env: {} });

    const closeAt = calls.indexOf("close");
    const stopAt = calls.findIndex((c) => c.startsWith("stopTracing("));
    const savedAt = calls.findIndex((c) => c.startsWith("video.saved("));

    // ★ Both indices are asserted PRESENT first. `findIndex` returns -1 when the call never
    // happened, and `-1 < closeAt` is TRUE — so a bare less-than would pass against a system
    // that never traces at all. This test passed for that exact wrong reason before the
    // implementation existed, which is how the vacuity was caught.
    expect(stopAt).toBeGreaterThan(-1);
    expect(savedAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(closeAt);
    expect(savedAt).toBeGreaterThan(closeAt);
  });

  it("persists downloads even when a navigation step failed", async () => {
    const { driver, calls } = recordingDriver({ downloads: ["partial.pdf"], navigateThrows: true });
    const result = await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([], []),
      resolvePath,
      env: {},
    });
    expect(result.ok).toBe(false);
    // Evidence already produced must survive a failed run — it is exactly the evidence
    // someone will want in order to understand the failure.
    expect(calls.some((c) => c.startsWith("saveAs("))).toBe(true);
    expect(calls).toContain("close");
  });
});

describe("BRW-002 session — download destinations are confined", () => {
  it("routes every download through the path resolver", async () => {
    const seen: Array<[string, string]> = [];
    const { driver, calls } = recordingDriver({ downloads: ["report.pdf"] });
    await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([], []),
      resolvePath: (root, name) => {
        seen.push([root, name]);
        return { ok: true, path: `${root}/${name}` };
      },
      env: {},
    });
    expect(seen).toEqual([["/job/downloads", "report.pdf"]]);
    expect(calls).toContain("saveAs(/job/downloads/report.pdf)");
  });

  it("does NOT save a download whose destination is refused", async () => {
    const { driver, calls } = recordingDriver({ downloads: ["../escape.txt"] });
    const result = await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([], []),
      resolvePath: () => ({ ok: false, reason: "outside_root", detail: "escapes" }),
      env: {},
    });
    // The refusal is reported, and crucially nothing was written.
    expect(calls.some((c) => c.startsWith("saveAs("))).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("download_refused");
  });
});

describe("BRW-002 session — a launch failure is reported, not swallowed", () => {
  it("reports a driver launch failure", async () => {
    const { driver } = recordingDriver({ launchThrows: true });
    const result = await runBrowserSession(CONFIG, {
      driver,
      measurePorts: ports([], []),
      resolvePath,
      env: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("launch_failed");
  });
});
