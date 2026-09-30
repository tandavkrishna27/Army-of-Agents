/**
 * JOB-015 slice (c) — worker-side receipt of the control-command channel.
 *
 * The control plane has always been able to QUEUE a control command for a fenced run
 * (`job_control_commands`, five persistable kinds, live producers). Until JOB-015 the
 * only thing that reached the worker was ONE BOOLEAN — `cancelRequested` on the
 * lease-renew response — filtered to `cancel`/`graceful_stop`. `drain`,
 * `product_approval_result` and `runtime_decision_result` were written and never read.
 * This module is the receiving half: it reads the bounded `dev.aoa.job/control-v1`
 * extension off the renew response, classifies each command through the frozen
 * `decideControlReceiverV1`, and reports what may be applied.
 *
 * ★ THE TWO "CANNOT READ IT" CASES ARE DELIBERATELY DIFFERENT — the same split
 * `staged-input.ts` makes, and for the same reason:
 *
 *   * the namespace is ABSENT  → `null`. Indistinguishable from a pre-JOB-015 server,
 *     and that is the point: `critical:false` means an unrecognised extension must
 *     behave exactly like an absent one, so the boolean floor keeps governing.
 *   * the namespace is PRESENT but unreadable → THROW. The control plane addressed a
 *     command to this run and this worker cannot tell what it is. Folding that into
 *     "no commands pending" is the FAIL-OPEN this whole ticket exists to remove: a
 *     delivery fault must never wear the same shape as an empty queue (D3).
 *
 * ★★ WHY `acceptedThroughSeq` IS SEEDED, AND WHAT `gap` MEANS HERE. The frozen
 * classifier specifies a PUSH receiver: `gap` means a sequence went missing in
 * transit. This channel is a PULL — every renewal returns the complete un-ACKed set
 * for the lease in `command_seq` order — so a sequence BELOW the lowest delivered one
 * is not lost, it is ACKed. Seeding the receiver state from `firstDelivered - 1` on the
 * first payload for a lease encodes exactly that fact; without it a worker that picked
 * up mid-lease would classify its first real command as a `gap` and refuse it forever,
 * which is the fail-closed dead lever the design's open question 1 warned about.
 *
 * The `gap` arm still MEANS something after that seeding, and it is not decorative:
 * it fires when the server delivers a sequence the worker has never observed and that
 * is not the next one — i.e. the per-lease sequence has a HOLE. Measured at build time:
 * both insert sites allocate `COALESCE(MAX(command_seq),0)+1` under the lease lock
 * (`requestCancellation`, `queueGovernedControlCommand`), so the sequence is contiguous
 * by construction today and this arm should never fire. It is a guard against a future
 * writer that allocates differently, and it is mutation-tested rather than assumed.
 *
 * Runtime imports: `@armyofagents/worker-protocol` + `node:crypto` — the E4-D01 boundary.
 */

import { createHash } from "node:crypto";

import {
  canonicalizeJsonV1,
  controlCommandV1Schema,
  decideControlReceiverV1,
  type ControlCommandV1,
  type ControlReceiverDecisionV1,
} from "@armyofagents/worker-protocol";

/** The namespace the control plane publishes pending control commands under. MUST match
 * `CONTROL_EXTENSION_NAMESPACE` in `server/src/services/control-command-projection.ts`;
 * the two cannot import each other across the E4-D01 boundary, and
 * `control-command-namespace.contract.test.ts` pins that they agree. */
export const CONTROL_EXTENSION_NAMESPACE = "dev.aoa.job/control-v1";

/** The ACK detail for a command that can never ride the renew channel. Paired with the
 * frozen `rejected` status, so no wire change: it is what UNBLOCKS a queue whose leading
 * command is too large, instead of returning the same overflow marker forever. */
export const OVERSIZED_FOR_RENEW_CHANNEL = "oversized_for_renew_channel";

/** Thrown when the control extension is present but cannot be read. A delivery fault —
 * never folded into "no commands pending". */
export class ControlDeliveryMalformedError extends Error {
  constructor(detail: string) {
    super(`control-command delivery is unreadable: ${detail}`);
    this.name = "ControlDeliveryMalformedError";
  }
}

/** The command the server says can never ride this channel; the worker ACKs it
 * `rejected` so the queue behind it drains. */
export interface OversizedLeadingCommand {
  readonly commandId: string;
  readonly commandSeq: number;
}

/** One renewal's worth of control delivery. */
export interface ControlCommandDelivery {
  readonly commands: readonly ControlCommandV1[];
  /** The TOTAL un-ACKed count for the lease — so a truncated view still says how much
   * it cannot see. */
  readonly pendingCount: number;
  /** The server could not fit the whole queue. Declared, never inferred from a short
   * list, because a short list and a complete list look identical. */
  readonly truncated: boolean;
  readonly oversizedLeading: OversizedLeadingCommand | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The digest `decideControlReceiverV1` compares for replay-vs-conflict. Over the
 * SINGLE frozen canonicalizer, so two workers agree byte-for-byte. */
export function controlCommandBodyDigest(body: unknown): string {
  return createHash("sha256").update(canonicalizeJsonV1(body)).digest("hex");
}

/**
 * Read the control-command delivery off a lease-renew response's extensions.
 *
 * Returns `null` when the namespace is absent (a server that predates JOB-015, or a
 * renewal with nothing queued — the projector emits `[]` in that case, byte-identical
 * to the old hardcoded value). THROWS when the namespace is present and the payload
 * cannot be read.
 */
export function readControlCommandDelivery(
  extensions: readonly unknown[] | undefined,
): ControlCommandDelivery | null {
  if (!extensions) return null;
  const matches = extensions.filter(
    (extension) => isRecord(extension) && extension.namespace === CONTROL_EXTENSION_NAMESPACE,
  );
  if (matches.length === 0) return null;
  // The frozen refiner already rejects duplicate namespaces at the envelope, so a
  // second one here means the envelope check was bypassed. Refuse rather than pick.
  if (matches.length > 1) throw new ControlDeliveryMalformedError("duplicate control extension");

  const extension = matches[0] as Record<string, unknown>;
  const value = extension.value;
  if (!isRecord(value)) throw new ControlDeliveryMalformedError("value is not an object");
  if (!Array.isArray(value.commands)) throw new ControlDeliveryMalformedError("commands is not an array");
  if (typeof value.pendingCount !== "number" || !Number.isInteger(value.pendingCount) || value.pendingCount < 0) {
    throw new ControlDeliveryMalformedError("pendingCount is not a non-negative integer");
  }
  if (typeof value.truncated !== "boolean") {
    throw new ControlDeliveryMalformedError("truncated is not a boolean");
  }

  let oversizedLeading: OversizedLeadingCommand | null = null;
  if (value.oversizedLeading !== undefined) {
    const marker = value.oversizedLeading;
    if (!isRecord(marker) || typeof marker.commandId !== "string" || typeof marker.commandSeq !== "number") {
      throw new ControlDeliveryMalformedError("oversizedLeading marker is unreadable");
    }
    oversizedLeading = { commandId: marker.commandId, commandSeq: marker.commandSeq };
  }

  const commands: ControlCommandV1[] = [];
  for (const raw of value.commands) {
    // Every command body is re-validated against the FROZEN schema here. The
    // extension container bounds size and structure, not fields (`value` is
    // `z.unknown()` on the frozen envelope), so an unvalidated body would be a
    // control-plane-shaped object the worker trusted on the strength of its namespace.
    const parsed = controlCommandV1Schema.safeParse(raw);
    if (!parsed.success) throw new ControlDeliveryMalformedError("a command body failed the frozen schema");
    commands.push(parsed.data);
  }

  return {
    commands,
    pendingCount: value.pendingCount,
    truncated: value.truncated,
    oversizedLeading,
  };
}

/** What the worker has already seen on THIS lease. `observedThroughSeq` is the highest
 * contiguous sequence the worker has SEEN (not the highest it has applied): the server
 * redelivers everything un-ACKed, so a command the worker observed but could not apply
 * must not make every later command look like a gap. */
export interface ControlReceiverMemory {
  observedThroughSeq: number;
  seeded: boolean;
  readonly priors: Map<string, { seq: number; bodyDigest: string }>;
  readonly applied: Set<string>;
}

export function createControlReceiverMemory(): ControlReceiverMemory {
  return { observedThroughSeq: 0, seeded: false, priors: new Map(), applied: new Set() };
}

export interface ClassifiedControlCommand {
  readonly command: ControlCommandV1;
  readonly decision: ControlReceiverDecisionV1;
  /** True when this worker has already applied this command id in this process. A
   * `replay` that was never applied is still worth another attempt; one that was is not. */
  readonly alreadyApplied: boolean;
}

/**
 * Classify a delivery against the worker's memory of this lease, in `command_seq` order.
 *
 * Mutates `memory`: this is the receiver's prior state and the classification is only
 * meaningful if it advances. `activeFenceToken` is the fence the worker currently holds —
 * a command bound to a superseded fence classifies `stale` and must not be applied.
 */
export function classifyControlDelivery(
  memory: ControlReceiverMemory,
  delivery: ControlCommandDelivery,
  activeFenceToken: string,
): ClassifiedControlCommand[] {
  if (!memory.seeded && delivery.commands.length > 0) {
    // Everything below the lowest un-ACKed sequence is ACKed, by construction of the
    // server's query (`ack_status IS NULL`, ordered ascending). Seed from it so a
    // worker that joins mid-lease does not gap on its first real command.
    memory.observedThroughSeq = Math.max(0, delivery.commands[0]!.commandSeq - 1);
    memory.seeded = true;
  }

  const classified: ClassifiedControlCommand[] = [];
  for (const command of delivery.commands) {
    const bodyDigest = controlCommandBodyDigest(command);
    const decision = decideControlReceiverV1(
      {
        acceptedThroughSeq: memory.observedThroughSeq,
        activeFenceToken,
        priorForCommandId: memory.priors.get(command.commandId) ?? null,
      },
      {
        commandId: command.commandId,
        commandSeq: command.commandSeq,
        fenceToken: command.fenceToken,
        bodyDigest,
      },
    );
    if (decision === "accept") {
      memory.observedThroughSeq = command.commandSeq;
      memory.priors.set(command.commandId, { seq: command.commandSeq, bodyDigest });
    }
    classified.push({
      command,
      decision,
      alreadyApplied: memory.applied.has(command.commandId),
    });
  }
  return classified;
}

/** Record that a command was applied, so a later `replay` is not re-applied. */
export function markControlCommandApplied(memory: ControlReceiverMemory, commandId: string): void {
  memory.applied.add(commandId);
}

/** A command may be applied on `accept`, or on `replay` when this worker never managed
 * to apply it (the server keeps redelivering precisely because it was not ACKed).
 * `gap`, `conflict` and `stale` are refusals. */
export function controlCommandIsApplicable(classified: ClassifiedControlCommand): boolean {
  if (classified.decision === "accept") return true;
  return classified.decision === "replay" && !classified.alreadyApplied;
}
