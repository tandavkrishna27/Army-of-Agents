/**
 * DSK-003 Lane C — a background host must not discard its own output.
 *
 * THE DEFECT THIS FIXES, in work this ticket already shipped. The LaunchAgent plist
 * carried Label, ProgramArguments, RunAtLoad, KeepAlive and ProcessType — and no
 * `StandardOutPath`. Modern launchd does not route an agent's stdout anywhere by default,
 * so every line the host wrote went to /dev/null. A background host you cannot get logs
 * out of is a background host you cannot diagnose, and `logs` (clause 4) had nothing to
 * read because nothing was ever written.
 *
 * THE ANSWER IS PER-PLATFORM AND ONE OF THEM IS "DO NOTHING":
 *
 *   darwin  launchd redirects natively — two plist keys, no host cooperation needed.
 *   linux   systemd already captures stdout to the journal. Adding a file here would be
 *           WORSE: it would bypass journald's rotation, retention and access control, and
 *           split one host's output across two places. `journalctl --user` is the answer.
 *   win32   Task Scheduler has NO native redirection. Fixing it requires the HOST to open
 *           its own file, which is not this module's job — so it stays a recorded residual
 *           rather than a pretend fix.
 */

import { describe, expect, it } from "vitest";

import {
  AUTOSTART_PLATFORMS,
  autostartLogPath,
  buildAutostartManifest,
} from "../install/autostart.js";

const BASE = {
  execPath: "/opt/aoa/bin/aoa-worker-desktop",
  label: "com.aoa.worker-desktop",
};

describe("DSK-003 — the log destination is per-platform and honest", () => {
  it("uses the macOS convention for darwin", () => {
    expect(autostartLogPath("darwin", BASE.label)).toBe("Library/Logs/com.aoa.worker-desktop.log");
  });

  it("returns null for linux, because journald already has it", () => {
    // Not an oversight. A file here would bypass journald's rotation, retention and
    // access control, and split one host's output across two places.
    expect(autostartLogPath("linux", BASE.label)).toBeNull();
  });

  it("keeps the windows path beside the manifest", () => {
    expect(autostartLogPath("win32", BASE.label)).toBe("AoA/com.aoa.worker-desktop.log");
  });

  it("is relative to home on every platform that has one", () => {
    // An absolute path would be a per-machine guess. The installer knows the home
    // directory; this module does not and must not pretend to.
    for (const platform of AUTOSTART_PLATFORMS) {
      const p = autostartLogPath(platform, BASE.label);
      if (p === null) continue;
      expect(p.startsWith("/"), platform).toBe(false);
      expect(/^[A-Za-z]:/.test(p), platform).toBe(false);
    }
  });
});

describe("DSK-003 — the darwin agent no longer discards its output", () => {
  it("sets BOTH StandardOutPath and StandardErrorPath", () => {
    // Both, not one: launchd treats them independently, and an agent that captured
    // stdout while discarding stderr would lose exactly the lines worth reading.
    //
    // `homeDir` is supplied here deliberately. A first draft of this test omitted it and
    // then contradicted the omit-without-a-home test two cases below — the code was
    // right and the pair of tests could not both be satisfied.
    const { contents } = buildAutostartManifest({
      ...BASE, platform: "darwin", homeDir: "/Users/tk",
    });
    expect(contents).toContain("<key>StandardOutPath</key>");
    expect(contents).toContain("<key>StandardErrorPath</key>");
  });

  it("points both at the log path, under the user's home", () => {
    const { contents } = buildAutostartManifest({
      ...BASE, platform: "darwin", homeDir: "/Users/tk",
    });
    const expected = "/Users/tk/Library/Logs/com.aoa.worker-desktop.log";
    expect(contents.split(expected).length - 1).toBe(2); // once for each key
  });

  it("omits the keys entirely when no home directory is supplied", () => {
    // Half a path is worse than none: launchd would create a file wherever it resolved
    // the relative string, which is not somewhere anyone will look.
    const { contents } = buildAutostartManifest({ ...BASE, platform: "darwin" });
    expect(contents).not.toContain("<key>StandardOutPath</key>");
  });

  it("escapes a hostile home directory rather than emitting it", () => {
    const { contents } = buildAutostartManifest({
      ...BASE, platform: "darwin", homeDir: "/Users/a&b/<key>RunAtLoad</key>",
    });
    expect(contents).toContain("&amp;");
    expect(contents).toContain("&lt;key&gt;");
    // The injected key did not become a real element — RunAtLoad appears once, ours.
    expect(contents.split("<key>RunAtLoad</key>").length - 1).toBe(1);
  });

  it("rejects a home directory carrying a control character", () => {
    const injected = `/Users/tk${String.fromCharCode(10)}<key>RunAtLoad</key>`;
    expect(() => buildAutostartManifest({ ...BASE, platform: "darwin", homeDir: injected }))
      .toThrow(/control character/i);
  });
});

describe("DSK-003 — the other two platforms are left correct, not uniform", () => {
  it("adds no log file to the systemd unit", () => {
    // journald is the platform's answer. A StandardOutput=append here would be a
    // regression dressed as consistency.
    const { contents } = buildAutostartManifest({
      ...BASE, platform: "linux", homeDir: "/home/tk",
    });
    expect(contents).not.toContain("StandardOutput=");
    expect(contents).not.toContain(".log");
  });

  it("adds no fake redirection to the Task Scheduler manifest", () => {
    // Task Scheduler cannot redirect. Emitting a path that nothing honours would read
    // as "logs are captured" while the output still goes nowhere — the exact dishonesty
    // this whole fix is correcting.
    const { contents } = buildAutostartManifest({
      ...BASE, platform: "win32", homeDir: "C:\\Users\\tk",
    });
    expect(contents).not.toContain(".log");
  });

  it("still requests no elevation on any platform, with a home directory set", () => {
    for (const platform of AUTOSTART_PLATFORMS) {
      const { contents } = buildAutostartManifest({ ...BASE, platform, homeDir: "/home/tk" });
      expect(/<RunLevel>\s*HighestAvailable/.test(contents), platform).toBe(false);
      expect(/LaunchDaemons/.test(contents), platform).toBe(false);
    }
  });
});
