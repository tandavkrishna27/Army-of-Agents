import { describe, expect, it, vi } from "vitest";
import {
  SHADOW_COMPARABLE_FIELDS,
  SHADOW_CALLER_DERIVED_FIELDS,
  createJobShadowComparator,
  type LegacyRunExecutionSnapshot,
  type ShadowComparisonResult,
} from "../services/job-shadow-comparator.js";
import { decideJobPlacement } from "../services/job-placement.js";
import {
  submitJobSourceIdentity,
  submitJobSourceWorkloadType,
  type SubmitJobSource,
} from "@armyofagents/shared";

const TASK_SOURCE: SubmitJobSource = {
  kind: "task_run",
  runId: "33333333-3333-4333-8333-333333333333",
  issueId: "44444444-4444-4444-8444-444444444444",
  assigneeAgentId: "55555555-5555-4555-8555-555555555555",
};

const SNAPSHOT: LegacyRunExecutionSnapshot = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  source: TASK_SOURCE,
  workloadType: "batch",
  routing: { executionTargetType: "e2b" },
  provenance: { executionPrincipalKind: "agent", credentialKind: "company_api_key" },
  policy: {
    model: "claude-sonnet",
    budgetPolicyId: "66666666-6666-4666-8666-666666666666",
    effectiveCompletionPolicy: "review_required",
  },
  workloadCharacterization: {
    command: "claude",
    args: ["--print", "do the thing"],
    maxRuntimeSeconds: 600,
    stdinArtifactId: null,
  },
};

function collectingSink() {
  const records: ShadowComparisonResult[] = [];
  return { records, record: (r: ShadowComparisonResult) => records.push(r) };
}

// ─── S1 ──────────────────────────────────────────────────────────────────────
// The defect this ticket exists to fix. Before Lane A, production composed the
// comparator with no independent derivation, the identity default ran, and every
// field was diffed against a copy of itself — so `match` was `true` for 100% of
// runs by construction. Measured at terrain time: 2,000 randomized snapshots,
// 0 divergences. The gate opens on a divergence rate; a rate whose numerator
// cannot increment is worse than no check at all.
describe("S1 — an uncompared field is never reported as agreement", () => {
  it("never counts a caller-derived field as compared, across 2000 randomized snapshots", () => {
    const sink = collectingSink();
    const comparator = createJobShadowComparator({ sink });
    const pick = <T,>(xs: readonly T[], i: number) => xs[i % xs.length];
    const targets = ["e2b", "local", "gvisor", "pooled_gvisor", ""] as const;
    const principals = ["agent", "user", "service", "system"] as const;
    const creds: readonly (string | null)[] = [null, "byo", "hosted"];
    const models: readonly (string | null)[] = [null, "opus", "sonnet"];
    const budgets: readonly (string | null)[] = [null, "bp-1"];
    const policies = ["review_required", "agent_can_complete"] as const;

    for (let i = 0; i < 2000; i++) {
      comparator.compare({
        ...SNAPSHOT,
        routing: { executionTargetType: pick(targets, i) },
        provenance: {
          executionPrincipalKind: pick(principals, i * 3),
          credentialKind: pick(creds, i * 5),
        },
        policy: {
          model: pick(models, i * 7),
          budgetPolicyId: pick(budgets, i * 11),
          effectiveCompletionPolicy: pick(policies, i * 13),
        },
      });
    }

    expect(sink.records).toHaveLength(2000);
    // The property the identity mapping violated: with no caller-supplied intent, NONE
    // of the six caller-derived fields may appear as compared, however the six values
    // vary. Only `workloadType` — which the comparator derives itself, purely — is.
    for (const record of sink.records) {
      expect(record.comparedFields).toEqual(["workloadType"]);
      expect(record.match).toBe("agree"); // agreement ONLY on the self-derived field
      expect([...record.uncomparedFields].sort()).toEqual([...SHADOW_CALLER_DERIVED_FIELDS].sort());
      for (const field of SHADOW_CALLER_DERIVED_FIELDS) {
        expect(record.comparedFields).not.toContain(field);
      }
    }
    // The denominator is explicit and small: 1 of 7, not 7 of 7 by default.
    expect(SHADOW_CALLER_DERIVED_FIELDS).toHaveLength(SHADOW_COMPARABLE_FIELDS.length - 1);
  });

  it("reports not_compared when not even workloadType can be checked", () => {
    // The three-state exists for this: an errored comparison claims nothing.
    const sink = collectingSink();
    const comparator = createJobShadowComparator({ sink });
    const result = comparator.compare({
      ...SNAPSHOT,
      // A missing source makes the record's own construction throw. Before the outer
      // guard this propagated into the caller — i.e. a malformed snapshot could fail a
      // live Commander turn, which is the one thing this module promises never to do.
      source: undefined as unknown as SubmitJobSource,
    });
    expect(result.errored).toBe(true);
    expect(result.match).toBe("not_compared");
    expect(result.comparedFields).toEqual([]);
  });

  // The self-derived field must be a REAL comparison, not a second tautology: the
  // snapshot's declared workload class comes from the seam (a hand-written constant),
  // the compared value from the source. A seam that declares the wrong class diverges.
  it("catches a seam that declares the wrong workload class", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const result = comparator.compare({
      ...SNAPSHOT,
      // Declared "batch" by the seam, but a browser_request really submits as
      // "browser_session".
      workloadType: "batch",
      source: {
        kind: "browser_request",
        browserRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        parentJobId: null,
      },
    });
    expect(result.match).toBe("diverge");
    expect(result.mismatchedFields).toEqual(["workloadType"]);
    expect(result.comparedFields).toEqual(["workloadType"]);
  });

  it("counts a field as compared ONLY when an independent value is supplied", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const result = comparator.compare(SNAPSHOT, {
      intent: { routing: { executionTargetType: "e2b" } },
    });
    expect(result.match).toBe("agree");
    expect(result.comparedFields).toEqual(["workloadType", "routing.executionTargetType"]);
    expect(result.mismatchedFields).toEqual([]);
    expect(result.uncomparedFields).not.toContain("routing.executionTargetType");
    expect(result.uncomparedFields).toHaveLength(SHADOW_COMPARABLE_FIELDS.length - 2);
  });

  it("a supplied value that differs is a divergence", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const result = comparator.compare(SNAPSHOT, {
      intent: {
        routing: { executionTargetType: "local" },
        policy: { model: "gpt-4" },
      },
    });
    expect(result.match).toBe("diverge");
    expect(result.mismatchedFields).toContain("routing.executionTargetType");
    expect(result.mismatchedFields).toContain("policy.model");
    expect(result.mismatchedFields).not.toContain("provenance.credentialKind");
  });

  // An explicit `null` is a supplied value, not an absent one. Two of the six
  // fields are legitimately null in production (`credentialKind`,
  // `budgetPolicyId`), so conflating "supplied null" with "not supplied" would
  // silently drop them out of the denominator — the same defect in miniature.
  it("an explicitly supplied null credentialKind is compared, not treated as absent", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const agree = comparator.compare(
      { ...SNAPSHOT, provenance: { executionPrincipalKind: "agent", credentialKind: null } },
      { intent: { provenance: { credentialKind: null } } },
    );
    expect(agree.comparedFields).toEqual(["workloadType", "provenance.credentialKind"]);
    expect(agree.match).toBe("agree");

    const diverge = comparator.compare(SNAPSHOT, {
      intent: { provenance: { credentialKind: null } },
    });
    expect(diverge.comparedFields).toEqual(["workloadType", "provenance.credentialKind"]);
    expect(diverge.mismatchedFields).toEqual(["provenance.credentialKind"]);
    expect(diverge.match).toBe("diverge");
  });

  // Both nullable fields need this, not just the first one written. A mutation pass
  // caught budgetPolicyId missing here while credentialKind was covered.
  it("an explicitly supplied null budgetPolicyId is compared, not treated as absent", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const agree = comparator.compare(
      { ...SNAPSHOT, policy: { ...SNAPSHOT.policy, budgetPolicyId: null } },
      { intent: { policy: { budgetPolicyId: null } } },
    );
    expect(agree.comparedFields).toEqual(["workloadType", "policy.budgetPolicyId"]);
    expect(agree.match).toBe("agree");

    const diverge = comparator.compare(SNAPSHOT, {
      intent: { policy: { budgetPolicyId: null } },
    });
    expect(diverge.comparedFields).toEqual(["workloadType", "policy.budgetPolicyId"]);
    expect(diverge.mismatchedFields).toEqual(["policy.budgetPolicyId"]);
    expect(diverge.match).toBe("diverge");
  });
});

// ─── S2 ──────────────────────────────────────────────────────────────────────
describe("S2 — compared/uncompared partition the comparable fields", () => {
  it("partitions exactly, with mismatched a subset of compared", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const result = comparator.compare(SNAPSHOT, {
      intent: {
        routing: { executionTargetType: "local" },
        provenance: { executionPrincipalKind: "agent" },
        policy: { effectiveCompletionPolicy: "agent_can_complete" },
      },
    });

    const union = [...result.comparedFields, ...result.uncomparedFields].sort();
    expect(union).toEqual([...SHADOW_COMPARABLE_FIELDS].sort());
    expect(new Set(union).size).toBe(SHADOW_COMPARABLE_FIELDS.length);
    for (const field of result.mismatchedFields) {
      expect(result.comparedFields).toContain(field);
    }
    expect(result.mismatchedFields.sort()).toEqual(
      ["policy.effectiveCompletionPolicy", "routing.executionTargetType"].sort(),
    );
  });
});

// ─── S3 / S4 ─────────────────────────────────────────────────────────────────
// The comparator hardcoded `kind: "task_run"` and required runId/issueId/
// assigneeAgentId, which two of the three MIG target sinks do not have. The
// FROZEN worker-protocol variants are `.strict()`, so fabricating those fields
// on a non-task variant is refused at the schema boundary — the wiring must
// never try.
describe("S3 — every source kind round-trips with its own identity", () => {
  // The expected id is written out LITERALLY. Asserting
  // `result.sourceId === submitJobSourceIdentity(source)` compares the implementation
  // to itself and passes for any wrong-but-consistent field — a mutation pass caught
  // exactly that here, which is the same tautology this whole ticket exists to remove.
  const SOURCES: ReadonlyArray<readonly [SubmitJobSource, string]> = [
    [TASK_SOURCE, "33333333-3333-4333-8333-333333333333"],
    [
      {
        kind: "commander_turn",
        internalAgentRunId: "77777777-7777-4777-8777-777777777777",
        conversationId: "88888888-8888-4888-8888-888888888888",
      },
      "77777777-7777-4777-8777-777777777777",
    ],
    [
      { kind: "crew_run", crewRunId: "99999999-9999-4999-8999-999999999999" },
      "99999999-9999-4999-8999-999999999999",
    ],
    [
      {
        kind: "one_shot",
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        operationKind: "extraction",
      },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ],
    [
      {
        kind: "browser_request",
        browserRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        parentJobId: null,
      },
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ],
    [
      {
        kind: "service_reconcile",
        serviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        generation: 3,
        reconciliationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ],
  ];

  it.each(SOURCES.map(([s, id]) => [s.kind, s, id] as const))(
    "echoes the %s source verbatim and never invents a task identity",
    (_kind, source, expectedId) => {
      const comparator = createJobShadowComparator({ sink: collectingSink() });
      const result = comparator.compare({ ...SNAPSHOT, source });

      expect(result.wouldBeSource).toEqual(source);
      expect(result.sourceKind).toBe(source.kind);
      expect(result.sourceId).toBe(expectedId);
      // …and the shared helper must agree with the literal, so the two cannot drift.
      expect(submitJobSourceIdentity(source)).toBe(expectedId);
      if (source.kind !== "task_run") {
        expect(result.wouldBeSource).not.toHaveProperty("runId");
        expect(result.wouldBeSource).not.toHaveProperty("issueId");
        expect(result.wouldBeSource).not.toHaveProperty("assigneeAgentId");
      }
    },
  );
});

// ─── S10 ─────────────────────────────────────────────────────────────────────
// The rollout key is (organizationId, workloadType) and the four sinks this
// programme cuts over all map to "batch". Benign for shadow; it is why Wave 4's
// MIG-005 → 006 → 007 ordering is not expressible today. Pinned so the limit
// cannot be widened by accident, nor quietly disappear.
describe("S10 — all four cutover sinks share one rollout key", () => {
  it("maps every cutover sink to the batch workload", () => {
    expect(submitJobSourceWorkloadType(TASK_SOURCE)).toBe("batch");
    expect(
      submitJobSourceWorkloadType({
        kind: "commander_turn",
        internalAgentRunId: "x",
        conversationId: "y",
      }),
    ).toBe("batch");
    expect(submitJobSourceWorkloadType({ kind: "crew_run", crewRunId: "z" })).toBe("batch");
    expect(
      submitJobSourceWorkloadType({
        kind: "one_shot",
        operationId: "o",
        operationKind: "compaction",
      }),
    ).toBe("batch");
    // The two non-cutover kinds are the ones that DO get their own key.
    expect(
      submitJobSourceWorkloadType({
        kind: "browser_request",
        browserRequestId: "b",
        parentJobId: null,
      }),
    ).toBe("browser_session");
    expect(
      submitJobSourceWorkloadType({
        kind: "service_reconcile",
        serviceId: "s",
        generation: 1,
        reconciliationId: "r",
      }),
    ).toBe("service");
  });
});

// ─── S5 ──────────────────────────────────────────────────────────────────────
describe("S5 — the comparator holds no database handle", () => {
  it("accepts only a sink; there is no Db-shaped dependency to pass", () => {
    // Structural: the factory's contract is one key. A future edit that adds a
    // Db/port dependency to reach the database directly fails here, which is the
    // point — effect-freeness is an absence, not a promise (design D4).
    const deps = { sink: collectingSink() };
    expect(Object.keys(deps)).toEqual(["sink"]);
    const comparator = createJobShadowComparator(deps);
    expect(Object.keys(comparator)).toEqual(["compare"]);
  });
});

describe("shadow comparator — retained CLI-005 properties", () => {
  it("derives the batch workload envelope from the run", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const result = comparator.compare(SNAPSHOT);
    expect(result.workloadValid).toBe(true);
    expect(result.wouldBeWorkload).toEqual({
      command: "claude",
      args: ["--print", "do the thing"],
      stdinArtifactId: null,
      maxRuntimeSeconds: 600,
    });
  });

  it("is NON-LEASABLE by construction (shadow placement lease-eligibility is false)", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    expect(comparator.compare(SNAPSHOT).placementLeaseEligible).toBe(false);

    const decision = decideJobPlacement({
      sourceKind: "task_run",
      rollout: { enabled: true, mode: "shadow", reason: "enabled" },
      requirements: {},
      providerDemand: {},
      credentialOwnerPrincipalId: null,
      now: new Date(),
      maxHeartbeatAgeMs: 30_000,
      inputDigest: "0".repeat(64),
      policyDigest: "0".repeat(64),
      candidates: [],
    } as never);
    expect(decision.leaseEligible).toBe(false);
  });

  it("records an invalid workload characterization without throwing", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    const result = comparator.compare({
      ...SNAPSHOT,
      workloadCharacterization: {
        command: "",
        args: [],
        maxRuntimeSeconds: 0,
        stdinArtifactId: null,
      },
    });
    expect(result.workloadValid).toBe(false);
    expect(result.wouldBeWorkload).toBeNull();
  });

  it("a sink failure never propagates into the run", () => {
    const throwingSink = {
      record: vi.fn(() => {
        throw new Error("sink down");
      }),
    };
    const comparator = createJobShadowComparator({ sink: throwingSink });
    expect(() => comparator.compare(SNAPSHOT)).not.toThrow();
    expect(throwingSink.record).toHaveBeenCalledTimes(1);
  });

  it("records the admissibility verdict the caller supplies", () => {
    const comparator = createJobShadowComparator({ sink: collectingSink() });
    expect(comparator.compare(SNAPSHOT).admissible).toBeNull();
    expect(comparator.compare(SNAPSHOT, { admissible: false }).admissible).toBe(false);
  });
});
