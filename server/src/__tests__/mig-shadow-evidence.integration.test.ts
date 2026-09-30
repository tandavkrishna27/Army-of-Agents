// MIG-005/006/007 Lane D — the shadow evidence harness.
//
// WHAT THIS IS, AND WHAT IT IS NOT. Gate clause 2 requires a shadow comparison that has
// run "against real traffic with a stated divergence rate and every divergence
// explained". This harness produces the RATE and the EXPLANATION over a SEEDED corpus,
// end to end through the real chain:
//
//   sink seam → recordDistributedShadow → the real rollout source (flag-first)
//             → the real read-only admissibility probe against a real database
//             → the real comparator → a collecting sink
//
// It is NOT organic production traffic, and this file does not pretend otherwise. The
// D1 two-replica lane exercises the worker/job-control platform (leases, tenancy, MinIO,
// fences, fan-out) and contains nothing that drives a Commander turn, a crew dispatch or
// an extraction — so there is no existing live lane whose volume could be cited. What a
// real-traffic run additionally requires is stated in the result doc.
//
// The value here is that every link is the production one. A harness that stubbed the
// probe or the comparator would report a rate about itself.
//
// Gate: Linux CI automatically; Windows-runnable in place via AOA_RUN_WIN_INTEGRATION=1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import { createDistributedExecutionRolloutSource } from "../config/distributed-execution-rollout-source.js";
import {
  createDistributedShadowRecorder,
  recordDistributedShadow,
  setDistributedShadowPort,
  type ShadowSinkInput,
} from "../services/distributed-shadow-port.js";
import { probeDistributedAdmissibility } from "../services/job-shadow-admissibility.js";
import {
  SHADOW_CALLER_DERIVED_FIELDS,
  createJobShadowComparator,
  type ShadowComparisonResult,
} from "../services/job-shadow-comparator.js";
import {
  COMPANY,
  ORG,
  setupJobControlFixture,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";

const RUN_INTEGRATION = process.platform !== "win32" || process.env.AOA_RUN_WIN_INTEGRATION === "1";

const WORKLOAD = {
  command: "claude",
  args: [] as string[],
  maxRuntimeSeconds: 600,
  stdinArtifactId: null,
};
const POLICY = { model: "claude-sonnet", budgetPolicyId: null, effectiveCompletionPolicy: "not_applicable" };

function sinkInput(source: SubmitJobSource, principal: ShadowSinkInput["principal"]): ShadowSinkInput {
  return {
    companyId: COMPANY,
    source,
    principal,
    routing: { executionTargetType: "e2b" },
    policy: POLICY,
    workloadCharacterization: WORKLOAD,
  };
}

describe.skipIf(!RUN_INTEGRATION)("Lane D — shadow evidence over a seeded corpus", () => {
  let fixture: JobControlFixture;
  let setupError: unknown;
  const records: ShadowComparisonResult[] = [];

  beforeAll(async () => {
    try {
      fixture = await setupJobControlFixture("mig-shadow-evidence");
    } catch (error) {
      setupError = error;
      return;
    }
    // The REAL rollout source, driven by the REAL env contract: the deployment flag is
    // read first, and only then the per-Organization map.
    const rolloutSource = createDistributedExecutionRolloutSource({
      AOA_DISTRIBUTED_EXECUTION_ENABLED: "1",
      AOA_DISTRIBUTED_EXECUTION_ROLLOUT: JSON.stringify({
        organizations: { [ORG]: { mode: "shadow", workloads: ["batch"] } },
      }),
    });
    setDistributedShadowPort(
      createDistributedShadowRecorder({
        resolveRolloutState: async () => ({
          state: rolloutSource.resolveRunRolloutState({
            deploymentMode: "cloud_auth",
            organizationId: ORG,
            workloadType: "batch",
          }),
          organizationId: ORG,
        }),
        probe: (input) => probeDistributedAdmissibility(fixture.app.db, input),
        comparator: createJobShadowComparator({ sink: { record: (r) => records.push(r) } }),
      }),
    );
  }, 240_000);

  afterAll(async () => {
    setDistributedShadowPort(null);
    await fixture?.teardown();
  }, 120_000);

  it("boots the fixture (fail closed)", () => {
    if (setupError) throw setupError;
    expect(fixture).toBeDefined();
  });

  it("runs the corpus and states the rate, per sink, with its denominator", async () => {
    records.length = 0;

    // MIG-005 Commander turns. `commander` requester with the founder role is what a
    // real Commander turn presents.
    for (let i = 0; i < 5; i++) {
      await recordDistributedShadow(
        sinkInput(
          {
            kind: "commander_turn",
            internalAgentRunId: `a6000000-0000-4000-8000-00000001000${i}`,
            conversationId: `a6000000-0000-4000-8000-00000002000${i}`,
          },
          { kind: "commander", id: "a6000000-0000-4000-8000-000000000bb1", role: "founder" },
        ),
      );
    }
    // MIG-006 crew dispatches.
    for (let i = 0; i < 5; i++) {
      await recordDistributedShadow(
        sinkInput({ kind: "crew_run", crewRunId: `a6000000-0000-4000-8000-00000003000${i}` }, {
          kind: "local_board",
          id: "a6000000-0000-4000-8000-000000000bb2",
        }),
      );
    }
    // MIG-007 one-shot operations, one of each frozen operation kind.
    for (const [i, kind] of (["extraction", "compaction", "readiness_probe"] as const).entries()) {
      await recordDistributedShadow(
        sinkInput(
          {
            kind: "one_shot",
            operationId: `a6000000-0000-4000-8000-00000004000${i}`,
            operationKind: kind,
          },
          { kind: "system", id: "a6000000-0000-4000-8000-000000000bb3" },
        ),
      );
    }

    expect(records).toHaveLength(13);

    // ── The evidence table ────────────────────────────────────────────────
    const bySink = new Map<string, ShadowComparisonResult[]>();
    for (const record of records) {
      bySink.set(record.sourceKind, [...(bySink.get(record.sourceKind) ?? []), record]);
    }
    const rows = [...bySink.entries()].map(([kind, rs]) => ({
      sink: kind,
      records: rs.length,
      comparedFieldsPerRecord: rs[0]?.comparedFields.length ?? 0,
      uncompared: rs[0]?.uncomparedFields.length ?? 0,
      diverged: rs.filter((r) => r.match === "diverge").length,
      notCompared: rs.filter((r) => r.match === "not_compared").length,
      errored: rs.filter((r) => r.errored).length,
      admissible: rs.filter((r) => r.admissible === true).length,
      refused: rs.filter((r) => r.admissible === false).length,
      undetermined: rs.filter((r) => r.admissible === null).length,
      // "Every divergence explained" has to be answerable FROM the records.
      refusalReasons: [...new Set(rs.filter((r) => r.admissible === false).map((r) => r.admissibilityReason))],
      authoritiesChecked: [...new Set(rs.map((r) => r.admissibilityAuthorities.join("+")))],
    }));
    // Printed so the result doc quotes a produced number rather than a remembered one.
    // eslint-disable-next-line no-console
    console.log("MIG SHADOW EVIDENCE\n" + JSON.stringify(rows, null, 2));

    // Every record carries an explicit denominator, and it is SMALL — one of seven.
    // This is the honest replacement for the old 100% "match" rate.
    for (const record of records) {
      expect(record.comparedFields).toEqual(["workloadType"]);
      expect(record.uncomparedFields).toHaveLength(SHADOW_CALLER_DERIVED_FIELDS.length);
      expect(record.errored).toBe(false);
    }
    // Zero divergences over 13 records on ONE compared field. Stated exactly that way:
    // it is a real measurement of a narrow property, not evidence of equivalence.
    expect(records.filter((r) => r.match === "diverge")).toHaveLength(0);
  });

  it("every one_shot record shows the weaker signal, and the other two do not", async () => {
    // S11 end to end: the asymmetry survives the real probe against a real database,
    // not just the unit fake.
    records.length = 0;
    await recordDistributedShadow(
      sinkInput(
        {
          kind: "one_shot",
          operationId: "a6000000-0000-4000-8000-000000005001",
          operationKind: "extraction",
        },
        { kind: "system", id: "a6000000-0000-4000-8000-000000000bb3" },
      ),
    );
    await recordDistributedShadow(
      sinkInput({ kind: "crew_run", crewRunId: "a6000000-0000-4000-8000-000000005002" }, {
        kind: "local_board",
        id: "a6000000-0000-4000-8000-000000000bb2",
      }),
    );
    // Both were observed; the DIFFERENCE is what the admissibility verdicts say.
    expect(records).toHaveLength(2);
    // one_shot has no per-source authority, so nothing about the operation can refuse it.
    expect(records[0]?.admissible).toBe(true);
    expect(records[0]?.admissibilityAuthorities).toEqual(["admission", "requester_kind"]);
    expect(records[0]?.admissibilityAuthorities).not.toContain("source");
    // crew_run reaches a real authority, and no crew run exists here, so it is refused.
    // A refusal is a DIVERGENCE finding, not an error — the thing Wave 4 needs to know.
    expect(records[1]?.admissible).toBe(false);
    expect(records[1]?.admissibilityAuthorities).toContain("source");
    // And it is EXPLAINED, from the record itself.
    expect(records[1]?.admissibilityReason).toBe("source_not_admitted");
  });

  it("produces nothing at all when the deployment flag is off", async () => {
    // The default-off gate, end to end. If this ever recorded, every deployment that
    // never opted in would be paying for shadow.
    const offRollout = createDistributedExecutionRolloutSource({
      AOA_DISTRIBUTED_EXECUTION_ROLLOUT: JSON.stringify({
        organizations: { [ORG]: { mode: "shadow", workloads: ["batch"] } },
      }),
    });
    const offRecords: ShadowComparisonResult[] = [];
    setDistributedShadowPort(
      createDistributedShadowRecorder({
        resolveRolloutState: async () => ({
          state: offRollout.resolveRunRolloutState({
            deploymentMode: "cloud_auth",
            organizationId: ORG,
            workloadType: "batch",
          }),
          organizationId: ORG,
        }),
        probe: (input) => probeDistributedAdmissibility(fixture.app.db, input),
        comparator: createJobShadowComparator({ sink: { record: (r) => offRecords.push(r) } }),
      }),
    );
    await recordDistributedShadow(
      sinkInput({ kind: "crew_run", crewRunId: "a6000000-0000-4000-8000-000000006001" }, {
        kind: "local_board",
        id: "a6000000-0000-4000-8000-000000000bb2",
      }),
    );
    expect(offRecords).toHaveLength(0);
  });
});
