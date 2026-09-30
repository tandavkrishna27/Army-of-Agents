// packages/worker-keystore/src/command-runner.ts
//
// DSK-001 (D2) — THE ONLY FILE IN THIS PACKAGE PERMITTED TO SPAWN A SUBPROCESS.
//
// `scripts/check-worker-keystore-boundary.mjs` enforces that mechanically, in the
// always-on `policy` job: any other runtime source importing `node:child_process`
// is a build failure. The confinement is what lets every decision that matters —
// the planner, the outcome classifier, the envelope codec, the store — stay pure
// and OS-free, and therefore provable on the ubuntu-only REQUIRED CI lane rather
// than on an advisory Windows one that cannot gate a merge.
//
// This file deliberately contains NO policy. It runs the plan it is handed and
// reports what happened. Every interpretation lives in `classifyStoreOutcome`.
//
// Two things here are load-bearing:
//
//   1. `execFileSync` with `input:` delivers the private key on STDIN. The port
//      this ultimately satisfies is synchronous (`DeviceKeyStore.load(): DeviceKey
//      | null`), so an async runner is not an option, and `input:` is how the sync
//      form preserves the "never on argv" property (I5).
//
//   2. **Absence is decided HERE, by the filesystem, and nowhere else.** On
//      Windows the blob file is the absence oracle: `ENOENT` means never enrolled.
//      An unprotect failure is ALWAYS a fault. This matters because the crypto
//      layer cannot tell the two apart — the same CryptographicException was
//      measured as exit 0 under `-File` and exit 1 under `-EncodedCommand`, with
//      identical empty stdout. So the runner probes the file first and sets
//      `absenceSignalled` explicitly; the classifier never infers it.
//
//      **The probe is THREE-valued, and that is not stylistic.** The first
//      version used `existsSync`, which returns `false` for ANY error — EACCES,
//      EPERM, ENOTDIR, ELOOP, an unreadable mount, an invalid path — not only for
//      non-existence. A permission-denied probe therefore reported ABSENCE,
//      `load()` returned `null`, `loadOrCreateKey` read that as NEVER ENROLLED,
//      and the device enrolled under a SECOND identity the server denies forever
//      with no reset route. That is the exact bug the six-valued classifier
//      exists to prevent, reintroduced one layer beneath it: a careful classifier
//      fed by a lossy oracle is not careful. A boolean cannot express a fault, so
//      the seam's TYPE is three-valued and every fake inherits the distinction
//      rather than the defect.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

import { selectChildEnv, type VaultCommandPlan } from "./command-plan.js";
import type { CommandRunner } from "./identity-store.js";
import type { StoreCommandResult } from "./outcome.js";

/** Generous enough for an envelope, bounded so a runaway child cannot exhaust us. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

interface ExecFileSyncError {
  status?: number | null;
  signal?: string | null;
  stdout?: Buffer | null;
  stderr?: Buffer | null;
  message?: string;
}

function isExecError(err: unknown): err is ExecFileSyncError {
  return typeof err === "object" && err !== null;
}

/**
 * A three-valued probe result. `{fault}` is what a boolean could not say.
 */
export type BlobProbe = "absent" | "present" | { readonly fault: string };

/**
 * The real probe. `statSync` THROWS with a discriminating `code`, which is the
 * whole reason it replaces `existsSync`: only `ENOENT` (and `ENOTDIR` on a path
 * whose parent is missing) means "not there". Everything else is a fault that
 * must not be mistaken for a device that has never enrolled.
 */
/**
 * The errno decision, extracted and exported so it is actually TESTABLE.
 *
 * It was originally inline inside `probeBlob`, where every test injected a fake
 * probe and therefore never exercised it — a mutation making it return `"absent"`
 * for every errno left the whole suite green. That is the vacuous-coverage shape
 * this repo's "mutation-test every guard" rule exists to catch, and it applied to
 * the single decision that prevents permanent device lockout.
 *
 * ONLY `ENOENT` is absence. Everything else — including `UNKNOWN`, which Windows
 * produces for several conditions — is a fault.
 */
export function classifyProbeErrno(code: string | undefined): BlobProbe {
  if (code === "ENOENT") return "absent";
  return { fault: code ?? "UNKNOWN" };
}

function probeBlob(path: string): BlobProbe {
  try {
    statSync(path);
    return "present";
  } catch (err) {
    return classifyProbeErrno((err as NodeJS.ErrnoException).code);
  }
}

/**
 * The production runner.
 *
 * `probe` is injectable so the absence oracle can be exercised without touching a
 * real filesystem. Its type is deliberately three-valued — see note 2 above.
 */
export function createCommandRunner(deps: { probe?: (path: string) => BlobProbe } = {}): CommandRunner {
  const probe = deps.probe ?? probeBlob;

  return {
    run(plan: VaultCommandPlan, stdin?: Uint8Array): StoreCommandResult {
      // (1) THE ABSENCE ORACLE. Only a `load` may be absent: a `store` that finds
      // no file is the normal first enrolment, and a `delete` of nothing is
      // handled by the store as success. Deciding absence here — from the
      // filesystem — is what keeps `classifyStoreOutcome` free to treat every
      // crypto-layer failure as a fault.
      if (plan.stdin === "none") {
        const probed = probe(plan.blobPath);
        if (probed === "absent") {
          return {
            exitCode: null, signal: null, stdout: new Uint8Array(),
            stderr: "", absenceSignalled: true,
          };
        }
        if (typeof probed === "object") {
          // A FAULT, never absence. Reported with the errno so the classifier can
          // separate a denial from a transient unavailability, and so an operator
          // sees which one it was. This branch also covers `clear()`, which takes
          // the same `stdin === "none"` path: without it a FAILED WIPE reported
          // success, contradicting clear()'s own contract.
          return {
            exitCode: null, signal: null, stdout: new Uint8Array(),
            stderr: `device identity blob probe failed: ${probed.fault}`,
            absenceSignalled: false,
          };
        }
      }

      try {
        const stdout = execFileSync(plan.argv[0]!, plan.argv.slice(1), {
          input: stdin ? Buffer.from(stdin) : undefined,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          // The child gets an ALLOWLISTED environment, never an inherited block.
          // With no `env:` it would receive everything this process holds —
          // including the enrollment credential, which lives in an operator-named
          // variable no denylist could target. See `selectChildEnv`.
          env: selectChildEnv(process.env),
          // stdio must NOT inherit: a child that inherits this process's stderr
          // could interleave its diagnostics into our logs, and inheriting stdin
          // would hand it whatever the daemon's stdin happens to be.
          stdio: ["pipe", "pipe", "pipe"],
        });
        return {
          exitCode: 0,
          signal: null,
          stdout: new Uint8Array(stdout),
          stderr: "",
          absenceSignalled: false,
        };
      } catch (err) {
        // A non-zero exit throws here. That is NOT an error condition to swallow —
        // it is the script's deliberate report (exit 3 locked, exit 4 already
        // present), and the classifier needs the raw numbers.
        if (!isExecError(err)) {
          return {
            exitCode: null, signal: null, stdout: new Uint8Array(),
            stderr: String(err), absenceSignalled: false,
          };
        }
        return {
          exitCode: typeof err.status === "number" ? err.status : null,
          signal: err.signal ?? null,
          stdout: err.stdout ? new Uint8Array(err.stdout) : new Uint8Array(),
          stderr: (err.stderr ? err.stderr.toString() : "") || err.message || "",
          absenceSignalled: false,
        };
      }
    },
  };
}
