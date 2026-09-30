// JOB-011 — source governance matrix (unit-shaped; runs on Windows, DEC-03).
//
// Cross-checks the bridge's per-source classification (describeSourceGovernance)
// against the FROZEN parity authority (distributed-execution-legacy-parity.json,
// Decision #121) for the `product_runtime_approval` dimension across all six source
// kinds, and proves the flag-off inertness of every entrypoint WITHOUT a database.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@armyofagents/db";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  describeSourceGovernance,
  jobApprovalBridge,
  JobApprovalBridgeDisabledError,
  type BridgeActor,
} from "../services/job-approval-bridge.js";

interface FrozenSource {
  kind: SubmitJobSource["kind"];
  crosswalkRows: string[];
  parity: Record<string, unknown>;
}
interface FrozenParity {
  parityDimensions: string[];
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

const SAMPLES = {
  task_run: { kind: "task_run", runId: "run-1", issueId: "issue-1", assigneeAgentId: "agent-1" },
  commander_turn: { kind: "commander_turn", internalAgentRunId: "car-1", conversationId: "conv-1" },
  crew_run: { kind: "crew_run", crewRunId: "crew-1" },
  one_shot: { kind: "one_shot", operationId: "op-1", operationKind: "extraction" },
  browser_request: { kind: "browser_request", browserRequestId: "br-1", parentJobId: null },
  service_reconcile: { kind: "service_reconcile", serviceId: "svc-1", generation: 1, reconciliationId: "rec-1" },
} satisfies Record<string, SubmitJobSource>;

const isNotApplicable = (dim: unknown): boolean =>
  typeof dim === "object" && dim !== null && (dim as { status?: string }).status === "not_applicable";

describe("JOB-011 frozen parity contract", () => {
  it("declares product_runtime_approval as a parity dimension and covers all six kinds", () => {
    expect(frozen.parityDimensions).toEqual(expect.arrayContaining(["product_runtime_approval"]));
    expect([...bySource.keys()].sort()).toEqual([
      "browser_request", "commander_turn", "crew_run", "one_shot", "service_reconcile", "task_run",
    ]);
  });
});

describe("JOB-011 per-source governance classification agrees with the frozen contract", () => {
  it("task_run drives a runtime decision (ask_human/work_question) + completion policy", () => {
    const entry = bySource.get("task_run")!;
    // Frozen: runtime decisions surface through ask_human / work_questions.
    expect(isNotApplicable(entry.parity.product_runtime_approval)).toBe(false);
    expect(describeSourceGovernance(SAMPLES.task_run)).toMatchObject({
      productApprovalAuthority: "none",
      runtimeDecisionAuthority: "ask_human_work_question",
      completionAuthority: "effective_completion_policy",
      disposition: "drive_in_tenant_tx",
      aggregateKind: "agent_runtime_decisions",
      projectionKind: "runtime_decision",
      mintsAggregate: true,
    });
  });

  it("crew_run drives the crew_dispatch PRODUCT approval + completion policy", () => {
    const entry = bySource.get("crew_run")!;
    expect(isNotApplicable(entry.parity.product_runtime_approval)).toBe(false);
    expect(String(entry.parity.product_runtime_approval)).toMatch(/crew_dispatch/i);
    expect(describeSourceGovernance(SAMPLES.crew_run)).toMatchObject({
      productApprovalAuthority: "crew_dispatch_approval",
      runtimeDecisionAuthority: "none",
      completionAuthority: "effective_completion_policy",
      disposition: "drive_in_tenant_tx",
      aggregateKind: "approvals",
      projectionKind: "product_approval",
      mintsAggregate: true,
    });
  });

  it("browser_request drives a download/egress PERMISSION decision (net-new, no completion)", () => {
    const entry = bySource.get("browser_request")!;
    expect(entry.crosswalkRows).toEqual([]);
    expect(String(entry.parity.product_runtime_approval)).toMatch(/download|egress|approval/i);
    expect(describeSourceGovernance(SAMPLES.browser_request)).toMatchObject({
      productApprovalAuthority: "none",
      runtimeDecisionAuthority: "permission_download_egress",
      completionAuthority: "none",
      disposition: "drive_in_tenant_tx",
      aggregateKind: "agent_runtime_decisions",
      projectionKind: "runtime_decision",
      mintsAggregate: true,
    });
  });

  it("commander_turn is INERT/shadow (Commander runtime-approval policy, never driven in-tx)", () => {
    const entry = bySource.get("commander_turn")!;
    expect(isNotApplicable(entry.parity.product_runtime_approval)).toBe(false);
    expect(describeSourceGovernance(SAMPLES.commander_turn)).toMatchObject({
      productApprovalAuthority: "commander_runtime_approval",
      runtimeDecisionAuthority: "none",
      completionAuthority: "none",
      disposition: "inert_shadow",
      aggregateKind: "internal_agent_runtime_approvals",
      projectionKind: null,
      mintsAggregate: false,
    });
  });

  it.each(["one_shot", "service_reconcile"] as const)(
    "%s is product_runtime_approval NOT_APPLICABLE — JOB-011 mints nothing",
    (kind) => {
      const entry = bySource.get(kind)!;
      // The frozen contract declares this source's product_runtime_approval not_applicable.
      expect(isNotApplicable(entry.parity.product_runtime_approval)).toBe(true);
      const profile = describeSourceGovernance(SAMPLES[kind]);
      expect(profile.disposition).toBe("not_applicable");
      expect(profile.mintsAggregate).toBe(false);
      expect(profile.aggregateKind).toBeNull();
      expect(profile.projectionKind).toBeNull();
      expect(profile.productApprovalAuthority).toBe("not_applicable");
    },
  );

  it("only task_run, crew_run, and browser_request mint an aggregate", () => {
    const minting = (Object.keys(SAMPLES) as Array<keyof typeof SAMPLES>)
      .filter((k) => describeSourceGovernance(SAMPLES[k]).mintsAggregate)
      .sort();
    expect(minting).toEqual(["browser_request", "crew_run", "task_run"]);
  });
});

describe("JOB-011 worker-cannot-create/approve/override is structural", () => {
  it("no worker route reaches the approval bridge (server-only control-plane module)", () => {
    const workerControl = readFileSync(
      fileURLToPath(new URL("../routes/worker-control.ts", import.meta.url)),
      "utf8",
    );
    // The bridge is invoked from dispatch/projection paths only; the worker's enroll /
    // poll / lease-ack / renew / events / control-ack routes never mint or flip a
    // governance aggregate. A worker only ACKs an already-server-authored control.
    expect(workerControl).not.toMatch(/job-approval-bridge|jobApprovalBridge|openGovernedDecision|resolveGovernedDecision/);
  });

  it("the bridge surface exposes no worker-facing create/approve entrypoint", () => {
    const bridge = jobApprovalBridge({} as unknown as Db, { env: {} });
    // The ONLY entrypoints are the control-plane open/resolve/park + the flag probe —
    // there is no `workerCreate`, `workerApprove`, or `override` on the surface.
    expect(Object.keys(bridge).sort()).toEqual(
      ["isEnabled", "openGovernedDecision", "parkRun", "resolveGovernedDecision"],
    );
  });
});

describe("JOB-011 flag-off leaves every current path byte-unchanged", () => {
  const throwingDb = new Proxy({}, {
    get() {
      throw new Error("the database must not be touched while the bridge is disabled");
    },
  }) as unknown as Db;
  const actor: BridgeActor = { kind: "agent", id: "agent-1", companyId: "company-1" };
  const fence = {
    organizationId: "org-1", companyId: "company-1", jobId: "job-1", attemptId: "att-1",
    attemptNumber: 1, leaseId: "lease-1", workerId: "worker-1", targetId: "target-1",
    targetAuthorityKey: "tak-1", targetGeneration: 1, profileHash: "ph", providerConstraintHash: "pch", fence: "fence-1",
  };

  it("isEnabled() is false and every entrypoint refuses without touching the database", async () => {
    const bridge = jobApprovalBridge(throwingDb, { env: {} });
    expect(bridge.isEnabled()).toBe(false);
    await expect(
      bridge.openGovernedDecision({ source: SAMPLES.task_run, actor, fence, idempotencyKey: "idem-1" }),
    ).rejects.toBeInstanceOf(JobApprovalBridgeDisabledError);
    await expect(
      bridge.resolveGovernedDecision({ source: SAMPLES.crew_run, actor, fence, idempotencyKey: "idem-1" }),
    ).rejects.toBeInstanceOf(JobApprovalBridgeDisabledError);
    await expect(
      bridge.parkRun({ actor, jobId: "job-1", reason: "park", graceful: true, commandId: "cmd-1" }),
    ).rejects.toBeInstanceOf(JobApprovalBridgeDisabledError);
  });

  it("isEnabled() is true when the deployment flag is set", () => {
    const bridge = jobApprovalBridge(throwingDb, {
      env: { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" },
    });
    expect(bridge.isEnabled()).toBe(true);
  });
});
