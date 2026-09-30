/**
 * DSK-003 Lane A / I1 + I4 + I5 — the desktop control surface.
 *
 * The security property is not "these two commands check a token". It is that a command
 * is authorized by DEFAULT-DENY: anything not explicitly declared read-only requires the
 * control token. A future `pause`, `reset`, or `rotate` added by someone who never read
 * this file is then gated automatically, which is the opposite of a list of mutating
 * commands that someone must remember to extend.
 *
 * I4 — `drain` does not re-derive the shutdown ordering. `worker-daemon.ts:280` already
 * composes `[...leaseSteps, ...outboxSteps, health-server]`, and `createLeaseLifecycleSteps`
 * already returns `[lease-stop, renewal-stop, lease-drain]`. A second copy inside a CLI
 * command is how the two drift until one stops renewing during a drain.
 *
 * I5 — `revoke` destroys LOCAL identity. A desktop cannot revoke its own server-side
 * target; that authority is the control plane's. A command that implied otherwise would
 * read as a security control it is not.
 */

import { describe, expect, it, vi } from "vitest";

import {
  CONTROL_COMMANDS,
  READ_ONLY_COMMANDS,
  authorizeControlCommand,
  parseControlCommand,
  requiresControlToken,
} from "../control/commands.js";

const OK_DEPS = { platform: "linux" as NodeJS.Platform, stat: () => ({ mode: 0o600 }) };

describe("DSK-003/I1 — authorization is DEFAULT-DENY", () => {
  it("requires a token for every command that is not declared read-only", () => {
    for (const command of CONTROL_COMMANDS) {
      const expected = !READ_ONLY_COMMANDS.includes(command as never);
      expect(requiresControlToken(command), command).toBe(expected);
    }
  });

  it("requires a token for a command nobody has declared at all", () => {
    // The property that makes this default-deny rather than a maintained list: an
    // unknown command is gated, not waved through.
    for (const unknown of ["pause", "rotate", "reset", "", "DRAIN"]) {
      expect(requiresControlToken(unknown as never), unknown).toBe(true);
    }
  });

  it("declares status and logs read-only, and nothing else", () => {
    expect([...READ_ONLY_COMMANDS].sort()).toEqual(["logs", "status"]);
  });

  it("keeps the two lists honest — every read-only command is a real command", () => {
    for (const command of READ_ONLY_COMMANDS) {
      expect(CONTROL_COMMANDS).toContain(command);
    }
  });
});

describe("DSK-003/I1 — the authorization gate", () => {
  const verifyOk = () => ({ ok: true }) as const;
  const verifyBad = () => ({ ok: false, reason: "mismatch" }) as const;

  it("allows a read-only command with no token at all", () => {
    expect(authorizeControlCommand("status", null, { verify: verifyBad, ...OK_DEPS }))
      .toEqual({ allowed: true });
  });

  it("allows a mutating command with a valid token", () => {
    expect(authorizeControlCommand("drain", "tok", { verify: verifyOk, ...OK_DEPS }))
      .toEqual({ allowed: true });
  });

  it("refuses a mutating command with no token", () => {
    expect(authorizeControlCommand("drain", null, { verify: verifyOk, ...OK_DEPS }))
      .toEqual({ allowed: false, reason: "not_presented" });
  });

  it("refuses a mutating command with a bad token, reporting the verifier's reason", () => {
    expect(authorizeControlCommand("revoke", "wrong", { verify: verifyBad, ...OK_DEPS }))
      .toEqual({ allowed: false, reason: "mismatch" });
  });

  it("refuses an UNKNOWN command even when a valid token is supplied", () => {
    // Authorization is not the only gate — an unrecognised command is refused outright
    // rather than dispatched because the caller happened to authenticate.
    expect(authorizeControlCommand("rmrf" as never, "tok", { verify: verifyOk, ...OK_DEPS }))
      .toEqual({ allowed: false, reason: "unknown_command" });
  });

  it("does not consult the verifier at all for a read-only command", () => {
    // A status call must not require, read, or touch the token file.
    const verify = vi.fn(verifyOk);
    authorizeControlCommand("status", "tok", { verify, ...OK_DEPS });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("DSK-003 Lane A — argv parsing", () => {
  it("parses a bare command", () => {
    expect(parseControlCommand(["status"])).toEqual({ command: "status", token: null });
  });

  it("parses --token=VALUE and --token VALUE", () => {
    expect(parseControlCommand(["drain", "--token=abc"])).toEqual({ command: "drain", token: "abc" });
    expect(parseControlCommand(["drain", "--token", "abc"])).toEqual({ command: "drain", token: "abc" });
  });

  it("reports no command when argv is empty", () => {
    expect(parseControlCommand([])).toEqual({ command: null, token: null });
  });

  it("does not treat a flag as the command", () => {
    expect(parseControlCommand(["--token=abc"])).toEqual({ command: null, token: "abc" });
  });

  it("skips flags it does not recognise instead of running them as commands", () => {
    // The first version of this only passed `--token=…`, which is consumed before the
    // flag guard is ever reached — so a mutant deleting that guard survived. An
    // UNRELATED flag is what actually exercises it, and without the guard `--verbose`
    // becomes the command name and gets refused as unknown while the real command is
    // ignored.
    expect(parseControlCommand(["--verbose", "drain"])).toEqual({ command: "drain", token: null });
    expect(parseControlCommand(["-v", "status"])).toEqual({ command: "status", token: null });
    expect(parseControlCommand(["--json", "--token=abc", "revoke"]))
      .toEqual({ command: "revoke", token: "abc" });
  });

  it("keeps an unknown command as-is rather than guessing", () => {
    // Correcting a typo to a nearby command is how `revoke` gets run by accident.
    expect(parseControlCommand(["revok"])).toEqual({ command: "revok", token: null });
  });

  it("takes the FIRST token flag, so a second cannot override it", () => {
    expect(parseControlCommand(["drain", "--token=first", "--token=second"]).token).toBe("first");
  });
});
