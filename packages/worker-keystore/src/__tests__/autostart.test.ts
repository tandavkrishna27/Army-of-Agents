/**
 * DSK-003 Lane C / I8 — the autostart manifest requests no elevation and no system domain.
 *
 * D6: "assert it, do not assert about it". A generated autostart manifest is a file with
 * contents, so least privilege is a property a test can READ. "We intend to run
 * unprivileged" is not a check; `<RunLevel>LeastPrivilege</RunLevel>` in a file is.
 *
 * D5 makes the per-OS answer concrete. The worker needs the user's own files (DSK-002's
 * granted folders) and the user's own keychain, and no system-wide privilege at run time.
 * So: a launchd LaunchAgent, never a LaunchDaemon; a systemd USER unit, never a system
 * one; a Task Scheduler task with an InteractiveToken, never SYSTEM. The installer may
 * still need elevation to write into a machine-wide location — that is an install-time
 * cost, not a run-time privilege, and the acceptance clause is about the HOST.
 */

import { describe, expect, it } from "vitest";

import { AUTOSTART_PLATFORMS, buildAutostartManifest } from "../install/autostart.js";

const BASE = {
  execPath: "/opt/aoa/bin/aoa-worker-desktop",
  label: "com.aoa.worker-desktop",
};

/** Control characters, built by code point so no editor or shell can mangle them. */
const NEWLINE = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

describe("DSK-003/I8 — every platform's manifest is per-user and unprivileged", () => {
  it("supports exactly the advertised platforms", () => {
    expect([...AUTOSTART_PLATFORMS].sort()).toEqual(["darwin", "linux", "win32"]);
  });

  it("never requests elevation, on any platform", () => {
    const forbidden = [
      /LaunchDaemons/i,
      /<RunLevel>\s*HighestAvailable/i,
      /\bUser\s*=\s*root\b/i,
      /S-1-5-18/, // the Windows SYSTEM SID
      /\bsudo\b/,
      /runas/i,
    ];
    for (const platform of AUTOSTART_PLATFORMS) {
      const { contents } = buildAutostartManifest({ ...BASE, platform });
      for (const pattern of forbidden) {
        expect(pattern.test(contents), `${platform} matched ${pattern}`).toBe(false);
      }
    }
  });

  it("installs into a PER-USER location on every platform", () => {
    const perUser: Record<string, RegExp> = {
      darwin: /^Library\/LaunchAgents\//,
      linux: /^\.config\/systemd\/user\//,
      win32: /^AoA\//,
    };
    for (const platform of AUTOSTART_PLATFORMS) {
      const { installPathRelativeToHome } = buildAutostartManifest({ ...BASE, platform });
      expect(installPathRelativeToHome, platform).toMatch(perUser[platform]!);
    }
  });

  it("declares least privilege POSITIVELY where the format supports it", () => {
    // Absence of an elevation marker is weaker than presence of a least-privilege one: a
    // format that defaulted to elevated would pass a purely negative check.
    const win = buildAutostartManifest({ ...BASE, platform: "win32" }).contents;
    expect(win).toMatch(/<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/);
    expect(win).toMatch(/<LogonType>\s*InteractiveToken\s*<\/LogonType>/);
    expect(buildAutostartManifest({ ...BASE, platform: "darwin" }).contents)
      .toMatch(/<key>RunAtLoad<\/key>/);
    expect(buildAutostartManifest({ ...BASE, platform: "linux" }).contents)
      .toMatch(/NoNewPrivileges=true/);
  });

  it("points at the executable it was given — non-vacuity", () => {
    // Without this, a generator returning a constant empty string would satisfy every
    // "does not contain" assertion above.
    for (const platform of AUTOSTART_PLATFORMS) {
      const { contents } = buildAutostartManifest({ ...BASE, platform });
      expect(contents, platform).toContain("aoa-worker-desktop");
      expect(contents.length, platform).toBeGreaterThan(100);
    }
  });
});

describe("DSK-003/I8 — a path cannot inject into the manifest", () => {
  // The exec path is attacker-influenced in the sense that matters: it is wherever the
  // installer was pointed. Each format has a DIFFERENT injection vector, and conflating
  // them is how one gets missed.
  const XML_NASTY = "/opt/a&b/<RunLevel>HighestAvailable</RunLevel>/aoa-worker-desktop";

  it("escapes XML metacharacters rather than emitting them", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const { contents } = buildAutostartManifest({ ...BASE, execPath: XML_NASTY, platform });
      expect(contents, platform).toContain("&amp;");
      expect(contents, platform).toContain("&lt;RunLevel&gt;");
      // …and the injection did not become a real element.
      expect(/<RunLevel>\s*HighestAvailable/.test(contents), platform).toBe(false);
    }
  });

  it("refuses elevation with a hostile path on the XML formats", () => {
    // Scoped to the XML formats deliberately. A systemd unit is INI-like, so `<RunLevel>`
    // in a path there is inert text — asserting on it would be testing the wrong format's
    // grammar, which an earlier draft of this file did. The systemd vector is below.
    for (const platform of ["darwin", "win32"] as const) {
      const { contents } = buildAutostartManifest({ ...BASE, execPath: XML_NASTY, platform });
      expect(/<RunLevel>\s*HighestAvailable/.test(contents), platform).toBe(false);
    }
  });

  it("rejects a NEWLINE in the path — the systemd injection vector", () => {
    // A unit file is INI-like: a newline closes `ExecStart=` and opens a fresh directive,
    // and `User=root` on that line is exactly the elevation this module prevents.
    const injected = `/opt/aoa/bin/host${NEWLINE}User=root`;
    for (const platform of AUTOSTART_PLATFORMS) {
      expect(
        () => buildAutostartManifest({ ...BASE, execPath: injected, platform }),
        platform,
      ).toThrow(/control character/i);
    }
  });

  it("rejects every other control character too, not just newline", () => {
    for (const bad of [
      `/opt/a${CARRIAGE_RETURN}b`,
      `/opt/a${NUL}b`,
      `/opt/a${TAB}b`,
    ]) {
      expect(() => buildAutostartManifest({ ...BASE, execPath: bad, platform: "linux" }))
        .toThrow(/control character/i);
    }
  });

  it("escapes systemd % specifiers rather than letting them expand", () => {
    // `%h` is the user's home directory to systemd. An unescaped one silently points the
    // unit somewhere other than where the installer meant.
    const { contents } = buildAutostartManifest({
      ...BASE,
      execPath: "/opt/aoa/%h/host",
      platform: "linux",
    });
    expect(contents).toContain("ExecStart=/opt/aoa/%%h/host");
  });

  it("leaves an ordinary path untouched on systemd — non-vacuity for the escaping", () => {
    const { contents } = buildAutostartManifest({ ...BASE, platform: "linux" });
    expect(contents).toContain("ExecStart=/opt/aoa/bin/aoa-worker-desktop");
  });

  it("rejects an empty or non-absolute exec path", () => {
    for (const execPath of ["", "   ", "relative/path"]) {
      expect(() => buildAutostartManifest({ ...BASE, execPath, platform: "linux" }))
        .toThrow(/exec path/i);
    }
  });

  it("accepts a Windows drive-absolute path", () => {
    // Non-vacuity for the absoluteness rule: it must not reject the platform's own shape.
    const { contents } = buildAutostartManifest({
      ...BASE,
      execPath: "C:\\Program Files\\AoA\\aoa-worker-desktop.exe",
      platform: "win32",
    });
    expect(contents).toContain("aoa-worker-desktop.exe");
  });

  it("rejects an unsupported platform rather than emitting something generic", () => {
    expect(() => buildAutostartManifest({ ...BASE, platform: "aix" as never }))
      .toThrow(/platform/i);
  });
});
