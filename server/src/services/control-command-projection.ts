// server/src/services/control-command-projection.ts
//
// JOB-015 slice (b) — the lease-renew CONTROL-COMMAND projection.
//
// Until this module existed there was exactly ONE delivery path from a queued
// `job_control_commands` row to a running worker, it carried a BOOLEAN
// (`cancelRequested`), and it was filtered to two of the five persistable kinds. The
// other three — `drain`, `product_approval_result`, `runtime_decision_result` — were
// written by live producers and never read out: `renewLease` hardcoded
// `extensions: []` directly beside `cancelRequested: Boolean(pendingCancel)`.
//
// This is the pure half of the fix: given the lease's un-ACKed commands in
// `command_seq` order, produce the bounded `dev.aoa.job/control-v1` extension for the
// frozen lease-renew response. It lives HERE and not in `packages/db` because the db
// package deliberately does NOT depend on `@armyofagents/worker-protocol` (see
// `packages/db/src/schema/services.ts:37-39`); the renew mutator takes the projector
// as a REQUIRED injected callback, exactly the topology `commitArtifactVersion`
// already uses for the frozen object-key prefix helper ("pre-evaluated by the server,
// which owns the frozen worker-protocol helper").
//
// ★★★ THE OMISSION RULE. An omitted extension is BYTE-IDENTICAL to `extensions: []`,
// so "the queue overflowed" and "nothing is pending" would be indistinguishable on the
// wire — which is the exact defect this ticket exists to close, re-committed one layer
// up. Therefore: when anything is pending, an extension is ALWAYS emitted. What varies
// is how much of the queue it carries and whether it is marked `truncated`.
//
// ★★★ AND THE OVERSIZED-LEADING TERMINAL. Commands are delivered in `command_seq`
// order, so a leading command that alone does not fit would make every renewal return
// the same "truncated, nothing included" marker forever: the worker has nothing to
// apply, nothing to ACK, and ACK is what clears `ack_status IS NULL`. That is a
// permanent stall with no terminal (the E7-F010 shape), and it is GUARANTEED at the
// bound rather than merely reachable — a work-question answer is capped at 16 KiB
// canonical and the per-extension-value cap is EXACTLY 16,384 bytes, so a maximal
// answer plus its own envelope necessarily overflows. So the marker names that command
// (`oversizedLeading`) and the worker ACKs it `rejected` /
// `oversized_for_renew_channel` — a frozen `CONTROL_ACK_STATUSES` value, no wire
// change — which clears the row and lets the queue behind it drain.
//
// ★ NOT SIBLING-BLIND. `pointerFitsExtension` (job-input-staging.ts) measures ONE
// value against the per-value cap and is fine only because the job envelope carries a
// single extension. This projector is handed the extensions ALREADY on the envelope
// and probes the UNION, so the combined ≤65,536-byte budget and the ≤16-extension
// count are enforced the moment a second lease-envelope extension appears.
//
// ★ ADMISSIBILITY IS THE REAL REFINER, NOT A BYTE ESTIMATE. The fit test runs the
// frozen `addWireExtensionArrayIssues` over the candidate array, so "fits" means
// exactly "the frozen envelope will accept it" — including the structural bounds a
// byte count cannot see (≤8 container levels, ≤128 array items, ≤64 object keys). The
// stored `command` jsonb is unbounded in DEPTH as well as in bytes, and a
// depth-overflowing command is caught by the same terminal rule as a byte-overflowing
// one instead of throwing out of `leaseRenewOperationResponseV1Schema.parse` later.

import {
  addWireExtensionArrayIssues,
  wireExtensionSchema,
  type WireExtension,
} from "@armyofagents/worker-protocol";
import { z } from "zod";

/** The bounded, namespaced, `critical:false`-ignorable container the pending control
 * commands ride on the frozen lease-renew response. `critical:false` is load-bearing:
 * a worker that predates this extension IGNORES it and keeps completing runs, which is
 * the whole reason the additive container exists. */
export const CONTROL_EXTENSION_NAMESPACE = "dev.aoa.job/control-v1";
export const CONTROL_EXTENSION_SCHEMA_VERSION = 1;

/** A hard cap on commands per response, independent of the byte budget. The frozen
 * per-value structural bound is 128 array items; this is far below it so the fit loop
 * is bounded work rather than bounded only by bytes. A queue longer than this is
 * delivered across successive renewals and is marked `truncated` while it drains. */
export const CONTROL_EXTENSION_MAX_COMMANDS = 16;

/** The ACK detail a worker reports for a command that can never ride this channel. */
export const OVERSIZED_FOR_RENEW_CHANNEL = "oversized_for_renew_channel";

/** The subset of a queued row this projection needs. Structurally compatible with the
 * db package's `QueuedControlCommand` without importing it (the server↔db direction of
 * this seam is a plain callback). */
export interface ProjectableControlCommand {
  readonly commandId: string;
  readonly commandSeq: number;
  readonly commandKind: string;
  /** The reconstructable frozen E1 wire body, as stored in the `command` jsonb. It
   * already carries `commandId`/`commandSeq`/`commandKind`/`fenceToken`, so nothing is
   * duplicated alongside it. */
  readonly command: Record<string, unknown>;
}

/** The shape carried in the extension's `value`. `pendingCount` is the TOTAL un-ACKed
 * count for the lease, so a truncated view still tells the worker how much it cannot
 * see. `oversizedLeading`, when present, names the one command that can never ride this
 * channel and must be ACKed `rejected` to unblock the queue. */
export interface ControlExtensionValue {
  readonly commands: readonly Record<string, unknown>[];
  readonly pendingCount: number;
  readonly truncated: boolean;
  readonly oversizedLeading?: { readonly commandId: string; readonly commandSeq: number };
}

/** Thrown when even the overflow MARKER cannot ride the envelope. D3's last resort: a
 * renew that fails loudly, never a 200 whose body reads as "no commands pending". */
export class ControlProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlProjectionError";
  }
}

/**
 * Run the FROZEN extension-array refiner over a candidate union and report whether it
 * would be accepted — count ≤16, unique namespaces, unknown-critical fail-closed, the
 * per-value structural walk (≤8 levels, ≤128 items, ≤64 keys, ≤100 key bytes), the
 * per-value ≤16,384 canonical-byte budget, and the combined ≤65,536-byte budget.
 *
 * The refiner is invoked with a counting `RefinementCtx` rather than through a composed
 * `z.object({...}).superRefine(...)`, which trips TS2589 ("type instantiation is
 * excessively deep") the same way `job-control-ack.ts`'s two-pass parse does. Each
 * candidate extension is still parsed against `wireExtensionSchema` itself, so the
 * container's own field rules are enforced and not merely assumed.
 *
 * ★ This is the fit test on purpose: "fits" means exactly "the frozen envelope will
 * accept it", not "my byte estimate says so". A structural overflow the byte count
 * cannot see is caught HERE, by the same terminal rule as a byte overflow, instead of
 * throwing out of `leaseRenewOperationResponseV1Schema.parse` after the transaction.
 */
function admissible(extensions: readonly WireExtension[]): boolean {
  for (const extension of extensions) {
    if (!wireExtensionSchema.safeParse(extension).success) return false;
  }
  let issues = 0;
  const ctx = {
    addIssue: () => {
      issues += 1;
    },
    path: [] as (string | number)[],
  } as unknown as z.RefinementCtx;
  addWireExtensionArrayIssues(extensions, ctx, []);
  return issues === 0;
}

function buildExtension(value: ControlExtensionValue): WireExtension {
  return {
    namespace: CONTROL_EXTENSION_NAMESPACE,
    schemaVersion: CONTROL_EXTENSION_SCHEMA_VERSION,
    critical: false,
    value,
  };
}

/**
 * Project the lease's un-ACKed control commands onto the frozen lease-renew response's
 * bounded extension container.
 *
 * `existing` is whatever the response already carries (today: nothing) — the union is
 * probed, so the combined budget is enforced rather than assumed.
 *
 * Returns the FULL extensions array for the response, never just the new entry.
 *
 * - No pending commands → `existing` unchanged. ★ With nothing pending the response is
 *   byte-identical to the pre-JOB-015 `extensions: []`. That is the positive control
 *   that proves this change is inert when it should be.
 * - Everything fits → one extension, `truncated: false`.
 * - A prefix fits → that prefix, `truncated: true` + the total `pendingCount`.
 * - The LEADING command alone does not fit → `commands: []`, `truncated: true`, and
 *   `oversizedLeading` naming it, so it can be ACKed `rejected` and the queue drains.
 * - Even that marker does not fit → THROW. Never a silent `[]`.
 */
export function projectControlCommandExtensions(
  existing: readonly WireExtension[],
  pending: readonly ProjectableControlCommand[],
): WireExtension[] {
  if (pending.length === 0) return [...existing];

  const pendingCount = pending.length;
  const capped = pending.slice(0, CONTROL_EXTENSION_MAX_COMMANDS);

  // Greedy prefix: include commands 1..k while the UNION stays admissible. Each
  // candidate is built with its FINAL `truncated` value, because that flag is itself
  // part of the canonical bytes being measured.
  let fitted = 0;
  for (let k = 1; k <= capped.length; k += 1) {
    const candidate = buildExtension({
      commands: capped.slice(0, k).map((command) => command.command),
      pendingCount,
      truncated: k < pendingCount,
    });
    if (!admissible([...existing, candidate])) break;
    fitted = k;
  }

  if (fitted === 0) {
    // The leading command cannot ride this channel at all — bytes or structure. Emit
    // the terminal marker so the stall has an exit rather than a hope.
    const leading = capped[0]!;
    const marker = buildExtension({
      commands: [],
      pendingCount,
      truncated: true,
      oversizedLeading: { commandId: leading.commandId, commandSeq: leading.commandSeq },
    });
    if (!admissible([...existing, marker])) {
      throw new ControlProjectionError(
        `the control-command overflow marker for command ${leading.commandId} does not fit the lease-renew extension budget`,
      );
    }
    return [...existing, marker];
  }

  return [
    ...existing,
    buildExtension({
      commands: capped.slice(0, fitted).map((command) => command.command),
      pendingCount,
      truncated: fitted < pendingCount,
    }),
  ];
}
