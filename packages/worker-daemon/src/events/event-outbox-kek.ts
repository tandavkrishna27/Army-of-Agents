/**
 * Key-Encryption-Key (KEK) custody for the durable event outbox (WRK-006, D3).
 *
 * The KEK is the long-lived secret from which each row's DEK is HKDF-derived
 * (`event-row-codec.ts`). Two sources are supported:
 *
 *  - {@link MountedSecretKekStore} — a 32-byte KEK in a mounted-secret file,
 *    generated on first use and persisted at `0600`. Custody mirrors
 *    `identity/key-store.ts` `MountedSecretKeyStore`: fail-closed on an
 *    unreadable / wrong-length / group-or-other-readable file, Windows-ACL-aware
 *    (the POSIX perm check is skipped on win32 where the OS default ACL enforces
 *    the invariant). It NEVER silently regenerates over a corrupt key (that would
 *    orphan every existing row under a new key → mass quarantine).
 *  - {@link deriveKekFromDeviceKey} — an HKDF over the device private key DER, so
 *    the KEK is bound to the device identity ("KEK from the device key material").
 *
 * Runtime imports: `node:crypto` + `node:fs` + `node:path` — the E4-D01 boundary.
 */

import { hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ownerOnlyViolation } from "../identity/file-custody.js";
import { dirname } from "node:path";

import { exportDevicePrivateKeyPkcs8Der, type DeviceKey } from "../identity/device-key.js";
import { KEK_BYTES } from "./event-row-codec.js";

const STRICT_FILE_MODE = 0o600;

/** HKDF params binding a device-derived KEK to this exact purpose + version. */
const DEVICE_KEK_SALT = Buffer.from("aoa-worker-event-outbox-kek-v1", "utf8");
const DEVICE_KEK_INFO = Buffer.from("event-outbox-kek", "utf8");

/** The closed failure mode for any KEK custody fault. */
export class EventOutboxKekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventOutboxKekError";
  }
}

/** The KEK custody port: return the 32-byte KEK (fail closed on any fault). */
export interface EventOutboxKekStore {
  load(): Buffer;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

/**
 * A 32-byte KEK stored in a mounted-secret file. Generated on first load,
 * persisted at `0600`, and loaded fail-closed thereafter.
 */
export class MountedSecretKekStore implements EventOutboxKekStore {
  private readonly path: string;
  private readonly mode: number;

  constructor(filePath: string, mode: number = STRICT_FILE_MODE) {
    this.path = filePath;
    this.mode = mode;
  }

  load(): Buffer {
    let raw: Buffer | null;
    try {
      raw = readFileSync(this.path);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") raw = null;
      else throw new EventOutboxKekError("event outbox KEK store is unreadable");
    }
    if (raw === null) return this.#generate();
    this.#assertSecurePermissions();
    if (raw.byteLength !== KEK_BYTES) {
      // Never regenerate over a corrupt key — that would orphan every stored row.
      throw new EventOutboxKekError("event outbox KEK store is corrupt (wrong length)");
    }
    return raw;
  }

  #generate(): Buffer {
    const kek = randomBytes(KEK_BYTES);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, kek, { mode: this.mode });
    try {
      chmodSync(this.path, this.mode);
    } catch {
      // Windows chmod cannot clear group/other bits; the OS default ACL enforces
      // the perm invariant there (mirrors MountedSecretKeyStore.save).
    }
    return kek;
  }

  /** Delegates to the shared `ownerOnlyViolation` (DSK-003 D2); see the twin comment in
   * `identity/key-store.ts`. The error type stays here — the classification is this
   * store's — and an unreadable file is now a refusal rather than a raw fs throw. */
  #assertSecurePermissions(): void {
    if (ownerOnlyViolation(this.path) !== null) {
      throw new EventOutboxKekError("event outbox KEK store has insecure permissions");
    }
  }
}

/** An injected raw KEK (tests / a device-derived KEK). Validates the length. */
export class StaticKek implements EventOutboxKekStore {
  readonly #kek: Buffer;
  constructor(kek: Buffer) {
    if (kek.byteLength !== KEK_BYTES) throw new EventOutboxKekError("KEK must be exactly 32 bytes");
    this.#kek = kek;
  }
  load(): Buffer {
    return this.#kek;
  }
}

/**
 * Derive a deterministic 32-byte KEK from the device private key (HKDF-SHA256).
 * Binds outbox encryption to the device identity — a re-enrolled device (new key)
 * cannot open a prior device's rows (they quarantine, fail closed).
 */
export function deriveKekFromDeviceKey(key: DeviceKey): Buffer {
  const ikm = exportDevicePrivateKeyPkcs8Der(key);
  return Buffer.from(hkdfSync("sha256", ikm, DEVICE_KEK_SALT, DEVICE_KEK_INFO, KEK_BYTES));
}
