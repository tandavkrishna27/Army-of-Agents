// DSK-001 / I3 + I6 + I7 — the enrolment coordinator.
//
// This is the piece whose failure mode is PERMANENT. If a device ever enrols
// under a second identity, the server denies it at BOTH of its denial sites, and
// `findWorkerForBinding` has no status predicate — so the stale row keeps
// matching forever and there is no reset route. Every test below exists because
// some ordering would otherwise produce that.
//
// The proofs are by COUNTING, not by reasoning: `randomWorkerId` and
// `generateKey` are injected spies, so "minted at most once" is an assertion
// about call counts rather than an argument about control flow. No module
// mocking anywhere.

import { describe, expect, it, vi } from "vitest";
import { enrollOnce, EnrollmentAuthorityError, type EnrollOnceDeps } from "../enrollment/enroll-once.js";
import { DeviceKeyStoreError } from "../identity/key-store.js";
import { generateDeviceKey, exportDevicePrivateKeyPkcs8Der } from "../identity/device-key.js";
import type { DeviceIdentityRecord, DeviceRecordStore } from "../identity/device-identity-store.js";

const TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CODE = "aoa_enr_" + "A".repeat(22) + "." + "B".repeat(43);

const realKey = generateDeviceKey();
const realDer = exportDevicePrivateKeyPkcs8Der(realKey);

const record = (over: Partial<DeviceIdentityRecord> = {}): DeviceIdentityRecord => ({
  v: 1,
  workerId: WORKER_ID,
  targetId: TARGET_ID,
  deviceGeneration: 1,
  privateKeyPkcs8Der: realDer,
  ...over,
});

/** An in-memory record store with real compare-and-set semantics. */
function memoryStore<T>(initial: T | null = null) {
  let value = initial;
  const store: DeviceRecordStore<T> & { peek: () => T | null } = {
    load: () => value,
    saveIfAbsent: (r: T) => {
      if (value !== null) return "already_present";
      value = r;
      return "stored";
    },
    clear: () => { value = null; },
    peek: () => value,
  };
  return store;
}

function deps(over: Partial<EnrollOnceDeps> = {}): EnrollOnceDeps & {
  randomWorkerId: ReturnType<typeof vi.fn>;
  generateKey: ReturnType<typeof vi.fn>;
  renew: ReturnType<typeof vi.fn>;
} {
  const randomWorkerId = vi.fn(() => WORKER_ID);
  const generateKey = vi.fn(() => realKey);
  const renewSpy = vi.fn(async () => ({
    outcome: "enrolled" as const,
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    deviceGeneration: 1,
    providerConstraints: null,
    session: { token: "SESSION-TOKEN-MUST-NOT-ESCAPE", expiresAt: "2026-01-01T00:00:00.000Z" },
    deviceThumbprint: "tp-1",
    replay: false,
  }));
  return {
    identityStore: memoryStore<DeviceIdentityRecord>(),
    receiptStore: memoryStore(),
    input: { targetId: TARGET_ID, enrollmentCode: CODE },
    client: {} as unknown as EnrollOnceDeps["client"],
    createEnrollerFn: () => ({
      enroll: async () => { throw new Error("enrollOnce must call renew(), never enroll()"); },
      renew: renewSpy,
    }),
    randomWorkerId,
    generateKey,
    renew: renewSpy,
    platform: "win32",
    arch: "x64",
    ...over,
  } as never;
}

describe("DSK-001/I3 — a store that cannot open NEVER produces an identity", () => {
  it("refuses when the identity store throws, with ZERO mints", async () => {
    const d = deps({
      identityStore: {
        load: () => { throw new DeviceKeyStoreError("locked"); },
        saveIfAbsent: () => { throw new Error("must not be reached"); },
        clear: () => {},
      },
    });
    await expect(enrollOnce(d)).rejects.toThrow();
    expect(d.randomWorkerId).not.toHaveBeenCalled();
    expect(d.generateKey).not.toHaveBeenCalled();
  });

  it("never reads the enrollment code when the store faults", async () => {
    // S4a before S4d: a fault-store boot must not materialize a live single-use
    // credential in memory at all.
    const readInput = vi.fn(() => ({ targetId: TARGET_ID, enrollmentCode: CODE }));
    const d = deps({
      identityStore: {
        load: () => { throw new DeviceKeyStoreError("locked"); },
        saveIfAbsent: () => "stored",
        clear: () => {},
      },
      readInput,
    });
    await expect(enrollOnce(d)).rejects.toThrow();
    expect(readInput).not.toHaveBeenCalled();
  });

  it("never contacts the control plane when the store faults", async () => {
    const d = deps({
      identityStore: {
        load: () => { throw new DeviceKeyStoreError("denied"); },
        saveIfAbsent: () => "stored",
        clear: () => {},
      },
    });
    await expect(enrollOnce(d)).rejects.toThrow();
    expect(d.renew).not.toHaveBeenCalled();
  });
});

describe("DSK-001/I7 — minted at most once, proven by counting", () => {
  it("mints exactly once on a first enrolment", async () => {
    const d = deps();
    const out = await enrollOnce(d);
    expect(out.minted).toBe(true);
    expect(d.randomWorkerId).toHaveBeenCalledTimes(1);
    expect(d.generateKey).toHaveBeenCalledTimes(1);
  });

  it("mints ZERO times on the second run — and never contacts the server again", async () => {
    // S4c: after one successful enrolment the device is in steady state. It does
    // not read the code, and it does not call the control plane, ever again.
    const identityStore = memoryStore<DeviceIdentityRecord>();
    const receiptStore = memoryStore();
    const first = deps({ identityStore, receiptStore });
    await enrollOnce(first);

    const second = deps({ identityStore, receiptStore });
    const out = await enrollOnce(second);
    expect(out.skipped).toBe(true);
    expect(second.randomWorkerId).not.toHaveBeenCalled();
    expect(second.generateKey).not.toHaveBeenCalled();
    expect(second.renew).not.toHaveBeenCalled();
  });

  it("keeps the SAME workerId after a FAILED enroll and a restart", async () => {
    // The scenario that motivates the whole ordering: the server rejects, the
    // process restarts, and the device must present the identity it already
    // persisted rather than minting a second one.
    const identityStore = memoryStore<DeviceIdentityRecord>();
    const receiptStore = memoryStore();

    const failing = deps({
      identityStore,
      receiptStore,
      createEnrollerFn: () => ({
        enroll: async () => { throw new Error("never"); },
        renew: async () => { throw new Error("401 unauthorized"); },
      }),
    });
    await expect(enrollOnce(failing)).rejects.toThrow();
    expect(failing.randomWorkerId).toHaveBeenCalledTimes(1);
    const persisted = identityStore.peek();
    expect(persisted).not.toBeNull();

    const retry = deps({ identityStore, receiptStore });
    const out = await enrollOnce(retry);
    expect(retry.randomWorkerId).not.toHaveBeenCalled();
    expect(retry.generateKey).not.toHaveBeenCalled();
    expect(out.workerId).toBe(persisted!.workerId);
  });

  it("adopts the WINNER's record when the CAS is lost, never a second identity", async () => {
    // S4f: the loser discards what it minted and reloads the winner's COMPLETE
    // record — workerId and key together — so two processes never present two
    // identities.
    const winner = record({ workerId: "11111111-1111-4111-8111-111111111111" });
    const identityStore: DeviceRecordStore<DeviceIdentityRecord> = {
      load: vi.fn()
        .mockReturnValueOnce(null)      // first look: nothing yet
        .mockReturnValue(winner),        // after the lost CAS: the winner's record
      saveIfAbsent: () => "already_present",
      clear: () => {},
    };
    const d = deps({ identityStore });
    const out = await enrollOnce(d);
    expect(out.minted).toBe(false);
    expect(out.workerId).toBe(winner.workerId);
  });

  it("THROWS rather than re-minting when a lost CAS is followed by an empty load", async () => {
    // A contradiction — the store said "already present" and then produced
    // nothing. Re-minting here is the lockout; refusing is recoverable.
    const identityStore: DeviceRecordStore<DeviceIdentityRecord> = {
      load: () => null,
      saveIfAbsent: () => "already_present",
      clear: () => {},
    };
    const d = deps({ identityStore });
    await expect(enrollOnce(d)).rejects.toThrow();
    expect(d.randomWorkerId).toHaveBeenCalledTimes(1); // minted once, then discarded
  });
});

describe("DSK-001 — the enroller is handed a view that cannot mint", () => {
  it("never calls generateDeviceKey inside the enroller, even on a fresh device", async () => {
    // `loadOrCreateKey` mints whenever the store returns null. The coordinator
    // resolves the key itself and passes a FROZEN view whose load() always
    // answers, so that branch is unreachable — I3 by construction, not by luck.
    const d = deps();
    await enrollOnce(d);
    expect(d.generateKey).toHaveBeenCalledTimes(1); // the coordinator's own mint, not the enroller's
  });
});

describe("DSK-001/I13 — the session token never escapes", () => {
  it("is absent from the outcome entirely", async () => {
    const out = await enrollOnce(deps());
    expect(JSON.stringify(out)).not.toContain("SESSION-TOKEN-MUST-NOT-ESCAPE");
    expect(Object.keys(out)).not.toContain("session");
    expect(Object.keys(out)).not.toContain("token");
  });

  it("returns a frozen object with a fixed key allowlist", async () => {
    const out = await enrollOnce(deps());
    expect(Object.isFrozen(out)).toBe(true);
    for (const key of Object.keys(out)) {
      expect([
        "enrolled", "minted", "skipped", "workerId", "targetId",
        "deviceGeneration", "deviceThumbprint",
      ]).toContain(key);
    }
  });
});

describe("WRK-010 slice 2 / E4-F012 — the enrolment session SINK (S2-M10, S2-A4 unit half)", () => {
  it("invokes onSessionMinted ONCE with the minted session on the enrolling path", async () => {
    const onSessionMinted = vi.fn();
    const out = await enrollOnce(deps({ onSessionMinted }));
    expect(out.skipped).toBe(false);
    expect(onSessionMinted).toHaveBeenCalledTimes(1);
    // The sink receives the real session — the token the outcome must NEVER carry.
    expect(onSessionMinted.mock.calls[0][0].token).toBe("SESSION-TOKEN-MUST-NOT-ESCAPE");
  });

  it("keeps I13 intact WITH the sink wired: the outcome still has no session/token key", async () => {
    const out = await enrollOnce(deps({ onSessionMinted: () => {} }));
    expect(JSON.stringify(out)).not.toContain("SESSION-TOKEN-MUST-NOT-ESCAPE");
    expect(Object.keys(out)).not.toContain("session");
    expect(Object.keys(out)).not.toContain("token");
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("does NOT invoke the sink on the steady-state (skipped) path — no session is minted", async () => {
    const identityStore = memoryStore<DeviceIdentityRecord>();
    const receiptStore = memoryStore();
    // First boot enrols and persists identity + receipt.
    await enrollOnce(deps({ identityStore, receiptStore }));
    // Second boot: identity + receipt on disk ⇒ skipped:true, before any network. The sink
    // must not fire — the first session on this path comes from the bootstrap dependency.
    const onSessionMinted = vi.fn();
    const out = await enrollOnce(deps({ identityStore, receiptStore, onSessionMinted }));
    expect(out.skipped).toBe(true);
    expect(onSessionMinted).not.toHaveBeenCalled();
  });
});

describe("DSK-001 — a target mismatch is refused, not silently re-enrolled", () => {
  it("refuses when the persisted identity belongs to a different target", async () => {
    const identityStore = memoryStore<DeviceIdentityRecord>(
      record({ targetId: "b3000000-0000-4000-8000-000000000009" }),
    );
    const d = deps({ identityStore });
    await expect(enrollOnce(d)).rejects.toThrow(/target/i);
    expect(d.randomWorkerId).not.toHaveBeenCalled();
  });
});

// -- found by adversarially reviewing the completed lane ----------------------

describe("DSK-001 — the receipt and the identity must agree", () => {
  const receipt = {
    v: 1 as const,
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    deviceGeneration: 1,
    deviceThumbprint: "tp-1",
  };

  it("REFUSES when a receipt exists but the identity is gone, instead of minting", async () => {
    // The quadrant the original code fell straight through: `receipt` was read
    // only inside `if (identity && receipt)`, and the mint gate was
    // `identity === null` alone. So a device whose key file was lost — AV
    // quarantine, a selective restore, an operator deleting "the key file" —
    // minted a SECOND identity the server denies permanently.
    //
    // The precondition already destroyed the private key, so refusing does not
    // recover the device; it makes the failure diagnosable instead of turning it
    // into a silent, durable false success.
    const d = deps({
      identityStore: memoryStore<DeviceIdentityRecord>(),
      receiptStore: memoryStore(receipt),
    });
    await expect(enrollOnce(d)).rejects.toThrow(/receipt/i);
    expect(d.randomWorkerId).not.toHaveBeenCalled();
    expect(d.generateKey).not.toHaveBeenCalled();
    expect(d.renew).not.toHaveBeenCalled();
  });

  it("REFUSES when both exist but name DIFFERENT workers", async () => {
    // Otherwise the device short-circuits forever, reporting itself enrolled as
    // the receipt's worker while holding a different worker's key — a permanent
    // silent disagreement that no later boot can detect.
    const d = deps({
      identityStore: memoryStore<DeviceIdentityRecord>(record()),
      receiptStore: memoryStore({ ...receipt, workerId: "99999999-9999-4999-8999-999999999999" }),
    });
    await expect(enrollOnce(d)).rejects.toThrow(/disagree|mismatch/i);
  });

  it("still short-circuits when they AGREE", async () => {
    // Non-vacuity: the cross-check must not break the steady-state path.
    const d = deps({
      identityStore: memoryStore<DeviceIdentityRecord>(record()),
      receiptStore: memoryStore(receipt),
    });
    const out = await enrollOnce(d);
    expect(out.skipped).toBe(true);
    expect(out.workerId).toBe(WORKER_ID);
  });

  it("REFUSES when the receipt write loses to a DISAGREEING existing receipt", async () => {
    // `saveIfAbsent`'s return was discarded, so a pre-existing receipt naming a
    // different worker survived silently and every later boot reported it.
    const d = deps({
      receiptStore: {
        load: () => null,
        saveIfAbsent: () => "already_present" as const,
        clear: () => {},
      },
    });
    await expect(enrollOnce(d)).rejects.toThrow(/receipt/i);
  });
});

describe("DSK-001/A1 — a NETWORK failure is distinguishable from a store fault", () => {
  // Amendment A1. The bootstrap's fatal/non-fatal split turns on whether this
  // boot MINTED. A plain throw carries no such thing, and treating every failure
  // as fatal would restart-loop a device whose identity is intact — which is
  // exactly what pressures an operator toward `--reset-identity`, the permanent
  // lockout. So an authority failure is typed and carries `minted`.
  //
  // Store and ticket faults deliberately do NOT get this treatment: they stay
  // plain and unconditionally fatal, because a store that cannot open must never
  // look survivable (I3).

  it("throws EnrollmentAuthorityError with minted=true when this boot minted", async () => {
    const d = deps({
      createEnrollerFn: () => ({
        enroll: async () => { throw new Error("never"); },
        renew: async () => { throw new Error("503 service unavailable"); },
      }),
    });
    await expect(enrollOnce(d)).rejects.toBeInstanceOf(EnrollmentAuthorityError);
    try {
      await enrollOnce(deps({
        createEnrollerFn: () => ({
          enroll: async () => { throw new Error("never"); },
          renew: async () => { throw new Error("503 service unavailable"); },
        }),
      }));
    } catch (err) {
      const e = err as EnrollmentAuthorityError;
      expect(e.minted).toBe(true);
      expect(e.workerId).toBe(WORKER_ID);
      expect(e.targetId).toBe(TARGET_ID);
    }
  });

  it("throws EnrollmentAuthorityError with minted=false when the identity pre-existed", async () => {
    // The device crashed between the identity write and the receipt write. Its
    // key is intact, so the bootstrap must be able to choose to run idle rather
    // than exit and loop.
    const identityStore = memoryStore<DeviceIdentityRecord>();
    const receiptStore = memoryStore();
    const first = deps({
      identityStore,
      receiptStore,
      createEnrollerFn: () => ({
        enroll: async () => { throw new Error("never"); },
        renew: async () => { throw new Error("503 service unavailable"); },
      }),
    });
    await expect(enrollOnce(first)).rejects.toBeInstanceOf(EnrollmentAuthorityError);

    const second = deps({
      identityStore,
      receiptStore,
      createEnrollerFn: () => ({
        enroll: async () => { throw new Error("never"); },
        renew: async () => { throw new Error("503 service unavailable"); },
      }),
    });
    try {
      await enrollOnce(second);
      throw new Error("expected a rejection");
    } catch (err) {
      const e = err as EnrollmentAuthorityError;
      expect(e).toBeInstanceOf(EnrollmentAuthorityError);
      expect(e.minted).toBe(false);
      expect(second.randomWorkerId).not.toHaveBeenCalled();
    }
  });

  it("does NOT type a store fault as an authority failure", async () => {
    // The distinction has to be narrow, or the bootstrap's survivable branch
    // starts swallowing the faults that must always be fatal.
    const d = deps({
      identityStore: {
        load: () => { throw new Error("device identity store unusable (locked)"); },
        saveIfAbsent: () => "stored" as const,
        clear: () => {},
      } as never,
    });
    await expect(enrollOnce(d)).rejects.not.toBeInstanceOf(EnrollmentAuthorityError);
  });

  it("carries the underlying error as `cause`, without flattening it into a message", async () => {
    // The bootstrap logs through the redactor; a pre-stringified message would
    // bypass the `err` serializer and could carry whatever the transport put in
    // it.
    const underlying = new Error("401 unauthorized");
    const d = deps({
      createEnrollerFn: () => ({
        enroll: async () => { throw new Error("never"); },
        renew: async () => { throw underlying; },
      }),
    });
    try {
      await enrollOnce(d);
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as EnrollmentAuthorityError).cause).toBe(underlying);
    }
  });

  it("never puts the enrollment code in the error", async () => {
    const d = deps({
      createEnrollerFn: () => ({
        enroll: async () => { throw new Error("never"); },
        renew: async () => { throw new Error("401 unauthorized"); },
      }),
    });
    try {
      await enrollOnce(d);
    } catch (err) {
      const e = err as EnrollmentAuthorityError;
      expect(e.message).not.toContain(CODE);
      expect(JSON.stringify({ m: e.message, w: e.workerId, t: e.targetId })).not.toContain("aoa_enr_");
    }
  });
});
