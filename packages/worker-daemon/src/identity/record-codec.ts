// packages/worker-daemon/src/identity/record-codec.ts
//
// WRK-014 (review F4) — the daemon's OWN record codec.
//
// `worker-keystore/src/envelope.ts` already encodes these records, but the
// keystore package is import-forbidden here (`check-worker-daemon-boundary.mjs`
// rejects any bare specifier outside the two-dependency pin), and re-using its
// codec would breach that boundary. So the daemon carries a structurally-
// equivalent copy, and the copy is what `FileRecordStore` serializes with.
//
// THE ONE PROPERTY THAT MATTERS. `DeviceIdentityRecord.privateKeyPkcs8Der` is a
// `Uint8Array`. `JSON.stringify` turns a `Uint8Array` into `{"0":48,"1":83,...}`
// and `JSON.parse` gives back a plain object, NOT bytes — so a naive round-trip
// hands `deviceKeyFromPkcs8Der` a non-buffer and it throws on every post-enrol
// boot: a crash-loop, which on the same target is the permanent lockout. The key
// is therefore base64-encoded explicitly, into a field NAMED so the daemon
// logger's redactor (`logging/logger.ts` SENSITIVE_SUBSTRINGS, `privatekey`)
// catches it if the record is ever accidentally logged.
//
// A partial or damaged record DECODES AS A THROW — never as half a record and
// never as absence. Absence is the filesystem's answer (ENOENT), not this codec's.

import type {
  DeviceEnrollmentReceipt,
  DeviceIdentityRecord,
} from "./device-identity-store.js";

/** Serialize a record to bytes and back. Decode throws (never partial, never null). */
export interface RecordCodec<T> {
  encode(record: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

/** Bumping this is a deliberate migration, not an accident. */
export const IDENTITY_RECORD_VERSION = 1;
export const RECEIPT_RECORD_VERSION = 1;

// Node-only package: `Buffer` is the base64 codec, and it is byte-exact for
// arbitrary `Uint8Array` input (unlike a JSON number-map round-trip).
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

/** Encoded on-disk shape of an identity record. The key field name is chosen so
 * the daemon logger's redactor masks it if the record is ever logged. */
interface EncodedIdentity {
  readonly v: number;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly privateKeyPkcs8B64: string;
}

interface EncodedReceipt {
  readonly v: number;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly deviceThumbprint: string;
}

function decodeJsonObject(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(bytes).trim();
  if (text.length === 0) throw new Error("record is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // No cause interpolation: the raw text holds the key on the identity path.
    throw new Error("record is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("record is not an object");
  }
  return parsed as Record<string, unknown>;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`record ${field} must be a positive integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`record ${field} is missing`);
  }
  return value;
}

export const identityRecordCodec: RecordCodec<DeviceIdentityRecord> = {
  encode(record: DeviceIdentityRecord): Uint8Array {
    if (record.privateKeyPkcs8Der.length === 0) {
      throw new Error("identity record: private key is required");
    }
    // Fixed key order ⇒ byte-stable encoding (a rewrite of the same record is
    // identical bytes), matching the crash-atomic write's expectation.
    const payload: EncodedIdentity = {
      v: IDENTITY_RECORD_VERSION,
      workerId: nonEmptyString(record.workerId, "workerId"),
      targetId: nonEmptyString(record.targetId, "targetId"),
      deviceGeneration: positiveInt(record.deviceGeneration, "deviceGeneration"),
      privateKeyPkcs8B64: toBase64(record.privateKeyPkcs8Der),
    };
    return new TextEncoder().encode(JSON.stringify(payload));
  },
  decode(bytes: Uint8Array): DeviceIdentityRecord {
    const parsed = decodeJsonObject(bytes) as Partial<EncodedIdentity>;
    if (parsed.v !== IDENTITY_RECORD_VERSION) {
      throw new Error(`identity record: unsupported version ${String(parsed.v)}`);
    }
    const workerId = nonEmptyString(parsed.workerId, "workerId");
    const targetId = nonEmptyString(parsed.targetId, "targetId");
    const deviceGeneration = positiveInt(parsed.deviceGeneration, "deviceGeneration");
    const keyB64 = nonEmptyString(parsed.privateKeyPkcs8B64, "privateKey");
    let der: Uint8Array;
    try {
      der = fromBase64(keyB64);
    } catch {
      throw new Error("identity record: private key is not valid base64");
    }
    if (der.length === 0) throw new Error("identity record: private key decoded empty");
    return { v: 1, workerId, targetId, deviceGeneration, privateKeyPkcs8Der: der };
  },
};

export const receiptRecordCodec: RecordCodec<DeviceEnrollmentReceipt> = {
  encode(record: DeviceEnrollmentReceipt): Uint8Array {
    const payload: EncodedReceipt = {
      v: RECEIPT_RECORD_VERSION,
      workerId: nonEmptyString(record.workerId, "workerId"),
      targetId: nonEmptyString(record.targetId, "targetId"),
      deviceGeneration: positiveInt(record.deviceGeneration, "deviceGeneration"),
      deviceThumbprint: nonEmptyString(record.deviceThumbprint, "deviceThumbprint"),
    };
    return new TextEncoder().encode(JSON.stringify(payload));
  },
  decode(bytes: Uint8Array): DeviceEnrollmentReceipt {
    const parsed = decodeJsonObject(bytes) as Partial<EncodedReceipt>;
    if (parsed.v !== RECEIPT_RECORD_VERSION) {
      throw new Error(`receipt record: unsupported version ${String(parsed.v)}`);
    }
    return {
      v: 1,
      workerId: nonEmptyString(parsed.workerId, "workerId"),
      targetId: nonEmptyString(parsed.targetId, "targetId"),
      deviceGeneration: positiveInt(parsed.deviceGeneration, "deviceGeneration"),
      deviceThumbprint: nonEmptyString(parsed.deviceThumbprint, "deviceThumbprint"),
    };
  },
};
