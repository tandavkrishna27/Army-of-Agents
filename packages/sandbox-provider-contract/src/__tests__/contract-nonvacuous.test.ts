import { describe, expect, it } from "vitest";

import {
  createFakeSandboxProvider,
  type ProviderOpArgs,
  type ProviderOpResult,
  type SandboxProviderDriver,
} from "@armyofagents/sandbox-fake-provider";

import { runSandboxProviderContract, type ContractReport } from "../index.js";

function checkFailed(report: ContractReport, name: string): boolean {
  const check = report.checks.find((c) => c.name === name);
  return check !== undefined && check.ok === false;
}

/** Wrap a base driver, intercepting `invoke` with a sabotaging transform. */
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

describe("contract non-vacuousness — sabotaged fakes are CAUGHT", () => {
  it("a leaked tenant key in the list/inspect projection FAILS redacted-projection", async () => {
    const report = await runSandboxProviderContract(() =>
      wrapDriver(createFakeSandboxProvider().makeDriver("leak"), async (_op, _args, run) => {
        const r = await run();
        if (r.kind === "inspect" && r.projection) {
          return { ...r, projection: { ...r.projection, organizationId: "org_LEAK" } as never };
        }
        if (r.kind === "list") {
          return {
            ...r,
            list: { ...r.list, resources: r.list.resources.map((p) => ({ ...p, organizationId: "org_LEAK" }) as never) },
          };
        }
        return r;
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "redacted-projection")).toBe(true);
  });

  it("a reconcile that does not actually clean FAILS reconcile-zero-resources", async () => {
    const report = await runSandboxProviderContract(() =>
      wrapDriver(createFakeSandboxProvider().makeDriver("dirty"), async (op, _args, run) => {
        if (op === "reconcile_cleanup") {
          return { kind: "cleanup", cleanup: { cleanupStatus: "success" } }; // sabotage: never sweep
        }
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "reconcile-zero-resources")).toBe(true);
  });

  it("a create that ignores the idempotency key FAILS idempotency-key-replay", async () => {
    let n = 0;
    const report = await runSandboxProviderContract(() => {
      const base = createFakeSandboxProvider().makeDriver("noidem");
      return wrapDriver(base, async (op, _args, run) => {
        if (op === "create") {
          n += 1;
          return { kind: "created", resource: { providerId: base.providerId, resourceId: `sab-${n}` }, deduplicated: false };
        }
        return run();
      });
    });
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "idempotency-key-replay")).toBe(true);
  });

  it("an unadvertised optional op that returns instead of throwing FAILS optional-op-negotiation", async () => {
    const report = await runSandboxProviderContract(() => {
      const base = createFakeSandboxProvider().makeDriver("sneaky", { optionalOps: ["restore", "health"] });
      return wrapDriver(base, async (op, _args, run) => {
        if (op === "checkpoint") {
          return { kind: "checkpoint", checkpointId: "sneaky" }; // should have raised UnsupportedProviderOperation
        }
        return run();
      });
    });
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "optional-op-negotiation")).toBe(true);
  });

  it("an execute that never reports a deadline timeout FAILS deadline-handling", async () => {
    const report = await runSandboxProviderContract(() =>
      wrapDriver(createFakeSandboxProvider().makeDriver("nohang"), async (op, args, run) => {
        if (op === "execute") {
          return { kind: "executed", terminalState: "succeeded", faultInjected: false, timedOut: false };
        }
        return run();
      }),
    );
    expect(report.passed).toBe(false);
    expect(checkFailed(report, "deadline-handling")).toBe(true);
  });
});
