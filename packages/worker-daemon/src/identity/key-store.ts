/**
 * Device key persistence (WRK-002).
 *
 * `DeviceKeyStore` is the custody port: `load()` returns the stored key or
 * `null` (never enrolled yet), and FAILS CLOSED (throws `DeviceKeyStoreError`)
 * on any corrupt/unreadable/wrong-permission store — the daemon must exit
 * non-zero rather than silently regenerate a key and re-enroll under a new
 * identity. `MountedSecretKeyStore` persists raw PKCS8 DER to a mounted-secret
 * file at strict `0600` perms (container deployment). `InMemoryKeyStore` is the
 * OS-keychain STUB for tests — the real `os_keychain` binding is DSK-001/002 and
 * out of scope here. No path logs the private key; only the SOURCE + thumbprint
 * are observable.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ownerOnlyViolation } from "./file-custody.js";
import { dirname } from "node:path";

import {
  deviceKeyFromPkcs8Der,
  exportDevicePrivateKeyPkcs8Der,
  type DeviceKey,
} from "./device-key.js";

/** The closed failure mode for any custody fault (fail-closed at load). */
export class DeviceKeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceKeyStoreError";
  }
}

export interface DeviceKeyStore {
  /** Load the stored device key, or `null` if none exists. Throws (fail closed)
   * on a corrupt/unreadable/insecure store — never returns a bogus key. */
  load(): DeviceKey | null;
  /** Persist the device key (private material to a strict-perm sink). */
  save(key: DeviceKey): void;
  /** Remove any stored key. */
  clear(): void;
}

/**
 * The OS-keychain custody port. The real platform binding (macOS Keychain,
 * Windows DPAPI/Credential Manager, libsecret) is DSK-001/002; WRK-002 ships the
 * interface only and the in-memory stub below. It is structurally a
 * `DeviceKeyStore`.
 */
export type OsKeychainKeyStore = DeviceKeyStore;

const STRICT_FILE_MODE = 0o600;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

/**
 * A device key stored as raw PKCS8 DER in a mounted-secret file. Loads fail
 * closed on unreadable/corrupt/insecure files; saves clamp perms to `0600`.
 */
export class MountedSecretKeyStore implements DeviceKeyStore {
  private readonly path: string;
  private readonly mode: number;

  constructor(filePath: string, mode: number = STRICT_FILE_MODE) {
    this.path = filePath;
    this.mode = mode;
  }

  load(): DeviceKey | null {
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return null;
      throw new DeviceKeyStoreError("device key store is unreadable");
    }
    if (raw.byteLength === 0) {
      throw new DeviceKeyStoreError("device key store is empty");
    }
    this.assertSecurePermissions();
    try {
      return deviceKeyFromPkcs8Der(raw);
    } catch {
      throw new DeviceKeyStoreError("device key store is corrupt");
    }
  }

  save(key: DeviceKey): void {
    const der = exportDevicePrivateKeyPkcs8Der(key);
    mkdirSync(dirname(this.path), { recursive: true });
    // Create with strict perms, then chmod to defend against a pre-existing lax
    // file (writeFileSync mode is only applied on CREATE).
    writeFileSync(this.path, der, { mode: this.mode });
    try {
      chmodSync(this.path, this.mode);
    } catch {
      // Windows chmod cannot clear group/other bits; the POSIX perm invariant is
      // enforced by the OS default ACL there, so a chmod failure is non-fatal.
    }
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  /** On POSIX, refuse a key file readable by group/other (fail closed). Windows
   * cannot represent these bits via `chmod`, so the check is skipped there.
   *
   * Delegates to the shared `ownerOnlyViolation` (DSK-003 D2) — this file and
   * `events/event-outbox-kek.ts` carried byte-identical copies of the comparison. The
   * ERROR TYPE stays here, because the classification is this store's, not the rule's.
   * An unreadable file is also a refusal: the previous inline version let `statSync`
   * throw a raw fs error out of a security check, which is a worse failure to read. */
  private assertSecurePermissions(): void {
    if (ownerOnlyViolation(this.path) !== null) {
      throw new DeviceKeyStoreError("device key store has insecure permissions");
    }
  }
}

/**
 * In-memory device key store — the OS-keychain stub for tests. Stores the same
 * PKCS8 DER bytes the mounted store persists, so it exercises the identical
 * serialize/deserialize path and fails closed on injected corruption.
 */
export class InMemoryKeyStore implements OsKeychainKeyStore {
  #stored: Buffer | null = null;

  load(): DeviceKey | null {
    if (this.#stored === null) return null;
    try {
      return deviceKeyFromPkcs8Der(this.#stored);
    } catch {
      throw new DeviceKeyStoreError("device key store is corrupt");
    }
  }

  save(key: DeviceKey): void {
    this.#stored = exportDevicePrivateKeyPkcs8Der(key);
  }

  clear(): void {
    this.#stored = null;
  }

  /** Test-only: seed corrupt material to prove the store fails closed. */
  injectCorruptForTest(bytes: Buffer): void {
    this.#stored = bytes;
  }
}
