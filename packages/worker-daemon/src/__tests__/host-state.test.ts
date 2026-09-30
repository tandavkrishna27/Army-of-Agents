/**
 * DSK-003 Lane A (continued) — the host state record, and the stale-PID defence.
 *
 * The control commands need to FIND the running host. A pid file is the obvious answer
 * and the obvious answer has a well-known bug: a host that crashed leaves its pid behind,
 * the OS recycles that pid for something else, and `drain` then signals a stranger's
 * process. On a desktop that stranger is the user's own editor.
 *
 * So the record carries an `instanceId` — a random per-boot nonce — and a command must
 * confirm the LIVE host reports the same one before it signals anything. A pid alone is
 * never sufficient authority to send a signal.
 *
 * The record also carries no credential and no device identity. The allowlist is asserted
 * exhaustively, the same shape as DSK-002 Lane D's projection: a future field must be
 * classified before it can ship.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOST_STATE_KEYS,
  TARGET_PROCESS_REJECTIONS,
  buildHostStateRecord,
  hostStateLeakKeys,
  readHostState,
  resolveTargetProcess,
} from "../control/host-state.js";

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-hoststate-"));
  statePath = path.join(dir, "host.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const OK_DEPS = { platform: "linux" as NodeJS.Platform, stat: () => ({ mode: 0o600 }) };

const RECORD = {
  instanceId: "11111111-1111-4111-8111-111111111111",
  pid: 4242,
  healthPort: 9464,
  startedAt: "2026-08-21T00:00:00.000Z",
  version: "0.1.0",
};

function writeState(value: unknown): void {
  writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 });
}

describe("DSK-003 — the record discloses nothing it should not", () => {
  it("emits exactly the allowlisted keys", () => {
    const record = buildHostStateRecord(RECORD);
    expect(Object.keys(record).sort()).toEqual([...HOST_STATE_KEYS].sort());
  });

  it("carries no credential, token, or device identity", () => {
    // The record sits on disk for the life of the process. It is the wrong place for
    // anything the keystore is protecting, and the control token in particular must not
    // be reachable by reading the file that tells you where the host is.
    const widened = {
      ...RECORD,
      controlToken: "CANARY-token",
      workerId: "CANARY-worker",
      targetId: "CANARY-target",
      devicePublicKey: "CANARY-key",
    };
    const record = buildHostStateRecord(widened as never);
    expect(JSON.stringify(record)).not.toContain("CANARY");
  });

  it("reports a widened runtime object, even when the static type is clean", () => {
    const widened = { ...buildHostStateRecord(RECORD), controlToken: "oops" };
    expect(hostStateLeakKeys(widened as never)).toEqual(["controlToken"]);
  });

  it("reports nothing for a correct record — the leak check is not always-on", () => {
    expect(hostStateLeakKeys(buildHostStateRecord(RECORD))).toEqual([]);
  });
});

describe("DSK-003 — reading the record fails closed", () => {
  it("reads a well-formed record", () => {
    writeState(buildHostStateRecord(RECORD));
    expect(readHostState(statePath, OK_DEPS)).toEqual({ ok: true, record: buildHostStateRecord(RECORD) });
  });

  it("refuses a missing record", () => {
    expect(readHostState(statePath, OK_DEPS)).toEqual({ ok: false, reason: "no_record" });
  });

  it("refuses a group-readable record", () => {
    // Same custody rule as the token: a state file anyone can read tells any local
    // process exactly which pid to signal and which port to talk to.
    writeState(buildHostStateRecord(RECORD));
    expect(readHostState(statePath, { platform: "linux", stat: () => ({ mode: 0o644 }) }))
      .toEqual({ ok: false, reason: "insecure_permissions" });
  });

  it("refuses malformed JSON rather than throwing", () => {
    writeFileSync(statePath, "{not json", { mode: 0o600 });
    expect(readHostState(statePath, OK_DEPS)).toEqual({ ok: false, reason: "malformed_record" });
  });

  it("refuses a record missing any required field", () => {
    for (const key of HOST_STATE_KEYS) {
      const partial: Record<string, unknown> = { ...buildHostStateRecord(RECORD) };
      delete partial[key];
      writeState(partial);
      expect(readHostState(statePath, OK_DEPS), key)
        .toEqual({ ok: false, reason: "malformed_record" });
    }
  });

  it("refuses a nonsensical pid", () => {
    for (const pid of [0, -1, 1.5, "4242"]) {
      writeState({ ...buildHostStateRecord(RECORD), pid });
      expect(readHostState(statePath, OK_DEPS), String(pid))
        .toEqual({ ok: false, reason: "malformed_record" });
    }
  });
});

describe("DSK-003 — a pid is never sufficient authority to signal", () => {
  const liveProbe = (instanceId: string) => vi.fn(async () => ({ instanceId }));

  it("resolves the pid when the live host reports the SAME instance", async () => {
    writeState(buildHostStateRecord(RECORD));
    const probe = liveProbe(RECORD.instanceId);
    await expect(resolveTargetProcess(statePath, { probe, ...OK_DEPS }))
      .resolves.toEqual({ ok: true, pid: RECORD.pid });
    expect(probe).toHaveBeenCalledWith(RECORD.healthPort);
  });

  it("REFUSES when the live host reports a different instance — the recycled pid", async () => {
    // The whole point. The record is well formed, the permissions are right, something IS
    // listening — and it is not our host. Signalling here kills a stranger's process.
    writeState(buildHostStateRecord(RECORD));
    const probe = liveProbe("22222222-2222-4222-8222-222222222222");
    await expect(resolveTargetProcess(statePath, { probe, ...OK_DEPS }))
      .resolves.toEqual({ ok: false, reason: "instance_mismatch" });
  });

  it("refuses when nothing answers on the recorded port", async () => {
    writeState(buildHostStateRecord(RECORD));
    const probe = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(resolveTargetProcess(statePath, { probe, ...OK_DEPS }))
      .resolves.toEqual({ ok: false, reason: "host_not_responding" });
  });

  it("refuses when the probe answers with no instance at all", async () => {
    writeState(buildHostStateRecord(RECORD));
    const probe = vi.fn(async () => ({}) as never);
    await expect(resolveTargetProcess(statePath, { probe, ...OK_DEPS }))
      .resolves.toEqual({ ok: false, reason: "instance_mismatch" });
  });

  it("does not probe at all when the record itself is unusable", async () => {
    // A refusal must not become a port scan driven by a corrupt file.
    const probe = vi.fn(async () => ({ instanceId: RECORD.instanceId }));
    await expect(resolveTargetProcess(statePath, { probe, ...OK_DEPS }))
      .resolves.toEqual({ ok: false, reason: "no_record" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("declares a closed rejection vocabulary", async () => {
    writeState(buildHostStateRecord(RECORD));
    const produced = [
      await resolveTargetProcess(path.join(dir, "absent"), {
        probe: liveProbe(RECORD.instanceId), ...OK_DEPS,
      }),
      await resolveTargetProcess(statePath, { probe: liveProbe("other"), ...OK_DEPS }),
      await resolveTargetProcess(statePath, {
        probe: vi.fn(async () => { throw new Error("down"); }), ...OK_DEPS,
      }),
    ];
    for (const r of produced) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(TARGET_PROCESS_REJECTIONS).toContain(r.reason);
    }
    expect(new Set(produced.map((r) => (r.ok ? "" : r.reason))).size).toBe(3);
  });
});
