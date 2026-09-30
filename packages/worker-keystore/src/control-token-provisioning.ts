// packages/worker-keystore/src/control-token-provisioning.ts
//
// DSK-003 Lane A — bring the control token into existence, and never quietly replace it.
//
// The host needs a token file before any mutating command can be authorized, so it
// creates one when absent. Everything else about this function is about NOT writing:
//
//   NEVER REGENERATE OVER AN EXISTING TOKEN. An operator saves this value. Minting a new
//   one each boot would break every saved token on every restart, and the symptom — "the
//   token stopped working" — points nowhere near the cause.
//
//   NEVER REGENERATE OVER A MALFORMED ONE EITHER, which is the sharper case. A truncated
//   or empty file is a FAULT, and quietly replacing it converts that fault into a silent
//   credential rotation. `worker-daemon/src/events/event-outbox-kek.ts` already carries
//   this exact rule and its reason — it "NEVER silently regenerates over a corrupt key
//   (that would orphan every existing row under a new key → mass quarantine)". The
//   analogue here orphans the operator.
//
//   AN UNREADABLE FILE IS NOT AN ABSENT ONE. EACCES means a token may well be there and
//   this process cannot see it; minting a second beside a first nobody can read is worse
//   than refusing.
//
// So: absent → create. Present and well-formed → keep, untouched. Anything else → refuse.
//
// The fs is injected, so every branch above is provable without a filesystem — including
// the ones that must NOT write.

import { randomBytes } from "node:crypto";

/** 32 bytes of CSPRNG output, base64url — matches the daemon's own token contract. */
const TOKEN_BYTES = 32;
const MIN_TOKEN_LENGTH = 43; // 32 bytes, base64url, unpadded
const STRICT_FILE_MODE = 0o600;

export interface ControlTokenIo {
  readFile(path: string): string;
  writeFile(path: string, data: string, mode: number): void;
}

export const CONTROL_TOKEN_PROVISION_REFUSALS = ["malformed_token_file", "unreadable"] as const;
export type ControlTokenProvisionRefusal = (typeof CONTROL_TOKEN_PROVISION_REFUSALS)[number];

export type ControlTokenProvisionResult =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly reason: ControlTokenProvisionRefusal };

/**
 * Ensure a usable control token exists at `path`.
 *
 * Returns `created: false` when one was already there — the caller can use that to tell
 * an operator where to find it on a first run without printing it on every boot.
 *
 * The token VALUE is never returned. This function's job is that a good one exists; a
 * caller that needs the value reads the file, which is the same 0600 gate every other
 * reader passes through.
 */
export function provisionControlToken(
  path: string,
  io: ControlTokenIo,
): ControlTokenProvisionResult {
  let existing: string | null = null;
  try {
    existing = io.readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // Only absence means "mint one". Anything else — EACCES above all — may be hiding a
    // token that already exists.
    if (code !== "ENOENT") return { ok: false, reason: "unreadable" };
  }

  if (existing !== null) {
    // `trim()` because every shell redirect that writes a token leaves a trailing
    // newline, and refusing that would refuse a perfectly good token.
    if (existing.trim().length < MIN_TOKEN_LENGTH) {
      return { ok: false, reason: "malformed_token_file" };
    }
    return { ok: true, created: false };
  }

  io.writeFile(path, `${randomBytes(TOKEN_BYTES).toString("base64url")}\n`, STRICT_FILE_MODE);
  return { ok: true, created: true };
}
