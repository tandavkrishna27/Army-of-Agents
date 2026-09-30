/**
 * MIG-002 convergence, part 2 — the sweeper projects a RUN terminal for each attempt the reaper
 * terminalized.
 *
 * Why this exists: `onAttemptTerminal` has exactly one producer, the worker's accepted event
 * batch. So an attempt the reaper terminalizes leaves its heartbeat run pinned at `running` —
 * and the orphaned-run reaper deliberately stands down on `execution_owner = "distributed"`
 * *because the attempt projector is the terminal authority*. After a reaper-terminalized
 * attempt that rationale is false: the authority it defers to will never speak.
 *
 * The fix is ONE projection with TWO triggers, never a second run-terminal writer. The sweeper
 * hands each terminalized attempt to the SAME `canary-terminal-projection` handler the ingest
 * path uses, so the ownership predicate ("project only when execution_owner is distributed")
 * stays in one place and the projector cannot become a second authority for run state.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJobControlSweeper } from "../services/job-control-sweeper.js";

const ORG_A = "11111111-1111-4111-8111-11111111111a";
const ORG_B = "11111111-1111-4111-8111-11111111111b";

function reapResult(over: Partial<Record<string, unknown>> = {}) {
  return {
    scanned: 0, revoked: 0, retried: 0, deadLettered: 0, cancelled: 0, finalized: 0,
    terminalized: [],
    ...over,
  };
}

function terminal(attemptId: string, terminalStatus = "failed") {
  return { companyId: "co-1", jobId: `job-${attemptId}`, attemptId, terminalStatus };
}

function sweeper(opts: {
  perOrg: Record<string, ReturnType<typeof reapResult>>;
  projectRunTerminal?: ReturnType<typeof vi.fn>;
  orgs?: string[];
}) {
  const projectRunTerminal = opts.projectRunTerminal ?? vi.fn(async () => {});
  const s = createJobControlSweeper({
    enabled: true,
    reconciliation: {
      reapOrganization: async (organizationId: string) => opts.perOrg[organizationId] ?? reapResult(),
    } as never,
    listAdmittedOrganizationIds: async () => opts.orgs ?? [ORG_A],
    projectRunTerminal,
  } as never);
  return { s, projectRunTerminal };
}

describe("N4 — one signal per terminalized attempt, carrying the loop's Organization", () => {
  it("projects each terminalized attempt exactly once", async () => {
    const { s, projectRunTerminal } = sweeper({
      perOrg: {
        [ORG_A]: reapResult({ revoked: 2, terminalized: [terminal("at-1"), terminal("at-2", "cancelled")] }),
      },
    });
    const result = await s.tick();

    expect(projectRunTerminal).toHaveBeenCalledTimes(2);
    expect(projectRunTerminal.mock.calls[0]?.[0]).toEqual({
      // The Organization is NOT in the reap row — it is the sweep loop's key, and forgetting
      // to add it would send a tenant-less signal into a tenant-scoped projection.
      organizationId: ORG_A,
      companyId: "co-1",
      jobId: "job-at-1",
      attemptId: "at-1",
      terminalStatus: "failed",
    });
    expect(projectRunTerminal.mock.calls[1]?.[0]).toMatchObject({
      attemptId: "at-2",
      terminalStatus: "cancelled",
    });
    expect(result.projected).toBe(2);
  });

  it("carries the RIGHT Organization when several are swept in one tick", async () => {
    const { s, projectRunTerminal } = sweeper({
      orgs: [ORG_A, ORG_B],
      perOrg: {
        [ORG_A]: reapResult({ terminalized: [terminal("at-a")] }),
        [ORG_B]: reapResult({ terminalized: [terminal("at-b")] }),
      },
    });
    await s.tick();
    const byAttempt = Object.fromEntries(
      projectRunTerminal.mock.calls.map((c) => [
        (c[0] as { attemptId: string }).attemptId,
        (c[0] as { organizationId: string }).organizationId,
      ]),
    );
    expect(byAttempt).toEqual({ "at-a": ORG_A, "at-b": ORG_B });
  });

  it("projects nothing when the reaper terminalized nothing", async () => {
    const { s, projectRunTerminal } = sweeper({
      perOrg: { [ORG_A]: reapResult({ scanned: 5, retried: 5 }) },
    });
    const result = await s.tick();
    // A retried attempt's job runs again. Projecting a run terminal for it is the
    // two-executor bug the reaper's exclusion exists to prevent — the sweeper must not
    // reintroduce it by inventing signals.
    expect(projectRunTerminal).not.toHaveBeenCalled();
    expect(result.projected).toBe(0);
  });
});

describe("N5 — a projection failure costs visibility, never the sweep", () => {
  it("keeps projecting the rest of the batch after one throws", async () => {
    const projectRunTerminal = vi.fn(async (signal: { attemptId: string }) => {
      if (signal.attemptId === "at-2") throw new Error("projection blew up");
    });
    const { s } = sweeper({
      perOrg: {
        [ORG_A]: reapResult({ terminalized: [terminal("at-1"), terminal("at-2"), terminal("at-3")] }),
      },
      projectRunTerminal,
    });
    const result = await s.tick();
    expect(projectRunTerminal).toHaveBeenCalledTimes(3);
    // Two landed; the failure is not counted as projected.
    expect(result.projected).toBe(2);
  });

  it("does not fail the tick, and still sweeps the next Organization", async () => {
    const projectRunTerminal = vi.fn(async () => {
      throw new Error("projection unavailable");
    });
    const { s } = sweeper({
      orgs: [ORG_A, ORG_B],
      perOrg: {
        [ORG_A]: reapResult({ revoked: 1, terminalized: [terminal("at-a")] }),
        [ORG_B]: reapResult({ revoked: 1, terminalized: [terminal("at-b")] }),
      },
      projectRunTerminal,
    });
    const result = await s.tick();
    expect(result.organizations).toBe(2);
    expect(result.revoked).toBe(2);
    expect(result.projected).toBe(0);
  });
});

describe("N6 — the sweeper makes no ownership decision of its own", () => {
  it("passes the signal through unchanged, deciding nothing about the run", async () => {
    // The predicate "project only when execution_owner is distributed" lives in
    // canary-terminal-projection, in one place, so the projector cannot become a second
    // authority for run state. A sweeper that filtered here would be that second authority.
    const { s, projectRunTerminal } = sweeper({
      perOrg: { [ORG_A]: reapResult({ terminalized: [terminal("at-1", "succeeded")] }) },
    });
    await s.tick();
    const signal = projectRunTerminal.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(signal).sort()).toEqual(
      ["attemptId", "companyId", "jobId", "organizationId", "terminalStatus"].sort(),
    );
    expect(signal.terminalStatus).toBe("succeeded");
  });

  it("is inert when no projector is composed", async () => {
    const s = createJobControlSweeper({
      enabled: true,
      reconciliation: {
        reapOrganization: async () => reapResult({ revoked: 1, terminalized: [terminal("at-1")] }),
      } as never,
      listAdmittedOrganizationIds: async () => [ORG_A],
    } as never);
    const result = await s.tick();
    expect(result.revoked).toBe(1);
    expect(result.projected).toBe(0);
  });

  it("projects nothing at all when the sweeper is disabled", async () => {
    const projectRunTerminal = vi.fn(async () => {});
    const s = createJobControlSweeper({
      enabled: false,
      reconciliation: {
        reapOrganization: async () => reapResult({ terminalized: [terminal("at-1")] }),
      } as never,
      listAdmittedOrganizationIds: async () => [ORG_A],
      projectRunTerminal,
    } as never);
    await s.tick();
    expect(projectRunTerminal).not.toHaveBeenCalled();
  });
});

// ─── N8 ──────────────────────────────────────────────────────────────────────
// `nextDelayMs` had ZERO callers anywhere before this slice — including its own tests — so half
// the sweeper's public interface was unexercised. The registration uses it, so pin it.
describe("N8 — the backoff split", () => {
  it("uses the active delay after a productive tick and the idle delay otherwise", () => {
    const s = createJobControlSweeper({
      enabled: true,
      reconciliation: { reapOrganization: async () => reapResult() } as never,
      listAdmittedOrganizationIds: async () => [],
      activeDelayMs: 1_000,
      idleDelayMs: 15_000,
    } as never);
    expect(s.nextDelayMs({ ...reapResult(), organizations: 1, revoked: 1 } as never)).toBe(1_000);
    expect(s.nextDelayMs({ ...reapResult(), organizations: 1, scanned: 9 } as never)).toBe(15_000);
  });
});

// ─── N7 ──────────────────────────────────────────────────────────────────────
// The trap the design named: registering the sweeper with `enabled` left false is a SCHEDULED
// NO-OP — this programme's signature failure, one level in. So it is not enough to prove the
// sweeper is constructed; the registration must actually drive it, and drive it with the
// SHARED projection rather than a second writer.
describe("N7 — the composition root actually starts it", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
  const region = SRC.slice(SRC.indexOf("const convergenceSweeper = createJobControlSweeper("), SRC.indexOf("const convergenceSweeper = createJobControlSweeper(") + 2200);

  it("constructs the sweeper exactly once", () => {
    expect(SRC.match(/createJobControlSweeper\(/g) ?? []).toHaveLength(1);
  });

  it("does NOT disable it at the registration", () => {
    // `enabled` defaults to true in the factory; passing false here would be the scheduled
    // no-op. If a future change needs a kill switch it must be an explicit, named flag, not a
    // literal buried in the composition.
    expect(region).not.toMatch(/enabled:\s*false/);
  });

  it("actually ticks, on a loop, rather than only being constructed", () => {
    expect(region).toContain("convergenceSweeper.tick()");
    expect(region).toContain("setTimeout(");
  });

  it("drives the backoff with nextDelayMs, which had no callers before", () => {
    expect(region).toContain("convergenceSweeper.nextDelayMs(");
  });

  it("projects through the SAME handler the worker ingest uses", () => {
    // One projection, two triggers. A second run-terminal writer here would make the projector
    // a second authority for run state.
    expect(region).toMatch(/projectRunTerminal:\s*onAttemptTerminal/);
  });

  it("shares the ONE org enumerator instead of a second copy", () => {
    expect(region).toContain("listAdmittedOrganizationIds!(");
    expect(SRC.match(/const listAdmittedOrganizationIds =/g) ?? []).toHaveLength(1);
  });

  it("stops on SIGTERM and SIGINT, like its sibling timers", () => {
    expect(region).toContain('process.once("SIGTERM", stopConvergence)');
    expect(region).toContain('process.once("SIGINT", stopConvergence)');
  });
});
