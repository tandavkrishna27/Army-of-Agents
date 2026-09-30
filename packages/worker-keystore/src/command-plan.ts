// packages/worker-keystore/src/command-plan.ts
//
// DSK-001 (D6) — the pure planner that decides HOW the OS vault is invoked.
//
// Pure on purpose, for the same reason `classifyStoreOutcome` is: the required CI
// lanes are ubuntu-only, so the security-critical decisions have to be provable
// without a Windows host. This module never spawns anything; `command-runner.ts`
// is the single file permitted to import `node:child_process` (D2).
//
// Three properties here are security-critical and none is compiler-guarded:
//
//   I5 — key material crosses **stdin only**. The planner takes no secret
//        parameter at all, so it cannot leak what it never receives. argv is
//        visible to any same-user process listing.
//   I9 — the protection scope is `CurrentUser`, never `LocalMachine`.
//        `LocalMachine` lets ANY user on the box unprotect the blob, which
//        defeats the whole point of OS-protected custody.
//   I9 — the interpreter is an ABSOLUTE System32 path. A bare `powershell.exe`
//        is a PATH lookup, and a writable PATH entry ahead of System32 becomes a
//        code-execution hijack that would be handed the key on stdin.
//
// The script is delivered by `-EncodedCommand`, not `-File` and not a temp
// script. Both alternatives were rejected on measured evidence:
//   - `-File` returned **exit 0 with empty stdout** on a genuine
//     `CryptographicException` (controller-measured), destroying the failure
//     oracle. `-EncodedCommand` returned exit 1 for the same exception.
//   - a runtime-written temp script is a substitution TOCTOU: whoever can write
//     that path gets a script that receives the private key on stdin.

/** The vault operations DSK-001 needs. */
export type VaultOp = "load" | "store" | "delete";

/** Where the protected envelope lives. DPAPI is not a store; we persist the blob. */
export interface VaultRef {
  /** Absolute path to the protected blob. Non-roaming by deliberate choice —
   * a roamed `CurrentUser` blob on a second machine is an undecryptable footgun. */
  readonly blobPath: string;
}

export interface VaultCommandPlan {
  /** argv[0] is the absolute interpreter path; no element carries a secret. */
  readonly argv: readonly string[];
  /** The PowerShell source, pre-encoding. Byte-locked by a committed fixture. */
  readonly scriptText: string;
  /** Whether the operation feeds the secret on stdin. Never argv. */
  readonly stdin: "none" | "secret";
  /** The script's deliberate exit contract, so the classifier is not guessing. */
  readonly exitCodes: { readonly ok: 0; readonly locked: 3; readonly alreadyExists: 4 };
  readonly blobPath: string;
}

/**
 * The absolute interpreter path. Deliberately NOT `%SystemRoot%`-expanded at plan
 * time: the value is byte-locked by the fixture, and an environment-derived path
 * would let a manipulated environment redirect it.
 */
export const POWERSHELL_ABSOLUTE_PATH =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * The exclusive-create refusal (I4). `store` opens the blob with `CreateNew`, so
 * an existing identity is refused by the OS rather than by a check-then-act the
 * store would have to win. That is what makes `saveIfAbsent` a real compare-and-set:
 * two racing enrollers cannot both believe they stored. It is deliberately a
 * DISTINCT code from the generic fault exit, because conflating 'someone else got
 * here first' with 'the store broke' would silently drop an enrollment while
 * reporting success.
 */
const EXIT_ALREADY_EXISTS = 4;

/**
 * Emitted on stdout by a successful `store`, so success is something the script
 * SAYS rather than something the caller infers from an absence of output.
 *
 * The store previously read `corrupt && exitCode === 0` — i.e. empty stdout — as
 * proof of a write. That is the same inference-from-nothing shape as reading
 * empty stdout as absence, which is the defect this whole package exists to
 * prevent. A positive sentinel closes it.
 */
export const STORE_SUCCESS_SENTINEL = "aoa-keystore-stored-v1";

/**
 * The ONLY environment variables the PowerShell child receives.
 *
 * `execFileSync` with no `env:` hands the child this process's ENTIRE environment
 * block. That is a real exposure here for two reasons.
 *
 * First, the daemon's enrollment credential lives in an OPERATOR-NAMED variable —
 * `AOA_WORKER_ENROLLMENT_CODE_ENV` names the variable that holds it
 * (`worker-daemon/src/config/config.ts:59`) — so there is no fixed name a
 * denylist could target. Only an allowlist can be correct.
 *
 * Second, the child is the process we hand the private key to on stdin. Whatever
 * else is in its environment is extra material sitting in exactly the process an
 * attacker would want to read.
 *
 * `PSModulePath` is excluded DELIBERATELY, not by oversight: a writable entry
 * there is code injection into that same process, which is the argv-hijack hazard
 * I9 closes with the absolute interpreter path, arriving by another door. Nothing
 * here needs it — the script runs `-NoProfile` and `Add-Type` resolves from the
 * GAC. `Path` is excluded for the same reason and is not needed, because argv[0]
 * is already absolute.
 *
 * What remains is what Windows itself needs to start a process and what DPAPI
 * `CurrentUser` needs to resolve the calling user's profile.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
];

/**
 * Project an environment down to the allowlist. Pure, so the exposure decision is
 * provable on the ubuntu-only REQUIRED lane rather than only on a Windows box.
 *
 * An absent name is OMITTED rather than set to `undefined`: `execFileSync` rejects
 * a non-string env value, so a key carrying `undefined` would crash on any machine
 * missing an optional variable.
 */
export function selectChildEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = env[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * Wrap a body so failure is reported DELIBERATELY rather than incidentally.
 *
 * This is what makes `locked` distinguishable from every other fault. Unwrapped,
 * the same `CryptographicException` surfaces as exit 1 under `-EncodedCommand`
 * and exit 0 under `-File` — the oracle depends on the invocation shape, so a
 * refactor between shapes would flip it with nothing failing. Exit 3 is ours.
 *
 * Diagnostics go to stderr so stdout remains purely the envelope channel; a
 * diagnostic on stdout would be indistinguishable from a returned blob.
 */
function harden(body: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    body,
    "  exit 0",
    "} catch {",
    "  [Console]::Error.Write($_.Exception.Message)",
    "  exit 3",
    "}",
  ].join("\n");
}

/** PowerShell single-quoted literal: the only escape is a doubled quote. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsScript(op: VaultOp, ref: VaultRef): string {
  const path = psLiteral(ref.blobPath);
  switch (op) {
    case "load":
      // Absence is the FILESYSTEM's answer, not the crypto's: the caller checks
      // ENOENT on the blob itself. An unprotect failure here is always a fault,
      // never an absence, which is why this path has no "not found" branch.
      return harden(
        [
          "  Add-Type -AssemblyName System.Security",
          `  $blob = [IO.File]::ReadAllBytes(${path})`,
          "  $der = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')",
          "  [Console]::Out.Write([Convert]::ToBase64String($der))",
        ].join("\n"),
      );
    case "store":
      // The DER arrives on stdin as base64 and never touches argv (I5).
      //
      // The write is an EXCLUSIVE CREATE (I4): `CreateNew` throws when the blob
      // already exists, which the script reports as its own exit 4 — an OS-level
      // refusal rather than a check-then-act race.
      //
      // The catch is narrowed to HResult 0x80070050 (ERROR_FILE_EXISTS). An
      // unqualified `catch [IO.IOException]` was far too wide: a full disk, a
      // vanished network path, a sharing violation and DirectoryNotFoundException
      // are all IOException, and reporting any of them as "already present" makes
      // the caller treat a FAILED enrolment as a lost race and report success.
      // Everything else falls through to the hardened exit 3.
      //
      // Flush($true) forces the bytes to the device before the handle is
      // released. Without it a power loss between Dispose and the physical write
      // leaves a zero-length blob that is PRESENT but undecodable — a bricked
      // device rather than an unenrolled one, and the CAS then refuses to heal it.
      return harden(
        [
          "  Add-Type -AssemblyName System.Security",
          `  $dir = [IO.Path]::GetDirectoryName(${path})`,
          "  if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }",
          "  $b64 = [Console]::In.ReadToEnd()",
          "  $der = [Convert]::FromBase64String($b64.Trim())",
          "  $blob = [Security.Cryptography.ProtectedData]::Protect($der, $null, 'CurrentUser')",
          "  try {",
          `    $fs = [IO.File]::Open(${path}, 'CreateNew')`,
          "  } catch [IO.IOException] {",
          "    if ($_.Exception.HResult -ne 0x80070050) { throw }",
          "    [Console]::Error.Write('identity already present')",
          `    exit ${EXIT_ALREADY_EXISTS}`,
          "  }",
          "  try { $fs.Write($blob, 0, $blob.Length); $fs.Flush($true) } finally { $fs.Dispose() }",
          `  [Console]::Out.Write('${STORE_SUCCESS_SENTINEL}')`,
        ].join("\n"),
      );
    case "delete":
      return harden(`  [IO.File]::Delete(${path})`);
  }
}

/**
 * Plan one vault invocation.
 *
 * Takes NO secret parameter — that is the structural half of I5. Whatever the
 * caller is holding, it cannot end up in this plan's argv.
 *
 * Throws for non-Windows platforms rather than improvising a command. D4: macOS
 * `security add-generic-password -w <secret>` puts the private key on argv where
 * same-user `ps` can read it, which is strictly worse than the 0600 file it would
 * replace; and omitting the value makes it prompt, which is useless for a daemon.
 * An untested command that leaks is worse than an honest refusal.
 */
export function planVaultCommand(
  op: VaultOp,
  ref: VaultRef,
  platform: NodeJS.Platform | string,
): VaultCommandPlan {
  if (platform !== "win32") {
    throw new Error(
      `worker-keystore: platform "${platform}" is not supported by DSK-001 — ` +
        "macOS and Linux ship as ports and command plans only (D4)",
    );
  }
  const scriptText = windowsScript(op, ref);
  const encoded = Buffer.from(scriptText, "utf16le").toString("base64");
  return {
    argv: [POWERSHELL_ABSOLUTE_PATH, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    scriptText,
    stdin: op === "store" ? "secret" : "none",
    exitCodes: { ok: 0, locked: 3, alreadyExists: 4 },
    blobPath: ref.blobPath,
  };
}
