/**
 * Per-row authenticated encryption for the durable event outbox (WRK-006, D3).
 *
 * Each persisted `WorkerEventV1` JSON blob is sealed with `aes-256-gcm` from
 * `node:crypto` — the daemon's FIRST symmetric cipher. A per-row Data Encryption
 * Key (DEK) is derived from the long-lived Key Encryption Key (KEK) via
 * `hkdfSync("sha256", …)` over a per-row random salt, so no two rows share key
 * material and the KEK never encrypts a payload directly. Every row carries a
 * fresh 12-byte IV and the GCM auth tag alongside the ciphertext.
 *
 * FAIL CLOSED: a wrong KEK or any tampered byte (ciphertext, tag, iv, or salt —
 * the salt feeds the DEK, so a flipped salt yields the wrong DEK) makes
 * `decipher.final()` throw; we translate that to a {@link RowDecryptError} and
 * NEVER surface partial/garbage plaintext. The caller quarantines the row.
 *
 * Runtime imports: `node:crypto` only — the E4-D01 boundary.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** The KEK / DEK length for aes-256 (32 bytes). */
export const KEK_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/** HKDF `info` binding the DEK to this exact purpose + version. */
const DEK_INFO = Buffer.from("aoa-worker-event-outbox-dek-v1", "utf8");

/** The closed failure mode for any decryption fault (wrong key / tamper). */
export class RowDecryptError extends Error {
  constructor(message = "event outbox row failed authenticated decryption") {
    super(message);
    this.name = "RowDecryptError";
  }
}

/** The at-rest ciphertext components stored per outbox row. */
export interface EncryptedEventRow {
  /** Per-row HKDF salt (never reused). */
  readonly salt: Buffer;
  /** Per-row aes-256-gcm IV (12 bytes, never reused). */
  readonly iv: Buffer;
  /** The 16-byte GCM authentication tag. */
  readonly authTag: Buffer;
  /** The sealed payload bytes. */
  readonly ciphertext: Buffer;
}

function assertKek(kek: Buffer): void {
  if (!Buffer.isBuffer(kek) || kek.byteLength !== KEK_BYTES) {
    // Never echo key bytes.
    throw new Error(`event outbox KEK must be exactly ${KEK_BYTES} bytes`);
  }
}

/** Derive the per-row DEK from the KEK + salt (HKDF-SHA256). */
function deriveDek(kek: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", kek, salt, DEK_INFO, KEK_BYTES));
}

/**
 * Seal `plaintext` under a fresh per-row DEK/IV. The plaintext is the full
 * `WorkerEventV1` JSON bytes; nothing about the event is stored in the clear.
 */
export function encryptEventRow(plaintext: Buffer, kek: Buffer): EncryptedEventRow {
  assertKek(kek);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const dek = deriveDek(kek, salt);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { salt, iv, authTag, ciphertext };
}

/**
 * Open a sealed row. Throws {@link RowDecryptError} (fail closed) on a wrong KEK
 * or ANY tampered component — the GCM tag verification in `final()` is the gate.
 */
export function decryptEventRow(row: EncryptedEventRow, kek: Buffer): Buffer {
  assertKek(kek);
  if (row.authTag.byteLength !== AUTH_TAG_BYTES || row.iv.byteLength !== IV_BYTES) {
    throw new RowDecryptError("event outbox row has malformed iv/auth tag");
  }
  const dek = deriveDek(kek, row.salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, row.iv);
    decipher.setAuthTag(row.authTag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
  } catch {
    // Deliberately opaque: never include the (attempted) plaintext or key bytes.
    throw new RowDecryptError();
  }
}
