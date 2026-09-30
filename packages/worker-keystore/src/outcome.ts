// packages/worker-keystore/src/outcome.ts
//
// DSK-001 (D5) — the six-valued outcome of probing an OS device-identity store,
// and the pure classifier that produces it.
//
// **Why this function is pure and OS-free.** It is the single most dangerous
// decision in the package, and the required CI lanes are ubuntu-only (the
// macOS/Windows lanes are advisory with `continue-on-error` and cannot gate a
// merge). Keeping the decision free of any OS call is what makes the invariant
// that actually causes the catastrophic bug provable on the lane that gates.
//
// **The bug it exists to prevent.** `DeviceKeyStore.load()` is contractually
// `DeviceKey | null`, where `null` means *never enrolled*
// (`worker-daemon/src/identity/key-store.ts:33-34`). A store that maps a FAULT to
// `null` hands `loadOrCreateKey` (`enrollment/enroll.ts:131-136`) a "no key"
// verdict; it mints a fresh key and enrols a NEW device identity — exactly what
// the module header at `identity/key-store.ts:4-11` forbids. The server then
// denies that identity permanently (`worker-enrollment.ts:418-423`
// `worker_transfer_denied`), and `findWorkerForBinding`
// (`packages/db/src/repositories/tenant/worker-enrollment.ts:274-287`) filters on
// scope / target / organization / owner with **no status predicate** — so even the
// revoked row keeps matching and blocks re-enrolment forever, with no reset route.
// A locked store must never look recoverable.
//
// **Why neither the exit code nor the output length may be the oracle.**
// Controller-measured on Windows PowerShell 5.1, tampering the HMAC region of a
// `ProtectedData.Protect` blob so `Unprotect` raises a genuine
// `CryptographicException` ("The data is invalid"):
//
//     powershell.exe -NoProfile -EncodedCommand <b64>   ->  exit 1, EMPTY stdout
//     powershell.exe -NoProfile -File <script.ps1>      ->  exit 0, EMPTY stdout
//
// The same exception, opposite exit codes, identical empty stdout. The signal is
// invocation-shape dependent, so a refactor between shapes would silently flip it
// with no test failing. Absence therefore arrives only through an explicit
// per-platform channel (`absenceSignalled`), which the caller sets from the
// platform's own absence oracle — on Windows, `ENOENT` on the blob file, because
// there the filesystem is the oracle and an unprotect failure is *always* a fault.

/** What a probe of the OS store actually found. Exactly six, and closed. */
export type KeyStoreProbeOutcome =
  /** A stored envelope was returned. */
  | { readonly kind: "present"; readonly envelope: Uint8Array }
  /** The platform's explicit absence channel fired. The ONLY route to `null`. */
  | { readonly kind: "absent" }
  /** The store exists but could not be opened (locked keychain, no session). */
  | { readonly kind: "locked"; readonly detail: string }
  /** Wrong OS user, or an ACL/ownership denial. */
  | { readonly kind: "denied"; readonly detail: string }
  /** The store answered, but not with something we can use. */
  | { readonly kind: "corrupt"; readonly detail: string }
  /** We never got a usable answer: binary missing, spawn failure, killed child. */
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * The raw result of running one store command.
 *
 * `absenceSignalled` is deliberately a separate boolean rather than something the
 * classifier could derive. Deriving it is the whole bug.
 */
export interface StoreCommandResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: string;
  /** Set by the platform adapter from its OWN absence oracle. Never inferred here. */
  readonly absenceSignalled: boolean;
}

/**
 * The hardened script's denial exit. The PowerShell plan wraps its body in
 * `try { …; exit 0 } catch { [Console]::Error.Write($_.Exception.Message); exit 3 }`
 * so a crypto/lock failure is reported deliberately rather than incidentally —
 * which is what makes it distinguishable from the shape-dependent generic exit.
 */
const EXIT_LOCKED = 3;

/** Substrings that identify an OS-level access denial rather than a lock. */
const DENIAL_MARKERS = ["access is denied", "permission denied", "unauthorized", "eacces", "eperm"];

/** Substrings that identify a failure to reach the tool at all. */
const UNAVAILABLE_MARKERS = ["enoent", "not recognized", "command not found", "spawn"];

function has(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Classify one store command result. Pure, total, and OS-free.
 *
 * Order matters and is deliberate:
 *  1. The explicit absence channel wins over everything, including stray output —
 *     a platform that says "no entry" is authoritative.
 *  2. A missing exit code means we never got an answer, whatever else is true.
 *  3. Only then may a zero exit with real bytes be read as `present`.
 *  4. Everything else is a fault, and faults are never `absent`.
 */
export function classifyStoreOutcome(result: StoreCommandResult): KeyStoreProbeOutcome {
  // (1) The ONLY route to `absent`.
  if (result.absenceSignalled) return { kind: "absent" };

  // (2) No exit code at all: spawn failure or a killed child. A signal says
  // nothing about the stored bytes, so this is `unavailable`, never `corrupt`.
  if (result.exitCode === null) {
    // A SIGNAL says nothing about the stored bytes, so a killed child is always
    // `unavailable` regardless of what it managed to write.
    if (result.signal) {
      return { kind: "unavailable", detail: `child terminated by ${result.signal}` };
    }
    const detail = result.stderr.trim() || "no exit code and no stderr";
    // No exit code and no signal also covers the runner's own three-valued blob
    // probe, which reports an errno rather than spawning. A permission errno is a
    // DENIAL, and saying `unavailable` would send an operator looking for a
    // missing binary instead of a broken ACL. Both are faults either way — the
    // run never becomes `absent` — so this only sharpens the diagnosis.
    if (has(detail, DENIAL_MARKERS)) return { kind: "denied", detail };
    return { kind: "unavailable", detail };
  }

  // (3) A ZERO EXIT IS THE AUTHORITY FOR SUCCESS, and stderr may not override it.
  //
  // This ordering was corrected after running the real Windows probe: PowerShell
  // writes CLIXML progress noise to STDERR on a SUCCESSFUL run ("Preparing
  // modules for first use."). With the fault matchers consulted first, a
  // successful load whose incidental stderr happened to contain a marker word was
  // classified `unavailable` — discarding a perfectly good key and, because the
  // daemon treats a store fault as fatal, refusing to start. stderr is advisory;
  // the exit code is not.
  //
  // A clean success must still carry real, non-whitespace bytes. An empty or
  // whitespace-only stdout on exit 0 is the measured `-File` fail-open, and that
  // is a FAULT — never an absence.
  if (result.exitCode === 0) {
    const text = new TextDecoder().decode(result.stdout);
    if (text.trim().length > 0) return { kind: "present", envelope: result.stdout };
    return {
      kind: "corrupt",
      detail: "store reported success but returned no envelope bytes",
    };
  }

  // (4) Non-zero only from here down, so stderr is now genuinely diagnostic.
  if (has(result.stderr, UNAVAILABLE_MARKERS)) {
    return { kind: "unavailable", detail: result.stderr.trim() };
  }
  if (has(result.stderr, DENIAL_MARKERS)) {
    return { kind: "denied", detail: result.stderr.trim() };
  }
  if (result.exitCode === EXIT_LOCKED) {
    return { kind: "locked", detail: result.stderr.trim() || "store could not be opened" };
  }

  // (5) Any other non-zero exit. Deliberately NOT `absent`: the measured
  // `-EncodedCommand` shape lands here on a genuine crypto failure.
  return {
    kind: "corrupt",
    detail: result.stderr.trim() || `store command exited ${result.exitCode}`,
  };
}
