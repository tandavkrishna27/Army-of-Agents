// packages/worker-keystore/src/envelope.ts
//
// DSK-001 (I6) — the device identity as ONE artifact.
//
// `workerId` and the private key are encoded together and decoded together. No
// stored state may ever hold one without the other, because either half alone
// leads to the same unrecoverable place: a device with a key but no `workerId`
// mints a `workerId`; a device with a `workerId` but no key mints a key. Both
// enrol a NEW identity, the server denies it permanently
// (`worker-enrollment.ts:418-423` `worker_transfer_denied`), and because
// `findWorkerForBinding` filters on scope / target / organization / owner with no
// status predicate, the stale row keeps matching forever with no reset route.
//
// So a partial or damaged record decodes as a THROW — never as half a record and,
// critically, never as absence. Absence is the filesystem's answer (ENOENT), not
// this codec's.
//
// The plaintext form exists only inside the OS-protected envelope: this record is
// what gets handed to DPAPI `Protect`, never what is written unprotected to disk.

/** Bumping this is a deliberate migration, not an accident. */
export const IDENTITY_ENVELOPE_VERSION = 1;

/**
 * The FIVE-field record, structurally identical to the daemon's port record
 * (`worker-daemon/src/identity/device-identity-store.ts`).
 *
 * An earlier version carried only `workerId` and the key, and a `as never` cast
 * at the composition root hid the mismatch from the compiler. That was not a
 * cosmetic gap: `targetId` is what the coordinator's "persisted identity belongs
 * to a different target" refusal reads, so dropping it makes that comparison
 * evaluate against `undefined` and THROW on every subsequent boot — leaving
 * `--reset-identity` (a second mint, denied permanently) as the only way out.
 * `deviceGeneration` is compared by the server for exact equality.
 *
 * Design D7 and the plan's remedy A4(iv) both specify these fields. The cast is
 * gone, so the compiler is the standing guard against the shapes diverging again.
 */
export interface DeviceIdentityRecord {
  readonly v: 1;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly privateKeyPkcs8Der: Uint8Array;
}

/**
 * The key-bearing field is named to be CAUGHT by the daemon logger's redactor,
 * not to slip past a scanner.
 *
 * This was `k`, justified by the frozen wire-safety normalizer
 * (`packages/worker-protocol/src/wire-safety.ts:18-31`). That justification cited
 * the wrong guard. The record never travels the wire — the entire design keeps it
 * on local disk under OS custody — so the wire normalizer never runs on it. The
 * guard that actually applies to a stray diagnostic is the daemon logger's
 * `SENSITIVE_SUBSTRINGS` (`worker-daemon/src/logging/logger.ts:37-49`), and
 * optimising for the scan that never runs made the field invisible to the scan
 * that does: `k` normalizes to `k` and matches nothing in that list, so logging
 * the envelope would print the base64 private key in full.
 *
 * `privateKeyPkcs8B64` normalizes to `privatekeypkcs8b64`, which contains
 * `privatekey` and is therefore redacted. Plan §1D specifies this name.
 *
 * `v` stays 1: zero devices are enrolled, so there is no corpus to migrate.
 */
interface EncodedEnvelope {
  readonly v: number;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly privateKeyPkcs8B64: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeIdentityEnvelope(record: DeviceIdentityRecord): Uint8Array {
  if (!record.workerId) throw new Error("identity envelope: workerId is required");
  if (!record.targetId) throw new Error("identity envelope: targetId is required");
  if (!Number.isInteger(record.deviceGeneration) || record.deviceGeneration < 1) {
    throw new Error("identity envelope: deviceGeneration must be a positive integer");
  }
  if (record.privateKeyPkcs8Der.length === 0) {
    throw new Error("identity envelope: private key is required");
  }
  // Key order is fixed so the encoding is byte-stable across calls — a stable
  // artifact means a rewrite that changes nothing produces identical bytes.
  const payload: EncodedEnvelope = {
    v: IDENTITY_ENVELOPE_VERSION,
    workerId: record.workerId,
    targetId: record.targetId,
    deviceGeneration: record.deviceGeneration,
    privateKeyPkcs8B64: toBase64(record.privateKeyPkcs8Der),
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Decode, or throw. Never returns a partial record.
 *
 * Every rejection here is a FAULT for the caller to surface as
 * `DeviceKeyStoreError` — none of them may be softened into `null`, because
 * `null` means *never enrolled* to `loadOrCreateKey` and that mints a new
 * identity.
 */
export function decodeIdentityEnvelope(bytes: Uint8Array): DeviceIdentityRecord {
  const text = new TextDecoder().decode(bytes).trim();
  if (text.length === 0) throw new Error("identity envelope: empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`identity envelope: not valid JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("identity envelope: not an object");
  }

  const {
    v,
    workerId,
    targetId,
    deviceGeneration,
    privateKeyPkcs8B64: keyB64,
  } = parsed as Partial<EncodedEnvelope>;
  if (v !== IDENTITY_ENVELOPE_VERSION) {
    throw new Error(`identity envelope: unsupported version ${String(v)}`);
  }
  if (typeof workerId !== "string" || workerId.length === 0) {
    throw new Error("identity envelope: missing workerId");
  }
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("identity envelope: missing targetId");
  }
  if (
    typeof deviceGeneration !== "number" ||
    !Number.isInteger(deviceGeneration) ||
    deviceGeneration < 1
  ) {
    throw new Error("identity envelope: deviceGeneration must be a positive integer");
  }
  if (typeof keyB64 !== "string" || keyB64.length === 0) {
    throw new Error("identity envelope: missing private key");
  }

  let der: Uint8Array;
  try {
    der = fromBase64(keyB64);
  } catch {
    throw new Error("identity envelope: private key is not valid base64");
  }
  if (der.length === 0) throw new Error("identity envelope: private key decoded empty");

  return { v: 1, workerId, targetId, deviceGeneration, privateKeyPkcs8Der: der };
}
