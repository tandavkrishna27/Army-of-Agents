/**
 * DSK-003 Lane A — the production control effects.
 *
 * The last composition step. Four properties carry weight, and three of them are about
 * what these must NOT do:
 *
 *   SIGTERM, NEVER SIGKILL. The daemon's shutdown handler is what performs
 *   lease-stop → drain → outbox → health, in that order. SIGKILL skips all of it: leases
 *   stay held until the server reaps them and the outbox never flushes. `drain` that
 *   killed would be the opposite of draining.
 *
 *   THE PROBE IS LOOPBACK BY CONSTRUCTION. The state record carries a PORT and no host,
 *   so a tampered record cannot redirect the instance probe at a remote server. The host
 *   is a literal here, and this asserts it stays one.
 *
 *   STATUS NEVER CARRIES THE TOKEN. `status` needs no authorization, so whatever it
 *   returns is readable by any caller that can run the binary.
 *
 *   AN ABSENT LOG IS SAID, NOT FAKED. Returning "" would read as "the host logged
 *   nothing", which is a different and much more alarming statement than "there is no log
 *   file on this platform".
 */

import { describe, expect, it, vi } from "vitest";

import { createDesktopControlEffects } from "../control-effects.js";

const PATHS = {
  tokenPath: "C:\\vault\\control-token.v1.txt",
  statePath: "C:\\vault\\host-state.v1.json",
};

function effects(over: Record<string, unknown> = {}) {
  const kills: Array<{ pid: number; signal: string }> = [];
  const fetched: string[] = [];
  return {
    kills,
    fetched,
    made: createDesktopControlEffects({
      paths: PATHS,
      platform: "win32",
      kill: (pid: number, signal: string) => { kills.push({ pid, signal }); },
      fetchInstance: async (url: string) => { fetched.push(url); return { instanceId: "i-1" }; },
      readHostStateAt: () => ({ ok: true, record: { instanceId: "i-1", pid: 7, healthPort: 9464, startedAt: "t", version: "v" } }),
      readLogFile: undefined,
      ...over,
    } as never),
  };
}

describe("DSK-003 — drain asks the host to shut down, it does not kill it", () => {
  it("sends SIGTERM", async () => {
    const e = effects();
    await e.made.signal(4242);
    expect(e.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  it("never sends SIGKILL", async () => {
    // SIGKILL skips the shutdown handler entirely: leases stay held until the server
    // reaps them and the outbox never flushes.
    const e = effects();
    await e.made.signal(4242);
    expect(e.kills.some((k) => k.signal === "SIGKILL")).toBe(false);
  });
});

describe("DSK-003 — the instance probe is loopback by construction", () => {
  it("probes 127.0.0.1 on the recorded port", async () => {
    const e = effects();
    await e.made.resolveTarget();
    expect(e.fetched).toHaveLength(1);
    expect(e.fetched[0]).toBe("http://127.0.0.1:9464/instance");
  });

  it("uses a literal loopback host, so a tampered record cannot redirect it", async () => {
    // The record carries a port and NO host — this asserts the host stays a literal
    // rather than becoming another field someone could point elsewhere.
    const e = effects({
      readHostStateAt: () => ({
        ok: true,
        record: {
          instanceId: "i-1", pid: 7, healthPort: 9464, startedAt: "t", version: "v",
          // A record that tried to smuggle a host in must be ignored.
          host: "evil.example.com",
        },
      }),
    });
    await e.made.resolveTarget();
    expect(e.fetched[0]).toContain("127.0.0.1");
    expect(e.fetched.join(" ")).not.toContain("evil.example.com");
  });

  it("resolves the pid when the live instance matches", async () => {
    const e = effects();
    await expect(e.made.resolveTarget()).resolves.toEqual({ ok: true, pid: 7 });
  });

  it("refuses when nothing answers on the recorded port", async () => {
    // Nothing in this file made the probe THROW, so a mutant that treated a failed
    // probe as a match survived. A host that is not listening must never be signalled:
    // its pid is either dead or belongs to something else.
    const e = effects({ fetchInstance: async () => { throw new Error("ECONNREFUSED"); } });
    await expect(e.made.resolveTarget()).resolves
      .toMatchObject({ ok: false, reason: "host_not_responding" });
  });

  it("refuses when the probe answers without identifying itself", async () => {
    // An empty answer is a mismatch, not a pass — `!==` against undefined is what makes
    // that true, and a truthiness guard would let it through.
    const e = effects({ fetchInstance: async () => ({}) });
    await expect(e.made.resolveTarget()).resolves.toMatchObject({ reason: "instance_mismatch" });
  });

  it("refuses when the live instance differs — the recycled pid", async () => {
    const e = effects({ fetchInstance: async () => ({ instanceId: "someone-else" }) });
    await expect(e.made.resolveTarget()).resolves.toMatchObject({ reason: "instance_mismatch" });
  });
});

describe("DSK-003 — status discloses the record and nothing else", () => {
  it("returns the record's fields", async () => {
    const e = effects();
    const status = await e.made.readStatus() as Record<string, unknown>;
    expect(status).toMatchObject({ running: true, pid: 7, healthPort: 9464 });
  });

  it("never carries the control token or its path", async () => {
    // `status` needs no authorization, so anything it returns is readable by any caller
    // that can run the binary.
    const e = effects();
    const rendered = JSON.stringify(await e.made.readStatus());
    expect(rendered).not.toContain("control-token");
    expect(rendered).not.toContain(PATHS.tokenPath);
  });

  it("reports not-running when there is no record", async () => {
    const e = effects({ readHostStateAt: () => ({ ok: false, reason: "no_record" }) });
    expect(await e.made.readStatus()).toMatchObject({ running: false, reason: "no_record" });
  });
});

describe("DSK-003 — an absent log is said, not faked", () => {
  it("says so rather than returning an empty string", async () => {
    // "" would read as "the host logged nothing", which is a different and far more
    // alarming statement than "there is no log file on this platform".
    const e = effects();
    const out = await e.made.readLogTail();
    expect(out).not.toBe("");
    expect(out).toMatch(/no log file|not available/i);
  });

  it("returns the log when one is readable", async () => {
    // Non-vacuity: without this, an implementation that always said "no log file" would
    // satisfy the case above.
    const e = effects({ readLogFile: () => "line one\nline two" });
    expect(await e.made.readLogTail()).toContain("line two");
  });

  it("says so when the log file exists but cannot be read", async () => {
    const e = effects({ readLogFile: () => { throw new Error("EACCES"); } });
    const out = await e.made.readLogTail();
    expect(out).toMatch(/could not|no log file|not available/i);
  });
});
