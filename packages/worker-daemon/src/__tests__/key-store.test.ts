import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateDeviceKey } from "../identity/device-key.js";
import {
  DeviceKeyStoreError,
  InMemoryKeyStore,
  MountedSecretKeyStore,
} from "../identity/key-store.js";

const tmpDirs: string[] = [];
function scratchFile(name = "device.key"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aoa-wd-keystore-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MountedSecretKeyStore", () => {
  it("returns null when no key file exists yet", () => {
    const store = new MountedSecretKeyStore(scratchFile());
    expect(store.load()).toBeNull();
  });

  it("round-trips a generated key with an identical public identity", () => {
    const file = scratchFile();
    const store = new MountedSecretKeyStore(file);
    const key = generateDeviceKey();
    store.save(key);
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.publicKeyDer).toBe(key.publicKeyDer);
    expect(loaded!.deviceThumbprint).toBe(key.deviceThumbprint);
  });

  it("persists the key file with strict 0600 perms and never as plaintext PEM", () => {
    const file = scratchFile();
    const store = new MountedSecretKeyStore(file);
    const key = generateDeviceKey();
    store.save(key);
    // The stored bytes are raw PKCS8 DER — not a PEM armor a careless grep would surface.
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("PRIVATE KEY");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses to load a world/group-accessible key file (POSIX, fail closed)", () => {
    if (process.platform === "win32") return; // chmod bits are not enforced on Windows
    const file = scratchFile();
    const store = new MountedSecretKeyStore(file);
    store.save(generateDeviceKey());
    chmodSync(file, 0o644);
    expect(() => store.load()).toThrow(DeviceKeyStoreError);
  });

  it("clear() removes the key file so a subsequent load is null", () => {
    const file = scratchFile();
    const store = new MountedSecretKeyStore(file);
    store.save(generateDeviceKey());
    store.clear();
    expect(store.load()).toBeNull();
  });

  it("does not throw if clear() runs with no key present", () => {
    const store = new MountedSecretKeyStore(scratchFile());
    expect(() => store.clear()).not.toThrow();
  });
});

describe("InMemoryKeyStore (OS-keychain stub for tests)", () => {
  it("round-trips through the same serialize path as the mounted store", () => {
    const store = new InMemoryKeyStore();
    expect(store.load()).toBeNull();
    const key = generateDeviceKey();
    store.save(key);
    const loaded = store.load();
    expect(loaded!.publicKeyDer).toBe(key.publicKeyDer);
    expect(loaded!.deviceThumbprint).toBe(key.deviceThumbprint);
    store.clear();
    expect(store.load()).toBeNull();
  });
});

describe("MountedSecretKeyStore — custody (DSK-003 Lane A)", () => {
  // `assertSecurePermissions` had NO test before this. Its twin in
  // `event-outbox-kek.ts` was covered; this one was not, so the guard on the file
  // holding the DEVICE IDENTITY was the uncovered half of the pair. Adding it here is
  // part of extracting the shared rule — the extraction is only safe if both callers
  // are actually pinned.
  it("FAILS CLOSED on insecure permissions (POSIX group/other readable)", () => {
    if (process.platform === "win32") return; // chmod cannot clear these bits here
    const file = scratchFile();
    const store = new MountedSecretKeyStore(file);
    store.save(generateDeviceKey());
    chmodSync(file, 0o644);
    expect(() => store.load()).toThrow(DeviceKeyStoreError);
  });

  it("accepts the 0600 file it wrote itself — non-vacuity", () => {
    const file = scratchFile();
    const store = new MountedSecretKeyStore(file);
    const key = generateDeviceKey();
    store.save(key);
    expect(store.load()).not.toBeNull();
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
