/**
 * Owner-only file custody — the single copy (DSK-003 Lane A, D2).
 *
 * The rule: a file holding key material or local authority must not be readable by
 * group or other. It existed TWICE before this module — `identity/key-store.ts` and
 * `events/event-outbox-kek.ts` each carried their own `STRICT_FILE_MODE` /
 * `GROUP_OTHER_MASK` pair, the same `process.platform === "win32"` early return, and the
 * same `statSync(path).mode & 0o777` comparison. They were compared line by line before
 * extraction and are behaviourally identical; they differ only in which error type they
 * throw, and that stays with each caller because the classification is theirs.
 *
 * DSK-003 needs the same rule for the control token that gates every MUTATING desktop
 * control, and a third copy would be a third thing to drift.
 *
 * WHY THE PREDICATE TAKES A MODE NUMBER RATHER THAN A PATH. Both prior tests open with
 * `if (process.platform === "win32") return;`, so on Windows they are no-ops and the rule
 * is only ever exercised on Linux CI. Separating the pure comparison — and injecting
 * `platform`/`stat` into the file-level wrapper — makes both branches testable on either
 * OS, which is how the win32 branch gets its first real test.
 *
 * Runtime imports: `node:fs` only — the E4-D01 boundary.
 */

import { statSync } from "node:fs";

/** Every group and other permission bit. The value both prior copies used. */
export const GROUP_OTHER_MASK = 0o077;

/** The mode a custody-bearing file is written with. */
export const STRICT_FILE_MODE = 0o600;

/**
 * True iff `mode` grants nothing to group or other.
 *
 * NO `& 0o777` PRE-MASK, deliberately. Both prior copies wrote
 * `statSync(path).mode & 0o777` before comparing, and it reads like it is protecting
 * against the file-type bits a `statSync` mode carries above the permission bits — but
 * `GROUP_OTHER_MASK` is `0o077`, which already selects only the low six bits, so the
 * pre-mask cannot change the result for ANY input. It was removed here rather than
 * carried into the shared copy: mutation flagged it as unkillable, which is the correct
 * signal for code that cannot affect an outcome. (A first draft of the test asserted the
 * pre-mask was load-bearing; it was not, and the assertion was wrong.)
 */
export function isOwnerOnlyMode(mode: number): boolean {
  return (mode & GROUP_OTHER_MASK) === 0;
}

/** Why a file failed custody, or `null` when it passed. */
export type OwnerOnlyViolation = "insecure_permissions" | "unreadable";

export interface OwnerOnlyDeps {
  /** Defaults to the real platform. Injected so the win32 branch is testable on POSIX. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to the real `statSync`. Injected so a mode can be supplied directly. */
  readonly stat?: (path: string) => { readonly mode: number };
}

/**
 * Check a file's custody, returning the violation or `null`.
 *
 * WINDOWS: the POSIX bit check is skipped, because `chmod` there cannot clear the
 * group/other bits and the OS default ACL enforces the invariant instead. This mirrors
 * the behaviour both prior copies already had — it is not a new exemption.
 *
 * A file that cannot be stat'ed is `"unreadable"`, never `null`. A missing or
 * permission-denied token must not read as "no violation found", which is the difference
 * between fail-closed and fail-silent.
 */
export function ownerOnlyViolation(path: string, deps: OwnerOnlyDeps = {}): OwnerOnlyViolation | null {
  const platform = deps.platform ?? process.platform;
  const stat = deps.stat ?? statSync;
  if (platform === "win32") return null;
  let mode: number;
  try {
    mode = stat(path).mode;
  } catch {
    return "unreadable";
  }
  return isOwnerOnlyMode(mode) ? null : "insecure_permissions";
}
