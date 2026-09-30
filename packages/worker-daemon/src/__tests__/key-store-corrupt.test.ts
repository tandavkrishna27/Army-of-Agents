import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
function scratchFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aoa-wd-keystore-corrupt-"));
  tmpDirs.push(dir);
  return path.join(dir, "device.key");
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("key store — corrupt/unreadable fails closed", () => {
  it("throws DeviceKeyStoreError on garbage bytes (never returns a bogus key)", () => {
    const file = scratchFile();
    writeFileSync(file, Buffer.from("this is not a pkcs8 der key"), { mode: 0o600 });
    const store = new MountedSecretKeyStore(file);
    expect(() => store.load()).toThrow(DeviceKeyStoreError);
  });

  it("throws on a truncated valid key (partial DER)", () => {
    const file = scratchFile();
    const store = new MountedSecretKeyStore(file);
    store.save(generateDeviceKey());
    // Truncate the DER to a partial key.
    const truncated = Buffer.from("30", "hex");
    writeFileSync(file, truncated, { mode: 0o600 });
    expect(() => store.load()).toThrow(DeviceKeyStoreError);
  });

  it("throws on an empty key file rather than treating it as absent", () => {
    const file = scratchFile();
    writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
    const store = new MountedSecretKeyStore(file);
    expect(() => store.load()).toThrow(DeviceKeyStoreError);
  });

  it("the in-memory keychain stub also fails closed on corrupt material", () => {
    const store = new InMemoryKeyStore();
    store.injectCorruptForTest(Buffer.from("garbage"));
    expect(() => store.load()).toThrow(DeviceKeyStoreError);
  });
});
