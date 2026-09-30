// CLI-006 (Task 4) — cancel routing for distributed-owned runs (R3).
//
// Today cancel is a lie for these runs. Every writer's only stop mechanism is
// `runningProcesses.get(run.id)`, which a distributed attempt never populates,
// and `grep requestCancellation server/src/services/heartbeat.ts` returns zero
// hits. Worse, the writer latches the run `cancelled`, so the projector's later
// terminal is discarded and the distributed evidence is lost.
//
// This file covers the two pieces that must exist BEFORE any writer is touched:
// the routing decision, and the port that carries the fence-revoking call.
//
// The port is module-level, not constructor-injected, and that is load-bearing.
// `cancelRun`'s three non-test callers all hold a bare `heartbeatService(db)`
// (agents.ts:198, issues.ts:99, index.ts:1828); only the scheduler instance
// receives options. A port on the constructor would be `undefined` at every real
// cancel — wired-looking, typechecking, and never firing. That is the Task 2a
// defect shape, and instance-independence is the property that fixes it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchCancel,
  resolveCancelRoute,
  setDistributedCancellationPort,
  getDistributedCancellationPort,
  type DistributedCancellationPort,
} from "../services/distributed-cancellation-port.js";

const JOB = "10b10b10-10b1-4b10-8b10-10b10b10b10b";

const distributedRun = {
  executionOwner: "distributed" as string | null,
  distributedJobId: JOB as string | null,
};

const port: DistributedCancellationPort = {
  // `queued` = a fenced worker will deliver the terminal event (see H1).
  requestCancellation: async () => ({ status: "queued" }),
};

beforeEach(() => {
  setDistributedCancellationPort(undefined);
});

describe("CLI-006/Task 4 — resolveCancelRoute", () => {
  it("routes a distributed-owned run to the fence-revoking cancel", () => {
    expect(resolveCancelRoute(distributedRun, port)).toEqual({
      route: "distributed",
      jobId: JOB,
    });
  });

  it("routes a legacy run to the legacy writer — the common case", () => {
    expect(
      resolveCancelRoute({ executionOwner: null, distributedJobId: null }, port),
    ).toEqual({ route: "legacy" });
  });

  it("falls through to LEGACY when no port is registered, and says why", () => {
    // A control-plane restart with the distributed flag off leaves marked runs
    // behind and no port. Refusing to terminalize would strand them forever;
    // with the subsystem disabled no worker will ever terminalize that attempt,
    // so the legacy write is the only convergent outcome. Deliberately the
    // OPPOSITE direction from the seam's fail-safe: suppression must never
    // strand a run, cancel must never leave one unkillable.
    expect(resolveCancelRoute(distributedRun, undefined)).toEqual({
      route: "legacy",
      degraded: "no_distributed_cancellation_port",
    });
  });

  it("falls through to LEGACY when the marker is present but the job id is not", () => {
    // Nothing to revoke a fence against. A half-written marker must not make a
    // run unkillable.
    expect(
      resolveCancelRoute({ executionOwner: "distributed", distributedJobId: null }, port),
    ).toEqual({ route: "legacy", degraded: "missing_distributed_job_id" });
  });

  it("does NOT route on an unrecognised owner value", () => {
    // Forward-compat: a future owner kind this build does not understand must
    // read as legacy, not as distributed.
    expect(
      resolveCancelRoute({ executionOwner: "owner_desktop", distributedJobId: JOB }, port),
    ).toEqual({ route: "legacy" });
  });
});

describe("CLI-006/Task 4 — the module-level port", () => {
  it("is absent until registered", () => {
    expect(getDistributedCancellationPort()).toBeUndefined();
  });

  it("is readable from a caller holding no service instance at all", () => {
    // The whole point: every real cancelRun caller builds heartbeatService(db)
    // with no options, so the port must not travel through an instance.
    setDistributedCancellationPort(port);
    expect(getDistributedCancellationPort()).toBe(port);
  });

  it("can be cleared, so a test or a reload cannot leak one deployment's port", () => {
    setDistributedCancellationPort(port);
    setDistributedCancellationPort(undefined);
    expect(getDistributedCancellationPort()).toBeUndefined();
  });

  it("carries the graceful flag and the reason through to the fence revoke", async () => {
    const requestCancellation = vi.fn(async () => ({ status: "queued" }));
    setDistributedCancellationPort({ requestCancellation });
    await getDistributedCancellationPort()!.requestCancellation({
      jobId: JOB,
      companyId: "c",
      reason: "Cancelled by control plane",
      graceful: true,
    });
    expect(requestCancellation).toHaveBeenCalledWith({
      jobId: JOB,
      companyId: "c",
      reason: "Cancelled by control plane",
      graceful: true,
    });
  });
});

// -- 4-D1: a THROWING port is not the same failure as a MISSING one -----------
//
// A missing port falls through to the legacy write, because with the subsystem
// disabled no worker will ever terminalize that attempt. That reasoning does NOT
// transfer to a port that throws: there the subsystem is ENABLED and the worker
// is LIVE, so writing `cancelled` locally would claim a stop that did not happen,
// latch the run, and make the projector discard the attempt's real terminal. The
// run would read cancelled in the UI while the sandbox kept burning budget.

const RUN_CTX = { companyId: "c", reason: "stop", graceful: true };

describe("CLI-006/4-D1 — dispatchCancel", () => {
  it("tells a legacy run's caller to write the terminal itself", async () => {
    await expect(
      dispatchCancel({
        run: { executionOwner: null, distributedJobId: null },
        ...RUN_CTX,
        port,
        onError: "propagate",
      }),
    ).resolves.toEqual({ writeLegacyTerminal: true });
  });

  it("revokes the fence and tells the caller NOT to write a terminal", async () => {
    const requestCancellation = vi.fn(async () => ({ status: "queued" }));
    await expect(
      dispatchCancel({ run: distributedRun, ...RUN_CTX, port: { requestCancellation }, onError: "propagate" }),
    ).resolves.toEqual({ writeLegacyTerminal: false });
    expect(requestCancellation).toHaveBeenCalledWith({
      jobId: JOB,
      companyId: "c",
      reason: "stop",
      graceful: true,
    });
  });

  it("falls through to the legacy write when no port is registered", async () => {
    await expect(
      dispatchCancel({ run: distributedRun, ...RUN_CTX, port: undefined, onError: "propagate" }),
    ).resolves.toEqual({ writeLegacyTerminal: true, degraded: "no_distributed_cancellation_port" });
  });

  it("PROPAGATES a port throw for cancelRun — an operator must not see a false success", async () => {
    const boom = { requestCancellation: async () => { throw new Error("unreachable"); } };
    await expect(
      dispatchCancel({ run: distributedRun, ...RUN_CTX, port: boom, onError: "propagate" }),
    ).rejects.toThrow(/unreachable/);
  });

  it("SKIPS a port throw for a batch, and still writes NO terminal", async () => {
    // One unreachable attempt must not abort a company-wide budget hard-stop for
    // every other run. But the skipped run must stay `running`, not be latched
    // cancelled — the worker is still live.
    const boom = { requestCancellation: async () => { throw new Error("unreachable"); } };
    await expect(
      dispatchCancel({ run: distributedRun, ...RUN_CTX, port: boom, onError: "skip" }),
    ).resolves.toEqual({ writeLegacyTerminal: false, degraded: "cancellation_request_failed" });
  });

  it("never writes a terminal on a throw, under EITHER error mode", async () => {
    // The single property that matters most in this file: a live worker plus a
    // locally-latched `cancelled` is the one outcome that silently lies.
    const boom = { requestCancellation: async () => { throw new Error("unreachable"); } };
    const skipped = await dispatchCancel({ run: distributedRun, ...RUN_CTX, port: boom, onError: "skip" });
    expect(skipped.writeLegacyTerminal).toBe(false);
    await expect(
      dispatchCancel({ run: distributedRun, ...RUN_CTX, port: boom, onError: "propagate" }),
    ).rejects.toThrow();
  });
});

// -- the wiring, asserted structurally -------------------------------------------
//
// The five writers live inside a service closure and inside a database
// transaction, so neither is reachable from an in-process unit test. What CAN be
// proven — and mutation-proven — is that each writer actually consults the
// routing, and that the bulk SQL carries its exclusion predicate. Per the CLI-002
// lesson: a mocked DB never executes a WHERE, so assert the predicate's presence
// rather than pretending to exercise it.

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("CLI-006/Task 4 — every heartbeat cancel writer consults the routing", () => {
  const heartbeat = src("../services/heartbeat.ts");

  it("routes all FOUR writers", () => {
    // cancelRun, cancelActiveForAgent, and both cancelBudgetScopeWork scopes.
    const calls = heartbeat.match(/routeRunCancellation\(run,/g) ?? [];
    expect(calls).toHaveLength(4);
  });

  it("propagates for cancelRun and skips for the three batch writers", () => {
    expect(heartbeat).toContain('onError: "propagate"');
    expect((heartbeat.match(/onError: "skip"/g) ?? []).length).toBe(3);
  });

  it("reads the port from module scope, never from a service option", () => {
    // A constructor option would be undefined at every real cancel — the three
    // callers all hold a bare heartbeatService(db).
    expect(heartbeat).toContain("port: getDistributedCancellationPort()");
    expect(heartbeat).not.toMatch(/distributedCancellation\??\.\s*requestCancellation/);
  });
});

describe("CLI-006/4-D2 — the bulk writer excludes distributed runs in SQL", () => {
  const issues = src("../services/issues.ts");

  it("carries the exclusion predicate on the bulk terminal update", () => {
    // This update bypasses setRunStatus entirely, so the CLI-006 terminal latch
    // does not protect it. Without this predicate a distributed-owned run is
    // latched `cancelled` and the projector discards the attempt's real terminal.
    expect(issues).toContain(
      'or(isNull(heartbeatRuns.executionOwner), ne(heartbeatRuns.executionOwner, "distributed"))',
    );
  });

  it("routes the distributed subset after the transaction, at BOTH call sites", () => {
    const calls = issues.match(/routeDistributedCancelsForRuns\(db, runsToTerminate/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("routes AFTER terminateTrackedRuns, not inside the transaction", () => {
    // requestCancellation goes through runInTenant on a different pool and must
    // not be entangled with this transaction's lifetime.
    const lines = issues.split(/\r?\n/);
    const terminate = lines.findIndex((l) => l.includes("terminateTrackedRuns(runsToTerminate);"));
    const route = lines.findIndex((l) => l.includes("routeDistributedCancelsForRuns(db, runsToTerminate"));
    expect(terminate).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(terminate);
  });
});

// -- H1: a cancel that no worker will ever terminalize must fall back to legacy --
//
// Found by adversarial review, and it is the difference between "cancel" and
// "this run can never be cancelled again".
//
// `repos.jobControl.requestCancellation` returns six statuses. Three of them mean
// NOTHING will ever emit a `job_events` terminal for this attempt:
//
//   cancelled   — no live lease, so the repo finalizes job+attempt DIRECTLY with
//                 row updates (job-control.ts:3001-3033) precisely because
//                 claimReadyOutbox would never dispatch it. No event is written.
//   job_terminal— already terminal.
//   not_found   — no visible job row.
//
// `onAttemptTerminal` has exactly ONE producer: the worker event-ingest path. So
// for those three, treating the cancel as "the distributed side owns the terminal"
// pins the run at `running` forever — and because every retry returns
// `job_terminal`, it is then permanently uncancellable, recoverable only by hand.
//
// An unleased attempt is not an edge case: it is what a first canary produces,
// since the worker daemon is inert outside the D1 topology (E4-D12).

describe("CLI-006/H1 — dispatchCancel honours the cancellation outcome", () => {
  const withStatus = (status: string) => ({
    requestCancellation: async () => ({ status }) as { status: string },
  });

  it("leaves the terminal to the worker when a fenced worker will deliver one", async () => {
    for (const status of ["queued", "already_requested"] as const) {
      const out = await dispatchCancel({
        run: distributedRun,
        ...RUN_CTX,
        port: withStatus(status),
        onError: "propagate",
      });
      expect(out.writeLegacyTerminal, status).toBe(false);
    }
  });

  it("writes the legacy terminal when NOTHING will ever project one", async () => {
    for (const status of ["cancelled", "job_terminal", "not_found", "no_active_lease"] as const) {
      const out = await dispatchCancel({
        run: distributedRun,
        ...RUN_CTX,
        port: withStatus(status),
        onError: "propagate",
      });
      expect(out.writeLegacyTerminal, status).toBe(true);
      expect(out.degraded, status).toBe("no_distributed_terminal_expected");
    }
  });

  it("treats an unrecognised status as no-terminal-expected, not as handled", async () => {
    // Fail towards a killable run: a status this build does not understand must
    // not be assumed to mean "a worker will finish it".
    const out = await dispatchCancel({
      run: distributedRun,
      ...RUN_CTX,
      port: withStatus("some_future_status"),
      onError: "propagate",
    });
    expect(out.writeLegacyTerminal).toBe(true);
  });

  it("still treats a THROW as no-terminal-write — the worker may be live (4-D1)", async () => {
    // H1 must not weaken 4-D1. A throw is not an outcome; the worker may be
    // executing, so a local `cancelled` would still be a lie.
    const boom = { requestCancellation: async () => { throw new Error("unreachable"); } };
    const out = await dispatchCancel({ run: distributedRun, ...RUN_CTX, port: boom, onError: "skip" });
    expect(out.writeLegacyTerminal).toBe(false);
  });
});

// -- H3: the issue execution lock must NOT be released for a live attempt -----
//
// The bulk terminal update was narrowed to exclude distributed-owned runs, but
// the `issues` update immediately below it still used the UNFILTERED id list. So
// a distributed run's issue lock was released while its worker was still
// executing. `heartbeat.cancelRun`'s sibling path gets this right and says why.
//
// The plan's own note — "the issue-lock release must still cover both subsets" —
// was wrong. It assumed an ineligible task cannot be claimed. For
// `reason: "reassigned"` the task stays perfectly eligible, just for a DIFFERENT
// agent, so the lock going free lets that agent check out and execute the same
// task while the attempt runs. The per-agent concurrency clamp does not help.

describe("CLI-006/H3 — the issue lock release excludes distributed runs", () => {
  const issues = src("../services/issues.ts");

  it("releases the lock only for the legacy subset", () => {
    expect(issues).toContain("inArray(issues.executionRunId, legacyRunIds)");
  });

  it("no longer releases it for the unfiltered id list", () => {
    expect(issues).not.toContain("inArray(issues.executionRunId, activeRunIds)");
  });
});

// -- A: the FIFTH writer must honour writeLegacyTerminal ----------------------
//
// Found by re-reviewing the H1 fix itself. H1 made `writeLegacyTerminal`
// load-bearing — for `cancelled` / `job_terminal` / `not_found` / unknown it means
// "nothing will ever project a terminal, the CALLER must write it". Four writers
// consume it via `routeRunCancellation`. `routeDistributedCancelsForRuns` — the
// task-ineligible sweep, the fifth writer — bound the outcome and read only
// `.degraded` for a log line, discarding the flag.
//
// Failure: a canary task with an in-flight Ask-Human continuation run whose
// attempt is not yet leased (the ordinary first-canary state). The founder marks
// the task done / cancelled / reassigns / deletes. The in-transaction terminal
// correctly excludes the run, the post-commit route gets
// `writeLegacyTerminal:true`, discards it, and the run is pinned `running` with no
// convergence path: no worker event was written, the reaper stands down on the
// marker, and the stale-lock breaker only covers queued/scheduled_retry.
//
// The blast radius is what makes it HIGH rather than a stranded row:
// `countRunningRunsForAgent` counts it with no owner filter, and at AoA's
// permanent `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1` the canary agent then
// never dispatches again.

describe("CLI-006/A — the task-ineligible sweep honours the cancel outcome", () => {
  const issues = src("../services/issues.ts");

  it("consumes writeLegacyTerminal, not just the degraded label", () => {
    const fn = issues.slice(
      issues.indexOf("async function routeDistributedCancelsForRuns"),
      issues.indexOf("function monitorClearReasonForIssue"),
    );
    expect(fn).toContain("writeLegacyTerminal");
  });

  it("writes the terminal itself for runs nothing will ever project", () => {
    const fn = issues.slice(
      issues.indexOf("async function routeDistributedCancelsForRuns"),
      issues.indexOf("function monitorClearReasonForIssue"),
    );
    expect(fn).toContain("task_no_longer_eligible");
    // and releases the execution lock for exactly those runs
    expect(fn).toContain("executionRunId: null");
  });

  it("still guards the terminal on a non-terminal status", () => {
    const fn = issues.slice(
      issues.indexOf("async function routeDistributedCancelsForRuns"),
      issues.indexOf("function monitorClearReasonForIssue"),
    );
    expect(fn).toContain('["queued", "running", "scheduled_retry"]');
  });
});

// -- B: a failed marker write must CONVERGE, not strand ----------------------
//
// The re-review refuted my own justification. The seam's comment claimed an
// unmarked suppressed run is "a recoverable inconsistency" — it is not. Nothing
// in the codebase recovers it, and the one mechanism that touches it (the reaper)
// does the actively wrong thing: with the marker absent, R1's stand-down does not
// apply, so the run is reaped and `releaseIssueExecutionAndPromote` frees the
// issue lock and promotes a deferred wake — a SECOND executor, while the attempt
// is durably lease-eligible.
//
// Revoking the fence in that catch converts the failure into a genuine
// Invariant 2 outcome: the attempt never runs, the later reap becomes the correct
// action, and promotion hands the work back to legacy.

describe("CLI-006/B — a failed handoff marker write revokes the fence", () => {
  const heartbeat = src("../services/heartbeat.ts");

  it("revokes the fence rather than leaving a live attempt behind", () => {
    const idx = heartbeat.indexOf("handoff marker write FAILED");
    expect(idx, "expected the marker-failure branch").toBeGreaterThan(-1);
    const branch = heartbeat.slice(idx - 1800, idx + 1800);
    expect(branch).toContain("getDistributedCancellationPort()");
  });

  it("no longer claims the unmarked state is recoverable", () => {
    // The claim was load-bearing for shipping the residual, and it was false.
    expect(heartbeat).not.toContain("recoverable inconsistency");
  });
});

// ── Wave-3→4 gate, clause 3 ──────────────────────────────────────────────────
// The fifth writer must REACH dispatchCancel when there is no port.
//
// `dispatchCancel` is built for a missing port — its signature takes
// `port: DistributedCancellationPort | undefined` and `resolveCancelRoute` answers LEGACY
// with `writeLegacyTerminal: true`, documented as "the legacy write is the only convergent
// outcome" for "a control-plane restart with the distributed flag off". Two tests above
// prove that CALLEE behaviour (`falls through to LEGACY when no port is registered` and
// `falls through to the legacy write when no port is registered`).
//
// But `routeDistributedCancelsForRuns` used to guard itself with `if (!port) return;`,
// which meant the fifth writer never reached the handling written for it — in exactly the
// post-rollback state that handling exists for. The H1 convergence block below it (latch
// `cancelled`, release the execution lock) was therefore dead precisely when it mattered,
// leaving a run pinned at `running` whose agent, at the permanent concurrency default of 1,
// never dispatches again.
//
// Proving the callee handles a case is not proving the caller reaches it.
describe("clause 3 — the fifth cancel writer converges with no port registered", () => {
  const issues = src("../services/issues.ts");
  // CODE ONLY. A source-contract test that matches comments is a trap: the fix for this very
  // defect explains itself by quoting the removed guard, which would keep the test red forever
  // and invite someone to weaken the comment instead of the code.
  // CODE ONLY. A source-contract test that matches comments is a trap: the fix for this very
  // defect explains itself by quoting the removed guard, which would keep the test red forever
  // and invite someone to weaken the comment instead of the code.
  const NEWLINE = String.fromCharCode(10);
  const body = issues
    .slice(
      issues.indexOf("async function routeDistributedCancelsForRuns"),
      issues.indexOf("async function routeDistributedCancelsForRuns") + 3500,
    )
    .split(NEWLINE)
    .filter((line) => !line.trim().startsWith("//"))
    .join(NEWLINE);

  it("does not bail out before dispatchCancel when the port is absent", () => {
    expect(
      body,
      "an early `if (!port) return;` makes the post-rollback convergence block unreachable " +
        "in the one state it was written for; dispatchCancel accepts an undefined port by design",
    ).not.toMatch(/if \(!port\) return;/);
  });

  it("still passes the (possibly undefined) port through to dispatchCancel", () => {
    expect(body).toContain("dispatchCancel({");
    expect(body).toContain("port,");
  });

  it("keeps the query filtered to distributed-marked runs, so a legacy deployment does no work", () => {
    // Removing the guard costs one indexed SELECT on terminate paths. A deployment that
    // never enabled distributed execution has no `executionOwner = "distributed"` rows, so
    // the loop body never runs.
    expect(body).toContain('eq(heartbeatRuns.executionOwner, "distributed")');
  });
});
