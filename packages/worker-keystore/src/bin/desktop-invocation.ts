// packages/worker-keystore/src/bin/desktop-invocation.ts
//
// DSK-003 Lane A — what an invocation of the desktop binary MEANS.
//
// One binary now serves three purposes: boot the background host, destroy the device
// identity (`--reset-identity`, guarded since DSK-001), and run a control command. This
// module decides which, and it is pure so the decision is a fact about a value rather
// than a hope about control flow.
//
// THE FAILURE THIS PREVENTS. A control command must NEVER mean boot. If
// `aoa-worker-desktop status` started a worker as a side effect, an operator checking on
// a running host would silently create a SECOND one — two daemons, two leases, one device
// identity — which is worse than whatever they were checking on.
//
// AN UNRECOGNISED WORD ROUTES TO CONTROL, deliberately. `aoa-worker-desktop stauts` must
// be refused by name, not silently start a daemon. The control layer already refuses
// unknown commands (default-deny); boot would say nothing and run one.
//
// THE PARSING IS NOT DUPLICATED. `parseControlCommand` already lives in
// `@armyofagents/worker-daemon` and this package depends on it, so it is imported rather
// than re-implemented. A first draft did re-implement it — which is precisely the drift
// risk argued against for the acknowledgement flag one file over, where duplication was
// unavoidable and had to be pinned by test. Here it is avoidable, so it is avoided.

import { parseControlCommand } from "@armyofagents/worker-daemon";

/** The subcommand that wipes a device identity. THE single declaration — the host
 * re-exports it from here, because which argv means what is a routing concern and
 * two declarations of one flag are two things to keep in step. */
export const RESET_IDENTITY_FLAG = "--reset-identity";

export type DesktopInvocation =
  | { readonly kind: "boot" }
  | { readonly kind: "reset_identity" }
  | { readonly kind: "control"; readonly command: string; readonly token: string | null };

/**
 * Decide what this argv means.
 *
 * `--reset-identity` wins over a control command in the same argv. An argv naming both is
 * ambiguous, and ambiguity must resolve toward the path with the LOUDER guard: the reset
 * path reads the identity and names it before destroying it, which the control path does
 * not do.
 */
export function resolveDesktopInvocation(argv: readonly string[]): DesktopInvocation {
  if (argv.includes(RESET_IDENTITY_FLAG)) return { kind: "reset_identity" };

  const { command, token } = parseControlCommand(argv);

  if (command === null) return { kind: "boot" };
  return { kind: "control", command, token };
}
