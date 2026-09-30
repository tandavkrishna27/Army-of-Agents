/**
 * DSK-003 Lane A — the effect layer, and the bypass it must not become.
 *
 * THE FINDING THIS FILE EXISTS FOR. `--reset-identity` already requires a second flag,
 * `--i-understand-this-is-permanent`, and `desktop-host.ts` documents exactly why: on the
 * same target the reset IS a permanent lockout, because the server denies the re-minted
 * workerId and `findWorkerForBinding` carries no status predicate, so the stale row keeps
 * matching forever with no reset route.
 *
 * `revoke` destroys the SAME local identity. A `revoke` without that acknowledgement would
 * be an unguarded second door onto a guarded action — the guard would still be there, and
 * simply not be on the path anyone takes. Two commands that destroy the same thing must
 * carry the same guard.
 *
 * Every effect is injected, so the ORDER and the REFUSALS are observable without a
 * process, a socket, or a keystore.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { RESET_ACKNOWLEDGEMENT_FLAG, executeControlCommand } from "../control/execute.js";

function deps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const base = {
    calls,
    authorize: vi.fn(() => ({ allowed: true }) as const),
    resolveTarget: vi.fn(async () => {
      calls.push("resolveTarget");
      return { ok: true, pid: 4242 } as const;
    }),
    signal: vi.fn(async (pid: number) => { calls.push(`signal:${pid}`); }),
    readStatus: vi.fn(async () => { calls.push("readStatus"); return { running: true }; }),
    readLogTail: vi.fn(async () => { calls.push("readLogTail"); return "log line"; }),
    destroyIdentity: vi.fn(async () => { calls.push("destroyIdentity"); }),
  };
  return { ...base, ...overrides } as typeof base;
}

describe("DSK-003 — revoke carries the SAME guard as --reset-identity", () => {
  it("refuses revoke without the acknowledgement flag", async () => {
    const d = deps();
    const result = await executeControlCommand(
      { command: "revoke", token: "tok", argv: [] }, d,
    );
    expect(result).toMatchObject({ ok: false, reason: "acknowledgement_required" });
    expect(d.destroyIdentity).not.toHaveBeenCalled();
    expect(d.signal).not.toHaveBeenCalled();
  });

  it("names the exact flag in the refusal, so it is actionable", async () => {
    const d = deps();
    const result = await executeControlCommand({ command: "revoke", token: "tok", argv: [] }, d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(RESET_ACKNOWLEDGEMENT_FLAG);
  });

  it("uses the SAME flag string the keystore host uses", () => {
    // If these ever diverge, an operator who learned one is refused by the other, and
    // worse, a future edit could weaken one without touching the other.
    expect(RESET_ACKNOWLEDGEMENT_FLAG).toBe("--i-understand-this-is-permanent");
  });

  it("proceeds when the acknowledgement IS given — non-vacuity", async () => {
    const d = deps();
    const result = await executeControlCommand(
      { command: "revoke", token: "tok", argv: [RESET_ACKNOWLEDGEMENT_FLAG] }, d,
    );
    expect(result.ok).toBe(true);
    expect(d.destroyIdentity).toHaveBeenCalled();
  });

  it("does NOT require the acknowledgement for drain, which destroys nothing", async () => {
    const d = deps();
    const result = await executeControlCommand({ command: "drain", token: "tok", argv: [] }, d);
    expect(result.ok).toBe(true);
    expect(d.destroyIdentity).not.toHaveBeenCalled();
  });
});

describe("DSK-003 — work stops before identity is destroyed", () => {
  it("drains, then destroys, in that order", async () => {
    const d = deps();
    await executeControlCommand(
      { command: "revoke", token: "tok", argv: [RESET_ACKNOWLEDGEMENT_FLAG] }, d,
    );
    const signalAt = d.calls.findIndex((c) => c.startsWith("signal:"));
    const destroyAt = d.calls.indexOf("destroyIdentity");
    expect(signalAt).toBeGreaterThan(-1);
    expect(destroyAt).toBeGreaterThan(signalAt);
  });

  it("does NOT destroy identity when the running host could not be stopped", async () => {
    // An identity destroyed while work is still in flight strands that work with no way
    // to report it — and the operator is left with neither a running host nor a device.
    const d = deps({
      resolveTarget: vi.fn(async () => ({ ok: false, reason: "instance_mismatch" }) as const),
    });
    const result = await executeControlCommand(
      { command: "revoke", token: "tok", argv: [RESET_ACKNOWLEDGEMENT_FLAG] }, d,
    );
    expect(result).toMatchObject({ ok: false, reason: "instance_mismatch" });
    expect(d.destroyIdentity).not.toHaveBeenCalled();
  });
});

describe("DSK-003 — authorization gates every effect", () => {
  it("runs NO effect when authorization is refused", async () => {
    const d = deps({
      authorize: vi.fn(() => ({ allowed: false, reason: "mismatch" }) as const),
    });
    const result = await executeControlCommand(
      { command: "revoke", token: "bad", argv: [RESET_ACKNOWLEDGEMENT_FLAG] }, d,
    );
    expect(result).toMatchObject({ ok: false, reason: "mismatch" });
    expect(d.calls).toEqual([]);
  });

  it("checks authorization BEFORE the acknowledgement", async () => {
    // Otherwise the refusal message tells an unauthorized caller which flag to add,
    // which is a small oracle but a free one.
    const d = deps({
      authorize: vi.fn(() => ({ allowed: false, reason: "not_presented" }) as const),
    });
    const result = await executeControlCommand({ command: "revoke", token: null, argv: [] }, d);
    expect(result).toMatchObject({ ok: false, reason: "not_presented" });
  });
});

describe("DSK-003 — read-only commands never signal", () => {
  it("status reads and does not touch the process", async () => {
    const d = deps();
    const result = await executeControlCommand({ command: "status", token: null, argv: [] }, d);
    expect(result.ok).toBe(true);
    expect(d.signal).not.toHaveBeenCalled();
    expect(d.destroyIdentity).not.toHaveBeenCalled();
  });

  it("logs reads and does not touch the process", async () => {
    const d = deps();
    const result = await executeControlCommand({ command: "logs", token: null, argv: [] }, d);
    expect(result.ok).toBe(true);
    expect(d.signal).not.toHaveBeenCalled();
    expect(d.readLogTail).toHaveBeenCalled();
  });

  it("refuses an unknown command without running anything", async () => {
    const d = deps({
      authorize: vi.fn(() => ({ allowed: false, reason: "unknown_command" }) as const),
    });
    const result = await executeControlCommand({ command: "rmrf", token: "tok", argv: [] }, d);
    expect(result).toMatchObject({ ok: false, reason: "unknown_command" });
    expect(d.calls).toEqual([]);
  });
});

describe("DSK-003 — drain reaches the resolved process and nothing else", () => {
  it("signals exactly the pid the resolver returned", async () => {
    const d = deps({
      resolveTarget: vi.fn(async () => ({ ok: true, pid: 9999 }) as const),
    });
    await executeControlCommand({ command: "drain", token: "tok", argv: [] }, d);
    expect(d.signal).toHaveBeenCalledWith(9999);
  });

  it("does not signal when the target cannot be resolved", async () => {
    const d = deps({
      resolveTarget: vi.fn(async () => ({ ok: false, reason: "host_not_responding" }) as const),
    });
    const result = await executeControlCommand({ command: "drain", token: "tok", argv: [] }, d);
    expect(result).toMatchObject({ ok: false, reason: "host_not_responding" });
    expect(d.signal).not.toHaveBeenCalled();
  });
});

describe("DSK-003 — the duplicated flag is pinned across the package boundary", () => {
  it("matches the keystore host's RESET_ACKNOWLEDGEMENT_FLAG, read from source", () => {
    // The daemon cannot import @armyofagents/worker-keystore — its dependency manifest is
    // pinned and checked in CI — so the flag string is duplicated. A duplicated guard that
    // drifts is two guards, and an operator who learned one would be refused by the other.
    // Reading the other package's SOURCE is the cross-package pin, the same technique
    // DSK-002 Lane D used to reach the daemon logger's word list from the server.
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..", "..", "..", "worker-keystore", "src", "bin", "desktop-host.ts",
      ),
      "utf8",
    );
    const match = /export const RESET_ACKNOWLEDGEMENT_FLAG = "([^"]+)";/.exec(source);
    expect(match, "the keystore host changed shape — the pin cannot read it").not.toBeNull();
    expect(match![1]).toBe(RESET_ACKNOWLEDGEMENT_FLAG);
  });

  it("also pins the flag the keystore host actually CHECKS, not just the constant", () => {
    // A constant that matches while the check uses a different literal would satisfy the
    // test above and still diverge in behaviour.
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..", "..", "..", "worker-keystore", "src", "bin", "desktop-host.ts",
      ),
      "utf8",
    );
    expect(source).toContain("deps.argv.includes(RESET_ACKNOWLEDGEMENT_FLAG)");
  });
});
