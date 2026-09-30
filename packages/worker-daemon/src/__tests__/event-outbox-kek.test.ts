import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateDeviceKey } from "../identity/device-key.js";
import {
  EventOutboxKekError,
  MountedSecretKekStore,
  deriveKekFromDeviceKey,
} from "../events/event-outbox-kek.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aoa-kek-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("event-outbox-kek — 0600 mounted-secret KEK custody (D3, mirrors MountedSecretKeyStore)", () => {
  it("generates a 32-byte KEK on first load and persists it at 0600", () => {
    const path = join(dir, "outbox.kek");
    const store = new MountedSecretKekStore(path);
    const kek = store.load();
    expect(kek.byteLength).toBe(32);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o077).toBe(0);
    }
    // A second load returns the SAME persisted key (stable across restarts).
    const again = new MountedSecretKekStore(path).load();
    expect(Buffer.compare(again, kek)).toBe(0);
  });

  it("FAILS CLOSED on a corrupt (wrong-length) key file — never silently regenerates", () => {
    const path = join(dir, "corrupt.kek");
    writeFileSync(path, Buffer.alloc(16, 1), { mode: 0o600 });
    expect(() => new MountedSecretKekStore(path).load()).toThrow(EventOutboxKekError);
  });

  it("FAILS CLOSED on insecure permissions (POSIX group/other readable)", () => {
    if (process.platform === "win32") return;
    const path = join(dir, "insecure.kek");
    writeFileSync(path, Buffer.alloc(32, 2), { mode: 0o644 });
    expect(() => new MountedSecretKekStore(path).load()).toThrow(EventOutboxKekError);
  });

  it("deriveKekFromDeviceKey yields a deterministic 32-byte KEK bound to the device key", () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();
    const kekA1 = deriveKekFromDeviceKey(a);
    const kekA2 = deriveKekFromDeviceKey(a);
    const kekB = deriveKekFromDeviceKey(b);
    expect(kekA1.byteLength).toBe(32);
    // Deterministic for the same device key…
    expect(Buffer.compare(kekA1, kekA2)).toBe(0);
    // …but distinct per device key.
    expect(Buffer.compare(kekA1, kekB)).not.toBe(0);
  });
});
