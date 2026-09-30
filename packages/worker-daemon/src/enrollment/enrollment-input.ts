// packages/worker-daemon/src/enrollment/enrollment-input.ts
//
// DSK-001 — the reader for `config.enrollmentCodeSource`.
//
// The config parser retains the SOURCE (a file path or an env-var name) and
// deliberately never the code itself. Nothing read that source until now: it is
// parsed at startup and has zero consumers. This closes that.
//
// Three properties here are security properties, not ergonomics.
//
// **The returned field is `enrollmentCode`, never `code`.** The daemon logger
// redacts by substring against `SENSITIVE_SUBSTRINGS`, which contains
// `"enrollmentcode"` and does NOT contain `"code"`
// (`packages/worker-daemon/src/logging/logger.ts:37-49`). So the same value
// prints in full under a `code` key and `[redacted]` under an `enrollmentCode`
// key. The NAME is the mitigation, which is exactly the kind of thing that gets
// "tidied" later by someone shortening a field — hence this note.
//
// **A path source must be LOCAL, and that is checked BEFORE the read.**
// `parseEnrollmentCodeSource` validates only non-emptiness and mutual exclusion;
// it performs no locality check. Reading a UNC path is an authenticated SMB round
// trip to a host somebody else chose: it leaks the fact and timing of an
// enrolment, and it invites a hostile file. Rejecting after the read would be
// pointless — the round trip has already happened. The check is platform-aware
// (WRK-015): a drive-letter arm on win32, a `/`-rooted arm on POSIX so a real
// container can enrol — see `assertLocalAbsolutePath` for why accepting an
// arbitrary POSIX absolute path is safe (the read is INERT) and the
// operator-sourced invariant it rests on.
//
// **No failure ever echoes what was read.** A malformed ticket file must not put
// its bytes into an exception that then lands in a log or a crash report. The
// ticket codec holds the same rule; this layer must not undo it.

import { decodeEnrollmentTicket } from "./ticket.js";

/** Mirrors the shape `parseEnrollmentCodeSource` produces. */
export type EnrollmentCodeSource =
  | { readonly kind: "env"; readonly envVar: string }
  | { readonly kind: "path"; readonly path: string };

export interface EnrollmentInput {
  readonly targetId: string;
  /** Named so the daemon logger redacts it. See the note above. */
  readonly enrollmentCode: string;
}

export class EnrollmentInputError extends Error {
  constructor(message: string) {
    super(`enrollment input rejected: ${message}`);
    this.name = "EnrollmentInputError";
  }
}

/**
 * Reject anything that is not a plain local absolute path.
 *
 * Deliberately an allowlist of one shape rather than a denylist of hostile ones:
 * a denylist over path syntax is a losing game (`\\?\UNC\`, `//`, `\\.\`, mapped
 * drives, `\??\`), and the legitimate case is narrow enough to state positively.
 *
 * PLATFORM-AWARE (mirrors `identity/file-custody.ts` `ownerOnlyViolation`): the
 * `platform` default is `process.platform`, injected so BOTH arms are testable on
 * either OS — the win32 arm was previously the only one, so every POSIX absolute
 * path was rejected and a container crash-looped here the instant it enrolled
 * (SPIKE F5). `win32` → the drive-letter arm, unchanged; else → the POSIX arm.
 *
 * WHY ACCEPTING AN ARBITRARY POSIX ABSOLUTE PATH IS SAFE HERE — it is NOT
 * confinement (there is no fixed root). It is that the read is INERT: its result
 * flows only into `decodeEnrollmentTicket` (a strict `aoa_tkt_<base64url>` codec)
 * and every failure is content-free, so even a symlink to `/etc/shadow` yields a
 * content-free `EnrollmentInputError` — plus check-before-read, a single-use
 * 10-minute code, and an operator-owned mount. The INVARIANT this rests on:
 * `EnrollmentCodeSource` must stay operator/config-sourced, NEVER wire/remote-
 * sourced. If an untrusted channel could ever set the path, this becomes an
 * arbitrary-file-read primitive with no confinement backstop. (`/dev`, `/proc`,
 * symlinks and network mounts are valid absolute paths and OUT of scope —
 * honest parity with the win32 arm, which has the identical residual via a
 * junction/reparse point under a `C:\` root.)
 */
function assertLocalAbsolutePath(path: string, platform: NodeJS.Platform = process.platform): void {
  if (path.length === 0) throw new EnrollmentInputError("path is empty");

  if (platform === "win32") {
    const normalized = path.replace(/\//g, "\\");
    if (normalized.startsWith("\\\\")) {
      // Covers UNC (`\\host\share`), the long-path UNC form (`\\?\UNC\...`), and
      // the device namespace (`\\.\pipe\...`).
      throw new EnrollmentInputError("path is not local (UNC or device namespace)");
    }
    // A drive-letter absolute path is the only accepted shape. A relative path
    // resolves against whatever cwd the host happened to start in, which is not
    // something an enrolment should depend on.
    if (!/^[A-Za-z]:\\/.test(normalized)) {
      throw new EnrollmentInputError("path is not an absolute local path");
    }
    return;
  }

  // POSIX arm — mirrors `worker-protocol/policy.ts isSandboxSecretFilePath`'s
  // SHAPE (bound, leading segment, no backslash, no control bytes, no empty/`.`/
  // `..` segments) MINUS the fixed sandbox root, PLUS an explicit leading-`/`
  // check. That function's `startsWith(ROOT)` line did DOUBLE DUTY — confinement
  // AND absoluteness (its segment loop `.slice(1)` assumes a leading `/`) — so
  // "minus the root" would naively ACCEPT a relative path (`"rel/x".slice(1)` →
  // `["l","x"]`). The leading-`/` check restores absoluteness. `worker-protocol`
  // is FROZEN, so this MIRRORS the shape rather than calling it (it is also
  // module-private).
  if (path.length > 1024) throw new EnrollmentInputError("path is too long");
  if (path.charCodeAt(0) !== 0x2f) {
    // Not `/`-rooted: a relative path resolves against an unpredictable cwd.
    throw new EnrollmentInputError("path is not an absolute local path");
  }
  if (path.includes("\\")) throw new EnrollmentInputError("path contains a backslash");
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) throw new EnrollmentInputError("path contains a control byte");
  }
  const segments = path.slice(1).split("/"); // drop the leading "/"
  for (const seg of segments) {
    if (seg.length === 0) throw new EnrollmentInputError("path contains an empty segment"); // "//" or trailing "/"
    if (seg === "." || seg === "..") throw new EnrollmentInputError("path contains a traversal segment");
  }
}

/** Strip exactly one trailing newline, as every text editor appends. */
function trimOneTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/**
 * Resolve the enrollment ticket to its two fields.
 *
 * `readFileText` is injected so the locality check is provable without a
 * filesystem — and so a test can assert the read NEVER HAPPENED for a hostile
 * path, which is the property that actually matters.
 */
export function readEnrollmentInput(
  source: EnrollmentCodeSource,
  env: Record<string, string | undefined>,
  readFileText: (path: string) => string,
  // Threaded to `assertLocalAbsolutePath` so the container (POSIX) and desktop
  // (win32) arms are both testable on either OS. Defaulted, so the composition-
  // root thunk (`bin/worker-daemon.ts:321`) stays a 3-arg call.
  platform: NodeJS.Platform = process.platform,
): EnrollmentInput {
  let raw: string;
  if (source.kind === "env") {
    const value = env[source.envVar];
    if (value === undefined || value.trim() === "") {
      // Names the VARIABLE, never its contents.
      throw new EnrollmentInputError(`environment variable ${source.envVar} is not set`);
    }
    raw = value;
  } else {
    // BEFORE the read. A rejection afterwards has already leaked the attempt.
    assertLocalAbsolutePath(source.path, platform);
    try {
      raw = readFileText(source.path);
    } catch {
      // Deliberately does not include the underlying error, which on some
      // platforms embeds the path or a partial read.
      throw new EnrollmentInputError("enrollment ticket file could not be read");
    }
  }

  let ticket;
  try {
    ticket = decodeEnrollmentTicket(trimOneTrailingNewline(raw.trim()));
  } catch (err) {
    // Re-wrapped so no layer can accidentally widen the message to include the
    // input. The codec's own errors already name only the failing constraint;
    // this preserves that without trusting a future edit to it.
    const constraint = err instanceof Error ? err.message : "unknown constraint";
    throw new EnrollmentInputError(constraint.replace(/^enrollment ticket rejected: /, ""));
  }

  return { targetId: ticket.targetId, enrollmentCode: ticket.code };
}
