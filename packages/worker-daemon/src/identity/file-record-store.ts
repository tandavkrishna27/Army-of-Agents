// packages/worker-daemon/src/identity/file-record-store.ts
//
// WRK-014 (Pivot 1) — a filesystem-backed `DeviceRecordStore<T>`.
//
// A shipped `mounted_secret` container has zero runtime key-load: it can hold a
// key but has nothing to be, so it can never enrol (SPIKE F1). `enrollOnce`
// consumes a `DeviceRecordStore` (`identityStore` + `receiptStore`) and persists
// the whole `DeviceIdentityRecord` — workerId, targetId, generation AND the key —
// as ONE artifact before the network call. This store is the container-side
// implementation of that port, over `node:fs` + `node:crypto` only, so it stays
// inside the daemon's two-dependency boundary (Pivot 2).
//
// Two invariants make this the safest code in the package to get wrong:
//
//   COMPARE-AND-SET, CRASH-ATOMICALLY. `saveIfAbsent` must never overwrite (two
//   processes racing a first enrol would present two identities, denied
//   permanently), and it must never leave a PARTIAL record at the final path (a
//   half-written record fails to decode forever = the lockout). Both fall out of
//   the same mechanism: write a UNIQUE temp file, `fsync` it, then `link()` it
//   into place. `link()` is atomic and fails EEXIST when the slot is taken — that
//   IS the compare-and-set — and the final path only ever appears fully formed.
//
//   FAIL CLOSED, CONTENT-FREE. The file holds the private key. A corrupt or
//   insecure-perms load THROWS (never returns a bogus record, never returns
//   `null` — `null` means "never enrolled" to the coordinator and mints a second
//   identity), and the thrown message names neither the key nor the path (I13).

import {
  closeSync as realCloseSync,
  fsyncSync as realFsyncSync,
  linkSync as realLinkSync,
  mkdirSync as realMkdirSync,
  openSync as realOpenSync,
  readFileSync as realReadFileSync,
  rmSync as realRmSync,
  unlinkSync as realUnlinkSync,
  writeSync as realWriteSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { ownerOnlyViolation, STRICT_FILE_MODE, type OwnerOnlyDeps } from "./file-custody.js";
import { DeviceKeyStoreError } from "./key-store.js";
import type { DeviceRecordStore } from "./device-identity-store.js";
import type { RecordCodec } from "./record-codec.js";

/** The `node:fs` sync operations this store uses. Injected in tests so the
 * crash-atomic write's SEQUENCE and its failure paths are exercisable without a
 * real power loss; the default is `node:fs` and every container uses it. */
export interface FileRecordStoreFs {
  readFileSync(path: string): Buffer;
  openSync(path: string, flags: string, mode: number): number;
  writeSync(fd: number, data: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(existingPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  rmSync(path: string, options: { force: boolean }): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
}

const REAL_FS: FileRecordStoreFs = {
  readFileSync: (path) => realReadFileSync(path),
  openSync: (path, flags, mode) => realOpenSync(path, flags, mode),
  writeSync: (fd, data, offset, length) => realWriteSync(fd, data, offset, length),
  fsyncSync: (fd) => realFsyncSync(fd),
  closeSync: (fd) => realCloseSync(fd),
  linkSync: (a, b) => realLinkSync(a, b),
  unlinkSync: (path) => realUnlinkSync(path),
  rmSync: (path, options) => realRmSync(path, options),
  mkdirSync: (path, options) => { realMkdirSync(path, options); },
};

export interface FileRecordStoreOptions<T> {
  readonly path: string;
  readonly codec: RecordCodec<T>;
  /** Strict-perm create mode (POSIX). Defaults to `0600`. */
  readonly mode?: number;
  /** Injected platform/stat for the permission check (testable on any OS). */
  readonly custody?: OwnerOnlyDeps;
  /** Injected fs (tests). Merged over the real `node:fs` defaults. */
  readonly fs?: Partial<FileRecordStoreFs>;
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

export class FileRecordStore<T> implements DeviceRecordStore<T> {
  private readonly path: string;
  private readonly codec: RecordCodec<T>;
  private readonly mode: number;
  private readonly custody?: OwnerOnlyDeps;
  private readonly fs: FileRecordStoreFs;

  constructor(options: FileRecordStoreOptions<T>) {
    this.path = options.path;
    this.codec = options.codec;
    this.mode = options.mode ?? STRICT_FILE_MODE;
    this.custody = options.custody;
    this.fs = { ...REAL_FS, ...options.fs };
  }

  load(): T | null {
    let raw: Buffer;
    try {
      raw = this.fs.readFileSync(this.path);
    } catch (err) {
      // ENOENT is the platform's positive "never enrolled" signal — the ONLY
      // path to `null`. Any other read fault is a refusal, not absence.
      if (isErrno(err) && err.code === "ENOENT") return null;
      throw new DeviceKeyStoreError("device record store is unreadable");
    }
    if (raw.byteLength === 0) {
      throw new DeviceKeyStoreError("device record store is empty");
    }
    // Permission check BEFORE decode, mirroring `MountedSecretKeyStore`: an
    // insecure file must be refused whether or not it happens to decode.
    if (ownerOnlyViolation(this.path, this.custody) !== null) {
      throw new DeviceKeyStoreError("device record store has insecure permissions");
    }
    try {
      return this.codec.decode(raw);
    } catch {
      // The codec's message may quote the raw bytes (which hold the key), so it
      // is DISCARDED — the fault surfaces content-free and path-free (I13).
      throw new DeviceKeyStoreError("device record store is corrupt");
    }
  }

  saveIfAbsent(record: T): "stored" | "already_present" {
    const encoded = this.codec.encode(record);
    this.fs.mkdirSync(dirname(this.path), { recursive: true });

    // A UNIQUE temp name: a fixed one left behind by a prior crash would wedge
    // every later save (its own `wx` open would EEXIST). The uuid guarantees a
    // fresh slot each attempt, so an orphaned temp is harmless.
    const temp = `${this.path}.${randomUUID()}.tmp`;

    // 1) Write the full record to the temp and fsync it durable BEFORE publish.
    let fd: number;
    try {
      fd = this.fs.openSync(temp, "wx", this.mode);
    } catch (err) {
      throw new DeviceKeyStoreError("device record store could not open a temp file");
    }
    try {
      let written = 0;
      while (written < encoded.length) {
        written += this.fs.writeSync(fd, encoded, written, encoded.length - written);
      }
      this.fs.fsyncSync(fd);
    } catch (err) {
      this.fs.closeSync(fd);
      this.bestEffortUnlink(temp);
      throw err instanceof DeviceKeyStoreError
        ? err
        : new DeviceKeyStoreError("device record store could not write a temp file");
    }
    this.fs.closeSync(fd);

    // 2) Atomically publish. `link()` fails EEXIST iff the slot is already taken
    //    — that is the compare-and-set. Either way the temp is removed after.
    try {
      this.fs.linkSync(temp, this.path);
    } catch (err) {
      this.bestEffortUnlink(temp);
      if (isErrno(err) && err.code === "EEXIST") return "already_present";
      throw err instanceof DeviceKeyStoreError
        ? err
        : new DeviceKeyStoreError("device record store could not publish a record");
    }
    // 3) Make the new directory ENTRY durable, not just the inode's data. Without
    //    this a successfully-"stored" identity can still be lost to power loss in
    //    the FS metadata-commit window, and a lost identity re-mints a workerId the
    //    server denies forever — the exact lockout the crash-atomic write exists to
    //    prevent (review MED). It completes the durable-publish idiom.
    this.fsyncParentDir();
    this.bestEffortUnlink(temp);
    return "stored";
  }

  clear(): void {
    this.fs.rmSync(this.path, { force: true });
  }

  /**
   * fsync the parent directory so the just-`link()`'d entry survives power loss.
   *
   * BEST-EFFORT: the record write already succeeded, so a failure here must never
   * fail the save. Some platforms (Windows) reject a directory fsync outright —
   * they throw on the open or the fsync, and it is swallowed. On the Linux
   * container (the real deployment) it commits the dirent, which is the point.
   */
  private fsyncParentDir(): void {
    let dfd: number | undefined;
    try {
      dfd = this.fs.openSync(dirname(this.path), "r", 0);
      this.fs.fsyncSync(dfd);
    } catch {
      // best-effort — the write is already durable-enough to be correct; this
      // only tightens the power-loss window.
    } finally {
      if (dfd !== undefined) {
        try { this.fs.closeSync(dfd); } catch { /* ignore */ }
      }
    }
  }

  /** Remove the temp file, ignoring a failure. The temp is orphaned at worst;
   * the durable record is whichever the `link()` outcome left at the final path. */
  private bestEffortUnlink(temp: string): void {
    try {
      this.fs.unlinkSync(temp);
    } catch {
      // An orphaned temp cannot cause a wrong verdict — a later save uses a fresh
      // uuid and `load()` reads only the final path.
    }
  }
}
