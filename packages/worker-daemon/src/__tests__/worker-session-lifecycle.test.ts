import { describe, expect, it, vi } from "vitest";

import { createWorkerSessionLifecycle } from "../identity/worker-session-lifecycle.js";
import { generateDeviceKey, exportDevicePrivateKeyPkcs8Der } from "../identity/device-key.js";
import type { DeviceIdentityRecord, DeviceRecordStore } from "../identity/device-identity-store.js";
import type { ControlPlaneClient } from "../transport/client.js";
import type { EnrollResult, WorkerSession } from "../enrollment/enroll.js";

// WRK-010 slice 2 — the lifecycle factory (§3.5). Proves the wiring the boot root and Sprint 3
// depend on: the sink writes the store, forceRefresh routes a live session to the RENEWER and an
// absent one to the enroll-route ENROLLER (bootstrap), and construction acquires nothing.

const IDENT: DeviceIdentityRecord = {
  v: 1,
  workerId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  deviceGeneration: 1,
  privateKeyPkcs8Der: exportDevicePrivateKeyPkcs8Der(generateDeviceKey()),
};

function session(token: string): WorkerSession {
  return {
    token,
    workerId: IDENT.workerId,
    targetId: IDENT.targetId,
    deviceGeneration: 1,
    obtainedAtMs: 0,
    ttlMs: 900_000,
    expiresAtMs: 900_000,
  };
}

function identityStore(record: DeviceIdentityRecord | null = IDENT) {
  const load = vi.fn(() => record);
  const store: DeviceRecordStore<DeviceIdentityRecord> = {
    load,
    saveIfAbsent: () => "stored",
    clear: () => {},
  };
  return { store, load };
}

const client = {} as unknown as ControlPlaneClient;
const readInput = () => ({ targetId: IDENT.targetId, enrollmentCode: "code-xyz" });

function enrollResult(token: string): EnrollResult {
  return {
    outcome: "enrolled",
    workerId: IDENT.workerId,
    targetId: IDENT.targetId,
    deviceGeneration: 1,
    providerConstraints: null,
    session: session(token),
    idempotencyKey: "idem",
    replay: true,
    deviceThumbprint: "tp",
  };
}

describe("createWorkerSessionLifecycle (WRK-010 slice 2)", () => {
  it("construction acquires NOTHING — no identity read, no renewer/enroller built", () => {
    const id = identityStore();
    const createRenewer = vi.fn();
    const createEnrollerFn = vi.fn();
    createWorkerSessionLifecycle({
      identityStore: id.store, client, now: () => 0, readInput, platform: "linux", arch: "x64",
      createRenewer: createRenewer as never, createEnrollerFn: createEnrollerFn as never,
    });
    expect(id.load).not.toHaveBeenCalled();
    expect(createRenewer).not.toHaveBeenCalled();
    expect(createEnrollerFn).not.toHaveBeenCalled();
  });

  it("onSessionMinted writes the session into the store (S2-A1 wiring)", () => {
    const id = identityStore();
    const life = createWorkerSessionLifecycle({
      identityStore: id.store, client, now: () => 0, readInput, platform: "linux", arch: "x64",
    });
    const s = session("first");
    life.onSessionMinted(s);
    expect(life.store.current()).toBe(s);
  });

  it("forceRefresh routes a LIVE session to the renewer, NOT the enroller (bootstrap)", async () => {
    const renewerFn = vi.fn(async (_cur: WorkerSession) => session("renewed"));
    const createRenewer = vi.fn(() => renewerFn);
    const enrollerRenew = vi.fn(async () => enrollResult("bootstrapped"));
    const createEnrollerFn = vi.fn(() => ({ enroll: vi.fn(), renew: enrollerRenew }));
    const id = identityStore();
    const life = createWorkerSessionLifecycle({
      identityStore: id.store, client, now: () => 0, readInput, platform: "linux", arch: "x64",
      createRenewer: createRenewer as never, createEnrollerFn: createEnrollerFn as never,
    });
    life.onSessionMinted(session("live"));
    const next = await life.store.forceRefresh();
    expect(next.token).toBe("renewed");
    expect(renewerFn).toHaveBeenCalledTimes(1);
    expect(enrollerRenew).not.toHaveBeenCalled();
  });

  it("forceRefresh routes an ABSENT session to the enroll-route code replay (bootstrap)", async () => {
    const renewerFn = vi.fn(async () => session("renewed"));
    const createRenewer = vi.fn(() => renewerFn);
    const enrollerRenew = vi.fn(async () => enrollResult("bootstrapped"));
    const createEnrollerFn = vi.fn(() => ({ enroll: vi.fn(), renew: enrollerRenew }));
    const id = identityStore();
    const life = createWorkerSessionLifecycle({
      identityStore: id.store, client, now: () => 0, readInput, platform: "linux", arch: "x64",
      createRenewer: createRenewer as never, createEnrollerFn: createEnrollerFn as never,
    });
    // empty store ⇒ forceRefresh → bootstrap
    const next = await life.store.forceRefresh();
    expect(next.token).toBe("bootstrapped");
    expect(enrollerRenew).toHaveBeenCalledTimes(1);
    expect(renewerFn).not.toHaveBeenCalled();
  });
});
