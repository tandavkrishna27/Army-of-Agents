import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalEventDigestInputV1, workerEventV1Schema } from "@armyofagents/worker-protocol";

import { EventSequencer, type WorkerEventSink } from "../supervisor/events.js";
import { REDACTION_MARKER, redactString, scrubEventStrings } from "../supervisor/redaction.js";

// DAT-005 D4 / invariant #4 — a known secret value in ANY event string is scrubbed
// BEFORE the #emit digest, so the digest + schema.parse cover the scrubbed bytes and
// the (verbatim-sealing) durable sink can never persist the value.

const SECRET = "sk-live-DEADBEEF-super-secret-token";

function identity() {
  return {
    organizationId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    workerId: "33333333-3333-4333-8333-333333333333",
    jobId: "44444444-4444-4444-8444-444444444444",
    attempt: 1,
    leaseId: "55555555-5555-4555-8555-555555555555",
    fenceToken: "f".repeat(40),
  };
}

function collectingSink(): WorkerEventSink & { events: unknown[] } {
  const events: unknown[] = [];
  return { events, emit(event) { events.push(event); } };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("redaction scrubber (pure)", () => {
  it("replaces every occurrence of a canary substring with the marker", () => {
    expect(redactString(`a ${SECRET} b ${SECRET}`, [SECRET])).toBe(`a ${REDACTION_MARKER} b ${REDACTION_MARKER}`);
  });

  it("scrubs nested strings, arrays, and free-text fields; leaves scalars + clean strings", () => {
    const input = {
      payload: { reason: `blocked ${SECRET}`, errorMessage: null, count: 7, ok: true },
      args: ["--flag", `--token=${SECRET}`],
      clean: "nothing here",
    };
    const out = scrubEventStrings(input, [SECRET]);
    expect(out.payload.reason).toBe(`blocked ${REDACTION_MARKER}`);
    expect(out.args[1]).toBe(`--token=${REDACTION_MARKER}`);
    expect(out.payload.count).toBe(7);
    expect(out.payload.ok).toBe(true);
    expect(out.clean).toBe("nothing here");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("returns the SAME reference when no canary is present (no needless clone)", () => {
    const input = { a: "clean" };
    expect(scrubEventStrings(input, [SECRET])).toBe(input);
    expect(scrubEventStrings(input, [])).toBe(input);
  });
});

describe("EventSequencer — redaction precedes the digest at #emit", () => {
  it("scrubs a terminal errorMessage before the digest; the sealed event holds the marker and the digest covers it", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [SECRET] });
    const event = await seq.terminal({ status: "failed", exitCode: 1, errorMessage: `crashed with ${SECRET}` });

    // The persisted event carries the marker, never the value.
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.payload.errorMessage).toBe(`crashed with ${REDACTION_MARKER}`);

    // The digest covers the SCRUBBED bytes: recomputing from the emitted (scrubbed)
    // event reproduces the stored eventDigest. Had scrubbing happened AFTER the
    // digest, the stored digest would be of the unscrubbed value → mismatch.
    const { eventDigest, ...withoutDigest } = event;
    expect(sha256Hex(canonicalEventDigestInputV1(withoutDigest))).toBe(eventDigest);

    // The scrubbed event still satisfies the frozen schema (parse ran in #emit).
    expect(() => workerEventV1Schema.parse(event)).not.toThrow();
  });

  it("scrubs the free-text network_denied.reason before the digest", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [SECRET] });
    const event = await seq.networkDenied({ destinationClass: "not_allowlisted", reason: `denied leaking ${SECRET}` });
    expect(JSON.stringify(event)).not.toContain(SECRET);
    expect(event.payload.reason).toBe(`denied leaking ${REDACTION_MARKER}`);
    const { eventDigest, ...withoutDigest } = event;
    expect(sha256Hex(canonicalEventDigestInputV1(withoutDigest))).toBe(eventDigest);
  });

  it("per-run scoping: one sequencer's canary does not scrub another run's events", async () => {
    const sinkA = collectingSink();
    const sinkB = collectingSink();
    const other = "other-run-secret-9999";
    const seqA = new EventSequencer({ identity: identity(), sink: sinkA, redactionCanaries: [SECRET] });
    const seqB = new EventSequencer({ identity: identity(), sink: sinkB, redactionCanaries: [other] });
    const evA = await seqA.terminal({ status: "failed", exitCode: 1, errorMessage: `has ${other}` });
    // seqA's canary is SECRET, not `other`, so run B's secret is untouched by run A.
    expect(evA.payload.errorMessage).toBe(`has ${other}`);
    const evB = await seqB.terminal({ status: "failed", exitCode: 1, errorMessage: `has ${other}` });
    expect(evB.payload.errorMessage).toBe(`has ${REDACTION_MARKER}`);
  });

  it("emits verbatim when no canaries are configured", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [] });
    const event = await seq.terminal({ status: "succeeded", exitCode: 0, errorMessage: null });
    expect(event.payload.status).toBe("succeeded");
  });
});
