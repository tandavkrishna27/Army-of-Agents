// WRK-014 §6.1 — FileRecordStore round-trip + fail-closed + crash-atomic.
//
// A container `mounted_secret` worker has zero runtime key-load and can never
// enrol (SPIKE F1). WRK-014's `FileRecordStore<T>` is the filesystem-backed
// `DeviceRecordStore` a container host injects so enrolment can persist an
// identity inline (Pivot 1). Three properties carry the weight, and every one is
// a lockout generator if it is wrong:
//
//   THE CODEC MUST NOT CORRUPT THE KEY. `DeviceIdentityRecord.privateKeyPkcs8Der`
//   is a `Uint8Array`; a naive JSON round-trip turns it into `{"0":12,...}` and
//   `deviceKeyFromPkcs8Der` then throws on every post-enrol boot — a crash-loop
//   (review F4). Proven here against a REAL Ed25519 key, byte-for-byte.
//
//   THE WRITE MUST BE CRASH-ATOMIC. A bare `wx` open leaves a PARTIAL file at the
//   final path on a mid-write crash, which fails to decode forever (review MED).
//   The store writes a unique temp → fsync → atomic `link()` → unlink temp, so the
//   final path only ever appears fully formed, and `saveIfAbsent`'s compare-and-set
//   is the `link()` EEXIST.
//
//   A FAULT NEVER LEAKS THE KEY OR THE PATH. The file holds the private key, so a
//   corrupt/insecure-perms load fails closed with a CONTENT-FREE, PATH-FREE message
//   (review F3, I13-adjacent), exactly like `DeviceKeyStoreError` already does.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileRecordStore } from "../identity/file-record-store.js";
import { identityRecordCodec, receiptRecordCodec } from "../identity/record-codec.js";
import { DeviceKeyStoreError } from "../identity/key-store.js";
import {
  generateDeviceKey,
  exportDevicePrivateKeyPkcs8Der,
  deviceKeyFromPkcs8Der,
} from "../identity/device-key.js";
import type {
  DeviceEnrollmentReceipt,
  DeviceIdentityRecord,
} from "../identity/device-identity-store.js";

const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TARGET_ID = "a3000000-0000-4000-8000-000000000003";

// A REAL Ed25519 key fixture — the whole point of §6.1. The base64 of these
// bytes is the string that must never appear in a thrown message or a log line.
const realKey = generateDeviceKey();
const realDer = exportDevicePrivateKeyPkcs8Der(realKey);

function identityRecord(over: Partial<DeviceIdentityRecord> = {}): DeviceIdentityRecord {
  return {
    v: 1,
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    deviceGeneration: 1,
    privateKeyPkcs8Der: realDer,
    ...over,
  };
}

function receiptRecord(over: Partial<DeviceEnrollmentReceipt> = {}): DeviceEnrollmentReceipt {
  return {
    v: 1,
    workerId: WORKER_ID,
    targetId: TARGET_ID,
    deviceGeneration: 1,
    deviceThumbprint: realKey.deviceThumbprint,
    ...over,
  };
}

let dir: string;
let identityPath: string;
let receiptPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wrk014-frs-"));
  identityPath = join(dir, "identity.json");
  receiptPath = join(dir, "receipt.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function identityStore() {
  return new FileRecordStore<DeviceIdentityRecord>({ path: identityPath, codec: identityRecordCodec });
}

describe("WRK-014/§6.1 — round-trip against a real Ed25519 key", () => {
  it("returns null when the file is absent (platform-signalled absence)", () => {
    expect(identityStore().load()).toBeNull();
  });

  it("saveIfAbsent then load is byte-equal, and the key still reconstructs", () => {
    const store = identityStore();
    expect(store.saveIfAbsent(identityRecord())).toBe("stored");

    const loaded = store.load();
    expect(loaded).not.toBeNull();
    // Byte-for-byte: the codec must not corrupt the Uint8Array (review F4).
    expect(Buffer.from(loaded!.privateKeyPkcs8Der).equals(Buffer.from(realDer))).toBe(true);
    expect(loaded!.workerId).toBe(WORKER_ID);
    expect(loaded!.targetId).toBe(TARGET_ID);
    expect(loaded!.deviceGeneration).toBe(1);
    // And the reconstructed key is REAL — a working key with the same thumbprint.
    expect(deviceKeyFromPkcs8Der(loaded!.privateKeyPkcs8Der).deviceThumbprint).toBe(
      realKey.deviceThumbprint,
    );
  });

  it("a receipt record round-trips through the same generic store", () => {
    const store = new FileRecordStore<DeviceEnrollmentReceipt>({
      path: receiptPath,
      codec: receiptRecordCodec,
    });
    expect(store.saveIfAbsent(receiptRecord())).toBe("stored");
    expect(store.load()).toEqual(receiptRecord());
  });

  it("clear() removes the record so load() returns null again", () => {
    const store = identityStore();
    store.saveIfAbsent(identityRecord());
    expect(store.load()).not.toBeNull();
    store.clear();
    expect(store.load()).toBeNull();
    expect(existsSync(identityPath)).toBe(false);
  });
});

describe("WRK-014/§6.1 — saveIfAbsent is compare-and-set (never an overwrite)", () => {
  it("a second saveIfAbsent returns already_present and does NOT overwrite", () => {
    const store = identityStore();
    expect(store.saveIfAbsent(identityRecord())).toBe("stored");
    const firstBytes = readFileSync(identityPath);

    // A different record for the SAME slot must be refused, byte-for-byte unchanged.
    const other = identityRecord({ workerId: "99999999-4f89-41d3-9a0c-0305e82c3301" });
    expect(store.saveIfAbsent(other)).toBe("already_present");
    expect(readFileSync(identityPath).equals(firstBytes)).toBe(true);
    expect(store.load()!.workerId).toBe(WORKER_ID);
  });
});

describe("WRK-014/§6.1 — the write is crash-atomic (temp → fsync → link)", () => {
  it("the durable-publish sequence: temp write → fsync → link → PARENT-DIR fsync (fully faked, deterministic)", () => {
    // The full idiom: fsync the temp's DATA, atomically link it into place, then
    // fsync the PARENT DIRECTORY so the new dirent is durable too. Without the
    // last step a successfully-"stored" identity can still be lost to power loss
    // in the FS metadata-commit window → next boot re-mints → permanent
    // worker_transfer_denied (review MED). Fully faked so the order is identical
    // on every platform (a real directory fsync is best-effort — Windows rejects it).
    const order: string[] = [];
    let fakeFd = 10;
    const store = new FileRecordStore<DeviceIdentityRecord>({
      path: identityPath,
      codec: identityRecordCodec,
      fs: {
        mkdirSync: () => {},
        openSync: (_p, flags) => { order.push(flags.includes("w") ? "open:temp" : "open:dir"); return fakeFd++; },
        writeSync: (_fd, _data, _off, len) => { order.push("write"); return len; },
        fsyncSync: () => { order.push("fsync"); },
        closeSync: () => { order.push("close"); },
        linkSync: () => { order.push("link"); },
        unlinkSync: () => { order.push("unlink"); },
      },
    });
    expect(store.saveIfAbsent(identityRecord())).toBe("stored");
    expect(order).toEqual([
      "open:temp", "write", "fsync", "close", "link", "open:dir", "fsync", "close", "unlink",
    ]);
  });

  it("the temp is really written + fsync'd before the real link, and no temp is left behind (real fs)", () => {
    const order: string[] = [];
    const store = new FileRecordStore<DeviceIdentityRecord>({
      path: identityPath,
      codec: identityRecordCodec,
      fs: {
        openSync: (p, flags, mode) => {
          if (String(p).endsWith(".tmp")) order.push("open:temp");
          return realOpen(p, flags, mode);
        },
        fsyncSync: (fd) => { order.push("fsync"); realFsync(fd); },
        linkSync: (a, b) => { order.push("link"); realLink(a, b); },
      },
    });
    expect(store.saveIfAbsent(identityRecord())).toBe("stored");
    // The temp is opened + fsync'd, and only THEN is the final path linked into place.
    expect(order.slice(0, 3)).toEqual(["open:temp", "fsync", "link"]);
    expect(store.load()).not.toBeNull();
    expect(readdirTemps(dir)).toEqual([]);
  });

  it("a crash between temp-write and link leaves the FINAL path absent — load() is null, not a partial", () => {
    const store = new FileRecordStore<DeviceIdentityRecord>({
      path: identityPath,
      codec: identityRecordCodec,
      // Simulate a power-loss the instant before the atomic publish.
      fs: { linkSync: () => { throw new Error("simulated crash before link"); } },
    });
    expect(() => store.saveIfAbsent(identityRecord())).toThrow();
    // The final path never received a partial write.
    expect(existsSync(identityPath)).toBe(false);
    expect(identityStore().load()).toBeNull();
    // The orphaned temp does not wedge a later save (fresh unique name).
    expect(identityStore().saveIfAbsent(identityRecord())).toBe("stored");
  });

  it("a lost compare-and-set race (link EEXIST) reports already_present without overwriting", () => {
    const store = identityStore();
    store.saveIfAbsent(identityRecord()); // winner writes the final path

    // A second store whose link ALWAYS reports EEXIST (a concurrent winner).
    const loser = new FileRecordStore<DeviceIdentityRecord>({
      path: identityPath,
      codec: identityRecordCodec,
      fs: {
        linkSync: () => {
          const err = new Error("EEXIST") as NodeJS.ErrnoException;
          err.code = "EEXIST";
          throw err;
        },
      },
    });
    expect(loser.saveIfAbsent(identityRecord({ workerId: "loser-worker-id" }))).toBe("already_present");
    // The winner's record survives, and the loser cleaned up its temp.
    expect(store.load()!.workerId).toBe(WORKER_ID);
    expect(readdirTemps(dir)).toEqual([]);
  });
});

describe("WRK-014/§6.1 — load() fails closed, content-free and path-free (I13)", () => {
  it("throws DeviceKeyStoreError on a corrupt file, echoing neither the key nor the path", () => {
    // Corrupt bytes at the final path (a truncated/garbled record).
    writeFileSync(identityPath, "{ not valid json", { mode: 0o600 });
    let thrown: unknown;
    try {
      identityStore().load();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DeviceKeyStoreError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(identityPath);
    expect(message).not.toContain(dir);
  });

  it("throws with a message free of the private key even when a well-formed record is on disk", () => {
    // Save a real record, then force the DECODE to fail so the fault path runs with
    // the real key present in the file. The message must never carry the key bytes.
    identityStore().saveIfAbsent(identityRecord());
    const keyB64 = Buffer.from(realDer).toString("base64");
    const store = new FileRecordStore<DeviceIdentityRecord>({
      path: identityPath,
      codec: {
        encode: identityRecordCodec.encode,
        decode: () => { throw new Error("decode blew up"); },
      },
    });
    let thrown: unknown;
    try {
      store.load();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DeviceKeyStoreError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(keyB64);
    expect(message).not.toContain(identityPath);
  });

  it("throws on insecure permissions (POSIX), content-free — proven via an injected stat", () => {
    // `ownerOnlyViolation` is a no-op on win32, so the branch is forced with an
    // injected linux platform + a group/other-readable mode, testable on any OS.
    identityStore().saveIfAbsent(identityRecord());
    const store = new FileRecordStore<DeviceIdentityRecord>({
      path: identityPath,
      codec: identityRecordCodec,
      custody: { platform: "linux", stat: () => ({ mode: 0o644 }) },
    });
    expect(() => store.load()).toThrow(DeviceKeyStoreError);
    try {
      store.load();
    } catch (err) {
      expect((err as Error).message).not.toContain(identityPath);
    }
  });

  it("throws on an empty file rather than treating it as absence", () => {
    writeFileSync(identityPath, "", { mode: 0o600 });
    expect(() => identityStore().load()).toThrow(DeviceKeyStoreError);
  });
});

// --- real-fs helpers, bound once so the injected spies can delegate ----------
import { openSync as realOpen, fsyncSync as realFsync, linkSync as realLink, readdirSync } from "node:fs";

/** Any leftover `*.tmp` temp files in the directory. */
function readdirTemps(d: string): string[] {
  return readdirSync(d).filter((f) => f.includes(".tmp"));
}
