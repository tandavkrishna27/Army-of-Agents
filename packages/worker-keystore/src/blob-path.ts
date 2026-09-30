// packages/worker-keystore/src/blob-path.ts
//
// DSK-001 — where the DPAPI-protected blobs live.
//
// A DPAPI `CurrentUser` blob is decryptable only by the user who wrote it, on the
// machine that wrote it. That makes the storage location a CORRECTNESS concern.
//
// **Never `%APPDATA%`.** That directory ROAMS. A roamed blob arrives on a second
// machine where it cannot be decrypted — and because the file EXISTS, the absence
// oracle correctly reports "present" and the unprotect correctly reports a fault.
// Every layer behaves properly and the device is still bricked: not unenrolled,
// but holding an identity it can never use, with the compare-and-set refusing to
// heal it because a record is already there. `%LOCALAPPDATA%` is non-roaming, and
// there is deliberately no fallback to the roaming path.
//
// **Never the cwd.** A daemon started from a different directory would look for a
// different identity, find none, mint a second one, and be denied permanently.
//
// Both absences are enforced by THROWING rather than by defaulting, because a
// default here is indistinguishable from a correct answer until the device is
// already locked out.
//
// The paths are NOT namespaced by target. A per-target path would let one machine
// silently hold several identities, each invisible to the others, and the
// coordinator's "persisted identity belongs to a different target" refusal would
// never fire.

import type { VaultRef } from "./command-plan.js";

/** Fixed, versioned filenames. A version bump is a deliberate migration. */
const IDENTITY_BLOB = "device-identity.v1.bin";
const RECEIPT_BLOB = "device-enrollment.v1.bin";
const SUBDIR = "AoA\\worker";

export interface VaultRefs {
  readonly identity: VaultRef;
  readonly receipt: VaultRef;
}

export class VaultPathError extends Error {
  constructor(message: string) {
    super(`device vault path: ${message}`);
    this.name = "VaultPathError";
  }
}

/**
 * Resolve both blob locations, or throw.
 *
 * Takes `env` and `platform` rather than reading `process`, so the rules are
 * provable on the ubuntu-only required lane — the same reason every other
 * decision in this package is pure.
 */
export function resolveVaultRefs(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform | string,
): VaultRefs {
  if (platform !== "win32") {
    throw new VaultPathError(
      `platform ${JSON.stringify(platform)} is not supported by DSK-001 — ` +
        "macOS and Linux ship as ports only (D4)",
    );
  }

  const local = env.LOCALAPPDATA?.trim();
  if (!local) {
    // Deliberately does NOT fall back to APPDATA (roaming) or to the cwd.
    throw new VaultPathError("LOCALAPPDATA is not set; refusing to guess a location");
  }
  // A drive-letter absolute path only. A UNC path would put the device identity
  // on a share — decryptable by nobody, reachable by everybody.
  if (!/^[A-Za-z]:\\/.test(local)) {
    throw new VaultPathError("LOCALAPPDATA is not an absolute local path");
  }

  const dir = `${local.replace(/\\+$/, "")}\\${SUBDIR}`;
  return {
    identity: { blobPath: `${dir}\\${IDENTITY_BLOB}` },
    receipt: { blobPath: `${dir}\\${RECEIPT_BLOB}` },
  };
}
