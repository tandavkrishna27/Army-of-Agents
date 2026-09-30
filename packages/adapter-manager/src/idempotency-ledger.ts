// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β1 — the durable, identity-namespaced idempotency ledger.
//
// The provider's own `#idempotency` map (`e2b-provider.ts:156`) is keyed by the
// worker-chosen `idempotencyKey` ALONE and sits BELOW the ownership gate — so a
// cross-identity replay of a key would hand tenant B tenant A's sandbox. This
// ledger is the server-layer authority that closes it: it is keyed by
// (IDENTITY, idempotencyKey), where identity is an UNAMBIGUOUS encoding of the
// verified capability's `ownedLabels`. The create-gate STRIPS `ctx.idempotencyKey`
// before `provider.create`, so this durable ledger is the SOLE idempotency layer.
//
// ★ IDENTITY IS THE ORDERED TUPLE, NOT `hashResourceLabels`. `hashResourceLabels`
// joins fields with a space (`provider.ts:158-167`) — non-injective: `org:"a",
// target:"b c"` and `org:"a b",target:"c"` collide, so two tenants would SHARE a
// namespace. B1 already rejected that space-join for AUTHORIZATION
// (`capability.ts:9-12`); the ledger must not reopen it. The logical key preserves
// every field boundary (a fixed-order JSON array), and the on-disk FILENAME is a
// SHA-256 over that unambiguous key — collision-resistant because its INPUT is.
//
// ★ THE STORE — the FileRecordStore write-once CAS IDIOM, REIMPLEMENTED here.
// `FileRecordStore` is not exported from the worker-daemon barrel, and the ledger
// must not import worker-daemon internals beyond the exported custody symbols. So
// this carries a structurally-equivalent per-key write: a UNIQUE temp -> fsync ->
// `link()` (the atomic compare-and-set: EEXIST == "already_present") -> **PARENT-DIR
// fsync**. The parent-dir fsync is the WRK-014 lesson (`file-record-store.ts:178`):
// without it a successfully-"stored" entry can be lost in the FS metadata-commit
// window on power loss. A reimplementation that drops it is silently wrong.
//
// ★ RUNTIME DIR IS CONFIGURED / OUT-OF-TREE (β1.7). The ledger dir is a runtime
// store, never a committed artifact — the server defaults it to an OS temp dir and
// a real deployment (β2) points it at a shared volume; the durability test writes
// to an OS temp dir, never the repo tree.
// -----------------------------------------------------------------------------

import {
  closeSync as realCloseSync,
  fsyncSync as realFsyncSync,
  linkSync as realLinkSync,
  mkdirSync as realMkdirSync,
  openSync as realOpenSync,
  readFileSync as realReadFileSync,
  unlinkSync as realUnlinkSync,
  writeSync as realWriteSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ResourceLabels } from "@armyofagents/worker-daemon";
import { STRICT_FILE_MODE, ownerOnlyViolation, type OwnerOnlyDeps } from "@armyofagents/worker-daemon";

/** The recorded value under a (identity, idempotencyKey) — the created sandbox. */
export interface LedgerRecord {
  readonly sandboxId: string;
  readonly resourceLabels: ResourceLabels;
}

/** The `node:fs` sync operations the ledger uses. Injectable in tests so the
 * crash-atomic write's SEQUENCE (incl. the parent-dir fsync) is exercisable without
 * a real power loss; the default is `node:fs` and every deployment uses it. */
export interface LedgerFs {
  readFileSync(path: string): Buffer;
  openSync(path: string, flags: string, mode: number): number;
  writeSync(fd: number, data: Uint8Array, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(existingPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
}

const REAL_FS: LedgerFs = {
  readFileSync: (path) => realReadFileSync(path),
  openSync: (path, flags, mode) => realOpenSync(path, flags, mode),
  writeSync: (fd, data, offset, length) => realWriteSync(fd, data, offset, length),
  fsyncSync: (fd) => realFsyncSync(fd),
  closeSync: (fd) => realCloseSync(fd),
  linkSync: (a, b) => realLinkSync(a, b),
  unlinkSync: (path) => realUnlinkSync(path),
  mkdirSync: (path, options) => {
    realMkdirSync(path, options);
  },
};

/** The closed failure mode of a ledger read. A corrupt / insecure-perms entry
 * THROWS (never returns a bogus record, never `null` — `null` means "no record"
 * and would re-provision), and the message names neither the path nor the value. */
export class IdempotencyLedgerError extends Error {
  constructor() {
    super("idempotency ledger entry is unreadable");
    this.name = "IdempotencyLedgerError";
  }
}

export interface IdempotencyLedgerOptions {
  /** The runtime directory the per-key files live in. Configured / out-of-tree. */
  readonly dir: string;
  /** Injected fs (tests). Merged over the real `node:fs` defaults. */
  readonly fs?: Partial<LedgerFs>;
  /** Injected custody platform/stat (tests). Defaults to the real platform. */
  readonly custody?: OwnerOnlyDeps;
  /** Strict-perm create mode (POSIX). Defaults to 0600. */
  readonly mode?: number;
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

export class IdempotencyLedger {
  readonly #dir: string;
  readonly #fs: LedgerFs;
  readonly #custody?: OwnerOnlyDeps;
  readonly #mode: number;

  constructor(options: IdempotencyLedgerOptions) {
    this.#dir = options.dir;
    this.#fs = { ...REAL_FS, ...options.fs };
    this.#custody = options.custody;
    this.#mode = options.mode ?? STRICT_FILE_MODE;
  }

  /**
   * The UNAMBIGUOUS logical key for (identity, idempotencyKey). Identity is the
   * verified capability's OWN labels flattened to a FIXED-ORDER array (field
   * boundaries preserved — unlike `hashResourceLabels`' space-join). Returned as a
   * string so it doubles as the per-key mutex key in the create-gate.
   */
  key(ownedLabels: ResourceLabels, idempotencyKey: string): string {
    const l = ownedLabels;
    // ★ The numeric fields (attempt, deviceGeneration) are assumed FINITE INTEGERS. A
    // non-finite value would JSON-stringify to "null" and could collide two identities in
    // this key while `labelsEqual` (===) treats them as distinct (the non-finite hygiene
    // class, cf. B1's expiresAt). That path is closed UPSTREAM twice over: the wire codec
    // serializes Infinity/NaN to null, which `isValidCapability` rejects as malformed
    // (`typeof === "number"` fails on null), and `labelsEqual` refuses a NaN attempt at the
    // create-gate label-match — so a non-finite identity can never reach this key over the
    // wire. Kept as an explicit invariant, not re-guarded here (defense already doubled).
    return JSON.stringify([
      [l.organizationId, l.targetId, l.workerId, l.jobId, l.attempt, l.leaseId, l.deviceGeneration],
      idempotencyKey,
    ]);
  }

  /** The recorded value for a logical key, or `null` if none. A corrupt / insecure
   * entry THROWS (never `null`). */
  lookup(logicalKey: string): LedgerRecord | null {
    const path = this.#pathFor(logicalKey);
    let raw: Buffer;
    try {
      raw = this.#fs.readFileSync(path);
    } catch (err) {
      // ENOENT is the ONLY path to `null` — a genuine "never recorded". Any other
      // read fault is a refusal, never absence.
      if (isErrno(err) && err.code === "ENOENT") return null;
      throw new IdempotencyLedgerError();
    }
    if (raw.byteLength === 0) throw new IdempotencyLedgerError();
    // Permission check BEFORE decode (win32: skipped — OS ACL enforces it).
    if (ownerOnlyViolation(path, this.#custody) !== null) throw new IdempotencyLedgerError();
    try {
      return decodeRecord(raw);
    } catch {
      throw new IdempotencyLedgerError();
    }
  }

  /**
   * Write-once record for a logical key. Returns `"stored"` on a first write, or
   * `"already_present"` when the slot is already taken (the `link()` EEXIST — the
   * compare-and-set). Never overwrites an existing entry.
   */
  record(logicalKey: string, value: LedgerRecord): "stored" | "already_present" {
    const path = this.#pathFor(logicalKey);
    const encoded = encodeRecord(value);
    this.#fs.mkdirSync(this.#dir, { recursive: true });

    // A UNIQUE temp name so a crash-orphaned temp can never wedge a later write.
    const temp = `${path}.${randomUUID()}.tmp`;

    // 1) Write the full record to the temp and fsync it durable BEFORE publish.
    let fd: number;
    try {
      fd = this.#fs.openSync(temp, "wx", this.#mode);
    } catch {
      throw new IdempotencyLedgerError();
    }
    try {
      let written = 0;
      while (written < encoded.length) {
        written += this.#fs.writeSync(fd, encoded, written, encoded.length - written);
      }
      this.#fs.fsyncSync(fd);
    } catch (err) {
      this.#fs.closeSync(fd);
      this.#bestEffortUnlink(temp);
      throw err instanceof IdempotencyLedgerError ? err : new IdempotencyLedgerError();
    }
    this.#fs.closeSync(fd);

    // 2) Atomically publish. `link()` fails EEXIST iff the slot is taken — the CAS.
    try {
      this.#fs.linkSync(temp, path);
    } catch (err) {
      this.#bestEffortUnlink(temp);
      if (isErrno(err) && err.code === "EEXIST") return "already_present";
      throw err instanceof IdempotencyLedgerError ? err : new IdempotencyLedgerError();
    }

    // 3) Make the new directory ENTRY durable, not just the inode data (WRK-014).
    this.#fsyncParentDir();
    this.#bestEffortUnlink(temp);
    return "stored";
  }

  /** `<dir>/<sha256(logicalKey)>.json`. The filename hash is collision-resistant
   * because its INPUT (the logical key) is unambiguous. */
  #pathFor(logicalKey: string): string {
    const fileName = createHash("sha256").update(logicalKey, "utf8").digest("hex");
    return join(this.#dir, `${fileName}.json`);
  }

  /** fsync the parent dir so the just-linked dirent survives power loss. BEST-EFFORT:
   * the record is already durable-enough to be correct; this tightens the window and
   * is swallowed on platforms (Windows) that reject a directory fsync. */
  #fsyncParentDir(): void {
    let dfd: number | undefined;
    try {
      // The ledger dir IS the parent of every per-key file — fsync it directly.
      dfd = this.#fs.openSync(this.#dir, "r", 0);
      this.#fs.fsyncSync(dfd);
    } catch {
      // best-effort — the write is already correct; this only tightens power-loss.
    } finally {
      if (dfd !== undefined) {
        try {
          this.#fs.closeSync(dfd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  #bestEffortUnlink(temp: string): void {
    try {
      this.#fs.unlinkSync(temp);
    } catch {
      // An orphaned temp cannot cause a wrong verdict — a later write uses a fresh
      // uuid and `lookup` reads only the final path.
    }
  }
}

// The on-disk shape is a fixed-order JSON object (byte-stable re-encode). The
// resourceLabels are management metadata (never customer data), stored verbatim so
// the check-after-create winner is returned faithfully.
interface EncodedRecord {
  readonly v: 1;
  readonly sandboxId: string;
  readonly resourceLabels: ResourceLabels;
}

function encodeRecord(record: LedgerRecord): Uint8Array {
  const payload: EncodedRecord = { v: 1, sandboxId: record.sandboxId, resourceLabels: record.resourceLabels };
  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodeRecord(bytes: Uint8Array): LedgerRecord {
  const text = new TextDecoder().decode(bytes).trim();
  if (text.length === 0) throw new IdempotencyLedgerError();
  const parsed = JSON.parse(text) as Partial<EncodedRecord>;
  if (parsed.v !== 1) throw new IdempotencyLedgerError();
  if (typeof parsed.sandboxId !== "string" || parsed.sandboxId.length === 0) throw new IdempotencyLedgerError();
  if (!isResourceLabels(parsed.resourceLabels)) throw new IdempotencyLedgerError();
  return { sandboxId: parsed.sandboxId, resourceLabels: parsed.resourceLabels };
}

function isResourceLabels(value: unknown): value is ResourceLabels {
  if (typeof value !== "object" || value === null) return false;
  const l = value as Record<string, unknown>;
  return (
    typeof l.organizationId === "string" &&
    typeof l.targetId === "string" &&
    typeof l.workerId === "string" &&
    typeof l.jobId === "string" &&
    typeof l.attempt === "number" &&
    typeof l.leaseId === "string" &&
    typeof l.deviceGeneration === "number"
  );
}
