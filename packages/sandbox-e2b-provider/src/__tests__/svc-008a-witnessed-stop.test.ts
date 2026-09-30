// -----------------------------------------------------------------------------
// SVC-008a — an affirmative stop requires a WITNESS (tests A1-A5, B-series).
//
// ★ WHY THESE RUN AGAINST `RealE2bTransport` IN THE NO-KEY CORE, AND WHAT THAT DOES
// AND DOES NOT PROVE. `RealE2bTransport` now accepts an injected `sdk` facade, so the
// PRODUCTION parsing and verdict-derivation code in `real-transport.ts` (`mapState`,
// `toRecord`, `signal`, `startProcess`, `processStatus`, `signalProcess`) can be driven
// against the response shapes a real SDK can return, with NO key and NO network. The
// code under test is the SHIPPING code; only the SDK boundary moves.
//
// It proves this file's LOGIC. It proves NOTHING about what the live `e2b` service
// actually returns, and it is not a substitute for the keyed lane — which is why the
// keyed arm of T8 must report SKIPPED, never passed, when `E2B_API_KEY` is absent.
// Before this seam existed, `RealE2bTransport` could not be exercised at all without a
// key, which is exactly how E7-F034 lived in shipped code for the life of the lane while
// `MockE2bTransport` — strictly MORE capable in the dimension under test — kept every
// ladder suite green.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { E2bSandboxProvider } from "../e2b-provider.js";
import { MockE2bTransport } from "../mock-transport.js";
import { ProcessLaunchNotAcknowledged, SandboxRecordIndeterminateError } from "../errors.js";
import { RealE2bTransport, mapState } from "../real-transport.js";
import { DIRECTIVE_KEYS } from "../directives.js";
import type { ProviderOpContext, ResourceLabels } from "@armyofagents/worker-daemon";

const CTX: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "idem-svc008a" };

const LABELS: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 3,
};

/** A minimal `e2b` SDK facade. Every method a test does not supply throws, so a test can
 * never accidentally rely on a default that answers when it should not. */
interface SdkStub {
  getInfo?: (id: string, opts: unknown) => Promise<unknown>;
  connect?: (id: string, opts: unknown) => Promise<unknown>;
  list?: (opts: unknown) => unknown;
}

function realWith(stub: SdkStub): RealE2bTransport {
  return new RealE2bTransport({ apiKey: "test-key-not-a-credential", sdk: stub });
}

// -----------------------------------------------------------------------------
// A1 / A4 — the E7-F034 regressions.
// -----------------------------------------------------------------------------

describe("SVC-008a A1 — a cancel that cannot stop must no longer report stopped", () => {
  it("a RUNNING record yields outcome 'ignored', not 'stopped'", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({ getInfo: async () => ({ sandboxId: "sbx-1", state: "running", metadata: {} }) }),
    });
    const stop = await provider.cancel("sbx-1", CTX);
    // RED BEFORE THE FIX: `signal` discarded the record and returned `{delivered: true}`,
    // which `cancel` mapped to "stopped".
    expect(stop.outcome).toBe("ignored");
  });

  it("★ a getInfo that THROWS yields 'ignored' — the finding in one line", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({
        getInfo: async () => {
          throw new Error("e2b control API is unreachable");
        },
      }),
    });
    const stop = await provider.cancel("sbx-1", CTX);
    // RED BEFORE THE FIX: `return { delivered: true }` from the CATCH block — an
    // affirmative stop produced by a read that had already failed.
    expect(stop.outcome).toBe("ignored");
    expect(stop.outcome).not.toBe("stopped");
  });

  it("a PAUSED sandbox's process was not stopped", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({ getInfo: async () => ({ sandboxId: "sbx-1", state: "paused", metadata: {} }) }),
    });
    expect((await provider.cancel("sbx-1", CTX)).outcome).toBe("ignored");
  });

  it("POSITIVE CONTROL — a genuinely stopped sandbox still reports 'stopped'", async () => {
    // Without this, an implementation hardcoded to "ignored" passes every case above and
    // asserts nothing. A checker needs a precision test as much as a recall test.
    const provider = new E2bSandboxProvider({
      transport: realWith({ getInfo: async () => ({ sandboxId: "sbx-1", state: "stopped", metadata: {} }) }),
    });
    expect((await provider.cancel("sbx-1", CTX)).outcome).toBe("stopped");
    expect((await provider.kill("sbx-1", CTX)).outcome).toBe("stopped");
  });
});

describe("SVC-008a A4 — ★★★ an UNREADABLE state is not a stop (the B1 regression)", () => {
  // The four payloads a real SDK can return and this parser cannot classify. Before
  // `mapState` gained its honest fallthrough, EVERY ONE of them produced
  // `state: "stopped"` -> `observed: "stopped"` -> `StopOutcome "stopped"`: an
  // affirmative stop from a read that witnessed nothing about the state. That is
  // E7-F034's class reconstructed inside E7-F034's own repair.
  const UNCLASSIFIABLE: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["{} — no state field at all", { sandboxId: "sbx-1", metadata: {} }],
    ["{state: undefined}", { sandboxId: "sbx-1", state: undefined, metadata: {} }],
    ["{state: 42} — non-string", { sandboxId: "sbx-1", state: 42, metadata: {} }],
    ["{state: 'hibernated'} — a plausible future/renamed member", { sandboxId: "sbx-1", state: "hibernated", metadata: {} }],
  ];

  for (const [label, payload] of UNCLASSIFIABLE) {
    it(`${label} -> mapState 'unknown', cancel 'ignored', NEVER 'stopped'`, async () => {
      expect(mapState((payload as { state?: unknown }).state)).toBe("unknown");
      const provider = new E2bSandboxProvider({ transport: realWith({ getInfo: async () => payload }) });
      const stop = await provider.cancel("sbx-1", CTX);
      // ★ ASSERT THE NEGATIVE EXPLICITLY. "stopped" is the value the pre-fix default
      // produced, and a test that only checked the positive would pass on the defect.
      expect(stop.outcome).not.toBe("stopped");
      expect(stop.outcome).toBe("ignored");
    });
  }

  it("mapState still recognizes every classifiable spelling (positive control)", () => {
    expect(mapState("running")).toBe("running");
    expect(mapState("RUNNING")).toBe("running");
    expect(mapState("paused")).toBe("paused");
    expect(mapState("stopped")).toBe("stopped");
    expect(mapState("killed")).toBe("stopped");
    expect(mapState("terminated")).toBe("stopped");
  });
});

describe("SVC-008a A4b — an indeterminate record is not laundered by inspect or list", () => {
  it("inspect THROWS SandboxRecordIndeterminateError, and NOT SandboxNotFoundError", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({ getInfo: async () => ({ sandboxId: "sbx-1", state: "hibernated", metadata: {} }) }),
    });
    await expect(provider.inspect("sbx-1", CTX)).rejects.toBeInstanceOf(SandboxRecordIndeterminateError);
    expect(provider.indeterminateRecordCount()).toBe(1);
  });

  it("★ §9.4 interim rule — an indeterminate record keeps hasLiveLease TRUE (non-destructive)", async () => {
    // `reconcile.ts`'s `defaultIsOrphan` is `!hasLiveLease`, so `false` here would send a
    // sandbox whose state field was merely unreadable to TEARDOWN. Until `ResourceSummary`
    // grows a third disposition (§9.4, deferred), this loses orphans to the reaper rather
    // than destroying live work.
    const provider = new E2bSandboxProvider({
      transport: realWith({
        list: () => [
          { sandboxId: "sbx-a", state: "running", metadata: { [labelsKey]: JSON.stringify(LABELS) } },
          { sandboxId: "sbx-b", state: "hibernated", metadata: { [labelsKey]: JSON.stringify(LABELS) } },
          { sandboxId: "sbx-c", state: "stopped", metadata: { [labelsKey]: JSON.stringify(LABELS) } },
        ],
      }),
    });
    const page = await provider.list(
      { ownershipSelector: { organizationId: "org-1", targetId: "tgt-1", workerId: "wkr-1" }, pageSize: 10 },
      CTX,
    );
    const byId = new Map(page.resources.map((r) => [r.sandboxId, r]));
    expect(byId.get("sbx-a")?.hasLiveLease).toBe(true);
    expect(byId.get("sbx-b")?.hasLiveLease).toBe(true); // the interim rule
    expect(byId.get("sbx-c")?.hasLiveLease).toBe(false); // POSITIVE CONTROL: a real stop still projects false
    expect(provider.indeterminateRecordCount()).toBe(1);
  });
});

const labelsKey = "__aoa_labels";

// -----------------------------------------------------------------------------
// A5 / B2 — no affirmative identifier is minted from an unreadable payload.
// -----------------------------------------------------------------------------

describe("SVC-008a A5/B2 — a launch that cannot be acknowledged THROWS; no empty handle", () => {
  const NO_HANDLE: ReadonlyArray<[string, unknown]> = [
    ["{} — no pid", {}],
    ["{pid: undefined}", { pid: undefined }],
    ["{pid: '17'} — a string, not a number", { pid: "17" }],
    ["{pid: 0}", { pid: 0 }],
  ];

  for (const [label, handle] of NO_HANDLE) {
    it(`${label} -> ProcessLaunchNotAcknowledged, never handle: ""`, async () => {
      const provider = new E2bSandboxProvider({
        transport: realWith({
          connect: async () => ({ commands: { run: async () => handle } }),
        }),
      });
      await expect(
        provider.startProcess({ sandboxId: "sbx-1", command: "sleep", args: ["1"], env: {} }, CTX),
      ).rejects.toBeInstanceOf(ProcessLaunchNotAcknowledged);
    });
  }

  it("POSITIVE CONTROL — a real pid resolves a non-empty handle", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({ connect: async () => ({ commands: { run: async () => ({ pid: 4242 }) } }) }),
    });
    const started = await provider.startProcess(
      { sandboxId: "sbx-1", command: "sleep", args: ["1"], env: {} },
      CTX,
    );
    expect(started.handle).toBe("4242");
    expect(started.handle.length).toBeGreaterThan(0);
  });

  it("★ startProcess ACKNOWLEDGES without waiting for the command to exit", async () => {
    // The whole reason the primitive exists: `execute`/`runCommand` resolve only AFTER the
    // command exits, so a supervisor built on them records a hung launch as started.
    let commandEverFinished = false;
    const provider = new E2bSandboxProvider({
      transport: realWith({
        connect: async () => ({
          commands: {
            // A background launch returns a handle immediately; nothing here awaits the
            // command. If the binding awaited a `wait()`, this test would hang forever.
            run: async (_cmd: string, opts: { background?: boolean }) => {
              expect(opts.background).toBe(true);
              return {
                pid: 99,
                wait: async () => {
                  await new Promise(() => {}); // never settles
                  commandEverFinished = true;
                },
              };
            },
          },
        }),
      }),
    });
    const started = await provider.startProcess(
      { sandboxId: "sbx-1", command: "sleep", args: ["infinity"], env: {} },
      CTX,
    );
    expect(started.handle).toBe("99");
    expect(commandEverFinished).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// B3′ — a failure to look is not an absence.
// -----------------------------------------------------------------------------

describe("SVC-008a B3′ — 'gone' requires an ANSWER, not a swallowed error", () => {
  it("a status read that THROWS is unknown/read_failed — never 'gone'", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({
        connect: async () => ({
          commands: {
            list: async () => {
              throw new Error("envd channel dropped");
            },
          },
        }),
      }),
    });
    const status = await provider.processStatus("sbx-1", "77", CTX);
    // RED against a `processStatus` built on `RealE2bTransport.isRunning`
    // (`catch { return false }`), whose `false` `e2b-provider.ts` already ships as
    // `status: "unhealthy"` — an affirmative absence from a read that threw.
    expect(status.observation.state).toBe("unknown");
    expect(status.observation).toMatchObject({ reason: "read_failed" });
    expect(status.observation.state).not.toBe("gone");
  });

  it("a sandbox that cannot be reached is unknown/sandbox_unreachable", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({
        connect: async () => {
          throw new Error("no such sandbox");
        },
      }),
    });
    const status = await provider.processStatus("sbx-1", "77", CTX);
    expect(status.observation).toMatchObject({ state: "unknown", reason: "sandbox_unreachable" });
  });

  it("a list that ANSWERS with the pid absent is 'gone' (positive control)", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({ connect: async () => ({ commands: { list: async () => [{ pid: 5 }] } }) }),
    });
    expect((await provider.processStatus("sbx-1", "77", CTX)).observation.state).toBe("gone");
  });

  it("a list that ANSWERS with the pid present is 'running' (positive control)", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({ connect: async () => ({ commands: { list: async () => [{ pid: 77 }] } }) }),
    });
    expect((await provider.processStatus("sbx-1", "77", CTX)).observation.state).toBe("running");
  });

  it("a list that answers with something unclassifiable is unknown/state_unrecognized", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({ connect: async () => ({ commands: { list: async () => ({ oops: true }) } }) }),
    });
    expect((await provider.processStatus("sbx-1", "77", CTX)).observation).toMatchObject({
      state: "unknown",
      reason: "state_unrecognized",
    });
  });

  it("a handle this binding did not mint is unknown/handle_unrecognized — never a guess", async () => {
    const provider = new E2bSandboxProvider({ transport: realWith({}) });
    expect((await provider.processStatus("sbx-1", "not-a-pid", CTX)).observation).toMatchObject({
      state: "unknown",
      reason: "handle_unrecognized",
    });
  });
});

// -----------------------------------------------------------------------------
// B4 / B4′ — nothing may be derived from `accepted`.
// -----------------------------------------------------------------------------

describe("SVC-008a B4/B4′ — `accepted` carries no claim about the process", () => {
  it("★ a kill that was ACCEPTED while the process is still running does not read as a stop", async () => {
    // Real E2B's only interesting case, and the one E7-F034 laundered into success.
    const provider = new E2bSandboxProvider({
      transport: realWith({
        connect: async () => ({
          commands: { kill: async () => true, list: async () => [{ pid: 77 }] },
        }),
      }),
    });
    const result = await provider.signalProcess("sbx-1", "77", "kill", CTX);
    expect(result.accepted).toBe("accepted");
    expect(result.observation.state).toBe("running");
    // `ProcessSignalResult` has NO member that could name a stop, so there is nothing for
    // a caller to misread. This assertion pins that the shape stays that way.
    expect(result).not.toHaveProperty("outcome");
  });

  it("★ B4′ — a graceful cancel is 'unsupported' on this provider, and still carries a RE-READ", async () => {
    // `e2b@2.30.5` exposes no per-pid SIGTERM (`Commands.kill` is SIGKILL and takes no
    // signal selector), so a graceful stop is reported ABSENT rather than simulated — and
    // it is NOT silently promoted to a kill.
    let killCalls = 0;
    const provider = new E2bSandboxProvider({
      transport: realWith({
        connect: async () => ({
          commands: {
            kill: async () => {
              killCalls += 1;
              return true;
            },
            list: async () => [{ pid: 77 }],
          },
        }),
      }),
    });
    const result = await provider.signalProcess("sbx-1", "77", "cancel", CTX);
    expect(result.accepted).toBe("unsupported");
    expect(killCalls).toBe(0);
    // Still a real observation: the process may have stopped for other reasons.
    expect(result.observation.state).toBe("running");
  });

  it("a kill call that THREW reports refused and an honest observation", async () => {
    const provider = new E2bSandboxProvider({
      transport: realWith({
        connect: async () => ({
          commands: {
            kill: async () => {
              throw new Error("rpc failed");
            },
            list: async () => {
              throw new Error("rpc failed");
            },
          },
        }),
      }),
    });
    const result = await provider.signalProcess("sbx-1", "77", "kill", CTX);
    expect(result.accepted).toBe("refused");
    expect(result.observation).toMatchObject({ state: "unknown", reason: "read_failed" });
  });
});

// -----------------------------------------------------------------------------
// The mock's new arms — a double that can finally represent production.
// -----------------------------------------------------------------------------

describe("SVC-008a — the DOUBLE can now produce every arm production has", () => {
  async function seed(directives: Readonly<Record<string, string>> = {}) {
    const transport = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport });
    const created = await provider.create(
      { resourceLabels: LABELS, command: "sleep", args: [], env: { ...directives }, workloadType: "batch" },
      CTX,
    );
    return { transport, provider, sandboxId: created.sandboxId };
  }

  it("a read that fails yields 'ignored' — the arm no double could reach before", async () => {
    const { provider, sandboxId } = await seed({ [DIRECTIVE_KEYS.readFails]: "1" });
    expect((await provider.cancel(sandboxId, { ...CTX, idempotencyKey: "k2" })).outcome).toBe("ignored");
  });

  it("an unrecognized record state yields 'ignored'", async () => {
    const { provider, sandboxId } = await seed({ [DIRECTIVE_KEYS.stateUnknown]: "1" });
    expect((await provider.cancel(sandboxId, { ...CTX, idempotencyKey: "k3" })).outcome).toBe("ignored");
  });

  it("an ignored cancel yields 'ignored'; an unscripted one yields 'stopped' (positive control)", async () => {
    const ignored = await seed({ [DIRECTIVE_KEYS.ignoreCancel]: "1" });
    expect((await ignored.provider.cancel(ignored.sandboxId, { ...CTX, idempotencyKey: "k4" })).outcome).toBe(
      "ignored",
    );
    const clean = await seed();
    expect((await clean.provider.cancel(clean.sandboxId, { ...CTX, idempotencyKey: "k5" })).outcome).toBe("stopped");
  });

  it("a refused launch throws rather than resolving an empty handle", async () => {
    const { provider, sandboxId } = await seed({ [DIRECTIVE_KEYS.refuseLaunch]: "1" });
    await expect(
      provider.startProcess({ sandboxId, command: "sleep", args: [], env: {} }, { ...CTX, idempotencyKey: "k6" }),
    ).rejects.toBeInstanceOf(ProcessLaunchNotAcknowledged);
  });

  it("a failed process read is unknown/read_failed, not 'gone'", async () => {
    const { provider, sandboxId } = await seed({ [DIRECTIVE_KEYS.processReadFails]: "1" });
    const started = await provider.startProcess(
      { sandboxId, command: "sleep", args: [], env: {} },
      { ...CTX, idempotencyKey: "k7" },
    );
    const status = await provider.processStatus(sandboxId, started.handle, { ...CTX, idempotencyKey: "k8" });
    expect(status.observation).toMatchObject({ state: "unknown", reason: "read_failed" });
  });
});
