// DE-18 wiring guard: the complete-but-unwired execution-target revocation fanout
// (`createExecutionTargetRevocationFanout`, JOB-007) must be composed at the server
// composition root AND ticked on the SAME running MIG-002 convergence timer.
//
// index.ts is the process entrypoint — not unit-bootable — so, exactly like the sibling
// MIG-002 tick-wiring guard in job-control-runtime.test.ts ("composes and stops the runtime
// only inside the distributed-execution flag"), this is a source-presence assertion. The
// fanout's convergence BEHAVIOUR (lease flip -> revoked, capacity release, target_revoked
// cancellation, record -> completed) is proven end-to-end against embedded Postgres in
// worker-revocation.integration.test.ts; this guard proves that proven behaviour is actually
// reached by a running timer instead of sitting inert.
//
// Red-when-removed anchor: `await revocationFanout.tick()` must appear INSIDE the
// `convergenceTick` body (between its declaration and the MIG-002 catch line). Delete that
// call — the wiring under test — and the "ticks the fanout inside the convergence tick" case
// goes red. Windows-runnable (pure fs read).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("DE-18 revocation fanout is wired into the convergence tick", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

  it("imports the fanout factory in the flag-gated dynamic import graph", () => {
    // Dynamic import (not a top-level import) so the flag-off import-graph guard stays
    // satisfied — the E3 job-control runtime must not enter the bootstrap graph.
    expect(src).toContain('import("./services/execution-target-revocation-fanout.js")');
    expect(src).toContain("createExecutionTargetRevocationFanout");
  });

  it("composes the fanout at the root with the operator pool and the shared reconciliation", () => {
    const composeIndex = src.indexOf("const revocationFanout = createExecutionTargetRevocationFanout({");
    expect(composeIndex).toBeGreaterThanOrEqual(0);
    // Composition must sit inside the `config.distributedExecutionEnabled && distributedExecutionDatabases`
    // block — flag-off allocates no aoa_app pool, so runInTenant would have nothing to open.
    const flagIndex = src.indexOf("if (config.distributedExecutionEnabled && distributedExecutionDatabases)");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(composeIndex).toBeGreaterThan(flagIndex);
    // Constructor deps match the fanout's contract: operator connection drives the durable
    // records, the SAME cancel-path reconciliation the reaper uses, and a page-draining
    // wrapper over the shared paginated enumerator.
    const composeBlock = src.slice(composeIndex, composeIndex + 900);
    expect(composeBlock).toContain("operatorDb: distributedExecutionDatabases.operatorDb");
    expect(composeBlock).toContain("reconciliation: jobReconciliationForCancel");
    expect(composeBlock).toMatch(/listAdmittedOrganizationIds:\s*async\s*\(\)/);
    // The drain wrapper collects every page (the enumerator caps pages at 32).
    expect(composeBlock).toContain("listAdmittedOrganizationIds!({");
    expect(composeBlock).toMatch(/afterOrganizationId:\s*after/);
  });

  it("ticks the fanout inside the convergence tick, under the same try/catch and timer", () => {
    const tickDeclIndex = src.indexOf("const convergenceTick = async ():");
    const catchIndex = src.indexOf('logger.warn({ err }, "[mig-002] lease reaper tick failed");');
    const fanoutTickIndex = src.indexOf("await revocationFanout.tick()");

    expect(tickDeclIndex).toBeGreaterThanOrEqual(0);
    expect(catchIndex).toBeGreaterThan(tickDeclIndex);
    // THE red-when-removed anchor: the fanout tick must live between the convergenceTick
    // declaration and the MIG-002 catch — i.e. in the try body of the one running timer.
    expect(fanoutTickIndex).toBeGreaterThan(tickDeclIndex);
    expect(fanoutTickIndex).toBeLessThan(catchIndex);
    // No second timer: the fanout is not given its own setInterval/setTimeout driver.
    expect(src).not.toMatch(/revocationFanout[\s\S]{0,80}set(Interval|Timeout)/);
  });
});
