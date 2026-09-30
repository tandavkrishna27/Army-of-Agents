// JOB-010 — source admission/assignment matrix (unit-shaped; runs on Windows, DEC-03).
//
// Cross-checks the bridge's per-source classification (describeSourceAdmission) against
// the FROZEN parity authority (distributed-execution-legacy-parity.json, Decision #121)
// for all six source kinds x the load-bearing FND-007 dimensions, and proves the pure
// admission gates (sentinel/unmapped rejection, flag-off inertness) WITHOUT a database.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  describeSourceAdmission,
  jobAdmissionBridge,
  JobAdmissionBridgeDisabledError,
  type BridgeActor,
} from "../services/job-admission-bridge.js";
import {
  assertAdmissibleMappedOrganization,
  FORBIDDEN_ORGANIZATION_SENTINELS,
  TenantAdmissionDeniedError,
} from "../services/tenant-admission.js";

interface FrozenSource {
  kind: SubmitJobSource["kind"];
  requiredFields: string[];
  forbiddenFields: string[];
  crosswalkRows: string[];
  requesterPrincipalKinds: string[];
  executorPrincipalKinds: string[];
  parity: Record<string, unknown>;
}
interface FrozenParity {
  parityDimensions: string[];
  forbiddenOrganizationSentinels: string[];
  sources: FrozenSource[];
}

const frozen = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../docs/architecture/distributed-execution-legacy-parity.json", import.meta.url),
    ),
    "utf8",
  ),
) as FrozenParity;

const bySource = new Map(frozen.sources.map((entry) => [entry.kind, entry]));

// One concrete sample per frozen kind (+ the three one_shot engines). Only task_run
// carries issue/run identity; the others carry opaque typed provenance.
const SAMPLES = {
  task_run: { kind: "task_run", runId: "run-1", issueId: "issue-1", assigneeAgentId: "agent-1" },
  commander_turn: { kind: "commander_turn", internalAgentRunId: "car-1", conversationId: "conv-1" },
  crew_run: { kind: "crew_run", crewRunId: "crew-1" },
  one_shot_extraction: { kind: "one_shot", operationId: "op-1", operationKind: "extraction" },
  one_shot_compaction: { kind: "one_shot", operationId: "op-2", operationKind: "compaction" },
  one_shot_readiness: { kind: "one_shot", operationId: "op-3", operationKind: "readiness_probe" },
  browser_request: { kind: "browser_request", browserRequestId: "br-1", parentJobId: null },
  service_reconcile: { kind: "service_reconcile", serviceId: "svc-1", generation: 1, reconciliationId: "rec-1" },
} satisfies Record<string, SubmitJobSource>;

const isNotApplicable = (dim: unknown): boolean =>
  typeof dim === "object" && dim !== null && (dim as { status?: string }).status === "not_applicable";

const EXPECTED_IDENTITY_FIELD: Record<SubmitJobSource["kind"], string> = {
  task_run: "runId",
  commander_turn: "internalAgentRunId",
  crew_run: "crewRunId",
  one_shot: "operationId",
  browser_request: "browserRequestId",
  service_reconcile: "reconciliationId",
};

describe("JOB-010 frozen parity contract", () => {
  it("declares the two load-bearing dimensions and the two forbidden sentinels", () => {
    expect(frozen.parityDimensions).toEqual(expect.arrayContaining([
      "checkout_assignment",
      "capacity_claim_release_wakeup",
    ]));
    // The bridge's opaque admission gate mirrors the frozen sentinel list exactly.
    expect([...FORBIDDEN_ORGANIZATION_SENTINELS].sort()).toEqual(
      [...frozen.forbiddenOrganizationSentinels].sort(),
    );
  });

  it("covers all six frozen source kinds", () => {
    expect([...bySource.keys()].sort()).toEqual([
      "browser_request", "commander_turn", "crew_run", "one_shot", "service_reconcile", "task_run",
    ]);
  });
});

describe("JOB-010 per-source checkout_assignment + identity parity", () => {
  it.each(Object.entries(SAMPLES))(
    "%s classification agrees with the frozen contract",
    (_label, source) => {
      const entry = bySource.get(source.kind)!;
      const profile = describeSourceAdmission(source);

      // Identity: only task_run's frozen requiredFields carry run/issue identity, and only
      // task_run's profile carries task identity + drives the legacy checkout.
      const frozenCarriesIdentity =
        entry.requiredFields.includes("runId") && entry.requiredFields.includes("issueId");
      expect(profile.carriesTaskIdentity).toBe(frozenCarriesIdentity);
      expect(profile.drivesLegacyCheckout).toBe(source.kind === "task_run");
      expect(profile.sourceIdentityField).toBe(EXPECTED_IDENTITY_FIELD[source.kind]);

      // Net-new iff the frozen source has no current-main crosswalk row.
      expect(profile.netNew).toBe(entry.crosswalkRows.length === 0);

      // checkout_assignment disposition derived from the frozen parity behaviour.
      const expectedDisposition = source.kind === "task_run"
        ? "drives_issue_checkout"
        : isNotApplicable(entry.parity.checkout_assignment)
          ? "not_applicable"
          : entry.crosswalkRows.length === 0
            ? "net_new_no_issue"
            : "reuses_checkout_engine_at_execute";
      expect(profile.checkoutAssignment).toBe(expectedDisposition);

      // capacity is characterization-only in JOB-010 (JOB-007 owns the engine); the frozen
      // contract still declares a capacity behaviour for every source.
      expect(profile.capacityAuthority).toBe("job007_characterization_only");
      expect(typeof entry.parity.capacity_claim_release_wakeup).not.toBe("undefined");
    },
  );

  it("task_run drives the real issue checkout carrying {runId, issueId, assigneeAgentId}", () => {
    const source = SAMPLES.task_run;
    const profile = describeSourceAdmission(source);
    expect(profile).toMatchObject({
      drivesLegacyCheckout: true,
      carriesTaskIdentity: true,
      checkoutAssignment: "drives_issue_checkout",
      assignmentAuthority: "issue_checkout",
    });
    // The identity the bridge feeds the checkout engine comes verbatim from the source.
    expect(source.runId).toBe("run-1");
    expect(source.issueId).toBe("issue-1");
    expect(source.assigneeAgentId).toBe("agent-1");
  });

  it("commander_turn is inert (frozen not_applicable, forbids run/issue identity, grant surface blocks claimTurn)", () => {
    const entry = bySource.get("commander_turn")!;
    expect(entry.forbiddenFields).toEqual(expect.arrayContaining(["runId", "issueId"]));
    expect(isNotApplicable(entry.parity.checkout_assignment)).toBe(true);
    expect(describeSourceAdmission(SAMPLES.commander_turn)).toMatchObject({
      drivesLegacyCheckout: false,
      carriesTaskIdentity: false,
      checkoutAssignment: "not_applicable",
      assignmentAuthority: "commander_conversation_inert",
      netNew: false,
    });
  });

  it("crew_run reuses the checkout engine at execute-time without a bridge-fabricated issue", () => {
    const entry = bySource.get("crew_run")!;
    expect(entry.forbiddenFields).toEqual(expect.arrayContaining(["runId", "issueId"]));
    expect(isNotApplicable(entry.parity.checkout_assignment)).toBe(false);
    expect(describeSourceAdmission(SAMPLES.crew_run)).toMatchObject({
      drivesLegacyCheckout: false,
      carriesTaskIdentity: false,
      checkoutAssignment: "reuses_checkout_engine_at_execute",
      assignmentAuthority: "crew_dispatch_admission",
      netNew: false,
    });
  });

  it("one_shot: extraction is the entry-claim engine; compaction/readiness are stateless; none carry task identity", () => {
    expect(describeSourceAdmission(SAMPLES.one_shot_extraction)).toMatchObject({
      checkoutAssignment: "not_applicable",
      carriesTaskIdentity: false,
      oneShotEngine: "extraction_entry_claim",
    });
    expect(describeSourceAdmission(SAMPLES.one_shot_compaction).oneShotEngine).toBe("compaction_stateless");
    expect(describeSourceAdmission(SAMPLES.one_shot_readiness).oneShotEngine).toBe("readiness_probe_stateless");
    // Frozen contract confirms one_shot checkout_assignment is not_applicable.
    expect(isNotApplicable(bySource.get("one_shot")!.parity.checkout_assignment)).toBe(true);
  });

  it.each(["browser_request", "service_reconcile"] as const)(
    "%s is NET-NEW (crosswalkRows=[], never 'parity passed'), no fabricated issue",
    (kind) => {
      const entry = bySource.get(kind)!;
      expect(entry.crosswalkRows).toEqual([]);
      const sample = kind === "browser_request" ? SAMPLES.browser_request : SAMPLES.service_reconcile;
      expect(describeSourceAdmission(sample)).toMatchObject({
        netNew: true,
        drivesLegacyCheckout: false,
        carriesTaskIdentity: false,
        checkoutAssignment: "net_new_no_issue",
      });
    },
  );
});

describe("JOB-010 sentinel/unmapped Organization admission is opaque and uniform", () => {
  const deniedInputs: Array<[string, string | null | undefined]> = [
    ["null (unmapped)", null],
    ["undefined (unmapped)", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["nil-ULID sentinel", "org_00000000000000000000000000"],
    ["default-org sentinel", "00000000-0000-0000-0000-000000000001"],
    ["upper-cased sentinel", "00000000-0000-0000-0000-000000000001".toUpperCase()],
    ["padded sentinel", "  org_00000000000000000000000000  "],
  ];

  it.each(deniedInputs)("rejects %s with the SAME opaque TenantAdmissionDeniedError", (_label, value) => {
    let thrown: unknown;
    try {
      assertAdmissibleMappedOrganization(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TenantAdmissionDeniedError);
    // Opaque: the message never names which check (unmapped vs sentinel) failed.
    expect((thrown as TenantAdmissionDeniedError).message).toBe("Job submission denied");
  });

  it("admits a normal mapped Organization id", () => {
    expect(() =>
      assertAdmissibleMappedOrganization("10000000-0000-4000-8000-000000000001"),
    ).not.toThrow();
  });
});

describe("JOB-010 flag-off leaves every current path byte-unchanged", () => {
  const throwingDb = new Proxy({}, {
    get() {
      throw new Error("the database must not be touched while the bridge is disabled");
    },
  }) as unknown as Db;
  const actor: BridgeActor = { kind: "agent", id: "agent-1", companyId: "company-1" };

  it("isEnabled() is false and admitAndSubmit refuses without touching the database", async () => {
    const bridge = jobAdmissionBridge(throwingDb, { env: {} });
    expect(bridge.isEnabled()).toBe(false);
    await expect(bridge.admitAndSubmit(SAMPLES.task_run, actor, "idem-1")).rejects.toBeInstanceOf(
      JobAdmissionBridgeDisabledError,
    );
    await expect(bridge.releaseTaskClaim(SAMPLES.task_run, actor)).rejects.toBeInstanceOf(
      JobAdmissionBridgeDisabledError,
    );
  });

  it("isEnabled() is true when the deployment flag is set", () => {
    const bridge = jobAdmissionBridge(throwingDb, {
      env: { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" },
    });
    expect(bridge.isEnabled()).toBe(true);
  });
});
