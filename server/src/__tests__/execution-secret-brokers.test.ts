import { describe, expect, it } from "vitest";
import { resolveRunJwtValue, type RunJwtMintDeps } from "../services/execution-secret-brokers.js";

// ---------------------------------------------------------------------------
// DAT-007 / CLI-008 — the run_jwt mint-at-resolve decision (resolveRunJwtValue).
//
// ★ THE R2 CRUX under test: the minted run_id MUST be the DISTRIBUTED heartbeat_runs
// row's id (re-derived from the job at resolve), NEVER the jobId the handle carries.
// classifyRunCurrency (DAT-007) FAILS OPEN on !runFound and on execution_owner !==
// "distributed", so a bearer whose run_id resolves to no distributed row would sail
// through the currency gate for its whole TTL. And every degenerate input fails CLOSED:
// no distributed run, an owner that disagrees with the run's agent, or no signing key
// all throw (a coarse `malformed` at the wire) rather than mint.
// ---------------------------------------------------------------------------

function deps(
  over: Partial<RunJwtMintDeps> = {},
): RunJwtMintDeps & { minted: Array<{ agentId: string; companyId: string; runId: string }> } {
  const minted: Array<{ agentId: string; companyId: string; runId: string }> = [];
  return {
    minted,
    async loadDistributedRun() {
      return { runId: "run-9", agentId: "agent-1" };
    },
    mintAgentJwt(input) {
      minted.push(input);
      return "MINTED.JWT.TOKEN";
    },
    ...over,
  };
}

describe("resolveRunJwtValue — mint-at-resolve, run-id bound to the distributed run", () => {
  it("mints with the RE-DERIVED run id, not the jobId the handle carries (R2)", async () => {
    const d = deps();
    const jwt = await resolveRunJwtValue(d, { companyId: "c1", refId: "job-abc", ownerPrincipalId: "agent-1" });
    expect(jwt).toBe("MINTED.JWT.TOKEN");
    expect(d.minted).toEqual([{ agentId: "agent-1", companyId: "c1", runId: "run-9" }]);
    // The run_id is the heartbeat_runs row's id — the row DAT-007 probes — NEVER the jobId.
    expect(d.minted[0]!.runId).not.toBe("job-abc");
  });

  it("re-derives the run from (companyId, jobId = refId)", async () => {
    const seen: Array<{ companyId: string; jobId: string }> = [];
    const d = deps({
      async loadDistributedRun(input) {
        seen.push(input);
        return { runId: "run-9", agentId: "agent-1" };
      },
    });
    await resolveRunJwtValue(d, { companyId: "c1", refId: "job-abc", ownerPrincipalId: "agent-1" });
    expect(seen).toEqual([{ companyId: "c1", jobId: "job-abc" }]);
  });

  it("FAILS CLOSED when no distributed run backs the job (never mints)", async () => {
    const d = deps({
      async loadDistributedRun() {
        return null;
      },
    });
    await expect(
      resolveRunJwtValue(d, { companyId: "c1", refId: "job-abc", ownerPrincipalId: "agent-1" }),
    ).rejects.toThrow();
    expect(d.minted).toEqual([]);
  });

  it("FAILS CLOSED when the run's agent disagrees with the handle owner (never mints across agents)", async () => {
    const d = deps();
    await expect(
      resolveRunJwtValue(d, { companyId: "c1", refId: "job-abc", ownerPrincipalId: "agent-2" }),
    ).rejects.toThrow();
    expect(d.minted).toEqual([]);
  });

  it("FAILS CLOSED when no signing key is configured (mintAgentJwt returns null)", async () => {
    const d = deps({
      mintAgentJwt() {
        return null;
      },
    });
    await expect(
      resolveRunJwtValue(d, { companyId: "c1", refId: "job-abc", ownerPrincipalId: "agent-1" }),
    ).rejects.toThrow();
  });

  it("an unbound handle (ownerPrincipalId null) skips the owner cross-check and mints", async () => {
    const d = deps();
    const jwt = await resolveRunJwtValue(d, { companyId: "c1", refId: "job-abc", ownerPrincipalId: null });
    expect(jwt).toBe("MINTED.JWT.TOKEN");
    expect(d.minted[0]!.runId).toBe("run-9");
  });
});
