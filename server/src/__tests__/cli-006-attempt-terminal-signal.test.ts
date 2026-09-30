// CLI-006 — the attempt-terminal projection trigger.
//
// `resolveAttemptTerminalSignal` decides whether a JOB-005 ingest just moved an
// attempt to a durable terminal state, which is what lets a canary-owned
// heartbeat run be finalized from the attempt's evidence.
//
// The load-bearing distinction is the ACK vocabulary. `status === "terminal"` does
// NOT mean "just became terminal" — it is the fence guard reporting the attempt was
// ALREADY terminal and refusing the append before touching any row. Projecting on
// that would re-fire the terminal projection on every late retry of a finished
// attempt, and (because the projector posts a run-summary comment) would spam the
// task with duplicates.

import { describe, expect, it } from "vitest";
import { resolveAttemptTerminalSignal } from "../services/job-events.js";

const IDENTITY = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  jobId: "33333333-3333-4333-8333-333333333333",
  attemptId: "44444444-4444-4444-8444-444444444444",
};

function event(over: Record<string, unknown> = {}) {
  return {
    eventId: "e1",
    sequence: 1,
    eventType: "log",
    fenceToken: "f1",
    suppliedDigest: "d",
    recomputedDigest: "d",
    occurredAt: new Date(),
    payload: {},
    terminalStatus: null,
    ...over,
  } as never;
}

describe("CLI-006 — resolveAttemptTerminalSignal", () => {
  it("signals when an accepted batch carried a terminal event", () => {
    const signal = resolveAttemptTerminalSignal({
      acceptInputs: [event(), event({ eventId: "e2", sequence: 2, eventType: "terminal", terminalStatus: "succeeded" })],
      ackStatus: "accepted",
      identity: IDENTITY,
    });
    expect(signal).toEqual({ ...IDENTITY, terminalStatus: "succeeded" });
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out"] as const)(
    "carries the `%s` terminal status through",
    (terminalStatus) => {
      const signal = resolveAttemptTerminalSignal({
        acceptInputs: [event({ eventType: "terminal", terminalStatus })],
        ackStatus: "accepted",
        identity: IDENTITY,
      });
      expect(signal?.terminalStatus).toBe(terminalStatus);
    },
  );

  it("does NOT signal for an accepted batch with no terminal event", () => {
    expect(
      resolveAttemptTerminalSignal({
        acceptInputs: [event(), event({ eventId: "e2", sequence: 2, eventType: "usage" })],
        ackStatus: "accepted",
        identity: IDENTITY,
      }),
    ).toBeNull();
  });

  // The distinction the whole helper exists for.
  it("does NOT signal on ackStatus `terminal` — the fence refused an ALREADY-terminal attempt", () => {
    expect(
      resolveAttemptTerminalSignal({
        acceptInputs: [event({ eventType: "terminal", terminalStatus: "succeeded" })],
        ackStatus: "terminal",
        identity: IDENTITY,
      }),
    ).toBeNull();
  });

  it.each(["gap", "hash_mismatch", "stale_fence"] as const)(
    "does NOT signal on a rejected batch (`%s`) even when it carried a terminal event",
    (ackStatus) => {
      expect(
        resolveAttemptTerminalSignal({
          acceptInputs: [event({ eventType: "terminal", terminalStatus: "failed" })],
          ackStatus,
          identity: IDENTITY,
        }),
      ).toBeNull();
    },
  );

  it("does not signal on an empty batch", () => {
    expect(
      resolveAttemptTerminalSignal({ acceptInputs: [], ackStatus: "accepted", identity: IDENTITY }),
    ).toBeNull();
  });
});
