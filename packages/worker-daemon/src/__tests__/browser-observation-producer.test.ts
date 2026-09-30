import { describe, it, expect } from "vitest";
import { EventSequencer, quantiseExtensionNumbers } from "../supervisor/events.js";
import type { WorkerEventV1 } from "@armyofagents/worker-protocol";

// BRW-003d-3 — the PRODUCER half.
//
// ★ THIS HALF IS DORMANT AND SAYS SO. `createSupervisor` has zero production
// callers, so nothing emits a browser observation yet. These tests are a FORWARD
// GUARD on the API the browser runtime will use — they are never the clause's
// proof. The clause is proven server-side, in the projection.
//
// What they DO prove non-vacuously: that the frozen contract accepts what this
// producer builds. The emit path runs `workerEventV1Schema.parse` before anything
// leaves, so a shape the contract rejects fails HERE rather than on the wire.

/** A VALID wire extension. The schema is `.strict()` and requires schemaVersion
 * and critical; omitting them makes every emit throw for the WRONG reason — which
 * is exactly how the float test below first passed vacuously. */
const ext = (value: unknown) => ({
  namespace: "aoa.dev/browser",
  schemaVersion: 1,
  critical: false,
  value,
});

const identity = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  workerId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  attempt: 1,
  leaseId: "55555555-5555-4555-8555-555555555555",
  fenceToken: "66666666-6666-4666-8666-666666666666",
} as const;

function sequencer() {
  const emitted: WorkerEventV1[] = [];
  let n = 0;
  const seq = new EventSequencer({
    identity: identity as never,
    sink: { emit: (e: WorkerEventV1) => { emitted.push(e); } },
    newEventId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    now: () => "2026-01-01T00:00:00.000Z",
    redactionCanaries: [],
  } as never);
  return { seq, emitted };
}

describe("BRW-003d-3 producer — browserObservation", () => {
  it("emits an event the FROZEN contract accepts", async () => {
    const { seq, emitted } = sequencer();
    await seq.browserObservation({ artifactIds: [], url: "https://ex.com/p", title: "P" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].eventType).toBe("browser_observation");
  });

  it("carries extensions onto the wire event", async () => {
    // The payload is `.strict()` with three fields, so this is the ONLY channel
    // console lines and network summaries have.
    const { seq, emitted } = sequencer();
    await seq.browserObservation({
      artifactIds: [],
      url: null,
      title: null,
      extensions: [ext({ requests: 3 })],
    });
    expect(JSON.stringify(emitted[0].extensions)).toContain("requests");
  });

  it("★ REFUSES a float rather than rounding it silently", async () => {
    // canonical-json rejects floats outright, and the parse runs BEFORE the wire —
    // so an un-quantised duration loses the whole observation at emit time. The
    // point of this test is that the failure is LOUD and local.
    const { seq } = sequencer();
    await expect(
      seq.browserObservation({
        artifactIds: [],
        url: null,
        title: null,
        extensions: [ext({ ms: 12.5 })],
      }),
    // ★ ASSERT THE REASON, not merely that it threw. This test first passed for
    // the WRONG reason: the fixture omitted the schema's required schemaVersion
    // and critical fields, so the emit threw on SHAPE and the float was never
    // exercised. Pinning the message is what stops that recurring.
    ).rejects.toThrow(/float is not allowed/i);
  });

  it("accepts the same summary once quantised", async () => {
    // The pair is the point: the frozen constraint is survivable, and this is how.
    const { seq, emitted } = sequencer();
    await seq.browserObservation({
      artifactIds: [],
      url: null,
      title: null,
      extensions: quantiseExtensionNumbers([ext({ ms: 12.5, bytes: 1024.4 })]),
    });
    expect(JSON.stringify(emitted[0].extensions)).toContain('"ms":13');
    expect(JSON.stringify(emitted[0].extensions)).toContain('"bytes":1024');
  });

  it("still emits an empty extensions array when none are given", async () => {
    const { seq, emitted } = sequencer();
    await seq.browserObservation({ artifactIds: [], url: null, title: null });
    expect(emitted[0].extensions).toEqual([]);
  });

  it("does not disturb the other producers' extensions", async () => {
    // `#emit` gained a parameter; every existing caller must keep emitting [].
    const { seq, emitted } = sequencer();
    await seq.attemptStarted("sandbox-1");
    await seq.log({ stream: "stdout", level: "info", message: "hi" });
    expect(emitted.map((e) => e.extensions)).toEqual([[], []]);
  });
});

describe("BRW-003d-3 — quantiseExtensionNumbers", () => {
  it("rounds floats anywhere in the structure", () => {
    expect(quantiseExtensionNumbers({ a: 1.4, b: [2.6, { c: 3.5 }] })).toEqual({
      a: 1,
      b: [3, { c: 4 }],
    });
  });

  it("leaves integers, strings, booleans and null alone", () => {
    const input = { i: 7, s: "x", b: true, n: null };
    expect(quantiseExtensionNumbers(input)).toEqual(input);
  });

  it("★ REFUSES a non-finite number instead of coercing it", () => {
    // NaN/Infinity are a producer bug. Turning one into 0 would bury it inside
    // otherwise-plausible telemetry.
    expect(() => quantiseExtensionNumbers({ ms: Number.NaN })).toThrow(RangeError);
    expect(() => quantiseExtensionNumbers({ ms: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
