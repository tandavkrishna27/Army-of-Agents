import { describe, expect, it } from "vitest";

import {
  createHostileSandboxProvider,
  HOSTILE_MAX_DESTROY_ATTEMPTS,
  type ProviderOpArgs,
  type ProviderOpResult,
  type SandboxProviderDriver,
} from "@armyofagents/sandbox-fake-provider";

import {
  assertIsolationReport,
  runSandboxIsolationConformance,
  runSandboxProviderContract,
  type ContractReport,
} from "../index.js";

// The DEP-008 isolation suite is CERTIFIED against the hostile reference driver:
//  (1) the hostile driver passes all eight isolation invariants;
//  (2) the hostile driver ALSO passes the DEP-000 happy-path suite (regression);
//  (3) each invariant has a paired wrapDriver sabotage a broken/leaking/escalating/
//      oracle-exposing driver MUST fail — non-vacuousness (design §2 mandate).

// Thread the destroy-retry ceiling from ONE source (the reference's exported
// constant) into BOTH the driver and the suite, so §2.4(c)'s bounded-ceiling
// assertion can never pass by coincidence of two independent defaults.
const CEIL = HOSTILE_MAX_DESTROY_ATTEMPTS;
const hostile = () => createHostileSandboxProvider().makeDriver("hostile-iso", { maxDestroyAttempts: CEIL });

function checkFailed(report: ContractReport, name: string): boolean {
  const check = report.checks.find((c) => c.name === name);
  return check !== undefined && check.ok === false;
}

/** The `.detail` of a named check (empty string if absent) — lets a sabotage test
 * assert the target failed FOR THE INTENDED REASON, not merely that it failed. */
function failDetail(report: ContractReport, name: string): string {
  return report.checks.find((c) => c.name === name)?.detail ?? "";
}

/** Wrap a base driver, intercepting `invoke` with a sabotaging transform (mirror of
 * the DEP-000 contract-nonvacuous idiom). `result()` runs the real op (and may throw). */
function wrapDriver(
  base: SandboxProviderDriver,
  transform: (op: string, args: ProviderOpArgs, result: () => Promise<ProviderOpResult>) => Promise<ProviderOpResult>,
): SandboxProviderDriver {
  return {
    providerId: base.providerId,
    supportedOperations: () => base.supportedOperations(),
    invoke: (op, args) => transform(op, args, () => base.invoke(op, args)),
  };
}

describe("DEP-008 isolation conformance — the hostile reference passes", () => {
  it("the hostile reference driver passes all eight isolation invariants", async () => {
    const report = await runSandboxIsolationConformance(hostile, { maxDestroyAttempts: CEIL });
    expect(report.checks.length).toBe(8);
    assertIsolationReport(report); // throws with detail on any failed check
    expect(report.passed).toBe(true);
  });

  it("the hostile reference driver ALSO passes the DEP-000 happy-path suite (regression)", async () => {
    const report = await runSandboxProviderContract(hostile, {});
    assertContractReportSafe(report);
    expect(report.passed).toBe(true);
  });
});

function assertContractReportSafe(report: ContractReport): void {
  if (report.passed) return;
  const failures = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("\n");
  throw new Error(`hostile driver failed the DEP-000 happy-path suite:\n${failures}`);
}

describe("DEP-008 isolation conformance — non-vacuousness (sabotaged drivers are CAUGHT)", () => {
  it("§2.1 a driver that runs execute post-withdrawal FAILS effect-authority-withdrawal", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, _args, run) => {
        if (op === "execute") return { kind: "executed", terminalState: "succeeded", faultInjected: false, timedOut: false };
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "effect-authority-withdrawal")).toBe(true);
    expect(failDetail(report, "effect-authority-withdrawal")).toContain("did not deny with EffectAuthorityWithdrawnError");
  });

  it("§2.2 a cleanup-facet checkpoint that succeeds FAILS effect-ops-unrepresentable-under-cleanup", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, args, run) => {
        // Scoped to the CLEANUP facet so the sabotage is SURGICAL — it must fail §2.2
        // without collaterally breaking §2.1's effect-facet checkpoint-denial.
        if (op === "checkpoint" && args.params?.authority === "cleanup") return { kind: "checkpoint", checkpointId: "sabotage" };
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "effect-ops-unrepresentable-under-cleanup")).toBe(true);
    expect(failDetail(report, "effect-ops-unrepresentable-under-cleanup")).toContain("did not deny with CleanupAuthorityDeniedError");
  });

  it("§2.3 a driver that distinguishes an absent target FAILS no-existence-oracle", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, args, run) => {
        // Reveal non-existence with a DISTINCT error identity for the absent probe.
        if (op === "inspect" && args.resourceId === "ghost-does-not-exist") {
          const err = new Error("sandbox not found");
          err.name = "SandboxNotFoundError";
          throw err;
        }
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "no-existence-oracle")).toBe(true);
    expect(failDetail(report, "no-existence-oracle")).toContain("did not throw ResourceNotAvailableError");
  });

  it("§2.4 a reconcile that never sweeps FAILS monotonic-cleanup-convergence", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, _args, run) => {
        if (op === "reconcile_cleanup") return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "monotonic-cleanup-convergence")).toBe(true);
    expect(failDetail(report, "monotonic-cleanup-convergence")).toContain("converge");
  });

  it("§2.4(d) an empty-pass reconcile that latches a fail-open no-op FAILS monotonic-cleanup-convergence", async () => {
    const report = await runSandboxIsolationConformance(
      () => {
        // Per-driver latch: an empty reconcile pass poisons the NEXT real converge into a
        // report-success-without-sweeping no-op — exactly the fail-open sub-check (d) guards.
        let latched = false;
        return wrapDriver(hostile(), async (op, args, run) => {
          if (op === "reconcile_cleanup" && args.params?.authority === "cleanup") {
            if (args.params?.emptyPass === true) {
              latched = true;
              return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
            }
            if (latched) return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
          }
          return run();
        });
      },
      { maxDestroyAttempts: CEIL },
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "monotonic-cleanup-convergence")).toBe(true);
    expect(failDetail(report, "monotonic-cleanup-convergence")).toContain("failed open");
  });

  it("§2.5 a projection carrying a sensitive canary byte FAILS zero-byte-management-projection", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, _args, run) => {
        const r = await run();
        // Smuggle the secret canary through the NEUTRAL `state` key (key-set gate
        // passes; the byte scan must still catch it — proving the scan non-vacuous).
        if (r.kind === "inspect" && r.projection) {
          return { ...r, projection: { ...r.projection, state: "CANARY-SECRET-0c9f6b" } };
        }
        return r;
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "zero-byte-management-projection")).toBe(true);
    expect(failDetail(report, "zero-byte-management-projection")).toContain("leaked sensitive canary");
  });

  it("§2.6 an egress that ignores a denial class FAILS network-denial-no-bypass", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, args, run) => {
        const egress = args.params?.egress as { classification?: string } | undefined;
        if (op === "execute" && egress && egress.classification !== undefined && egress.classification !== "allow") {
          return { kind: "executed", terminalState: "succeeded", faultInjected: false, timedOut: false };
        }
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "network-denial-no-bypass")).toBe(true);
    expect(failDetail(report, "network-denial-no-bypass")).toContain("was not refused");
  });

  it("§2.7 a list that embeds a tenant canary FAILS no-credential-or-customer-byte-leak", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, _args, run) => {
        const r = await run();
        if (r.kind === "list") return { ...r, list: { ...r.list, nextCursor: "CANARY-TENANT-91d3c2" } };
        return r;
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "no-credential-or-customer-byte-leak")).toBe(true);
    expect(failDetail(report, "no-credential-or-customer-byte-leak")).toContain("leaked a credential/tenant/customer canary");
  });

  it("§2.8 an execute that never times out FAILS bounded-lifecycle-faults", async () => {
    const report = await runSandboxIsolationConformance(() =>
      wrapDriver(hostile(), async (op, _args, run) => {
        if (op === "execute") return { kind: "executed", terminalState: "succeeded", faultInjected: false, timedOut: false };
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "bounded-lifecycle-faults")).toBe(true);
    expect(failDetail(report, "bounded-lifecycle-faults")).toContain("did not reach a timedOut terminal");
  });
});
