// -----------------------------------------------------------------------------
// SVC-007 (Unit B) — the durable audit for a service control action, purely.
//
// ★★★ WHAT THIS SUITE IS ACTUALLY ABOUT. `SVC-007a-result.md` §4a(iii)/§7 declined an
// `activity_log` row for these routes and gave a MECHANICAL reason: the shipped
// distributed-execution audit path is `jobAuditBridge.recordAcceptedActivity`, that function's
// input type requires `fence: ActiveFenceRequest`, a service create has no attempt and a
// desired-state change has no fence — so, it concluded, "that bridge is structurally unusable
// here" and AGENTS.md's "activity logging for all mutating actions" invariant was "NOT met by
// these routes".
//
// The first half is true and is re-verified at source in `service-control-audit.ts`'s header.
// The SECOND half — that the table is therefore unwritable from here — is measured false, and
// this suite is the executable form of that measurement. See `E9-F010`.
//
// ★ EVERY CASE NAMES THE MUTANT THAT MUST RE-RED IT. A test nobody watched go red is a test
// that measures nothing, and the mutants are listed in `SVC-007b-result.md` with their counts.
//
// ★ WHAT IS REAL HERE AND WHAT IS NOT, said before the first assertion. REAL: the shipped
// `insertActivity` -> `insertActivityLog` chain, including `assertUnreservedActivityNamespace`
// and `sanitizeRecord`, and the shipped `setServiceDesiredStateWithinTenant` decision path.
// NOT REAL: the database. The transaction handle is a recorder, so what this file proves is
// WHICH rows are prepared and with what content — NOT that they commit atomically with the
// mutation. That property needs a real transaction and is pinned by T1/T13/T14-T18 in
// `service-management.integration.test.ts`.
// -----------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

import {
  SERVICE_AUDIT_ENTITY_TYPE,
  SERVICE_CREATE_ACTION,
  SERVICE_DESIRED_STATE_ACTION,
  publishServiceControlActivity,
  recordServiceCreateActivity,
  recordServiceDesiredStateActivity,
} from "../services/service-control-audit.js";
import { setServiceDesiredStateWithinTenant } from "../services/service-management.js";
import { insertActivity } from "../services/activity-log.js";
import type { PreparedActivityEvent } from "../services/activity-log.js";
import { SECURITY_DENIAL_ACTION_PREFIX } from "../services/activity-namespace.js";

const ORG = "c1000000-0000-4000-8000-000000000001";
const COMPANY = "c1000000-0000-4000-8000-000000000002";
const SERVICE = "c1000000-0000-4000-8000-000000000003";
const ACTOR = { actorType: "user" as const, actorId: "c1000000-0000-4000-8000-0000000000aa" };

interface RecordedRow {
  companyId: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
}

/**
 * A transaction handle that records instead of writing.
 *
 * It implements exactly the chain `insertActivityLog` uses —
 * `insert(table).values(row).returning(cols)` — and nothing else, so a future writer that
 * reaches the database a different way does not silently pass through it.
 */
function recordingTx() {
  const rows: RecordedRow[] = [];
  const tx = {
    insert() {
      return {
        values(values: RecordedRow) {
          return {
            async returning() {
              rows.push(values);
              return [{ id: `activity-${rows.length}` }];
            },
          };
        },
      };
    },
  };
  return { tx: tx as never, rows };
}

function auditContext() {
  const { tx, rows } = recordingTx();
  const published: PreparedActivityEvent[] = [];
  return { tx, rows, published, actor: ACTOR, ctx: { tx, actor: ACTOR, published } };
}

/** The stub repository shape SVC-007a's own pure suite uses, kept deliberately identical. */
interface StubOptions {
  service: { desiredState: string; generation: number } | null;
  updateReturns?: { desiredState: string; generation: number } | null;
  instance?: { serviceInstanceId: string; status: string; jobId: string | null } | null;
  cancellation?: { status: string };
  terminalize?: { outcome: string };
}

function stubRepos(input: StubOptions) {
  return {
    jobControl: {
      async lockServiceForReconcile() {
        return input.service;
      },
      async updateServiceDesiredState(values: { desiredState: string }) {
        return input.updateReturns === undefined
          ? { desiredState: values.desiredState, generation: input.service?.generation ?? 1 }
          : input.updateReturns;
      },
      async findLiveServiceInstance() {
        return input.instance ?? null;
      },
      async currentDatabaseTime() {
        return new Date("2026-09-10T12:00:00.000Z");
      },
      async requestCancellation() {
        return input.cancellation ?? { status: "cancelled", command: null };
      },
      async terminalizeServiceInstanceForCancelledAttempt() {
        return input.terminalize ?? { outcome: "applied" };
      },
    },
  } as never;
}

describe("SVC-007 Unit B — the audit row a service control action writes", () => {
  // MUTANT: pass a `runId` through instead of forcing null.
  //
  // ★ THIS IS NOT A STYLE ASSERTION. `activity_log.run_id` FKs `heartbeat_runs`, and the two
  // ids in scope on a service control path (a job id, a distributed attempt id) are neither.
  // A passed-through id would raise 23503 and roll the MUTATION back with it — the audit would
  // not merely be wrong, it would delete the create.
  it("B1 — a create audit is one row, on the service, with run_id and agent_id forced null", async () => {
    const a = auditContext();
    const event = await recordServiceCreateActivity(a.tx, {
      actor: ACTOR,
      companyId: COMPANY,
      organizationId: ORG,
      serviceId: SERVICE,
      generation: 1,
      desiredState: "running",
    });

    expect(a.rows).toHaveLength(1);
    const row = a.rows[0]!;
    expect(row.action).toBe(SERVICE_CREATE_ACTION);
    expect(row.entityType).toBe(SERVICE_AUDIT_ENTITY_TYPE);
    expect(row.entityId, "the row must be findable by service id").toBe(SERVICE);
    expect(row.companyId).toBe(COMPANY);
    expect(row.actorType).toBe("user");
    expect(row.actorId).toBe(ACTOR.actorId);
    expect(row.runId, "run_id FKs heartbeat_runs; a service control has no heartbeat run").toBeNull();
    expect(row.agentId, "a service control is an operator act, not an agent's").toBeNull();
    expect(row.details).toMatchObject({ organizationId: ORG, serviceId: SERVICE, generation: 1, desiredState: "running" });
    expect(event.id, "the prepared event carries the inserted row id for the after-commit publish").toBe("activity-1");
  });

  // MUTANT: omit `reason` from the desired-state details.
  //
  // This is the half of external review's P1 that SVC-007a fixed only for the process log: the
  // route REQUIRES a reason, and before this unit a resume put it nowhere durable.
  it("B2 — a desired-state audit carries the transition, the stop outcome AND the operator's reason", async () => {
    const a = auditContext();
    await recordServiceDesiredStateActivity(a.tx, {
      actor: ACTOR,
      companyId: COMPANY,
      organizationId: ORG,
      serviceId: SERVICE,
      outcome: "updated",
      from: "running",
      to: "stopped",
      generation: 3,
      reason: "budget freeze for Q4",
      stopStatus: "requested",
      stopInstance: "applied",
    });

    expect(a.rows).toHaveLength(1);
    const row = a.rows[0]!;
    expect(row.action).toBe(SERVICE_DESIRED_STATE_ACTION);
    expect(row.details).toEqual({
      organizationId: ORG,
      serviceId: SERVICE,
      outcome: "updated",
      from: "running",
      to: "stopped",
      generation: 3,
      reason: "budget freeze for Q4",
      stopStatus: "requested",
      stopInstance: "applied",
    });
  });

  // MUTANT: omit the `from` key entirely on `unchanged` rather than writing null.
  it("B3 — an `unchanged` control records `from: null` rather than an absent key", async () => {
    const a = auditContext();
    await recordServiceDesiredStateActivity(a.tx, {
      actor: ACTOR,
      companyId: COMPANY,
      organizationId: ORG,
      serviceId: SERVICE,
      outcome: "unchanged",
      to: "stopped",
      generation: 3,
      reason: "re-issued stop",
      stopStatus: "no_instance",
      stopInstance: null,
    });
    const details = a.rows[0]!.details as Record<string, unknown>;
    expect(Object.keys(details), "a reader must not have to know which verdicts carry `from`").toContain("from");
    expect(details.from).toBeNull();
  });

  // MUTANT: hard-code an action inside the reserved `security.denied.` namespace.
  //
  // ★ ANTI-VACUITY. The first two assertions alone would pass if the guard did nothing, so the
  // third drives a reserved action through the SAME `insertActivity` chain and requires it to
  // throw. Without it, "the namespace guard covers these writes" would be untested.
  it("B4 — both audited actions clear the reserved namespaces, and the guard that clears them bites", async () => {
    expect(SERVICE_CREATE_ACTION).toBe("service.create");
    expect(SERVICE_DESIRED_STATE_ACTION).toBe("service.desired_state");
    expect(SERVICE_CREATE_ACTION).not.toBe(SERVICE_DESIRED_STATE_ACTION);
    for (const action of [SERVICE_CREATE_ACTION, SERVICE_DESIRED_STATE_ACTION]) {
      expect(action.startsWith(SECURITY_DENIAL_ACTION_PREFIX), action).toBe(false);
    }

    const a = auditContext();
    await expect(insertActivity(a.tx, {
      companyId: COMPANY,
      actorType: "user",
      actorId: ACTOR.actorId,
      action: `${SECURITY_DENIAL_ACTION_PREFIX}service_control`,
      entityType: SERVICE_AUDIT_ENTITY_TYPE,
      entityId: SERVICE,
    })).rejects.toThrow(/reserved/i);
    expect(a.rows, "the refused write must not have reached the table").toEqual([]);
  });

  // MUTANT: publish inside `recordService*Activity` instead of returning the prepared event.
  //
  // A pre-commit poke announces a mutation a later rollback un-does. The event is RETURNED and
  // pushed onto the caller's sink; `publishServiceControlActivity` is a separate, exported
  // function precisely so the transaction's owner decides when it runs.
  it("B5 — recording prepares an event and publishes nothing; publishing is a separate call", async () => {
    const live = await import("../services/live-events.js");
    const spy = vi.spyOn(live, "publishLiveEvent").mockImplementation(() => {});
    try {
      const a = auditContext();
      const event = await recordServiceCreateActivity(a.tx, {
        actor: ACTOR, companyId: COMPANY, organizationId: ORG,
        serviceId: SERVICE, generation: 1, desiredState: "running",
      });
      expect(spy, "recording must not poke the live channel").not.toHaveBeenCalled();

      publishServiceControlActivity([event]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({ companyId: COMPANY, type: "activity.logged" });
    } finally {
      spy.mockRestore();
    }
  });

  // MUTANT: drop the try/catch in `publishServiceControlActivity`.
  //
  // The row is already durable when this runs. A live-channel poke that throws must never turn
  // a committed control action into a 500.
  it("B6 — a throwing live poke does not propagate out of the after-commit drain", async () => {
    const live = await import("../services/live-events.js");
    const spy = vi.spyOn(live, "publishLiveEvent").mockImplementation(() => {
      throw new Error("live channel down");
    });
    try {
      const a = auditContext();
      const event = await recordServiceCreateActivity(a.tx, {
        actor: ACTOR, companyId: COMPANY, organizationId: ORG,
        serviceId: SERVICE, generation: 1, desiredState: "running",
      });
      expect(() => publishServiceControlActivity([event])).not.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("SVC-007 Unit B — WHICH verdicts of the desired-state control are audited", () => {
  // MUTANT: audit unconditionally, on every verdict.
  it("B7 — an `updated` verdict writes exactly one audit row, carrying the stop outcome", async () => {
    const a = auditContext();
    const result = await setServiceDesiredStateWithinTenant(
      stubRepos({
        service: { desiredState: "running", generation: 2 },
        instance: { serviceInstanceId: "i1", status: "pending", jobId: "j1" },
      }),
      { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE, desiredState: "stopped", reason: "operator stop" },
      a.ctx,
    );
    expect(result.verdict.outcome).toBe("updated");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.details).toMatchObject({
      outcome: "updated", from: "running", to: "stopped", generation: 2,
      reason: "operator stop", stopStatus: "requested", stopInstance: "applied",
    });
    expect(a.published, "the event must reach the caller's after-commit sink").toHaveLength(1);
  });

  // MUTANT: skip the audit on `unchanged` because it "changed nothing".
  //
  // ★ IT IS NOT A NO-OP. The stop still runs on `unchanged` — a reconcile pass that began
  // before an earlier stop can commit an instance after that stop moved the column — so an
  // `unchanged` control action can cancel a job and terminalize an instance. Treating it as
  // nothing would leave that act unrecorded.
  it("B8 — an `unchanged` verdict that still cancels a live instance IS audited", async () => {
    const a = auditContext();
    const result = await setServiceDesiredStateWithinTenant(
      stubRepos({
        service: { desiredState: "stopped", generation: 5 },
        instance: { serviceInstanceId: "i2", status: "pending", jobId: "j2" },
      }),
      { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE, desiredState: "stopped", reason: "re-issue" },
      a.ctx,
    );
    expect(result.verdict.outcome).toBe("unchanged");
    expect(result.stop?.status, "the re-issued stop must actually have run").toBe("requested");
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.details).toMatchObject({ outcome: "unchanged", from: null, to: "stopped", generation: 5 });
  });

  // MUTANT: audit before the verdict is known, or on every exit.
  //
  // Three refusals, driven through the shipped decision path rather than asserted about it.
  // `absent` is the one that would matter most: the route answers a UNIFORM 404 so a caller
  // cannot distinguish "no such service" from "another tenant's service", and an audit row
  // written on that path would be a record of a mutation that did not happen.
  it("B9 — `illegal`, `conflict` and `absent` write NO audit row", async () => {
    const illegal = auditContext();
    const illegalResult = await setServiceDesiredStateWithinTenant(
      stubRepos({ service: { desiredState: "deleted", generation: 1 } }),
      { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE, desiredState: "running", reason: "r" },
      illegal.ctx,
    );
    expect(illegalResult.verdict.outcome).toBe("illegal");
    expect(illegal.rows).toEqual([]);
    expect(illegal.published).toEqual([]);

    const conflict = auditContext();
    const conflictResult = await setServiceDesiredStateWithinTenant(
      stubRepos({ service: { desiredState: "running", generation: 1 }, updateReturns: null }),
      { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE, desiredState: "stopped", reason: "r" },
      conflict.ctx,
    );
    expect(conflictResult.verdict.outcome).toBe("conflict");
    expect(conflict.rows).toEqual([]);

    const absent = auditContext();
    const absentResult = await setServiceDesiredStateWithinTenant(
      stubRepos({ service: null }),
      { organizationId: ORG, companyId: COMPANY, serviceId: SERVICE, desiredState: "stopped", reason: "r" },
      absent.ctx,
    );
    expect(absentResult.verdict.outcome).toBe("absent");
    expect(absent.rows, "a uniform 404 must not leave a mutation record behind").toEqual([]);
  });

  // MUTANT: pass the operator's reason straight to `insert` rather than through
  // `insertActivityLog`, bypassing `sanitizeRecord`.
  //
  // ★ A `reason` IS FREE-FORM OPERATOR TEXT and the body schema admits 1000 characters of it,
  // so it can carry a pasted token. The shipped redactor is the reason this row is safe to
  // keep; this case pins that the redactor is actually in the path.
  it("B10 — a secret-looking reason is redacted by the shipped sanitizer before it lands", async () => {
    const a = auditContext();
    await recordServiceDesiredStateActivity(a.tx, {
      actor: ACTOR, companyId: COMPANY, organizationId: ORG, serviceId: SERVICE,
      outcome: "updated", from: "running", to: "stopped", generation: 1,
      reason: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      stopStatus: null, stopInstance: null,
    });
    const details = a.rows[0]!.details as Record<string, unknown>;
    expect(details.reason, "the raw token must not be durable").not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });
});
