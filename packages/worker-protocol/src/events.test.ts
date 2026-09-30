import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalEventDigestInputV1 } from "./canonical-json.js";
import {
  WORKER_EVENT_TYPES,
  workerEventAckV1Schema,
  workerEventBatchV1Schema,
  workerEventV1Schema,
} from "./events.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// UUID / fence identities (the wire encoding, distinct from the FND-004 fixture
// ULID/integer encoding used only in the digest cross-check below).
const UUID = {
  event: "00000000-0000-4000-8000-000000000021",
  event2: "00000000-0000-4000-8000-000000000024",
  org: "00000000-0000-4000-8000-000000000030",
  company: "00000000-0000-4000-8000-000000000031",
  worker: "00000000-0000-4000-8000-000000000032",
  job: "00000000-0000-4000-8000-000000000022",
  lease: "00000000-0000-4000-8000-000000000023",
  artifact: "00000000-0000-4000-8000-000000000060",
  approval: "00000000-0000-4000-8000-000000000061",
  request: "00000000-0000-4000-8000-000000000062",
  service: "00000000-0000-4000-8000-000000000040",
  serviceInstance: "00000000-0000-4000-8000-000000000041",
  sandbox: "00000000-0000-4000-8000-000000000042",
};

const base = {
  protocolVersion: 1,
  eventId: UUID.event,
  organizationId: UUID.org,
  companyId: UUID.company,
  workerId: UUID.worker,
  jobId: UUID.job,
  attempt: 1,
  leaseId: UUID.lease,
  fenceToken: "d".repeat(43),
  seq: 1,
  eventDigest: "a".repeat(64),
  occurredAt: "2026-08-07T00:00:01.000Z",
  extensions: [] as unknown[],
};

const evt = (eventType: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  ...clone(base),
  eventType,
  payload,
  ...overrides,
});

// One valid payload per event type.
const validPayloads: Record<string, unknown> = {
  attempt_started: { sandboxId: UUID.sandbox },
  log: { stream: "stdout", level: "info", message: "started the adapter" },
  progress: { message: "halfway", percent: 50 },
  usage: { inputTokens: 31000, outputTokens: 14210, cachedInputTokens: 0, runtimeMillis: 42000 },
  artifact_prepared: { artifactId: UUID.artifact, kind: "workspace_patch" },
  browser_observation: { artifactIds: [UUID.artifact], url: "https://example.com/a", title: "Example" },
  browser_approval_requested: { approvalId: UUID.approval, action: "download", summary: "download the file" },
  runtime_decision_requested: {
    decisionKind: "permission",
    requestId: UUID.request,
    nonce: "n-1",
    requestDigest: "b".repeat(64),
    schemaVersion: 1,
    sourceRevision: 0,
    expiresAt: "2026-08-07T00:05:00.000Z",
    title: "Approve command",
    summary: null,
    timeoutPolicy: "deny",
    defaultDecision: null,
    toolName: null,
    command: null,
    cwd: null,
    path: null,
    networkTarget: null,
    riskClass: null,
  },
  service_instance_started: {
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
    providerResourceId: "provider-res-1",
  },
  service_health: {
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
    status: "healthy",
    detail: null,
  },
  service_checkpoint_prepared: {
    artifactId: UUID.artifact,
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
  },
  service_checkpoint_restored: {
    artifactId: UUID.artifact,
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
  },
  service_graceful_stop_observed: {
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
    deadline: "2026-08-07T00:10:00.000Z",
  },
  service_instance_stopped: {
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
    exitCode: 0,
  },
  service_instance_lost: {
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
    reason: "lease_lost",
  },
  service_provider_interrupted: {
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
    reason: "spot_reclaim",
  },
  service_provider_resumed: {
    serviceId: UUID.service,
    serviceInstanceId: UUID.serviceInstance,
    generation: 1,
    providerResourceId: "provider-res-2",
  },
  network_denied: { destinationClass: "metadata", reason: "blocked cloud metadata endpoint" },
  terminal: { status: "succeeded", exitCode: 0, errorCode: null, errorMessage: null },
};

// -----------------------------------------------------------------------------
// Event type coverage
// -----------------------------------------------------------------------------

describe("workerEventV1Schema — every event type parses with its payload", () => {
  it("locks the exact V1 event-type vocabulary (19 types)", () => {
    expect([...WORKER_EVENT_TYPES].sort()).toEqual(Object.keys(validPayloads).sort());
    expect(WORKER_EVENT_TYPES.length).toBe(19);
  });

  for (const eventType of Object.keys(validPayloads)) {
    it(`parses a valid ${eventType} event`, () => {
      const result = workerEventV1Schema.safeParse(evt(eventType, validPayloads[eventType]));
      expect(result.success).toBe(true);
    });
  }

  it("rejects an unknown event type", () => {
    expect(workerEventV1Schema.safeParse(evt("mystery_event", {})).success).toBe(false);
  });

  it("rejects a payload that does not match its event type (strict)", () => {
    expect(workerEventV1Schema.safeParse(evt("attempt_started", validPayloads.log)).success).toBe(false);
    expect(workerEventV1Schema.safeParse(evt("attempt_started", { sandboxId: UUID.sandbox, extra: 1 })).success).toBe(false);
  });

  it("rejects a missing / malformed base identity", () => {
    expect(workerEventV1Schema.safeParse(evt("attempt_started", validPayloads.attempt_started, { seq: 0 })).success).toBe(false);
    expect(workerEventV1Schema.safeParse(evt("attempt_started", validPayloads.attempt_started, { fenceToken: "short" })).success).toBe(false);
    expect(workerEventV1Schema.safeParse(evt("attempt_started", validPayloads.attempt_started, { protocolVersion: 2 })).success).toBe(false);
    expect(workerEventV1Schema.safeParse(evt("attempt_started", validPayloads.attempt_started, { surprise: 1 })).success).toBe(false);
  });
});

describe("workerEventV1Schema — payload bounds and metering rules", () => {
  it("rejects a log message over 65,536 characters", () => {
    expect(workerEventV1Schema.safeParse(evt("log", { stream: "stdout", level: "info", message: "x".repeat(65_536) })).success).toBe(true);
    expect(workerEventV1Schema.safeParse(evt("log", { stream: "stdout", level: "info", message: "x".repeat(65_537) })).success).toBe(false);
  });

  it("accepts an integer progress percent (nullable) and rejects a fractional one", () => {
    expect(workerEventV1Schema.safeParse(evt("progress", { message: "p", percent: 0 })).success).toBe(true);
    expect(workerEventV1Schema.safeParse(evt("progress", { message: "p", percent: 100 })).success).toBe(true);
    expect(workerEventV1Schema.safeParse(evt("progress", { message: "p", percent: null })).success).toBe(true);
    expect(workerEventV1Schema.safeParse(evt("progress", { message: "p", percent: 33.3 })).success).toBe(false);
    expect(workerEventV1Schema.safeParse(evt("progress", { message: "p", percent: 101 })).success).toBe(false);
    expect(workerEventV1Schema.safeParse(evt("progress", { message: "p", percent: -1 })).success).toBe(false);
  });

  it("keeps usage evidentiary: rejects pricing / billing fields", () => {
    for (const pricing of ["costMicros", "provider", "model", "biller", "billingType", "rate", "rounding"]) {
      const payload = { ...clone(validPayloads.usage as object), [pricing]: 1 };
      expect(workerEventV1Schema.safeParse(evt("usage", payload)).success).toBe(false);
    }
    expect(workerEventV1Schema.safeParse(evt("usage", { inputTokens: -1, outputTokens: 0, cachedInputTokens: 0, runtimeMillis: 0 })).success).toBe(false);
  });

  it("rejects terminal statuses outside succeeded|failed|cancelled|expired (no service states)", () => {
    expect(workerEventV1Schema.safeParse(evt("terminal", { status: "failed", exitCode: 1, errorCode: "E", errorMessage: "boom" })).success).toBe(true);
    for (const bad of ["stopped", "lost", "healthy", "done"]) {
      expect(workerEventV1Schema.safeParse(evt("terminal", { status: bad, exitCode: null, errorCode: null, errorMessage: null })).success).toBe(false);
    }
  });
});

describe("workerEventV1Schema — wire safety and safe additive extensions", () => {
  const okExtension = { namespace: "com.armyofagents.hint", schemaVersion: 1, critical: false, value: { note: "safe" } };

  it("preserves a safe non-critical extension (additive data survives)", () => {
    const result = workerEventV1Schema.safeParse(evt("log", validPayloads.log, { extensions: [clone(okExtension)] }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.extensions[0] as { value: unknown }).value).toEqual(okExtension.value);
    }
  });

  it("rejects a nested credential-bearing key inside an extension value", () => {
    const bad = evt("log", validPayloads.log, {
      extensions: [{ namespace: "com.x.y", schemaVersion: 1, critical: false, value: { password: "leak" } }],
    });
    expect(workerEventV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a nested credential-bearing key inside a payload", () => {
    const bad = evt("browser_observation", { artifactIds: [], url: null, title: null, accessToken: "leak" });
    expect(workerEventV1Schema.safeParse(bad).success).toBe(false);
  });

  it("fails closed on an unknown critical extension and bounds the count", () => {
    expect(workerEventV1Schema.safeParse(evt("log", validPayloads.log, { extensions: [{ ...okExtension, critical: true }] })).success).toBe(false);
    const many = Array.from({ length: 17 }, (_, i) => ({ ...okExtension, namespace: `com.x.n${i}` }));
    expect(workerEventV1Schema.safeParse(evt("log", validPayloads.log, { extensions: many })).success).toBe(false);
  });
});

// The event schema MUST enforce the ONE shared bounded-extension container
// identically to jobEnvelopeV1Schema — the value structural walk + combined
// budget the bespoke event refiner previously dropped (E1-F005).
describe("workerEventV1Schema — full shared bounded-extension container (E1-F005)", () => {
  const okExt = { namespace: "com.armyofagents.hint", schemaVersion: 1, critical: false, value: { note: "safe" } };
  const logExt = (extensions: unknown[]) => workerEventV1Schema.safeParse(evt("log", validPayloads.log, { extensions }));
  const nest = (depth: number): unknown => (depth <= 0 ? 1 : { k: nest(depth - 1) });
  // Distribute a target combined-canonical-byte total across 5 bare-string
  // extension values (canonical bytes per value = len + 2), each well under the
  // 16,384 per-value cap, so ONLY the combined budget is exercised.
  const combinedExt = (totalCanonicalBytes: number) => {
    const sumLen = totalCanonicalBytes - 5 * 2;
    const per = Math.floor(sumLen / 5);
    const lens = [sumLen - per * 4, per, per, per, per];
    return lens.map((len, i) => ({ ...okExt, namespace: `com.x.c${i}`, value: "z".repeat(len) }));
  };

  it("enforces the value container depth boundary (≤8 levels)", () => {
    expect(logExt([{ ...okExt, value: nest(8) }]).success).toBe(true);
    expect(logExt([{ ...okExt, value: nest(9) }]).success).toBe(false);
  });

  it("enforces the value array-item boundary (≤128 items)", () => {
    expect(logExt([{ ...okExt, value: { list: Array.from({ length: 128 }, () => 1) } }]).success).toBe(true);
    expect(logExt([{ ...okExt, value: { list: Array.from({ length: 129 }, () => 1) } }]).success).toBe(false);
  });

  it("enforces the value object-key boundary (≤64 keys)", () => {
    const obj = (n: number) => {
      const value: Record<string, number> = {};
      for (let i = 0; i < n; i += 1) value[`k${i}`] = i;
      return [{ ...okExt, value }];
    };
    expect(logExt(obj(64)).success).toBe(true);
    expect(logExt(obj(65)).success).toBe(false);
  });

  it("enforces the value key-byte boundary (≤100 UTF-8 bytes per key)", () => {
    expect(logExt([{ ...okExt, value: { ["a".repeat(100)]: 1 } }]).success).toBe(true);
    expect(logExt([{ ...okExt, value: { ["a".repeat(101)]: 1 } }]).success).toBe(false);
  });

  it("enforces the per-value canonical byte budget (16,384 bytes)", () => {
    expect(logExt([{ ...okExt, value: "x".repeat(16_382) }]).success).toBe(true); // 16,384 bytes
    expect(logExt([{ ...okExt, value: "x".repeat(16_383) }]).success).toBe(false); // 16,385 bytes
  });

  it("enforces the combined ≤65,536-byte extension budget at the exact boundary", () => {
    expect(logExt(combinedExt(65_536)).success).toBe(true); // exactly at budget
    expect(logExt(combinedExt(65_537)).success).toBe(false); // one byte over
  });

  it("now REJECTS the 5 shapes the bespoke event refiner previously accepted", () => {
    const violating: Array<[string, unknown[]]> = [
      ["depth 9", [{ ...okExt, value: nest(9) }]],
      ["129 array items", [{ ...okExt, value: { list: Array.from({ length: 129 }, () => 1) } }]],
      ["65 object keys", [(() => { const value: Record<string, number> = {}; for (let i = 0; i < 65; i += 1) value[`k${i}`] = i; return { ...okExt, value }; })()]],
      ["101-byte key", [{ ...okExt, value: { ["a".repeat(101)]: 1 } }]],
      ["combined >65,536", combinedExt(65_537)],
    ];
    for (const [, extensions] of violating) {
      expect(logExt(extensions).success).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// runtime_decision_requested union
// -----------------------------------------------------------------------------

const permissionRequest = validPayloads.runtime_decision_requested as Record<string, unknown>;
const workQuestionRequest = {
  decisionKind: "work_question",
  requestId: UUID.request,
  nonce: "n-2",
  requestDigest: "c".repeat(64),
  schemaVersion: 1,
  sourceRevision: 0,
  expiresAt: "2026-08-07T00:05:00.000Z",
  title: "Pick one",
  summary: null,
  timeoutPolicy: "cancel_run",
  promptText: "Which option?",
  options: [
    { optionId: "o1", label: "Yes", value: { pick: 1 }, isDefault: false },
    { optionId: "o2", label: "No", value: { pick: 2 }, isDefault: false },
  ],
};

describe("runtime_decision_requested — permission timeout/default rules", () => {
  const permission = (overrides: Record<string, unknown>) =>
    workerEventV1Schema.safeParse(evt("runtime_decision_requested", { ...clone(permissionRequest), ...overrides }));

  it("accepts the base permission request", () => {
    expect(permission({}).success).toBe(true);
  });

  it("requires a non-null defaultDecision only for continue_with_default", () => {
    expect(permission({ timeoutPolicy: "continue_with_default", defaultDecision: "allow_once" }).success).toBe(true);
    expect(permission({ timeoutPolicy: "continue_with_default", defaultDecision: null }).success).toBe(false);
  });

  it("requires a null defaultDecision for every non-continue policy", () => {
    for (const policy of ["deny", "cancel_run", "park_run", "escalate"]) {
      expect(permission({ timeoutPolicy: policy, defaultDecision: null }).success).toBe(true);
      expect(permission({ timeoutPolicy: policy, defaultDecision: "allow_once" }).success).toBe(false);
    }
  });

  it("never allows allow_always as a timeout default", () => {
    expect(permission({ timeoutPolicy: "continue_with_default", defaultDecision: "allow_always" }).success).toBe(false);
  });

  it("rejects a work-question field on a permission request (no cross-kind fields)", () => {
    expect(permission({ promptText: "leak" }).success).toBe(false);
  });
});

describe("runtime_decision_requested — work-question default rules", () => {
  const workQuestion = (overrides: Record<string, unknown>) =>
    workerEventV1Schema.safeParse(evt("runtime_decision_requested", { ...clone(workQuestionRequest), ...overrides }));
  const withDefaults = (flags: boolean[]) =>
    flags.map((isDefault, i) => ({ optionId: `o${i}`, label: `L${i}`, value: { i }, isDefault }));

  it("accepts a work question with zero defaults for a non-continue policy", () => {
    expect(workQuestion({}).success).toBe(true);
  });

  it("requires exactly one default for continue_with_default", () => {
    expect(workQuestion({ timeoutPolicy: "continue_with_default", options: withDefaults([true, false]) }).success).toBe(true);
    expect(workQuestion({ timeoutPolicy: "continue_with_default", options: withDefaults([false, false]) }).success).toBe(false);
    expect(workQuestion({ timeoutPolicy: "continue_with_default", options: withDefaults([true, true]) }).success).toBe(false);
  });

  it("requires zero defaults for every non-continue policy", () => {
    for (const policy of ["cancel_run", "park_run", "escalate"]) {
      expect(workQuestion({ timeoutPolicy: policy, options: withDefaults([false, false]) }).success).toBe(true);
      expect(workQuestion({ timeoutPolicy: policy, options: withDefaults([true, false]) }).success).toBe(false);
    }
  });

  it("rejects deny as a work-question timeout policy (permission-only)", () => {
    expect(workQuestion({ timeoutPolicy: "deny" }).success).toBe(false);
  });

  it("bounds the option list at 32 and rejects a permission field", () => {
    const overLimit = Array.from({ length: 33 }, (_, i) => ({ optionId: `o${i}`, label: `L${i}`, value: { i }, isDefault: false }));
    expect(workQuestion({ options: overLimit }).success).toBe(false);
    expect(workQuestion({ defaultDecision: "allow_once" }).success).toBe(false);
  });

  it("rejects an option value over the 16 KiB canonical byte budget", () => {
    const big = { optionId: "o", label: "L", value: { blob: "z".repeat(16_385) }, isDefault: false };
    expect(workQuestion({ options: [big] }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Batch + cumulative ACK
// -----------------------------------------------------------------------------

const batchBase = {
  protocolVersion: 1,
  organizationId: UUID.org,
  companyId: UUID.company,
  workerId: UUID.worker,
  jobId: UUID.job,
  attempt: 1,
  leaseId: UUID.lease,
  fenceToken: "d".repeat(43),
};

const eventAt = (seq: number, eventId: string) => evt("log", validPayloads.log, { seq, eventId });

describe("workerEventBatchV1Schema — identity, uniqueness, contiguous sequence", () => {
  it("accepts a contiguous batch whose events repeat the batch identity", () => {
    const batch = { ...batchBase, events: [eventAt(1, UUID.event), eventAt(2, UUID.event2)] };
    expect(workerEventBatchV1Schema.safeParse(batch).success).toBe(true);
  });

  it("rejects a sequence gap (1 then 3)", () => {
    const batch = { ...batchBase, events: [eventAt(1, UUID.event), eventAt(3, UUID.event2)] };
    expect(workerEventBatchV1Schema.safeParse(batch).success).toBe(false);
  });

  it("rejects a duplicate sequence", () => {
    const batch = { ...batchBase, events: [eventAt(1, UUID.event), eventAt(1, UUID.event2)] };
    expect(workerEventBatchV1Schema.safeParse(batch).success).toBe(false);
  });

  it("rejects a duplicate event ID inside one batch", () => {
    const batch = { ...batchBase, events: [eventAt(1, UUID.event), eventAt(2, UUID.event)] };
    expect(workerEventBatchV1Schema.safeParse(batch).success).toBe(false);
  });

  it("rejects an event whose identity does not repeat the batch identity", () => {
    const rogue = eventAt(2, UUID.event2);
    rogue.workerId = "00000000-0000-4000-8000-0000000000ff";
    const batch = { ...batchBase, events: [eventAt(1, UUID.event), rogue] };
    expect(workerEventBatchV1Schema.safeParse(batch).success).toBe(false);
  });

  it("rejects an empty batch and bounds the batch at 500 events", () => {
    expect(workerEventBatchV1Schema.safeParse({ ...batchBase, events: [] }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => eventAt(i + 1, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
    expect(workerEventBatchV1Schema.safeParse({ ...batchBase, events: many }).success).toBe(false);
  });
});

describe("workerEventAckV1Schema — cumulative ACK invariants", () => {
  const ack = (overrides: Record<string, unknown>) =>
    workerEventAckV1Schema.safeParse({
      ...batchBase,
      acceptedThroughSeq: 5,
      expectedNextSeq: 6,
      status: "accepted",
      ...overrides,
    });

  it("accepts a cumulative ACK where expectedNextSeq === acceptedThroughSeq + 1", () => {
    expect(ack({}).success).toBe(true);
    expect(ack({ acceptedThroughSeq: 0, expectedNextSeq: 1 }).success).toBe(true);
  });

  it("rejects an ACK whose expectedNextSeq is not acceptedThroughSeq + 1", () => {
    expect(ack({ acceptedThroughSeq: 5, expectedNextSeq: 5 }).success).toBe(false);
    expect(ack({ acceptedThroughSeq: 5, expectedNextSeq: 7 }).success).toBe(false);
  });

  it("rejects negative sequence values", () => {
    expect(ack({ acceptedThroughSeq: -1, expectedNextSeq: 0 }).success).toBe(false);
  });

  it("requires rejectedEventId for hash_mismatch and forbids it otherwise", () => {
    expect(ack({ status: "hash_mismatch", rejectedEventId: UUID.event }).success).toBe(true);
    expect(ack({ status: "hash_mismatch" }).success).toBe(false);
    expect(ack({ status: "accepted", rejectedEventId: UUID.event }).success).toBe(false);
    expect(ack({ status: "gap", rejectedEventId: UUID.event }).success).toBe(false);
  });

  it("accepts each locked ACK status and rejects an unknown one", () => {
    for (const status of ["accepted", "gap", "stale_fence", "target_revoked", "terminal"]) {
      expect(ack({ status }).success).toBe(true);
    }
    expect(ack({ status: "mystery" }).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Cross-implementation digest equivalence with the frozen E0 golden fixtures.
// This closes the two-canonicalizer seam: the E0 checker (.mjs) owns the
// fixtures' committed eventDigest bytes; this package (.ts) must reproduce every
// one byte-for-byte. A single mismatch fails the suite.
// -----------------------------------------------------------------------------

describe("cross-implementation eventDigest equivalence (E0 golden fixtures)", () => {
  const fixturesDir = new URL("../../../tests/fixtures/distributed-execution/", import.meta.url);
  const fixtureFiles = readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));

  it("reproduces every committed eventDigest across all 9 fixtures (50 events, zero mismatches)", () => {
    let fixturesWithEvents = 0;
    let totalEvents = 0;
    const mismatches: string[] = [];
    for (const file of fixtureFiles) {
      const parsed = JSON.parse(readFileSync(new URL(file, fixturesDir), "utf8")) as {
        expectedEvents?: Array<Record<string, unknown>>;
      };
      const events = Array.isArray(parsed.expectedEvents) ? parsed.expectedEvents : [];
      if (events.length > 0) fixturesWithEvents += 1;
      for (const event of events) {
        if (typeof event.eventDigest !== "string") continue;
        totalEvents += 1;
        const recomputed = sha256hex(canonicalEventDigestInputV1(event));
        if (recomputed !== event.eventDigest) {
          mismatches.push(`${file}:${String(event.eventId)} got ${recomputed} expected ${event.eventDigest}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(fixturesWithEvents).toBe(9);
    expect(totalEvents).toBe(50);
  });
});
