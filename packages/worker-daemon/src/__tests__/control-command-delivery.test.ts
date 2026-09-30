/**
 * JOB-015 slices (c)+(d) — the worker-side READER and CLASSIFIER.
 *
 * ★ Every refusal below has its ALLOW-SIDE TWIN in the same `describe`. A denial suite
 * with no accept case cannot distinguish "refused" from "nothing was delivered" — which
 * is the exact defect JOB-015 closes, and reproducing it in the tests that close it
 * would be the worst possible outcome.
 */

import { describe, expect, it } from "vitest";
import { canonicalizeJsonV1 } from "@armyofagents/worker-protocol";

import {
  CONTROL_EXTENSION_NAMESPACE,
  ControlDeliveryMalformedError,
  classifyControlDelivery,
  controlCommandBodyDigest,
  controlCommandIsApplicable,
  createControlReceiverMemory,
  markControlCommandApplied,
  readControlCommandDelivery,
  type ControlCommandDelivery,
} from "../lease/control-commands.js";

// A fence token is ≥32 chars on the frozen schema.
const FENCE = "fence-token-000000000000000000001";
const OLDER_FENCE = "fence-token-000000000000000000000";
const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const WORKER = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const LEASE = "55555555-5555-4555-8555-555555555555";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function body(seq: number, kind = "drain", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    protocolVersion: 1,
    audience: "control_channel",
    commandId: uuid(seq),
    commandSeq: seq,
    idempotencyKey: uuid(seq),
    issuedAt: "2026-01-01T00:00:00.000Z",
    nonce: `nonce-${seq}`,
    organizationId: ORG,
    companyId: COMPANY,
    workerId: WORKER,
    jobId: JOB,
    attempt: 1,
    leaseId: LEASE,
    fenceToken: FENCE,
    commandKind: kind,
  };
  if (kind === "drain") base.reason = "operator drain";
  if (kind === "graceful_stop") base.deadline = "2026-01-01T00:05:00.000Z";
  if (kind === "cancel") {
    base.reason = "stop";
    base.graceful = true;
  }
  return { ...base, ...overrides };
}

/** A real `runtime_decision_result` payload — the BRW-004 fail-closed denial that
 * cannot reach a running worker without this ticket. */
function permissionDenial(): Record<string, unknown> {
  return {
    decisionKind: "permission",
    requestId: uuid(9),
    nonce: "decision-nonce",
    requestDigest: "a".repeat(64),
    schemaVersion: 1,
    sourceRevision: 0,
    expiresAt: "2026-01-01T01:00:00.000Z",
    decidedBy: { principalType: "user", principalId: "operator-1" },
    decidedAt: "2026-01-01T00:00:01.000Z",
    idempotencyKey: uuid(10),
    timeoutPolicy: "deny",
    decision: "deny",
  };
}

function extension(value: unknown): Record<string, unknown> {
  return { namespace: CONTROL_EXTENSION_NAMESPACE, schemaVersion: 1, critical: false, value };
}

function delivery(seqs: number[], extra: Record<string, unknown> = {}): ControlCommandDelivery {
  return readControlCommandDelivery([
    extension({ commands: seqs.map((s) => body(s)), pendingCount: seqs.length, truncated: false, ...extra }),
  ])!;
}

describe("JOB-015 (c) — reading the delivery: absent vs unreadable are NOT the same", () => {
  it("★ POSITIVE CONTROL — a well-formed extension is read and its commands parsed", () => {
    const read = readControlCommandDelivery([
      extension({
        commands: [body(1), body(2, "runtime_decision_result", { result: permissionDenial() })],
        pendingCount: 2,
        truncated: false,
      }),
    ]);
    expect(read).not.toBeNull();
    expect(read!.commands.map((c) => c.commandKind)).toEqual(["drain", "runtime_decision_result"]);
    expect(read!.truncated).toBe(false);
    expect(read!.pendingCount).toBe(2);
  });

  it("returns null when the namespace is ABSENT — indistinguishable from a pre-JOB-015 server", () => {
    expect(readControlCommandDelivery([])).toBeNull();
    expect(readControlCommandDelivery(undefined)).toBeNull();
    expect(
      readControlCommandDelivery([{ namespace: "dev.aoa.other/x", schemaVersion: 1, critical: false, value: {} }]),
    ).toBeNull();
  });

  it("THROWS when the namespace is present but the payload is unreadable — never 'no commands'", () => {
    const cases: unknown[] = [
      extension("not-an-object"),
      extension({ commands: "nope", pendingCount: 0, truncated: false }),
      extension({ commands: [], pendingCount: -1, truncated: false }),
      extension({ commands: [], pendingCount: 0, truncated: "yes" }),
      extension({ commands: [], pendingCount: 0, truncated: false, oversizedLeading: { commandId: 1 } }),
      extension({ commands: [{ not: "a command" }], pendingCount: 1, truncated: false }),
    ];
    for (const value of cases) {
      expect(() => readControlCommandDelivery([value])).toThrow(ControlDeliveryMalformedError);
    }
  });

  it("refuses a duplicated control namespace rather than picking one", () => {
    const one = extension({ commands: [], pendingCount: 0, truncated: false });
    expect(() => readControlCommandDelivery([one, one])).toThrow(ControlDeliveryMalformedError);
  });

  it("reads the oversizedLeading marker so the queue can be unblocked", () => {
    const read = readControlCommandDelivery([
      extension({
        commands: [],
        pendingCount: 3,
        truncated: true,
        oversizedLeading: { commandId: uuid(7), commandSeq: 7 },
      }),
    ]);
    expect(read!.oversizedLeading).toEqual({ commandId: uuid(7), commandSeq: 7 });
    expect(read!.truncated).toBe(true);
  });
});

describe("JOB-015 (d) — classification through the frozen decideControlReceiverV1", () => {
  it("★ POSITIVE CONTROL — an in-sequence command on the live fence is ACCEPTED and applicable", () => {
    const memory = createControlReceiverMemory();
    const [first] = classifyControlDelivery(memory, delivery([1]), FENCE);
    expect(first!.decision).toBe("accept");
    expect(controlCommandIsApplicable(first!)).toBe(true);
  });

  it("seeds from the lowest un-ACKed sequence so a mid-lease join does not gap forever", () => {
    // Commands 1-4 were ACKed earlier; the server's un-ACKed set now starts at 5. A
    // receiver seeded to 0 would classify this `gap` and refuse it on every renewal.
    const memory = createControlReceiverMemory();
    const [entry] = classifyControlDelivery(memory, delivery([5]), FENCE);
    expect(entry!.decision).toBe("accept");
  });

  it("a HOLE the worker never observed is a gap — not applied", () => {
    const memory = createControlReceiverMemory();
    classifyControlDelivery(memory, delivery([1]), FENCE);
    // Seq 3 with 2 never observed: on this pull channel the server sends the complete
    // un-ACKed set, so a skipped sequence means the per-lease allocation has a hole.
    const [entry] = classifyControlDelivery(memory, delivery([3]), FENCE);
    expect(entry!.decision).toBe("gap");
    expect(controlCommandIsApplicable(entry!)).toBe(false);
  });

  it("★ POSITIVE CONTROL — the very next sequence after the same prefix is accepted", () => {
    const memory = createControlReceiverMemory();
    classifyControlDelivery(memory, delivery([1]), FENCE);
    const [entry] = classifyControlDelivery(memory, delivery([2]), FENCE);
    expect(entry!.decision).toBe("accept");
  });

  it("a command bound to a SUPERSEDED fence is stale — not applied", () => {
    const memory = createControlReceiverMemory();
    const stale = readControlCommandDelivery([
      extension({
        commands: [body(1, "drain", { fenceToken: OLDER_FENCE })],
        pendingCount: 1,
        truncated: false,
      }),
    ])!;
    const [entry] = classifyControlDelivery(memory, stale, FENCE);
    expect(entry!.decision).toBe("stale");
    expect(controlCommandIsApplicable(entry!)).toBe(false);
  });

  it("★ POSITIVE CONTROL — the same command on the LIVE fence is applied", () => {
    const memory = createControlReceiverMemory();
    const [entry] = classifyControlDelivery(memory, delivery([1]), FENCE);
    expect(entry!.decision).toBe("accept");
  });

  it("a redelivered id with the SAME body is a replay — applied once, then not again", () => {
    const memory = createControlReceiverMemory();
    const [first] = classifyControlDelivery(memory, delivery([1]), FENCE);
    expect(controlCommandIsApplicable(first!)).toBe(true);
    markControlCommandApplied(memory, first!.command.commandId);

    const [again] = classifyControlDelivery(memory, delivery([1]), FENCE);
    expect(again!.decision).toBe("replay");
    expect(again!.alreadyApplied).toBe(true);
    expect(controlCommandIsApplicable(again!)).toBe(false);
  });

  it("a replay this worker never managed to apply IS retried", () => {
    // The server redelivers precisely because the command was not ACKed. A `replay`
    // that was never applied must not become permanently unreachable.
    const memory = createControlReceiverMemory();
    classifyControlDelivery(memory, delivery([1]), FENCE);
    const [again] = classifyControlDelivery(memory, delivery([1]), FENCE);
    expect(again!.decision).toBe("replay");
    expect(controlCommandIsApplicable(again!)).toBe(true);
  });

  it("the same id with a CHANGED body is a conflict — never applied", () => {
    const memory = createControlReceiverMemory();
    classifyControlDelivery(memory, delivery([1]), FENCE);
    const mutated = readControlCommandDelivery([
      extension({
        commands: [body(1, "drain", { reason: "a different reason" })],
        pendingCount: 1,
        truncated: false,
      }),
    ])!;
    const [entry] = classifyControlDelivery(memory, mutated, FENCE);
    expect(entry!.decision).toBe("conflict");
    expect(controlCommandIsApplicable(entry!)).toBe(false);
  });

  it("★ POSITIVE CONTROL — a DISTINCT command id alongside a known one is accepted separately", () => {
    const memory = createControlReceiverMemory();
    const classified = classifyControlDelivery(memory, delivery([1, 2]), FENCE);
    expect(classified.map((c) => c.decision)).toEqual(["accept", "accept"]);
    expect(new Set(classified.map((c) => c.command.commandId)).size).toBe(2);
  });

  it("digests over the SINGLE frozen canonicalizer, so two receivers agree", () => {
    const value = body(1);
    expect(controlCommandBodyDigest(value)).toBe(controlCommandBodyDigest({ ...value }));
    expect(canonicalizeJsonV1(value)).toBe(canonicalizeJsonV1({ ...value }));
  });
});
