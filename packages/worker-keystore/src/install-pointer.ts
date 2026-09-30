// packages/worker-keystore/src/install-pointer.ts
//
// DSK-004 Lane C — reading and writing the `current` pointer (clause 5, I5).
//
// `install-layout.ts` decides WHETHER the pointer may move. This is what makes moving it
// safe. Without it, clause (5) — "power loss recovers to one valid version" — is a design
// intention rather than a property: side-by-side versions only help if the pointer itself
// can never be observed half-written.
//
// THE DESTINATION IS NEVER WRITTEN DIRECTLY. Content goes to a temporary file and is moved
// onto the destination with a rename, which the filesystem performs atomically (on win32
// Node's rename maps to MoveFileEx with REPLACE_EXISTING, so it also replaces). A reader
// sees the whole old pointer or the whole new one; a machine that loses power mid-update
// comes back to one of the two, never to a truncated file naming half a version.
//
// Note that the end state of a direct write and of a write-then-rename are identical.
// Only one of them survives losing power halfway, so the ORDER OF OPERATIONS is the
// property, and the IO is injected so a test can assert the sequence rather than the
// result — and so the whole thing is provable on the ubuntu-only required lane.
//
// The version read back out is validated exactly as one going in. The pointer is a file
// on disk: anything that can write it can put a traversal in it, and the value is used to
// build a path.

import { isSafeVersionSegment } from "./install-layout.js";

/** A bump is a deliberate migration. An unknown value is refused, never interpreted. */
export const POINTER_SCHEMA_VERSION = 1;

const TEMP_SUFFIX = ".tmp";

export interface PointerIo {
  /** Read the pointer. Throws (ENOENT or otherwise) when it cannot be read. */
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  /** Atomically move `from` onto `to`, replacing it. */
  rename(from: string, to: string): void;
  /** Best-effort cleanup of a temporary file. Never throws in practice; ignored if it does. */
  removeFile(path: string): void;
}

export type PointerReadResult =
  | { readonly ok: true; readonly version: string }
  | {
      readonly ok: false;
      readonly reason: "absent" | "unreadable" | "unsupported_schema" | "unsafe_version";
    };

/**
 * Read the live version.
 *
 * `absent` and `unreadable` are DISTINCT outcomes because they call for different operator
 * responses: absent is a machine with no install, unreadable is a machine with a damaged
 * one. Collapsing them into "no version" would make a damaged install look like a fresh
 * one and quietly reinstall over it.
 */
export function readVersionPointer(io: PointerIo, pointerPath: string): PointerReadResult {
  let raw: string;
  try {
    raw = io.readFile(pointerPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { ok: false, reason: code === "ENOENT" ? "absent" : "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "unreadable" };
  }

  const { schema, version } = parsed as { schema?: unknown; version?: unknown };
  if (schema !== POINTER_SCHEMA_VERSION) return { ok: false, reason: "unsupported_schema" };
  if (!isSafeVersionSegment(version)) return { ok: false, reason: "unsafe_version" };
  return { ok: true, version: version as string };
}

/**
 * Move the pointer, or throw.
 *
 * Throws rather than returning a result because there is no partial success to describe:
 * either the rename happened and the pointer names the new version, or it did not and the
 * pointer still names the old one. The caller — `runDrainBeforeSwap` — turns the throw
 * into a `swap_failed` refusal.
 */
export function writeVersionPointer(io: PointerIo, pointerPath: string, version: string): void {
  if (!isSafeVersionSegment(version)) {
    throw new Error(`worker-keystore: refusing to point at unsafe version ${JSON.stringify(version)}`);
  }
  const tempPath = `${pointerPath}${TEMP_SUFFIX}`;
  const body = JSON.stringify({ schema: POINTER_SCHEMA_VERSION, version });

  io.writeFile(tempPath, body);
  try {
    io.rename(tempPath, pointerPath);
  } catch (error) {
    // The destination is untouched — that is the guarantee. Clear the temporary file so a
    // later attempt does not inherit a stale one, and never let cleanup mask the failure.
    try {
      io.removeFile(tempPath);
    } catch {
      // Best effort.
    }
    throw new Error(
      `worker-keystore: could not move the version pointer to ${JSON.stringify(version)}: ${String(error)}`,
    );
  }
}
