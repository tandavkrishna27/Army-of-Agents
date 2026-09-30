// DSK-001 — where the protected blobs live, and the fallbacks that must not exist.
//
// DPAPI `CurrentUser` blobs are decryptable only by the user who wrote them, on
// the machine that wrote them. So the storage location is a correctness concern,
// not a tidiness one:
//
//   NEVER %APPDATA%. That directory ROAMS. A roamed CurrentUser blob arrives on a
//   second machine where it cannot be decrypted — and, because the file EXISTS,
//   the absence oracle correctly reports "present" and the unprotect correctly
//   reports a fault. The device is then bricked rather than unenrolled, and the
//   compare-and-set refuses to heal it because a record is already there.
//
//   NEVER the cwd. A daemon started from a different directory would look for a
//   different identity, mint a second one, and be denied permanently.
//
// Both are absences, so both are tested by asserting the resolver THROWS rather
// than quietly producing a path.

import { describe, expect, it } from "vitest";
import { resolveVaultRefs } from "../blob-path.js";

const LOCAL = "C:\\Users\\t\\AppData\\Local";
const ROAMING = "C:\\Users\\t\\AppData\\Roaming";

describe("DSK-001 — the blobs live under LOCALAPPDATA", () => {
  it("resolves both refs under a single fixed directory", () => {
    const refs = resolveVaultRefs({ LOCALAPPDATA: LOCAL }, "win32");
    expect(refs.identity.blobPath).toBe(`${LOCAL}\\AoA\\worker\\device-identity.v1.bin`);
    expect(refs.receipt.blobPath).toBe(`${LOCAL}\\AoA\\worker\\device-enrollment.v1.bin`);
  });

  it("gives the identity and the receipt DIFFERENT paths", () => {
    const refs = resolveVaultRefs({ LOCALAPPDATA: LOCAL }, "win32");
    expect(refs.identity.blobPath).not.toBe(refs.receipt.blobPath);
  });

  it("is NOT namespaced by target, so re-pointing a device is a deliberate act", () => {
    // A per-target path would let one machine silently hold several identities,
    // each invisible to the others — and the coordinator's "different target"
    // refusal would never fire.
    const refs = resolveVaultRefs({ LOCALAPPDATA: LOCAL }, "win32");
    expect(refs.identity.blobPath).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

describe("DSK-001 — the fallbacks that must not exist", () => {
  it("THROWS rather than falling back to the ROAMING APPDATA", () => {
    // The footgun: a roamed CurrentUser blob on a second machine is present but
    // undecryptable — a bricked device, not an unenrolled one.
    expect(() => resolveVaultRefs({ APPDATA: ROAMING }, "win32")).toThrow(/LOCALAPPDATA/i);
  });

  it("never produces a path containing Roaming, even when APPDATA is set", () => {
    const refs = resolveVaultRefs({ LOCALAPPDATA: LOCAL, APPDATA: ROAMING }, "win32");
    expect(refs.identity.blobPath).not.toContain("Roaming");
    expect(refs.identity.blobPath).toContain("Local");
  });

  it("THROWS rather than falling back to the cwd", () => {
    expect(() => resolveVaultRefs({}, "win32")).toThrow(/LOCALAPPDATA/i);
  });

  it("THROWS when LOCALAPPDATA is set but not absolute", () => {
    for (const value of ["", "   ", "AppData\\Local", ".\\local", "\\\\share\\local"]) {
      expect(() => resolveVaultRefs({ LOCALAPPDATA: value }, "win32"), JSON.stringify(value)).toThrow();
    }
  });
});

describe("DSK-001/D4 — non-Windows is a port, not a production adapter", () => {
  it("THROWS for darwin and linux rather than inventing a location", () => {
    for (const platform of ["darwin", "linux", "aix"]) {
      expect(() => resolveVaultRefs({ LOCALAPPDATA: LOCAL }, platform), platform)
        .toThrow(/not supported|unsupported/i);
    }
  });
});
