/**
 * The local control token (DSK-003 Lane A, D1/D2) — the authorization boundary for every
 * MUTATING desktop control.
 *
 * WHY IT EXISTS. `health/health-server.ts` binds loopback-only and has NO authentication,
 * which is right for `GET /healthz` and payload-free counters: read-only liveness that
 * exposes no tenant data. Clause (4) also asks for `drain` and `revoke`. Serving those
 * from the same surface would change the category — from unauthenticated read-only to
 * unauthenticated MUTATING control reachable by every local process. On a shared desktop
 * any local user, or anything the user runs, could revoke the worker's identity or drain
 * its work. **Loopback is a network boundary, not an authorization boundary.**
 *
 * THE AUTHORITY IS THE OS. The token lives in a file only the installing user can read,
 * so "may this caller control the host" reduces to "can this caller read that file" — a
 * question the operating system already answers, and answers better than anything this
 * process could implement. That is the same rule the device keystore uses, which is why
 * `file-custody.ts` was extracted rather than copied a third time.
 *
 * Runtime imports: `node:crypto` + `node:fs` — the E4-D01 boundary.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import { ownerOnlyViolation, type OwnerOnlyDeps } from "./file-custody.js";

/** 32 bytes of CSPRNG output — 256 bits, far beyond any local brute force. */
export const CONTROL_TOKEN_BYTES = 32;

/**
 * The shortest stored value that may be treated as a token.
 *
 * A truncated or partially-written file must not become a guessable credential, and an
 * EMPTY file must never authorize: the dangerous symmetry is an empty stored token
 * comparing equal to an empty presented one, which would turn `> control.token` into a
 * grant-everyone operation.
 */
export const MIN_STORED_TOKEN_LENGTH = 43; // 32 bytes, base64url, unpadded

export const CONTROL_TOKEN_REJECTIONS = [
  "not_presented",
  "no_token_file",
  "malformed_token_file",
  "insecure_permissions",
  "mismatch",
] as const;

export type ControlTokenRejection = (typeof CONTROL_TOKEN_REJECTIONS)[number];

export type ControlTokenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ControlTokenRejection };

/** A fresh token. base64url so it never needs shell quoting on any platform. */
export function generateControlToken(): string {
  return randomBytes(CONTROL_TOKEN_BYTES).toString("base64url");
}

/**
 * Verify a presented token against the stored one.
 *
 * ORDER IS DELIBERATE — custody is checked BEFORE the value. A token file any local user
 * can read is already compromised, and admitting it because the caller happened to know
 * the value would defeat the control entirely. `insecure_permissions` therefore wins over
 * `mismatch`, never the other way round.
 *
 * COMPARISON IS OVER DIGESTS, not the raw strings. `timingSafeEqual` throws on unequal
 * lengths, so comparing raw values would force a length check that leaks the stored
 * length — and a plain `===` returns on the first differing byte. Hashing both sides
 * yields two fixed-width buffers, so any presented value of any length is compared in
 * constant time.
 *
 * The result never carries the stored token: this function must not become a read oracle
 * for the very secret it protects.
 */
export function verifyControlToken(
  tokenPath: string,
  presented: string | null | undefined,
  deps: OwnerOnlyDeps = {},
): ControlTokenResult {
  if (typeof presented !== "string" || presented.length === 0) {
    return { ok: false, reason: "not_presented" };
  }

  // CUSTODY BEFORE READ. Do not pull a secret into this process out of a file whose
  // permissions have not been validated. The first draft read first and checked after,
  // which produced the same answers but is the wrong order on principle — and left the
  // "unreadable" arm dead, since a file that cannot be stat'ed also cannot be read and
  // both ended at `no_token_file`. Mutation surfaced that redundancy; the arm is gone
  // and the read's own catch is the single place absence is reported.
  if (ownerOnlyViolation(tokenPath, deps) === "insecure_permissions") {
    return { ok: false, reason: "insecure_permissions" };
  }

  let stored: string;
  try {
    stored = readFileSync(tokenPath, "utf8").trim();
  } catch {
    return { ok: false, reason: "no_token_file" };
  }

  if (stored.length < MIN_STORED_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed_token_file" };
  }

  const a = createHash("sha256").update(stored).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "mismatch" };
}
