/**
 * DSK-003 Lane A — what an invocation of the desktop binary MEANS.
 *
 * One binary now serves three purposes: boot the background host, destroy the identity
 * (`--reset-identity`, guarded since DSK-001), and run a control command. Deciding which
 * is a routing question, and getting it wrong has a specific failure:
 *
 *   A CONTROL COMMAND MUST NEVER BOOT A HOST. If `aoa-worker-desktop status` started a
 *   worker as a side effect, an operator checking on a running host would silently create
 *   a SECOND one — two daemons, two leases, one device identity. That is worse than the
 *   thing they were checking on.
 *
 * The routing is a pure function so that property is a fact about a value, not a hope
 * about control flow.
 */

import { describe, expect, it } from "vitest";

import {
  RESET_IDENTITY_FLAG,
  resolveDesktopInvocation,
} from "../bin/desktop-invocation.js";

describe("DSK-003 — a control command never means boot", () => {
  it("routes each control command to control, not boot", () => {
    for (const command of ["status", "logs", "drain", "revoke"]) {
      expect(resolveDesktopInvocation([command]), command)
        .toEqual({ kind: "control", command, token: null });
    }
  });

  it("carries the token through", () => {
    expect(resolveDesktopInvocation(["drain", "--token=abc"]))
      .toEqual({ kind: "control", command: "drain", token: "abc" });
  });

  it("routes a bare invocation to boot", () => {
    expect(resolveDesktopInvocation([])).toEqual({ kind: "boot" });
  });

  it("routes an invocation of only flags to boot", () => {
    // Flags an operator might pass to the host itself must not be mistaken for a command.
    expect(resolveDesktopInvocation(["--verbose"])).toEqual({ kind: "boot" });
  });

  it("routes --reset-identity to its own path, NOT to control", () => {
    // It is guarded separately and reads the identity before destroying it, which the
    // control path does not do. Routing it through control would lose that warning.
    expect(resolveDesktopInvocation([RESET_IDENTITY_FLAG]))
      .toEqual({ kind: "reset_identity" });
    expect(resolveDesktopInvocation([RESET_IDENTITY_FLAG, "--i-understand-this-is-permanent"]))
      .toEqual({ kind: "reset_identity" });
  });

  it("gives --reset-identity precedence over a control command in the same argv", () => {
    // An argv naming both is ambiguous, and the ambiguity must resolve to the path with
    // the LOUDER guard rather than the quieter one.
    expect(resolveDesktopInvocation(["revoke", RESET_IDENTITY_FLAG]))
      .toEqual({ kind: "reset_identity" });
  });

  it("routes an UNRECOGNISED word to control, so it is refused rather than booting", () => {
    // A typo must not silently start a worker. Control refuses an unknown command by
    // name; boot would start a daemon and say nothing.
    expect(resolveDesktopInvocation(["stauts"]))
      .toEqual({ kind: "control", command: "stauts", token: null });
  });

  it("is a pure function of argv — same input, same answer", () => {
    const argv = ["drain", "--token=t"];
    expect(resolveDesktopInvocation(argv)).toEqual(resolveDesktopInvocation(argv));
  });
});
