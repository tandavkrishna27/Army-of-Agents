// packages/worker-keystore/src/identity-store.ts
//
// DSK-001 (D5, I2, I4) — the command-driven device identity store.
//
// This is where the classifier's six outcomes become behaviour. It holds no OS
// code itself: the `CommandRunner` is injected, so every invariant below is
// provable on the ubuntu-only REQUIRED lane. `command-runner.ts` is the single
// file in this package permitted to import `node:child_process` (D2), and it is
// mechanically confined by `scripts/check-worker-keystore-boundary.mjs` rather
// than by review.
//
// The store is SYNCHRONOUS because the daemon-side port it will eventually be
// adapted to is synchronous: `DeviceKeyStore.load(): DeviceKey | null`
// (`packages/worker-daemon/src/identity/key-store.ts:32-40`).
//
// NOTE — it is NOT structurally that port, and an earlier version of this comment
// implied it was. `DeviceKeyStore` is `load(): DeviceKey | null` + `save(key)` +
// `clear()`; this is `load(): DeviceIdentityRecord | null` + `saveIfAbsent(record)`
// + `clear()`. Different return type, different write method, different write
// semantics. An adapter is MANDATORY, and by the boundary rule it cannot live
// under `packages/worker-daemon/src` — no file there may name this package. The
// difference is deliberate: `DeviceKeyStore` persists a key with no `workerId`
// and its `save()` is a plain overwrite, so it can satisfy neither I6 (one
// artifact) nor I4 (compare-and-set).
//
// I2 — every outcome other than `present`/`absent` throws `DeviceKeyStoreError`.
//      `load()` never returns a key it could not authenticate, and never returns
//      `null` for a fault. `null` means NEVER ENROLLED to `loadOrCreateKey`
//      (`enrollment/enroll.ts:131-136`), which mints a fresh key and enrols a new
//      identity the server refuses forever.
//
// I4 — `saveIfAbsent` is compare-and-set, resolved by the OS via an exclusive
//      `CreateNew` open rather than by a check-then-act this code would have to
//      win. Two racing enrollers therefore yield exactly one surviving envelope.

import { classifyStoreOutcome, type StoreCommandResult } from "./outcome.js";
import {
  planVaultCommand,
  STORE_SUCCESS_SENTINEL,
  type VaultCommandPlan,
  type VaultRef,
} from "./command-plan.js";
import { decodeIdentityEnvelope, encodeIdentityEnvelope, type DeviceIdentityRecord } from "./envelope.js";

/**
 * Mirrors `DeviceKeyStoreError` from the worker-daemon port by NAME rather than
 * by import, so this package does not drag the daemon's module graph into a pure
 * unit test.
 *
 * CORRECTION — an earlier version of this comment claimed "the daemon's
 * fail-closed handling keys on the name". It does not. Grep confirms nothing in
 * `packages/worker-daemon/src` or `server/src` ever tests
 * `err.name === "DeviceKeyStoreError"`; the fail-closed property comes ENTIRELY
 * from the throw being UNCAUGHT.
 *
 * That matters for whoever wires this up: adding a broad `catch` anywhere around
 * the enroller silently regresses I3 ("a store that cannot open never results in
 * a new identity"), because there is no name check to fall back on. The name is
 * for humans reading logs; the guarantee is the uncaught throw.
 */
export class DeviceKeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceKeyStoreError";
  }
}

/** Runs one planned command. The ONLY seam through which an OS call happens. */
export interface CommandRunner {
  run(plan: VaultCommandPlan, stdin?: Uint8Array): StoreCommandResult;
}

export interface DeviceRecordStore<T> {
  /** The stored record, or `null` ONLY when the platform signalled absence. */
  load(): T | null;
  /** Compare-and-set. `already_present` means someone else won the race. */
  saveIfAbsent(record: T): "stored" | "already_present";
  /** Remove any stored record. Throws on a fault — a failed wipe is not success. */
  clear(): void;
}

/** The identity store: the general record store bound to the identity codec. */
export type DeviceIdentityStore = DeviceRecordStore<DeviceIdentityRecord>;

/** Base64 without depending on Node's Buffer, so the module stays runtime-neutral. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The record codec. Generalized so the identity blob and the enrollment receipt
 * share ONE store implementation: two near-identical stores would drift, and the
 * fault discipline here is the part that must never differ between them.
 */
export interface RecordCodec<T> {
  encode(record: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

const identityCodec: RecordCodec<DeviceIdentityRecord> = {
  encode: encodeIdentityEnvelope,
  decode: decodeIdentityEnvelope,
};

export function createOsRecordStore<T>(deps: {
  runner: CommandRunner;
  ref: VaultRef;
  platform: NodeJS.Platform | string;
  codec: RecordCodec<T>;
}): DeviceRecordStore<T> {
  const { runner, ref, platform, codec } = deps;

  return {
    load() {
      const outcome = classifyStoreOutcome(runner.run(planVaultCommand("load", ref, platform)));
      switch (outcome.kind) {
        case "absent":
          // The ONLY route to null. Everything below is a fault.
          return null;
        case "present":
          break;
        default:
          // I2. Softening any of these to `null` is the lockout bug.
          throw new DeviceKeyStoreError(
            `device identity store unusable (${outcome.kind}): ${outcome.detail}`,
          );
      }

      // The envelope arrived authenticated by the OS; it must still be a complete
      // record. A decode failure is a FAULT, never absence (I6).
      try {
        return codec.decode(fromBase64(new TextDecoder().decode(outcome.envelope)));
      } catch (err) {
        throw new DeviceKeyStoreError(
          `device record envelope is unusable: ${(err as Error).message}`,
        );
      }
    },

    saveIfAbsent(record) {
      const plan = planVaultCommand("store", ref, platform);
      // The record crosses STDIN (I5). `planVaultCommand` never sees it, so it
      // cannot appear in argv where a same-user process listing would read it.
      const stdin = new TextEncoder().encode(toBase64(codec.encode(record)));
      const result = runner.run(plan, stdin);

      // The exclusive-create refusal is a DISTINCT exit code, checked before the
      // generic classification: "someone else got here first" is a normal race
      // outcome, while every other non-zero exit is a genuine fault that must
      // throw. Conflating them would silently drop an enrollment and leave the
      // device unenrolled while reporting success.
      if (result.exitCode === plan.exitCodes.alreadyExists) return "already_present";

      // Success must be POSITIVE. This previously accepted
      // `corrupt && exitCode === 0` — i.e. it inferred a successful write from an
      // ABSENCE of output, the same inference-from-nothing shape that made the
      // absence oracle fail open. The script now emits a sentinel and we require it.
      const outcome = classifyStoreOutcome(result);
      if (
        outcome.kind === "present" &&
        new TextDecoder().decode(outcome.envelope).trim() === STORE_SUCCESS_SENTINEL
      ) {
        return "stored";
      }
      throw new DeviceKeyStoreError(
        `device identity store could not save (${outcome.kind}): ` +
          ("detail" in outcome ? outcome.detail : ""),
      );
    },

    clear() {
      const plan = planVaultCommand("delete", ref, platform);
      const result = runner.run(plan);
      const outcome = classifyStoreOutcome(result);
      // Deleting what is not there is success, not a fault.
      if (outcome.kind === "absent") return;
      if (outcome.kind === "present") return;
      if (outcome.kind === "corrupt" && result.exitCode === plan.exitCodes.ok) return;
      throw new DeviceKeyStoreError(
        `device identity store could not clear (${outcome.kind}): ` +
          ("detail" in outcome ? outcome.detail : ""),
      );
    },
  };
}

/**
 * The identity store. A thin alias so existing callers and tests are unchanged
 * while the implementation is shared with the receipt store.
 */
export function createOsIdentityStore(deps: {
  runner: CommandRunner;
  ref: VaultRef;
  platform: NodeJS.Platform | string;
}): DeviceIdentityStore {
  return createOsRecordStore({ ...deps, codec: identityCodec });
}
