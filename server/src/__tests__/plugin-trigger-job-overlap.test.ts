/**
 * A-M16 — manual `triggerJob` overlap TOCTOU regression test.
 *
 * The scheduled path (`dispatchJob`) claims `activeJobs` synchronously *before*
 * creating the run. The manual path (`triggerJob` → `dispatchManualRun`) used to
 * claim only inside the fire-and-forget `dispatchManualRun`, leaving a
 * time-of-check/time-of-use window: two concurrent `triggerJob` calls within one
 * tick both pass the in-memory `activeJobs.has` guard (still empty) and the DB
 * guard (which only saw `running` runs, never the just-created `queued` run),
 * so both dispatch a worker `runJob` — a double-dispatch.
 *
 * These tests pin the fix: the manual path must claim synchronously and the DB
 * guard must also consider `queued` runs.
 */

import { describe, expect, it, vi } from "vitest";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";

const JOB_ID = "job-1";
const PLUGIN_ID = "plugin-1";

interface RunRow {
  id: string;
  jobId: string;
  pluginId: string;
  status: string;
}

/**
 * Build a scheduler wired to controllable mocks. The DB `select(...)` guard
 * query resolves to whatever `existingRuns()` returns at call time, so the
 * test can decide whether the just-created `queued` run is visible.
 */
function buildHarness() {
  const createdRuns: RunRow[] = [];
  let runSeq = 0;

  // Worker `runJob` invocations are counted here — this is the double-dispatch
  // signal.
  const runJobCalls: unknown[] = [];

  const workerManager = {
    isRunning: vi.fn(() => true),
    call: vi.fn(async (_pluginId: string, method: string, params: unknown) => {
      if (method === "runJob") {
        runJobCalls.push(params);
      }
      return {} as never;
    }),
  };

  const jobStore = {
    getJobById: vi.fn(async () => ({
      id: JOB_ID,
      pluginId: PLUGIN_ID,
      jobKey: "demo.job",
      status: "active",
      schedule: "* * * * *",
      nextRunAt: new Date(),
      lastRunAt: null,
    })),
    createRun: vi.fn(async (input: { jobId: string; pluginId: string }) => {
      const row: RunRow = {
        id: `run-${++runSeq}`,
        jobId: input.jobId,
        pluginId: input.pluginId,
        status: "queued",
      };
      createdRuns.push(row);
      return row;
    }),
    markRunning: vi.fn(async (runId: string) => {
      const row = createdRuns.find((r) => r.id === runId);
      if (row) row.status = "running";
    }),
    completeRun: vi.fn(async (runId: string, input: { status: string }) => {
      const row = createdRuns.find((r) => r.id === runId);
      if (row) row.status = input.status;
    }),
    updateRunTimestamps: vi.fn(async () => {}),
    listJobs: vi.fn(async () => []),
  };

  // The DB guard query: `db.select().from(pluginJobRuns).where(...)`. Resolve to
  // the set of runs the guard's status filter is meant to catch. We honor the
  // fix's intent: both `running` and `queued` runs count.
  const db = {
    select: () => {
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "orderBy", "limit"]) {
        chain[method] = () => chain;
      }
      chain.then = (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(
          resolve(
            createdRuns.filter(
              (r) =>
                r.jobId === JOB_ID &&
                (r.status === "running" || r.status === "queued"),
            ),
          ),
        );
      return chain;
    },
  };

  const scheduler = createPluginJobScheduler({
    db: db as never,
    jobStore: jobStore as never,
    workerManager: workerManager as never,
  });

  return { scheduler, workerManager, jobStore, runJobCalls };
}

describe("A-M16 — manual triggerJob overlap TOCTOU", () => {
  it("dispatches the worker exactly once when two triggers race in one tick", async () => {
    const { scheduler, runJobCalls } = buildHarness();

    const results = await Promise.allSettled([
      scheduler.triggerJob(JOB_ID),
      scheduler.triggerJob(JOB_ID),
    ]);

    // Exactly one trigger should win; the other must be rejected as an overlap.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as Error).message,
    ).toMatch(/already (running|has a (running|queued|pending) execution)/i);

    // Let any fire-and-forget dispatch settle.
    await new Promise((r) => setImmediate(r));

    // The crux: the worker `runJob` RPC must fire exactly ONCE.
    expect(runJobCalls).toHaveLength(1);
  });

  it("still dispatches once for a single trigger", async () => {
    const { scheduler, runJobCalls } = buildHarness();

    const result = await scheduler.triggerJob(JOB_ID);
    expect(result.jobId).toBe(JOB_ID);

    await new Promise((r) => setImmediate(r));

    expect(runJobCalls).toHaveLength(1);
  });

  it("permits a fresh trigger after the previous one completes (activeJobs cleared in finally)", async () => {
    const { scheduler, runJobCalls } = buildHarness();

    await scheduler.triggerJob(JOB_ID);
    // Allow dispatchManualRun to run through its finally (clears activeJobs and
    // marks the run completed, so it's no longer queued/running for the guard).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // diagnostics should show no active job now.
    expect(scheduler.diagnostics().activeJobCount).toBe(0);

    await scheduler.triggerJob(JOB_ID);
    await new Promise((r) => setImmediate(r));

    expect(runJobCalls).toHaveLength(2);
  });
});
