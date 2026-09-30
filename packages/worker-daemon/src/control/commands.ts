/**
 * The desktop control surface (DSK-003 Lane A, D1/D3/D10).
 *
 * AUTHORIZATION IS DEFAULT-DENY. The rule is not "these commands check a token"; it is
 * that anything NOT explicitly declared read-only requires one. A `pause`, `rotate` or
 * `reset` added later by someone who never opened this file is gated automatically. The
 * alternative — a list of mutating commands somebody must remember to extend — fails
 * open exactly once, silently, and in the direction that matters.
 *
 * WHY A TOKEN AT ALL. `health/health-server.ts` is loopback-only and unauthenticated,
 * which is correct for read-only liveness. Mutating control cannot share that surface:
 * loopback is a network boundary, not an authorization boundary, and on a shared desktop
 * every local process is inside it. See `identity/control-token.ts`.
 *
 * D10 — `drain` IS A CALLER. `bin/worker-daemon.ts:280` already composes
 * `[...leaseSteps, ...outboxSteps, health-server]` and `createLeaseLifecycleSteps` already
 * returns `[lease-stop, renewal-stop, lease-drain]`. This module never re-derives that
 * ordering; the command's job is to reach the running host and trigger the handler it
 * already has. Two copies of an ordering drift until one of them stops renewing during a
 * drain, and nothing fails until it matters.
 *
 * D3 — `revoke` is LOCAL authority only. A desktop cannot revoke its own server-side
 * target; that lives in the control plane. This destroys the local identity and stops
 * work. Naming it precisely matters: a `revoke` that silently did half the job would read
 * as a security control it is not.
 *
 * Pure — no fs, no process, no clock. The verifier and platform are injected.
 */

import type { ControlTokenRejection, ControlTokenResult } from "../identity/control-token.js";
import type { OwnerOnlyDeps } from "../identity/file-custody.js";

/** Every command the desktop control surface accepts. `uninstall` is Lane B. */
export const CONTROL_COMMANDS = ["status", "logs", "drain", "revoke"] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

/**
 * The commands that need no token, enumerated EXHAUSTIVELY and deliberately short.
 *
 * `status` and `logs` disclose liveness and local diagnostics the OS already lets the
 * caller read. Everything else — present or future — is gated.
 */
export const READ_ONLY_COMMANDS = ["status", "logs"] as const;
export type ReadOnlyCommand = (typeof READ_ONLY_COMMANDS)[number];

const READ_ONLY: ReadonlySet<string> = new Set(READ_ONLY_COMMANDS);
const KNOWN: ReadonlySet<string> = new Set(CONTROL_COMMANDS);

/**
 * True unless the command is explicitly declared read-only.
 *
 * Deliberately phrased as "not in the allowlist" rather than "in the mutating list": an
 * unknown command must be gated, and a membership test against the mutating set would
 * wave it through.
 */
export function requiresControlToken(command: string): boolean {
  return !READ_ONLY.has(command);
}

export type ControlAuthzRejection = ControlTokenRejection | "unknown_command";

export type ControlAuthzResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: ControlAuthzRejection };

export interface ControlAuthzDeps extends OwnerOnlyDeps {
  /** The token verifier, injected so this module needs no fs. */
  readonly verify: (presented: string | null | undefined, deps: OwnerOnlyDeps) => ControlTokenResult;
}

/**
 * Decide whether a command may run.
 *
 * An UNKNOWN command is refused before authorization is even considered — authenticating
 * successfully must not dispatch something the surface does not define.
 */
export function authorizeControlCommand(
  command: string,
  presented: string | null | undefined,
  deps: ControlAuthzDeps,
): ControlAuthzResult {
  if (!KNOWN.has(command)) return { allowed: false, reason: "unknown_command" };
  if (!requiresControlToken(command)) return { allowed: true };
  // Absence is refused HERE, not delegated. `verifyControlToken` also returns
  // `not_presented` for this input, so against the real verifier the check is redundant —
  // but `verify` is an INJECTED seam, and the gate must not depend on whichever
  // implementation is wired being strict about the most basic case. A lenient verifier
  // should cost a wrong token, never a missing one.
  if (typeof presented !== "string" || presented.length === 0) {
    return { allowed: false, reason: "not_presented" };
  }
  const verified = deps.verify(presented, deps);
  return verified.ok ? { allowed: true } : { allowed: false, reason: verified.reason };
}

export interface ParsedControlCommand {
  /** `null` when argv named no command (only flags, or nothing). */
  readonly command: string | null;
  readonly token: string | null;
}

/**
 * Parse `argv` into a command plus an optional `--token`.
 *
 * An unrecognised command is returned VERBATIM rather than corrected to a near match.
 * "Did you mean revoke?" is how `revoke` gets run by accident, and the authorization gate
 * above refuses unknown commands anyway.
 *
 * The FIRST `--token` wins, so a later duplicate cannot override an earlier one — the
 * shape that lets an injected argument quietly replace a legitimate value.
 */
export function parseControlCommand(argv: readonly string[]): ParsedControlCommand {
  let command: string | null = null;
  let token: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--token=")) {
      if (token === null) token = arg.slice("--token=".length);
      continue;
    }
    if (arg === "--token") {
      const next = argv[i + 1];
      if (token === null && next !== undefined) token = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (command === null) command = arg;
  }
  return { command, token };
}
