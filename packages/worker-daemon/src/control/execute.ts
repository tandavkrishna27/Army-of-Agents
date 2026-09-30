/**
 * The control-command effect layer (DSK-003 Lane A).
 *
 * THE BYPASS THIS EXISTS TO AVOID. `packages/worker-keystore/src/bin/desktop-host.ts`
 * already guards identity destruction behind TWO flags — `--reset-identity` plus
 * `--i-understand-this-is-permanent` — and documents why: on the same target the reset IS
 * a permanent lockout, because the server denies the re-minted workerId and
 * `findWorkerForBinding` carries no status predicate, so the stale row keeps matching
 * forever with no reset route.
 *
 * `revoke` destroys the SAME local identity. Shipping it without that acknowledgement
 * would leave the guard in place and simply not on the path anyone takes — the worst kind
 * of security control, one that looks present and is routed around. Two commands that
 * destroy the same thing carry the same guard.
 *
 * ORDER IS ENFORCED, NOT ASSUMED. `revoke` stops work before it destroys anything, and it
 * destroys NOTHING if the running host could not be stopped: an identity destroyed while
 * work is in flight strands that work with no way to report it, and leaves the operator
 * with neither a running host nor a device.
 *
 * AUTHORIZATION COMES FIRST, before even the acknowledgement check. Otherwise the refusal
 * would tell an unauthorized caller which flag to add — a small oracle, but a free one.
 *
 * Every effect is INJECTED. This module decides; it does not signal, read files, or touch
 * a keystore, which is what makes the ordering and the refusals testable at all.
 */

import type { ControlAuthzRejection, ControlAuthzResult } from "./commands.js";
import type { TargetProcessRejection, TargetProcessResult } from "./host-state.js";

/**
 * The acknowledgement `revoke` requires.
 *
 * The literal string is duplicated from `worker-keystore`'s `RESET_ACKNOWLEDGEMENT_FLAG`
 * rather than imported, because the daemon may not depend on that package — its manifest
 * is pinned and checked in CI. The duplication is PINNED BY TEST on both sides, so a
 * divergence fails rather than silently producing two different guards. That is the least
 * bad option available: an operator who learned one flag must not be refused by the other.
 */
export const RESET_ACKNOWLEDGEMENT_FLAG = "--i-understand-this-is-permanent";

export type ControlExecuteRejection =
  | ControlAuthzRejection
  | TargetProcessRejection
  | "acknowledgement_required";

export type ControlExecuteResult =
  | { readonly ok: true; readonly command: string; readonly detail?: unknown }
  | { readonly ok: false; readonly reason: ControlExecuteRejection; readonly message: string };

export interface ControlExecuteInput {
  readonly command: string;
  readonly token: string | null;
  readonly argv: readonly string[];
}

export interface ControlExecuteDeps {
  authorize(command: string, token: string | null): ControlAuthzResult;
  resolveTarget(): Promise<TargetProcessResult>;
  /** Ask the host to shut down. The ORDERING inside that shutdown is the daemon's own
   * (`lifecycle/shutdown.ts` lease-stop → drain → outbox → health), never re-derived
   * here — see D10. */
  signal(pid: number): Promise<void>;
  readStatus(): Promise<unknown>;
  readLogTail(): Promise<string>;
  destroyIdentity(): Promise<void>;
}

function refuse(reason: ControlExecuteRejection, message: string): ControlExecuteResult {
  return { ok: false, reason, message };
}

/**
 * Run one control command, or refuse with a reason an operator can act on.
 */
export async function executeControlCommand(
  input: ControlExecuteInput,
  deps: ControlExecuteDeps,
): Promise<ControlExecuteResult> {
  // 1. Authorization, before anything else — including before the acknowledgement check.
  const authz = deps.authorize(input.command, input.token);
  if (!authz.allowed) {
    return refuse(authz.reason, `control command refused: ${authz.reason}`);
  }

  if (input.command === "status") {
    return { ok: true, command: "status", detail: await deps.readStatus() };
  }

  if (input.command === "logs") {
    return { ok: true, command: "logs", detail: await deps.readLogTail() };
  }

  // 2. `revoke` destroys the device identity, so it carries the same acknowledgement the
  //    keystore host's `--reset-identity` requires. See the module header.
  if (input.command === "revoke" && !input.argv.includes(RESET_ACKNOWLEDGEMENT_FLAG)) {
    return refuse(
      "acknowledgement_required",
      `revoke destroys this device's identity permanently and it cannot be re-enrolled ` +
        `on the same target. To proceed: revoke ${RESET_ACKNOWLEDGEMENT_FLAG}`,
    );
  }

  // 3. Stop work. A pid alone is never authority — `resolveTarget` requires the live host
  //    to prove it is the instance the state record describes.
  const target = await deps.resolveTarget();
  if (!target.ok) {
    return refuse(target.reason, `could not address the running host: ${target.reason}`);
  }
  await deps.signal(target.pid);

  // 4. Only now, and only for `revoke`, touch the identity.
  if (input.command === "revoke") {
    await deps.destroyIdentity();
    return { ok: true, command: "revoke" };
  }

  return { ok: true, command: input.command };
}
