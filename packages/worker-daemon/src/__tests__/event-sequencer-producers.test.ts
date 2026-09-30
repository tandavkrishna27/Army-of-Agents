import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalEventDigestInputV1, workerEventV1Schema } from "@armyofagents/worker-protocol";

import { EventSequencer, type WorkerEventSink } from "../supervisor/events.js";
import { REDACTION_MARKER } from "../supervisor/redaction.js";

// -----------------------------------------------------------------------------
// CLI-003/D2 — the `log` / `progress` / `usage` producer emitters on the
// EventSequencer. Each stamps a CONTIGUOUS seq + eventDigest, scrubs secret
// canaries BEFORE the digest, and validates the FROZEN `workerEventV1Schema` — the
// exact contract the existing attempt_started/terminal emitters obey. The payloads
// are the FROZEN log/progress/usage schemas (never edited).
// -----------------------------------------------------------------------------

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

describe("CLI-003/D2 — EventSequencer log/progress/usage producers", () => {
  it("emits contiguous, digest-valid, schema-valid log/progress/usage events", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [] });

    const log = await seq.log({ stream: "stdout", level: "info", message: "building" });
    const progress = await seq.progress({ message: "compiling", percent: 42 });
    const usage = await seq.usage({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, runtimeMillis: 1234 });

    expect([log.eventType, progress.eventType, usage.eventType]).toEqual(["log", "progress", "usage"]);
    expect([log.seq, progress.seq, usage.seq]).toEqual([1, 2, 3]);
    for (const event of [log, progress, usage]) {
      const { eventDigest, ...withoutDigest } = event;
      expect(sha256Hex(canonicalEventDigestInputV1(withoutDigest))).toBe(eventDigest);
      expect(() => workerEventV1Schema.parse(event)).not.toThrow();
    }
    if (log.eventType === "log") expect(log.payload).toEqual({ stream: "stdout", level: "info", message: "building" });
    if (progress.eventType === "progress") expect(progress.payload).toEqual({ message: "compiling", percent: 42 });
    if (usage.eventType === "usage") {
      expect(usage.payload).toEqual({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 10, runtimeMillis: 1234 });
    }
  });

  it("progress accepts a null percent (indeterminate)", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [] });
    const progress = await seq.progress({ message: "working", percent: null });
    if (progress.eventType === "progress") expect(progress.payload.percent).toBeNull();
  });

  it("scrubs a secret canary from a log message BEFORE the digest", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [SECRET] });
    const log = await seq.log({ stream: "stderr", level: "warn", message: `leaking ${SECRET} here` });
    expect(JSON.stringify(log)).not.toContain(SECRET);
    if (log.eventType === "log") expect(log.payload.message).toBe(`leaking ${REDACTION_MARKER} here`);
    const { eventDigest, ...withoutDigest } = log;
    expect(sha256Hex(canonicalEventDigestInputV1(withoutDigest))).toBe(eventDigest);
  });

  it("usage carries NO cost/price field — the frozen .strict() schema rejects it at parse", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [] });
    const usage = await seq.usage({ inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, runtimeMillis: 3 });
    // Only the four evidentiary fields exist — no cost/provider/model.
    if (usage.eventType === "usage") {
      expect(Object.keys(usage.payload).sort()).toEqual([
        "cachedInputTokens",
        "inputTokens",
        "outputTokens",
        "runtimeMillis",
      ]);
    }
  });

  it("truncates an over-long log message to the frozen 65536-byte ceiling", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [] });
    const huge = "x".repeat(70_000);
    const log = await seq.log({ stream: "stdout", level: "debug", message: huge });
    // The frozen logPayloadV1 caps message at 65536; the emitter truncates so an
    // over-long chunk never fails the parse.
    if (log.eventType === "log") expect(log.payload.message.length).toBeLessThanOrEqual(65_536);
    expect(() => workerEventV1Schema.parse(log)).not.toThrow();
  });

  it("truncation never bisects a UTF-16 surrogate pair (would throw in the canonicalizer)", async () => {
    const sink = collectingSink();
    const seq = new EventSequencer({ identity: identity(), sink, redactionCanaries: [] });
    // 65535 ASCII + a 2-code-unit emoji: slice(0,65536) lands on the LONE HIGH surrogate.
    // A raw slice would leave it dangling and canonicalizeString would throw, dropping
    // the log (and the run's trailing usage event). The safe truncation drops it.
    const message = "a".repeat(65_535) + "\u{1F600}";
    const log = await seq.log({ stream: "stdout", level: "debug", message });
    expect(() => workerEventV1Schema.parse(log)).not.toThrow();
    if (log.eventType === "log") {
      expect(log.payload.message.length).toBe(65_535); // the dangling high surrogate dropped
      expect(log.payload.message.endsWith("\uD83D")).toBe(false);
    }
    // The digest is valid (proves the canonicalizer accepted it — no lone surrogate).
    const { eventDigest, ...withoutDigest } = log;
    expect(sha256Hex(canonicalEventDigestInputV1(withoutDigest))).toBe(eventDigest);
  });
});
