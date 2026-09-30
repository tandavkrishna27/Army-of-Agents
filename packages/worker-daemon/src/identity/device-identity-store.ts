// packages/worker-daemon/src/identity/device-identity-store.ts
//
// DSK-001 — the custody PORT, declared structurally so nothing here names
// `@armiesofagents/worker-keystore`.
//
// The boundary rule is exact: `scripts/check-worker-daemon-boundary.mjs` walks
// `packages/worker-daemon/src` and rejects a bare specifier the moment a file
// there names one outside the two-dependency pin. So the daemon declares the
// SHAPE it needs and the host injects an implementation that happens to satisfy
// it. The keystore package's `DeviceIdentityStore` is structurally identical by
// construction, not by import.
//
// **Why this port exists rather than reusing `DeviceKeyStore`.** That port is
// `load(): DeviceKey | null` + `save(key)` + `clear()`: it persists a key with no
// `workerId`, and its `save()` is an unconditional overwrite. It can satisfy
// neither I6 (identity and key are ONE artifact) nor I7's compare-and-set. The
// two ports coexist deliberately; `frozenDeviceKeyView` below is the adapter.

import type { DeviceKey } from "./device-key.js";
import type { DeviceKeyStore } from "./key-store.js";

/** The persisted device identity. One artifact — never half of one (I6). */
export interface DeviceIdentityRecord {
  readonly v: 1;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly privateKeyPkcs8Der: Uint8Array;
}

/** Proof that an enrolment completed, so a steady-state boot skips the network. */
export interface DeviceEnrollmentReceipt {
  readonly v: 1;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly deviceThumbprint: string;
}

/**
 * A compare-and-set record store.
 *
 * `saveIfAbsent` rather than `save` is the whole point: with a plain overwrite,
 * two processes racing a first enrolment both believe they stored, and the device
 * ends up presenting two identities — which the server denies permanently.
 */
export interface DeviceRecordStore<T> {
  /** The record, or `null` ONLY when the platform positively signalled absence. */
  load(): T | null;
  saveIfAbsent(record: T): "stored" | "already_present";
  clear(): void;
}

/**
 * Adapt an already-resolved key into the `DeviceKeyStore` the enroller expects.
 *
 * This is I3's mechanism, and it is structural. `loadOrCreateKey`
 * (`enrollment/enroll.ts:131-136`) mints a fresh key whenever `load()` returns
 * `null` — and it is reachable from BOTH `enroll()` and `renew()`, so there are
 * two mint entry points through one function. A view whose `load()` ALWAYS
 * answers makes that branch unreachable: the coordinator has already decided
 * which identity is in play, and the enroller cannot invent another.
 *
 * `save` and `clear` are no-ops because custody does not belong to the enroller.
 * They are deliberately silent rather than throwing: `submit` calls
 * `loadOrCreateKey` on every call, and a throwing `save` would turn a benign
 * no-op into a failed enrolment.
 */
/**
 * The two concrete instantiations, named so a host outside this package can
 * declare what it is composing in without spelling the generic each time — and
 * so the keystore side can prove assignability at compile time instead of with a
 * cast. An earlier `as never` at that composition root hid a genuine record-shape
 * mismatch; naming the types is what makes the compiler the standing guard.
 */
export type DeviceIdentityStore = DeviceRecordStore<DeviceIdentityRecord>;
export type DeviceReceiptStore = DeviceRecordStore<DeviceEnrollmentReceipt>;

export function frozenDeviceKeyView(key: DeviceKey): DeviceKeyStore {
  return Object.freeze({
    load: () => key,
    save: () => {},
    clear: () => {},
  });
}

/** What custody mode the daemon should run in, decided BEFORE any I/O. */
export type CustodyVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * I11 — decide custody from config alone, purely, so the daemon can exit
 * non-zero BEFORE it opens a socket.
 *
 * `keyStoreMode` is read today only to be logged (`bin/worker-daemon.ts:121`);
 * nothing constructs a store from it. So a deployment configured for
 * `os_keychain` with no injected store would previously start, open its health
 * listener, and only discover it has no custody when something tried to enrol.
 * Pure and total so the decision is provable without a filesystem or a socket.
 */
export function resolveCustody(
  mode: string,
  identityStore: DeviceRecordStore<DeviceIdentityRecord> | undefined,
  receiptStore: DeviceRecordStore<DeviceEnrollmentReceipt> | undefined,
): CustodyVerdict {
  if (mode === "os_keychain") {
    if (!identityStore) {
      return { kind: "refuse", reason: "keyStoreMode is os_keychain but no identity store was injected" };
    }
    if (!receiptStore) {
      return { kind: "refuse", reason: "keyStoreMode is os_keychain but no receipt store was injected" };
    }
    return { kind: "ok" };
  }
  if (mode === "mounted_secret") {
    // Plan §4/D3 row 2. A store injected under `mounted_secret` is a
    // CONTRADICTORY configuration, and refusing is better than quietly ignoring
    // it: `MountedSecretKeyStore` persists PKCS8 DER with no `workerId` slot
    // (`identity/key-store.ts:89-101`), so anything that went on to enrol
    // against it would ship exactly the torn-identity hazard I6 exists to
    // prevent. The operator should learn at boot, before a socket is bound —
    // not from a worker that reports healthy and never enrols.
    //
    // This row did not ship originally, and nothing caught it until a mutation
    // showed that removing the enrolment block's mode gate left the suite green:
    // no test had ever put a store and `mounted_secret` together.
    if (identityStore) {
      return { kind: "refuse", reason: "keyStoreMode is mounted_secret but an identity store was injected" };
    }
    if (receiptStore) {
      return { kind: "refuse", reason: "keyStoreMode is mounted_secret but a receipt store was injected" };
    }
    return { kind: "ok" };
  }
  if (mode === "file_record") {
    // WRK-014 §3 — the DISTINCT container-custody mode (added because v1's
    // "amend `mounted_secret` to admit a DeviceRecordStore" was infeasible: both
    // params are typed `DeviceRecordStore`, so this function cannot tell a
    // record store from a key store — a `DeviceKeyStore` can never reach here).
    //
    // Unlike `mounted_secret`, a `file_record` container DECLARES it will persist
    // an identity, so BOTH stores are required. Exactly one is the torn-config
    // hazard (an identity with nowhere to write its receipt, or vice versa); none
    // is a misconfigured host. Both → ok; anything else → refuse, pre-socket.
    if (!identityStore) {
      return { kind: "refuse", reason: "keyStoreMode is file_record but no identity store was injected" };
    }
    if (!receiptStore) {
      return { kind: "refuse", reason: "keyStoreMode is file_record but no receipt store was injected" };
    }
    return { kind: "ok" };
  }
  // An unknown mode fails closed. A future mode this build does not understand
  // must not silently fall back to a weaker custody model.
  return { kind: "refuse", reason: `unknown keyStoreMode ${JSON.stringify(mode)}` };
}
