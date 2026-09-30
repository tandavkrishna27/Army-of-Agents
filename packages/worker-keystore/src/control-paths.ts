// packages/worker-keystore/src/control-paths.ts
//
// DSK-003 Lane A — where the control token and the host state record live.
//
// BESIDE THE DEVICE VAULT, resolved by the same rules. Inventing a second location scheme
// is how a machine ends up with two ideas of "the AoA directory" and a control command
// that cannot find the host running next to it.
//
// The rules are `blob-path.ts`'s, inherited deliberately rather than restated:
//
//   - **win32 only.** DSK-001's D4 ships macOS and Linux as ports; `resolveVaultRefs`
//     throws for them. A control path that resolved where the vault refuses would be a
//     control surface for an identity that cannot exist there.
//   - **Refuse rather than guess.** No fallback to APPDATA — roaming would follow the
//     user to another machine, carrying a control token for a host that is not there —
//     and none to the cwd.
//   - **Drive-letter absolute only.** A UNC path would put these on a share: reachable by
//     everybody, with the per-user ACL that makes the token meaningful gone.
//
// It DERIVES from `resolveVaultRefs` rather than re-deriving the directory, so the two
// cannot drift: if the vault ever moves, these move with it, and the refusals are shared
// by construction instead of by being written twice.

import { resolveVaultRefs } from "./blob-path.js";

/** Fixed, versioned filenames. A version bump is a deliberate migration. */
const CONTROL_TOKEN_FILE = "control-token.v1.txt";
const HOST_STATE_FILE = "host-state.v1.json";
const HOST_LOG_FILE = "host.v1.log";

export interface ControlPaths {
  /** The 0600-equivalent file whose readability authorizes a mutating command. */
  readonly tokenPath: string;
  /** The record naming the running host's pid, port and per-boot instance nonce. */
  readonly statePath: string;
  /**
   * Where the background host writes its own output.
   *
   * Beside the vault rather than under `Library/Logs` or `%APPDATA%`, for the same reason
   * the other two are: one AoA directory, one set of refusals. Task Scheduler cannot
   * redirect, so the host opens this file itself (`createWorkerLogger({ filePath })`) —
   * no shell on the launch path of the process holding the device identity.
   */
  readonly logPath: string;
}

/**
 * Resolve both control-file locations, or throw.
 *
 * Takes `env` and `platform` rather than reading `process`, so the rules are provable on
 * the ubuntu-only required lane — the same reason every other decision in this package
 * is pure.
 */
export function resolveControlPaths(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform | string,
): ControlPaths {
  // Every refusal — unsupported platform, missing LOCALAPPDATA, UNC path — comes from
  // here, so this function has none of its own to keep in step.
  const identityBlob = resolveVaultRefs(env, platform).identity.blobPath;
  const dir = identityBlob.split("\\").slice(0, -1).join("\\");
  return {
    tokenPath: `${dir}\\${CONTROL_TOKEN_FILE}`,
    statePath: `${dir}\\${HOST_STATE_FILE}`,
    logPath: `${dir}\\${HOST_LOG_FILE}`,
  };
}
