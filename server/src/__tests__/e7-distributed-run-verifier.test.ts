// evidence-verifier A — the E7-1 distributed-run promotion gate (design v2, §4).
//
// PURE store-fixture units — no embedded-PG, no drizzle — exactly like
// cli-006-canary-preflight.test.ts. Each fixture reddens for EXACTLY ONE clause
// (the anti-vacuity invariant): (b)->1, (c)->2, (d)->3, (e)/(f)->4, (g)/(h)->5.
//
// Clause 5 is the load-bearing anti-false-PASS clause: a distributed HANDOFF that no
// worker ever leased terminalizes carrying every mark clauses 1-4 check, so fixture
// (g) is the v1 false-PASS this whole verifier exists to catch.

import { describe, expect, it } from "vitest";
import {
  createE7DistributedRunVerifier,
  e7VerifyExitCode,
  formatVerifyResult,
  E7_CAPABILITY_LIMITATIONS,
  detectHardLeakClasses,
  type E7RunVerifierStore,
  type E7RunRow,
  type E7AttemptRow,
  type E7LeaseRow,
  type E7JobEventRow,
  type E7AttemptTerminalReceiptRow,
  type E7ScanSurface,
} from "../services/e7-distributed-run-verifier.js";
import { redactSecretsInString } from "../redaction.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "99999999-9999-4999-8999-999999999999";
const ORG = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_ID = "66666666-6666-4666-8666-666666666666";

// Leak-class values the CHOSEN hard matcher actually catches (anti-vacuity — the
// programme's signature defect is a clause-4 fixture that plants a value nothing
// matches). Each is asserted against the real matcher in its own test's setup.
const PROVIDER_KEY_LEAK = "sk-ant-api03ABCDEFabcdef0123456789"; // provider-key class
const E2B_KEY_VALUE = "e2b_0123456789abcdefghijKLMN"; // e2b_ + >=16 alnum
const E2B_LEAK_LINE = `E2B_API_KEY=${E2B_KEY_VALUE}`; // literal assignment + value
// A BARE e2b_ key with NO `E2B_API_KEY=` prefix — exercises the `e2b_key` value arm
// in ISOLATION (the assignment arm cannot fire on it), so deleting that arm reddens.
const BARE_E2B_VALUE = "e2b_0123456789abcdefghijMNOP";
const BROAD_ONLY_TOKEN = "sess_abcdefghij0123456789ABCD"; // pattern-7 broad, NOT a hard class

function run(overrides: Partial<E7RunRow> = {}): E7RunRow {
  return {
    id: RUN_ID,
    companyId: COMPANY,
    executionOwner: "distributed",
    distributedJobId: JOB_ID,
    distributedAttemptId: ATTEMPT_ID,
    status: "cancelled",
    errorCode: null,
    error: null,
    finishedAt: new Date("2026-08-28T00:00:00.000Z"),
    ...overrides,
  };
}

function attempt(overrides: Partial<E7AttemptRow> = {}): E7AttemptRow {
  return {
    id: ATTEMPT_ID,
    organizationId: ORG,
    companyId: COMPANY,
    jobId: JOB_ID,
    status: "cancelled",
    ...overrides,
  };
}

function lease(overrides: Partial<E7LeaseRow> = {}): E7LeaseRow {
  return { id: LEASE_ID, companyId: COMPANY, status: "revoked", ...overrides };
}

function event(eventType: string, overrides: Partial<E7JobEventRow> = {}): E7JobEventRow {
  return {
    eventId: `event-${eventType}`,
    companyId: COMPANY,
    eventType,
    payload: { type: eventType },
    ...overrides,
  };
}

function receipt(overrides: Partial<E7AttemptTerminalReceiptRow> = {}): E7AttemptTerminalReceiptRow {
  return { projectionKind: "attempt_terminal", status: "applied", companyId: COMPANY, ...overrides };
}

interface GoldenParts {
  runRow?: E7RunRow;
  attemptRow?: E7AttemptRow | null;
  leases?: E7LeaseRow[];
  events?: E7JobEventRow[];
  terminalReceipt?: E7AttemptTerminalReceiptRow | null;
  surfaces?: E7ScanSurface[];
  produced?: { workspacePatchArtifacts: number; taskOutputs: number };
}

// Fixture (a): the golden journey — distributed owner, both ids, cancelled+finished,
// a leased+started+projected+revoked attempt, clean surfaces.
function goldenStore(parts: GoldenParts = {}): E7RunVerifierStore {
  const runRow = parts.runRow ?? run();
  const attemptRow = parts.attemptRow === undefined ? attempt() : parts.attemptRow;
  const leases = parts.leases ?? [lease()];
  const events = parts.events ?? [event("attempt_started"), event("log"), event("terminal")];
  const terminalReceipt = parts.terminalReceipt === undefined ? receipt() : parts.terminalReceipt;
  const surfaces = parts.surfaces ?? [];
  const produced = parts.produced ?? { workspacePatchArtifacts: 1, taskOutputs: 1 };
  return {
    getRun: async (id) => (id === runRow.id ? runRow : null),
    getAttempt: async (id) => (attemptRow && id === attemptRow.id ? attemptRow : null),
    listLeases: async () => leases,
    listJobEvents: async () => events,
    getAttemptTerminalReceipt: async () => terminalReceipt,
    listRunSecretScanSurfaces: async () => surfaces,
    countProducedOutputs: async () => produced,
  };
}

function clauses(result: { failures: readonly { clause: number }[] }): Set<number> {
  return new Set(result.failures.map((f) => f.clause));
}

describe("evidence-verifier A — fixture table (design §4, one clause per fixture)", () => {
  it("(a) golden distributed journey PASSES", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore() });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.observed.executionOwner).toBe("distributed");
    expect(result.observed.leaseCount).toBe(1);
    expect(result.observed.attemptStartedEvents).toBe(1);
    expect(result.observed.terminalEvents).toBe(1);
    expect(result.observed.projectionReceiptApplied).toBe(true);
    expect(result.observed.organizationId).toBe(ORG);
  });

  it("(b) execution_owner=null FAILS clause 1 only", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ runRow: run({ executionOwner: null }) }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([1]));
  });

  it("(c) a distributed id null FAILS clause 2 only", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ runRow: run({ distributedAttemptId: null }) }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([2]));
  });

  it("(d) status=running, finished_at=null FAILS clause 3 only", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ runRow: run({ status: "running", finishedAt: null }) }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([3]));
  });

  it("(e) a job_events log payload leaking a provider key FAILS clause 4 only", async () => {
    // Anti-vacuity: the planted value MUST trip the real matcher.
    expect(redactSecretsInString(PROVIDER_KEY_LEAK)).not.toBe(PROVIDER_KEY_LEAK);
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({
        events: [
          event("attempt_started"),
          event("log", { eventId: "leaky-log", payload: { line: `authenticating with ${PROVIDER_KEY_LEAK}` } }),
          event("terminal"),
        ],
      }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([4]));
    const c4 = result.failures.find((f) => f.clause === 4)!;
    expect(c4.reason).toContain("job_events");
    expect(c4.reason).not.toContain(PROVIDER_KEY_LEAK); // never quote the match
  });

  it("(f) stdout_excerpt leaking an E2B key FAILS clause 4, and the raw value appears NOWHERE", async () => {
    // Anti-vacuity: the line trips A's explicit E2B arms — the bare `e2b_<16+>` key AND the
    // literal `E2B_API_KEY=` assignment (the assignment arm catches an E2B key regardless of
    // the value's shape, which is exactly why A carries it rather than leaning on the heuristic).
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({
        surfaces: [{ surface: "heartbeat_runs", fieldOrEventId: "stdout_excerpt", text: E2B_LEAK_LINE }],
      }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([4]));
    const printed = formatVerifyResult(result);
    for (const blob of [JSON.stringify(result), printed]) {
      expect(blob).not.toContain(E2B_KEY_VALUE);
      expect(blob).not.toContain(E2B_LEAK_LINE);
    }
  });

  it("(g) THE v1 false-PASS: a never-leased handoff FAILS clause 5 only", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ leases: [], events: [], terminalReceipt: null }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([5]));
    expect(result.observed.leaseCount).toBe(0);
  });

  it("(h) a cross-tenant attempt row FAILS clause 5 only (tenant)", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ attemptRow: attempt({ companyId: OTHER_COMPANY }) }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([5]));
  });

  it("(i) an absent run returns notFound, no throw", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore() });
    const result = await verifier.verify({ runId: "00000000-0000-4000-8000-000000000000" });
    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("(j) a durable FAILED terminal PASSES; observed surfaces the status", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({
        runRow: run({ status: "failed", error: "coding CLI exited 1", errorCode: "nonzero_exit" }),
        attemptRow: attempt({ status: "failed" }),
        leases: [lease({ status: "released" })], // not cancelled → no revoked requirement
        events: [event("attempt_started"), event("terminal")],
      }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(true);
    expect(result.observed.status).toBe("failed");
    expect(result.observed.errorCode).toBe("nonzero_exit");
  });
});

describe("evidence-verifier A — clause 5 corroboration edges", () => {
  it("a cancelled terminal WITHOUT a revoked lease FAILS clause 5 (fence not revoked)", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ leases: [lease({ status: "released" })] }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([5]));
  });

  it("a missing attempt_started event FAILS clause 5", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ events: [event("log"), event("terminal")] }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([5]));
  });

  it("a pending (not applied) terminal projection receipt FAILS clause 5", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ terminalReceipt: receipt({ status: "pending" }) }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([5]));
    expect(result.observed.projectionReceiptApplied).toBe(false);
  });

  it("a cross-tenant terminal receipt FAILS clause 5", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ terminalReceipt: receipt({ companyId: OTHER_COMPANY }) }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([5]));
  });

  it("an attempt whose job_id does not match the run's distributed_job_id FAILS clause 5", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ attemptRow: attempt({ jobId: "77777777-7777-4777-8777-777777777777" }) }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([5]));
  });
});

describe("evidence-verifier A — clause 4 leak specificity + no-leak invariant", () => {
  it("a broad <prefix>_<20+> token is ADVISORY, not a hard fail", async () => {
    // It must NOT trip a hard class — else this would test the wrong thing.
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({
        surfaces: [{ surface: "task_outputs", fieldOrEventId: "summary", text: `session ${BROAD_ONLY_TOKEN}` }],
      }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(true); // advisory does NOT fail the gate
    expect(result.observed.suspectedHeuristicHits.length).toBeGreaterThanOrEqual(1);
    const hit = result.observed.suspectedHeuristicHits[0];
    expect(hit.surface).toBe("task_outputs");
    expect(JSON.stringify(result)).not.toContain(BROAD_ONLY_TOKEN); // still never quoted
  });

  it("a BARE e2b_ key (no E2B_API_KEY= prefix) FAILS clause 4 via the e2b_key value arm in isolation", async () => {
    // Anti-vacuity: the bare value trips the `e2b_key` value arm and NOT the
    // assignment arm — so deleting the `e2b_key` matcher makes this fixture redden
    // (without it, the earlier E2B fixtures still pass via the assignment arm).
    expect(detectHardLeakClasses(BARE_E2B_VALUE)).toContain("e2b_key");
    expect(detectHardLeakClasses(BARE_E2B_VALUE)).not.toContain("e2b_api_key_assignment");
    expect(detectHardLeakClasses(BARE_E2B_VALUE)).not.toContain("provider_key");
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({
        events: [
          event("attempt_started"),
          event("log", { eventId: "bare-e2b", payload: { note: `spawned sandbox ${BARE_E2B_VALUE}` } }),
          event("terminal"),
        ],
      }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([4]));
    expect(JSON.stringify(result)).not.toContain(BARE_E2B_VALUE);
  });

  it("a connection-string URI in a scan surface FAILS clause 4", async () => {
    const conn = "postgresql://user:hunter2@db.internal:5432/app";
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({
        surfaces: [{ surface: "heartbeat_runs", fieldOrEventId: "error", text: `connect failed: ${conn}` }],
      }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(clauses(result)).toEqual(new Set([4]));
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("no planted secret from ANY hard surface appears in the result or printed output", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({
        events: [
          event("attempt_started"),
          event("log", { eventId: "leaky", payload: { key: PROVIDER_KEY_LEAK } }),
          event("terminal"),
        ],
        surfaces: [{ surface: "heartbeat_runs", fieldOrEventId: "detected_outputs", text: E2B_LEAK_LINE }],
      }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    // Positive control: the scanner MUST have actually fired clause 4 — otherwise the
    // absence assertions below would pass vacuously (nothing matched, nothing to leak).
    expect(result.ok).toBe(false);
    expect(result.failures.filter((f) => f.clause === 4).length).toBeGreaterThanOrEqual(2);
    const printed = formatVerifyResult(result);
    for (const blob of [JSON.stringify(result), printed]) {
      expect(blob).not.toContain(PROVIDER_KEY_LEAK);
      expect(blob).not.toContain(E2B_KEY_VALUE);
    }
  });
});

describe("evidence-verifier A — expected org/company assertion + read-only surface", () => {
  it("an expected companyId that mismatches the run FAILS (identity)", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore() });
    const result = await verifier.verify({ runId: RUN_ID, expected: { companyId: OTHER_COMPANY } });
    expect(result.ok).toBe(false);
  });

  it("an expected organizationId that mismatches the attempt FAILS (identity)", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore() });
    const result = await verifier.verify({
      runId: RUN_ID,
      expected: { organizationId: "88888888-8888-4888-8888-888888888888" },
    });
    expect(result.ok).toBe(false);
  });

  it("matching expected org + company still PASSES the golden run", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore() });
    const result = await verifier.verify({ runId: RUN_ID, expected: { organizationId: ORG, companyId: COMPANY } });
    expect(result.ok).toBe(true);
  });

  // The port type exposes only reads, so "no mutation" is a compile-time guarantee.
  // What this test guards is that verify() drops NO evidence source — if it stopped
  // consulting one (e.g. listLeases), the called-set would shrink and this reddens.
  it("consults all 7 read evidence sources and drops none", async () => {
    const calls: string[] = [];
    const base = goldenStore();
    const store: E7RunVerifierStore = {
      getRun: async (...a) => (calls.push("getRun"), base.getRun(...a)),
      getAttempt: async (...a) => (calls.push("getAttempt"), base.getAttempt(...a)),
      listLeases: async (...a) => (calls.push("listLeases"), base.listLeases(...a)),
      listJobEvents: async (...a) => (calls.push("listJobEvents"), base.listJobEvents(...a)),
      getAttemptTerminalReceipt: async (...a) => (calls.push("getAttemptTerminalReceipt"), base.getAttemptTerminalReceipt(...a)),
      listRunSecretScanSurfaces: async (...a) => (calls.push("listRunSecretScanSurfaces"), base.listRunSecretScanSurfaces(...a)),
      countProducedOutputs: async (...a) => (calls.push("countProducedOutputs"), base.countProducedOutputs(...a)),
    };
    await createE7DistributedRunVerifier({ store }).verify({ runId: RUN_ID });
    expect(new Set(calls)).toEqual(
      new Set([
        "getRun",
        "getAttempt",
        "listLeases",
        "listJobEvents",
        "getAttemptTerminalReceipt",
        "listRunSecretScanSurfaces",
        "countProducedOutputs",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// E7-F003 — the capability blind spot, PINNED ON PURPOSE.
//
// ★ DO NOT "FIX" THIS DESCRIBE BLOCK. It asserts today's behaviour deliberately,
// exactly as the MIG-010 Unit 2.2 repro did: it is the record of what the verifier
// could not see. `ok` answers "was the distributed journey corroborated" — the
// MECHANISM — and a context-free run corroborates that journey perfectly well.
// Making `ok` false here would be the naive fix CLI-008 Unit A explicitly rejects
// (`producedArtifacts` is structurally 0 until Unit F ships output capture, so a
// clause folded into `ok` is a gate nobody can pass — and a permanently-red gate
// gets bypassed, argued around, or deleted).
//
// If this block reddens, someone folded capability into `ok`. Read
// `docs/replatform/qa/2026-09-02-cli-008-unit-a-verifier-clause-plan.md` §"The
// design decision" before changing anything.
// ---------------------------------------------------------------------------
describe("evidence-verifier A — E7-F003 blind spot (pinned: today's verifier blesses a context-free run)", () => {
  // A run whose sandbox agent had no tools, no identity, no workspace and a
  // context-free prompt, and whose CLI exited 127 — yet a worker leased it,
  // started it, terminalized it, and the projector applied the receipt. Every
  // existing clause is satisfied; NOTHING the agent did reached AoA.
  function contextFreeRunStore() {
    return goldenStore({
      runRow: run({ status: "failed", errorCode: "nonzero_exit", error: "claude: command not found (exit 127)" }),
      attemptRow: attempt({ status: "failed" }),
      leases: [lease({ status: "released" })],
      events: [event("attempt_started"), event("terminal")],
      produced: { workspacePatchArtifacts: 0, taskOutputs: 0 },
    });
  }

  it("a context-free run that produced NOTHING satisfies every clause and PASSES (this is the defect)", async () => {
    const verifier = createE7DistributedRunVerifier({ store: contextFreeRunStore() });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("the produced-output counts are VISIBLE and INERT — the signal exists and changes nothing", async () => {
    const verifier = createE7DistributedRunVerifier({ store: contextFreeRunStore() });
    const result = await verifier.verify({ runId: RUN_ID });
    // The pairing IS the finding: the verifier computed the number that would
    // catch this, reported it, and let the run through anyway.
    expect(result.observed.producedArtifacts).toEqual({ workspacePatchArtifacts: 0, taskOutputs: 0 });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI-008 Unit A — the capability dimension, and the three properties that make
// it real (plan Task 4). Each is a mutation target, named in the test.
// ---------------------------------------------------------------------------
describe("evidence-verifier A — clause 6: capability, a dimension separate from ok", () => {
  const NOTHING_PRODUCED = { workspacePatchArtifacts: 0, taskOutputs: 0 };

  it("a context-free run is capabilityProven=false with exactly one clause-6 failure", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore({ produced: NOTHING_PRODUCED }) });
    const result = await verifier.verify({ runId: RUN_ID });
    // MUTATION 1: delete the capability computation and this reddens, while the
    // E7-F003 pin above stays green. If nothing reds, the dimension is decorative.
    expect(result.capabilityProven).toBe(false);
    expect(result.capabilityFailures.map((f) => f.clause)).toEqual([6]);
    // The reason must teach an operator what is UNBUILT, not restate that a count was 0.
    expect(result.capabilityFailures[0].reason).toContain("Unit F");
    expect(result.capabilityFailures[0].reason).toContain("observeRun");
  });

  it("the capability failure NEVER enters failures, so ok stays true", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore({ produced: NOTHING_PRODUCED }) });
    const result = await verifier.verify({ runId: RUN_ID });
    // MUTATION 2: push the capability failure into `failures` instead and BOTH this
    // and the E7-F003 pin redden. This is the guard against the exact regression the
    // design rejects — `producedArtifacts` is structurally 0 until Unit F, so a
    // capability clause folded into `ok` makes E7-1 permanently red.
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.failures.some((f) => f.clause === 6)).toBe(false);
  });

  // MUTATION 3, both arms: a dimension that can never be true is not a check.
  it("a committed workspace_patch artifact ALONE flips capabilityProven true", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 1, taskOutputs: 0 } }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.capabilityProven).toBe(true);
    expect(result.capabilityFailures).toEqual([]);
  });

  it("a task_output ALONE flips capabilityProven true", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 1 } }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.capabilityProven).toBe(true);
    expect(result.capabilityFailures).toEqual([]);
  });

  it("a mechanism FAILURE does not suppress the capability verdict (both dimensions, always)", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ leases: [], events: [], terminalReceipt: null, produced: NOTHING_PRODUCED }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(result.capabilityProven).toBe(false);
    expect(formatVerifyResult(result)).toContain("capability: NOT PROVEN");
  });

  it("an absent run is capabilityProven=false — a run that does not exist proved nothing", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore() });
    const result = await verifier.verify({ runId: "00000000-0000-4000-8000-000000000000" });
    expect(result.notFound).toBe(true);
    expect(result.capabilityProven).toBe(false);
  });
});

describe("evidence-verifier A — the RESULT line cannot be quoted as capability", () => {
  it("a mechanism-PASS with capability unproven says so ON THE RESULT LINE", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 0 } }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.ok).toBe(true);
    const resultLine = formatVerifyResult(result)
      .split("\n")
      .find((l) => l.includes("RESULT:"))!;
    // The property (plan Task 3 Step 1): a reader who sees ONLY this line must not
    // come away believing capability was proven. So PASS is never unqualified, and
    // the capability verdict travels with it.
    expect(resultLine).toContain("NOT PROVEN");
    expect(resultLine).toContain("mechanism");
    expect(resultLine).not.toContain("RESULT: PASS —"); // the old unqualified wording
  });

  it("the counts are printed with the verdict, on a passing run", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 2, taskOutputs: 3 } }),
    });
    const printed = formatVerifyResult(await verifier.verify({ runId: RUN_ID }));
    expect(printed).toContain("capability: PROVEN (workspace_patch_artifacts=2 task_outputs=3)");
    expect(printed).toContain("RESULT: PASS (mechanism)");
  });
});

describe("evidence-verifier A — the --require-capability exit decision", () => {
  // ★ THIS TABLE EXISTS BECAUSE OF WHAT THIS UNIT IS. Unit A stops a claim from living only in
  // prose. A `--require-capability` flag whose enforcing branch is exercised by nothing would
  // reproduce that exact shape one level up: everyone believes it gates the campaign, and
  // nothing checks that it does. The decision is pure, so all four rows are reachable without
  // a live DATABASE_URL.
  const cases: ReadonlyArray<[boolean, boolean, boolean, 0 | 1 | 3]> = [
    // ok,  capabilityProven, requireCapability, expected
    [true, true, false, 0],
    [true, false, false, 0], // today's real run: mechanism green, capability unproven, not required
    [true, false, true, 3], // ★ the branch the campaign flips at Unit F
    [false, false, true, 1], // a mechanism failure OUTRANKS the capability flag
  ];

  for (const [ok, capabilityProven, requireCapability, expected] of cases) {
    it(`ok=${ok} capabilityProven=${capabilityProven} requireCapability=${requireCapability} -> exit ${expected}`, () => {
      expect(e7VerifyExitCode({ ok, capabilityProven }, requireCapability)).toBe(expected);
    });
  }

  it("3 is distinct from 1, so a campaign script can tell the two failures apart", () => {
    // "the journey did not happen" and "the journey happened and proved nothing about the
    // agent" call for different next steps; collapsing them would hide the second.
    expect(e7VerifyExitCode({ ok: false, capabilityProven: false }, true)).toBe(1);
    expect(e7VerifyExitCode({ ok: true, capabilityProven: false }, true)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// W7U2 — the verdict states its own limit (E7-F020).
//
// This unit added NO predicate, arm, conjunct or count. It added TEXT, printed with
// every verdict and carried in the result so `verdict-json` cannot shed it. Three
// blocks, and they are not interchangeable:
//
//   1. THE ASSERTION  — the rendered verdict carries the limitation. This is the one
//      the mutation (delete the caveat from formatVerifyResult) must redden.
//   2. SECOND CONTROL — the text NAMES arm 2 and CITES E7-F020, and does not overclaim
//      in either direction. Without this, a caveat reading "results may vary" passes
//      block 1 while disclosing nothing, which is this programme's signature defect
//      one level up: a check that cannot fail.
//   3. POSITIVE CONTROL — the verdict and both arm counts are UNCHANGED by the diff.
//      The expectations below are not beliefs: they were CAPTURED by running this exact
//      input table against the pre-change module at 31d33a3b0 and pasted in verbatim.
//      If this block reds, behaviour moved and the unit failed its central constraint.
// ---------------------------------------------------------------------------

describe("W7U2 — the capability verdict states its own limit (E7-F020)", () => {
  it("a PROVEN verdict carries the limitation in the RENDERED output", async () => {
    // The dangerous shape: arm 2 alone carries the green (arm 1 is zero).
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 1 } }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.capabilityProven).toBe(true);
    const printed = formatVerifyResult(result);
    // MUTATION: delete the capabilityLimitations block from formatVerifyResult and this reds,
    // while every pre-existing capability test and the positive control below stay green.
    expect(printed).toContain("E7-F020");
    // ★ W21: was "task_outputs arm" — the block now leads with the predicate, so the arm is
    // named as "Arm 2 (task_outputs)". Same property: the arm is identified, not "the check".
    expect(printed).toContain("Arm 2 (task_outputs)");
    expect(printed).toContain("limit of this verdict");
  });

  it("a NOT-PROVEN verdict carries it too — the limit is a property of the arm, not of the green", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 0 } }),
    });
    expect(formatVerifyResult(await verifier.verify({ runId: RUN_ID }))).toContain("E7-F020");
  });

  it("the limitation is in the RESULT too, so verdict-json cannot shed it", async () => {
    // The CLI prints `verdict-json: ${JSON.stringify(result)}` beside the human text. A
    // limitation that lived only in the printed lines would vanish the moment anyone quoted
    // the machine-readable line — which is the line a campaign script would quote.
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 1 } }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(JSON.stringify(result)).toContain("E7-F020");
  });

  it("a run whose arm 2 is non-zero is told so SPECIFICALLY, with its own count", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 2 } }),
    });
    const printed = formatVerifyResult(await verifier.verify({ runId: RUN_ID }));
    expect(printed).toContain("THIS RUN: arm 2 is non-zero (task_outputs=2)");
  });

  it("a run whose arm 2 is ZERO gets no THIS-RUN line — the sharpening must not fire vacuously", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 1, taskOutputs: 0 } }),
    });
    const printed = formatVerifyResult(await verifier.verify({ runId: RUN_ID }));
    expect(printed).toContain("E7-F020"); // the general limit still prints
    expect(printed).not.toContain("THIS RUN: arm 2 is non-zero");
  });
});

describe("W7U2 SECOND CONTROL — the caveat says something FALSIFIABLE", () => {
  const text = E7_CAPABILITY_LIMITATIONS.join(" ");

  it("names the arm and the exact column, not 'the capability check'", () => {
    // A caveat that says "this verdict has limitations" passes a naive contains-check while
    // disclosing nothing. These are the load-bearing nouns.
    // ★ W21D — this used to read `toContain("arm 2")`, which could never red: "arm 2" is a
    // substring of "arm 2 ONLY", asserted on the SAME `text` in the Scope test below, so a
    // caveat that had lost every other mention of the arm still passed here. Pin the arm-2
    // sentence's own opening instead — no sibling assertion supplies it.
    // The sentence pin already carries the column name, so a separate bare
    // `toContain("task_outputs")` would be the same vacuous-sibling defect one line down —
    // it was removed rather than kept for appearances.
    expect(text).toContain("Arm 2 (task_outputs) counts ONLY rows");
    expect(text).toContain("created_by_run_id");
    // ★ W21: the literal line range `:213-216` was dropped when the predicate moved. The FILE
    // is still named; a line range that drifts on the next edit is a citation that rots.
    expect(text).toContain("e7-distributed-run-verifier-store.ts");
  });

  // ★ W21 — THE NEW REQUIRED HALF. The block used to be pure disclosure; arm 2 now applies a
  // provenance predicate, and the text has to NAME it, or a reader cannot check whether the
  // rule described is the rule enforced. These are the load-bearing nouns of the new predicate.
  it("names the provenance predicate arm 2 actually applies", () => {
    expect(text).toContain("output_projection");
    expect(text).toContain("job_projection_receipts");
    expect(text).toContain("projectAcceptedOutput");
  });

  it("cites E7-F020 so a reader can find the measurement", () => {
    expect(text).toContain("E7-F020");
  });

  // ★ W21C — THE SECOND TIME THIS BLOCK WOULD HAVE GONE FALSE SILENTLY. It stated the receipt
  // match as `job_id` alone and declared arm 1 untouched; E7-F031 made both arms attempt-bound,
  // so both sentences became false claims printed beside every verdict. These nouns pin the
  // corrected version — a future edit that re-widens either arm to job scope, or that narrows
  // the SCANNER to the attempt, leaves a text that no longer describes the code and reds here.
  it("names the ATTEMPT granularity both arms now enforce, and the scanner's exemption", () => {
    // ★★★ W21D — THE ASSERTION THAT COULD NEVER RED, AND THE PROOF THAT IT COULD NOT.
    // This line used to read `toContain("attempt_id")`. "attempt_id" is a SUBSTRING of the
    // "distributed_attempt_id" asserted on the very next line: measured offsets of
    // "attempt_id" in the joined text were [170, 832], and 832 falls inside the
    // "distributed_attempt_id" occurrence starting at 820. So while line 2 was green,
    // line 1 was mathematically incapable of failing.
    //
    // MEASURED CONSEQUENCE, not a worry: reverting the arm-2 sentence to its pre-W21C
    // job-only wording ("for THIS run's distributed job") left this ENTIRE describe block
    // green — all of its toContain assertions, both deny-lists and the positional window —
    // while the caveat printed beside every verdict said both "matched on job_id" and
    // "Both are now attempt-bound", contradicting itself. This is the SECOND time an
    // assertion satisfied by its own siblings has shipped on this branch pair; the first
    // hid the invisible-byte defect on PR #383.
    //
    // The fix pins the SENTENCE. Reverting the caveat now reds here, which is the point.
    expect(text).toContain("matched on job_id AND attempt_id");
    expect(text).toContain("not job_id alone");
    expect(text).toContain("distributed_attempt_id");
    expect(text).toContain("max_attempts");
    expect(text).toContain("E7-F031");
    // The asymmetry is the part a "consistency" edit destroys, so it is asserted, not implied.
    // ★ W21D made this precise. The text used to say flatly "the scanner is deliberately NOT
    // attempt-bound", which is false of ONE of its four surfaces: `listJobEvents` is keyed on
    // `attempt_id`, so a sibling attempt's event payloads are never scanned — the gap the same
    // commit filed as E7-F032. The pin now covers BOTH halves, so a future edit cannot drop
    // the disclosure and keep the reassuring half.
    expect(text).toContain("task_outputs and job_artifacts surfaces are deliberately NOT attempt-bound");
    expect(text).toContain("job_events surface IS attempt-narrow");
    expect(text).toContain("E7-F032");
  });

  it("names the writer path that makes it true, so the claim can be checked", () => {
    expect(text).toContain("heartbeat.ts:4524");
    expect(text).toContain("task-output-emitters.ts:113");
  });

  // ★ THE TWO ANTI-DRIFT GUARDS BELOW ARE BOUNDED, AND SAYING SO IS THE POINT. They assert on
  // PHRASES, not on meaning: a fixed deny-list of substrings ("now handled", "meaningless", …)
  // plus one required substring. They catch the drift that reuses the obvious wording; they do
  // NOT catch a rewrite that overclaims in a synonym this list does not carry ("this risk is
  // addressed", "amounts to nothing"), and they cannot tell whether a sentence is TRUE. Nothing
  // here makes the caveat semantically correct — a human reader still owes that. They are cheap
  // regression tripwires on the exact wordings this unit reviewed, and that is their whole claim.
  // Do not read a green here as "the caveat has been checked for honesty".
  // ★★★ W21 REPOINTED, NOT RELAXED. The required phrase used to be "DISCLOSURE, not a control",
  // which stopped being true the moment W21 gave arm 2 a predicate — a caveat that describes
  // itself wrongly is the drift this guard exists to catch, so the guard had to move with the
  // text rather than be deleted. What replaces it is STRICTLY MORE: the deny-list is kept
  // verbatim AND extended with the overclaim this particular change invites ("the capability
  // gate now works"), and the block must still say what a green does not establish.
  it("states the residual and must not read as 'the gate now works'", () => {
    expect(text).toContain("WHAT A GREEN STILL DOES NOT ESTABLISH");
    expect(text).toContain("E7-F018");
    expect(text).toContain("gates nothing");
    for (const claim of ["now handled", "is fixed", "no longer", "mitigated", "prevents"]) {
      expect(text.toLowerCase()).not.toContain(claim);
    }
    for (const claim of ["now works", "gate works", "capability is proven", "ready to gate"]) {
      expect(text.toLowerCase()).not.toContain(claim);
    }
  });

  it("does NOT overclaim in the other direction either", () => {
    // E7-F020 does not say capabilityProven is meaningless or always false, and neither is
    // true. Overclaiming a limit is how a real one gets dismissed as alarmism.
    for (const overclaim of ["meaningless", "always false", "never true", "worthless"]) {
      expect(text.toLowerCase()).not.toContain(overclaim);
    }
  });

  it("scopes itself to arm 2 and does NOT attribute E7-F020 to arm 1", () => {
    // Arm 1 (workspace_patch job_artifacts) has a DIFFERENT open question (E7-F019) and is
    // short-circuited by `if (run.distributedJobId && attemptId)`. Blurring them would make the
    // text unfalsifiable, and E7-F018/F019/F020 exist precisely because the arms differ.
    expect(text).toContain("arm 2 ONLY");
    expect(text).toContain("E7-F019");

    // ★★★ W21C WIDENED THIS FROM A STRING BAN TO A STRUCTURAL ONE, AND THE REASON MATTERS.
    // The check used to be a flat `not.toContain("both arms")`. E7-F031 then made a cross-arm
    // statement TRUE — the attempt binding really does cover arm 1 and arm 2 — so the flat ban
    // forbade an accurate sentence. The tempting move at that point is to reword around the
    // banned string, which keeps the guard green while saying the same thing in other words:
    // a guard defeated by a synonym is a guard that has stopped guarding.
    //
    // So the rule now says what it always MEANT: a cross-arm claim is allowed, but only inside
    // the paragraph that cites the finding licensing it, and NEVER attached to the E7-F020
    // provenance claim, which is arm-2-only and must stay that way.
    // ★★★ W21D — THE GUARD WAS LOOSER THAN THE RULE IT STATES, AND ONLY ONE BOUND WAS PROVEN.
    // It used `Scope:` as the upper bound, which is not where the licensing paragraph ends: the
    // window ran [630, 2323] — 1693 characters spanning THREE paragraphs, because "WHAT A GREEN
    // STILL DOES NOT ESTABLISH" starts at 1610 and the E7-F020 residual at 1976 both sat inside
    // it. Measured: inserting "— this holds for both arms —" into the WHAT-A-GREEN paragraph
    // left this test GREEN. The recorded mutation had only ever exercised the UPPER bound.
    //
    // The upper bound is now the START OF THE NEXT SECTION, computed rather than named, so the
    // window tracks the text instead of a landmark two paragraphs away. Both bounds are pinned.
    const attemptParagraph = text.indexOf("ATTEMPT GRANULARITY (E7-F031)");
    expect(attemptParagraph).toBeGreaterThan(-1);
    const laterSections = ["WHAT A GREEN STILL DOES NOT ESTABLISH", "E7-F020 stays OPEN", "Scope:"]
      .map((marker) => text.indexOf(marker))
      .filter((at) => at > attemptParagraph);
    expect(laterSections.length).toBeGreaterThan(0);
    const attemptParagraphEnd = Math.min(...laterSections);

    // ANTI-VACUITY: with zero occurrences the loop below asserts nothing at all, and a text that
    // had quietly lost its cross-arm sentence would pass a guard whose whole subject is that
    // sentence. The count is asserted, so the loop is never empty.
    const crossArm = [...text.matchAll(/both arms/gi)];
    expect(crossArm.length).toBeGreaterThan(0);
    for (const match of crossArm) {
      const at = match.index ?? -1;
      expect(at).toBeGreaterThan(attemptParagraph);
      expect(at).toBeLessThan(attemptParagraphEnd);
    }

    // And no sentence making the E7-F020 provenance claim may reach for arm 1 — the original
    // intent, now checked per sentence instead of over the whole blob.
    for (const sentence of text.split(/(?<=\.)\s+/)) {
      if (!sentence.includes("E7-F020")) continue;
      expect(sentence.toLowerCase()).not.toContain("arm 1");
      expect(sentence.toLowerCase()).not.toContain("both arms");
    }
  });
});

describe("W7U2 POSITIVE CONTROL — the verdict and the arm counts did not move", () => {
  // ★ CAPTURED, NOT BELIEVED. Every expectation below was produced by running this exact
  // input table against the module at 31d33a3b0 (the merge-base of this branch), BEFORE
  // any edit in this unit, and pasted in verbatim. It is the check that this unit disclosed
  // a limit rather than quietly changing what clause 6 counts.
  const BASELINE: ReadonlyArray<readonly [number, number, boolean, boolean, readonly number[]]> = [
    // wp, to,  ok,   capabilityProven, capabilityFailure clauses
    [0, 0, true, false, [6]],
    [0, 1, true, true, []],
    [0, 3, true, true, []],
    [1, 0, true, true, []],
    [1, 1, true, true, []],
    [1, 3, true, true, []],
    [2, 0, true, true, []],
    [2, 1, true, true, []],
    [2, 3, true, true, []],
  ];

  for (const [wp, to, ok, capabilityProven, capFailClauses] of BASELINE) {
    it(`wp=${wp} to=${to} -> ok=${ok} capabilityProven=${capabilityProven} counts unchanged`, async () => {
      const verifier = createE7DistributedRunVerifier({
        store: goldenStore({ produced: { workspacePatchArtifacts: wp, taskOutputs: to } }),
      });
      const result = await verifier.verify({ runId: RUN_ID });
      expect(result.ok).toBe(ok);
      expect(result.capabilityProven).toBe(capabilityProven);
      expect(result.capabilityFailures.map((f) => f.clause)).toEqual(capFailClauses);
      // The counts are passed through untouched — no filter, no weighting, no subtraction.
      expect(result.observed.producedArtifacts).toEqual({
        workspacePatchArtifacts: wp,
        taskOutputs: to,
      });
    });
  }

  it("notFound is unchanged: ok=false, capabilityProven=false, counts 0/0", async () => {
    const verifier = createE7DistributedRunVerifier({ store: goldenStore() });
    const result = await verifier.verify({ runId: "00000000-0000-4000-8000-000000000000" });
    expect(result.ok).toBe(false);
    expect(result.capabilityProven).toBe(false);
    expect(result.observed.producedArtifacts).toEqual({ workspacePatchArtifacts: 0, taskOutputs: 0 });
  });

  it("the exit decision is unchanged for all four rows", () => {
    // The caveat must not have leaked into the gate. `--require-capability` still exits 3 on
    // exactly the same input it did before, and 0 stays 0.
    expect(e7VerifyExitCode({ ok: true, capabilityProven: true }, true)).toBe(0);
    expect(e7VerifyExitCode({ ok: true, capabilityProven: false }, false)).toBe(0);
    expect(e7VerifyExitCode({ ok: true, capabilityProven: false }, true)).toBe(3);
    expect(e7VerifyExitCode({ ok: false, capabilityProven: false }, true)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// W7U2-FIX — the HEADLINE may not assert what the caveat disclaims.
//
// W7U2 added an accurate caveat and left it sitting ten lines BELOW a RESULT line that still
// read "CAPABILITY: PROVEN — output from the agent reached AoA". The report asserted in its
// title the thing it disclaimed in its footnote, and a headline is exactly the part a reader
// stops at. This block pins the fix: the PROVEN headline states the COUNT it made and points
// DOWN to the limit, instead of contradicting it.
//
// TEXT ONLY. The positive control immediately after re-asserts that `capabilityProven` and
// BOTH arm counts are byte-identical for the same inputs — if that reds, this stopped being a
// wording fix and became a behaviour change, which is the one thing the unit forbids.
// ---------------------------------------------------------------------------

describe("W7U2-FIX — the PROVEN headline does not claim agent provenance", () => {
  const resultLineOf = (printed: string) =>
    printed.split("\n").find((l) => l.includes("RESULT:"))!;

  it("the PROVEN headline drops the agent-provenance claim", async () => {
    // The dangerous shape again: arm 2 alone carries the green, and arm 2 is the arm E7-F020
    // measures as satisfiable with zero agent output.
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 1 } }),
    });
    const result = await verifier.verify({ runId: RUN_ID });
    expect(result.capabilityProven).toBe(true);
    const resultLine = resultLineOf(formatVerifyResult(result));
    // ★ MUTATION: restore the old branch text
    //     "CAPABILITY: PROVEN — output from the agent reached AoA"
    //   and this assertion reds, while the positive control below stays green.
    expect(resultLine).not.toContain("output from the agent reached AoA");
    // Not a swing to the other overclaim: something WAS counted, and the line still says PROVEN.
    expect(resultLine).toContain("CAPABILITY: PROVEN");
    for (const overclaim of ["MEANINGLESS", "UNPROVEN"]) {
      expect(resultLine).not.toContain(overclaim);
    }
  });

  it("the PROVEN headline says what was actually counted and defers to the limit below", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 1 } }),
    });
    const printed = formatVerifyResult(await verifier.verify({ runId: RUN_ID }));
    const resultLine = resultLineOf(printed);
    expect(resultLine).toContain("produced-output rows were counted for this run");
    expect(resultLine).toContain("does NOT by itself establish they came from the agent");
    // The pointer must not dangle: the phrase the headline sends the reader to has to exist in
    // the SAME rendered report. A caveat reference to a block that got renamed is a dead end.
    expect(resultLine).toContain("limit of this verdict");
    // ★ W21: the parenthetical changed from "(a DISCLOSURE — nothing below is enforced)" because
    // that stopped being true — arm 2's first sentences now describe an ENFORCED predicate. The
    // dangling-pointer property this assertion exists for is unchanged.
    expect(printed).toContain("limit of this verdict (what a green here does NOT establish)");
  });

  it("the NOT-PROVEN branch is untouched — the two branches stay distinct", async () => {
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 0, taskOutputs: 0 } }),
    });
    const resultLine = resultLineOf(formatVerifyResult(await verifier.verify({ runId: RUN_ID })));
    expect(resultLine).toContain("CAPABILITY: NOT PROVEN — nothing the agent produced reached AoA");
  });

  it("the headline still carries BOTH dimensions, so neither can be quoted alone", async () => {
    // The pre-existing property from Unit A: mechanism and capability share one line. The
    // qualification must not have pushed the capability verdict off it.
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 2, taskOutputs: 3 } }),
    });
    const resultLine = resultLineOf(formatVerifyResult(await verifier.verify({ runId: RUN_ID })));
    expect(resultLine).toContain("PASS (mechanism)");
    expect(resultLine).toContain("CAPABILITY: PROVEN");
    expect(resultLine).not.toContain("RESULT: PASS —"); // the old unqualified wording
  });
});

describe("W7U2-FIX POSITIVE CONTROL — the headline reword moved NO count and NO verdict", () => {
  // Same captured baseline table as the W7U2 positive control above, re-run against the
  // reworded printer. It is here as well as there on purpose: this unit's single constraint is
  // that a TEXT edit changed no behaviour, and the check for that has to sit beside the edit.
  const BASELINE: ReadonlyArray<readonly [number, number, boolean, boolean]> = [
    // wp, to,  ok,   capabilityProven
    [0, 0, true, false],
    [0, 1, true, true],
    [1, 0, true, true],
    [2, 3, true, true],
  ];

  for (const [wp, to, ok, capabilityProven] of BASELINE) {
    it(`wp=${wp} to=${to} -> ok=${ok} capabilityProven=${capabilityProven}, counts passed through`, async () => {
      const verifier = createE7DistributedRunVerifier({
        store: goldenStore({ produced: { workspacePatchArtifacts: wp, taskOutputs: to } }),
      });
      const result = await verifier.verify({ runId: RUN_ID });
      expect(result.ok).toBe(ok);
      expect(result.capabilityProven).toBe(capabilityProven);
      expect(result.observed.producedArtifacts).toEqual({
        workspacePatchArtifacts: wp,
        taskOutputs: to,
      });
    });
  }

  it("the count line under the headline is byte-identical to before the reword", async () => {
    // The reword touched the RESULT line only. The `capability:` line that carries the actual
    // numbers is the one a script parses, and it must be exactly what it was.
    const verifier = createE7DistributedRunVerifier({
      store: goldenStore({ produced: { workspacePatchArtifacts: 2, taskOutputs: 3 } }),
    });
    const printed = formatVerifyResult(await verifier.verify({ runId: RUN_ID }));
    expect(printed).toContain("  capability: PROVEN (workspace_patch_artifacts=2 task_outputs=3)");
  });

  it("the exit decision is untouched by the reword", () => {
    expect(e7VerifyExitCode({ ok: true, capabilityProven: true }, true)).toBe(0);
    expect(e7VerifyExitCode({ ok: true, capabilityProven: false }, true)).toBe(3);
    expect(e7VerifyExitCode({ ok: false, capabilityProven: false }, true)).toBe(1);
  });
});
