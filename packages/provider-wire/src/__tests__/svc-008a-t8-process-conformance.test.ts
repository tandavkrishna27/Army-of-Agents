// -----------------------------------------------------------------------------
// SVC-008a T8 — THE CONFORMANCE TEST. The point of the unit, not an extra.
//
// ★★★ WHAT IT WOULD HAVE CAUGHT, PRECISELY.
//
// E7-F034 exists because `MockE2bTransport.signal` honoured `kind`, returned
// `{delivered: false}` under the `ignoreCancel`/`ignoreKill` directives, and set
// `record.state = "stopped"` — a state transition `RealE2bTransport` NEVER performed.
// `RealE2bTransport.signal` ignored `_kind`, did one `getInfo`, and returned
// `{delivered: true}` on BOTH branches including the catch. So the double was STRICTLY
// MORE CAPABLE than production in exactly the dimension under test, and every suite that
// exercised the escalation rung was green while the rung was structurally unreachable in
// production. `sandbox-e2b-provider`'s `conformance.test.ts` calls itself the no-key
// core's central proof of the driver's monotonic convergence, and for that rung it
// validated the MOCK's behaviour, not the shipping transport's.
//
// Run against the tree as it stood, clause 3 below REDS on the real arm and PASSES on the
// mock: the mock reports still-running under `ignoreCancel`; the real transport reports
// stopped. THE ARMS DISAGREE, AND THAT DISAGREEMENT IS E7-F034. Clause 6 reds on the real
// arm four more times, for the deeper `mapState` half the finding did not measure. Clause
// 11 reds because the two arms disagreed about whether a graceful cancel exists at all.
//
// ★ AND WHAT KEEPS IT FROM BEING THEATRE. A suite that asserted only "a refusal is
// representable" is passed perfectly by a transport hardcoded to `unknown`, which asserts
// nothing — the same inversion that let `delivered: true` pass every ladder test. So
// clause 4 is a POSITIVE CONTROL, clause 2 is anti-vacuity on the discovery walk itself,
// and discovery is a DIRECTORY WALK rather than a hand-listed pair, because a hand-listed
// pair is the version a future third implementer silently escapes.
// -----------------------------------------------------------------------------

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  E2bSandboxProvider,
  MockE2bTransport,
  RealE2bTransport,
  ProcessLaunchNotAcknowledged,
  DIRECTIVE_KEYS,
  type E2bTransport,
} from "@armyofagents/sandbox-e2b-provider";

import {
  UnsupportedProviderOperation,
  createNoopProvider,
  deriveStopVerdict,
  type ProviderOpContext,
  type ResourceLabels,
  type SandboxProvider,
} from "@armyofagents/worker-daemon";

import { NetworkedProviderDriver } from "../driver.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = path.resolve(HERE, "..", "..", "..");

const CTX: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "t8" };
let keySeq = 0;
const ctx = (): ProviderOpContext => ({ deadlineMs: 5_000, idempotencyKey: `t8-${++keySeq}` });

const LABELS: ResourceLabels = {
  organizationId: "org-t8",
  targetId: "tgt-t8",
  workerId: "wkr-t8",
  jobId: "job-t8",
  attempt: 1,
  leaseId: "lease-t8",
  deviceGeneration: 1,
};

// =============================================================================
// Clause 1 — DISCOVERY IS A DIRECTORY WALK, NOT A HAND-LISTED PAIR.
// =============================================================================

/**
 * Strip block and line comments before matching.
 *
 * ★ NOT A NICETY. This tree's own port docstrings contain the literal prose
 * "can `implements SandboxProvider` without copying the shape", so a walk over raw text
 * counts `worker-daemon/src/index.ts` and `supervisor/provider.ts` as implementers. A
 * discovery that miscounts in one direction can miscount in the other, and a walk whose
 * count is wrong is a walk whose anti-vacuity floor means nothing.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every non-test `.ts` file under the packages tree whose CODE matches `re`. */
function walkForPattern(re: RegExp): string[] {
  const hits: string[] = [];
  const packagesDir = PACKAGES_ROOT;
  const visit = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        if (re.test(stripComments(readFileSync(full, "utf8")))) {
          hits.push(path.relative(packagesDir, full).replace(/\\/g, "/"));
        }
      }
    }
  };
  if (existsSync(packagesDir)) visit(packagesDir);
  return hits.sort();
}

/** The `E2bTransport` implementers this suite EXERCISES, keyed by discovered file. */
const TRANSPORT_ARMS_BY_FILE = new Set([
  "sandbox-e2b-provider/src/real-transport.ts",
  "sandbox-e2b-provider/src/mock-transport.ts",
]);

/**
 * The `SandboxProvider` implementers this suite EXERCISES, keyed by discovered file.
 *
 * ★ `worker-daemon/src/__tests__/support/fake-provider.ts` is listed here and exercised
 * by worker-daemon's OWN `svc-008a-fake-provider-conformance.test.ts` — that package is
 * downstream of this one and its `__tests__` tree is not an exported entry point, so it
 * cannot be imported here. It is named rather than omitted: the point of the walk is that
 * an implementer cannot be silently absent, and "covered elsewhere, by name" is a claim a
 * reader can check, while a missing row is not.
 */
const PROVIDER_ARMS_BY_FILE = new Map<string, "here" | "worker-daemon suite">([
  ["sandbox-e2b-provider/src/e2b-provider.ts", "here"],
  ["provider-wire/src/driver.ts", "here"],
  ["worker-daemon/src/supervisor/noop-provider.ts", "here"],
  ["worker-daemon/src/__tests__/support/fake-provider.ts", "worker-daemon suite"],
]);

describe("T8 clause 1+2 — discovery is a directory walk, and it is NOT vacuous", () => {
  const transports = walkForPattern(/implements\s+E2bTransport\b/);
  const providers = walkForPattern(/(implements|extends)\s+SandboxProvider\b|\)\s*:\s*SandboxProvider\s*\{/);

  it("discovers at least two E2bTransport implementers", () => {
    // A suite that finds nothing to check reports OK forever. That is the failure class
    // this programme keeps re-learning, not a clean tree.
    expect(transports.length).toBeGreaterThanOrEqual(2);
  });

  it("discovers at least four SandboxProvider implementers", () => {
    expect(providers.length).toBeGreaterThanOrEqual(4);
  });

  it("★ EVERY discovered transport implementer is exercised by an arm below", () => {
    // A hand-listed pair is the version a future third implementer silently escapes.
    // There is no automated mutant for "delete the real arm and keep the mock", which is
    // exactly why discovery must be a walk.
    for (const file of transports) {
      expect(TRANSPORT_ARMS_BY_FILE.has(file), `undeclared E2bTransport implementer: ${file}`).toBe(true);
    }
  });

  it("★ EVERY discovered SandboxProvider implementer is exercised, here or by name", () => {
    for (const file of providers) {
      expect(PROVIDER_ARMS_BY_FILE.has(file), `undeclared SandboxProvider implementer: ${file}`).toBe(true);
    }
  });

  it("★ THE REVERSE DIRECTION — every declared arm was actually DISCOVERED by the walk", () => {
    // Without this, a regex that quietly stopped matching `real-transport.ts` would leave
    // the forward check vacuously true and the count satisfied by whatever else it caught.
    // A walk is only anti-orphan if its own recall is pinned.
    for (const file of TRANSPORT_ARMS_BY_FILE) {
      expect(transports, `walk lost transport implementer: ${file}`).toContain(file);
    }
    for (const file of PROVIDER_ARMS_BY_FILE.keys()) {
      expect(providers, `walk lost provider implementer: ${file}`).toContain(file);
    }
  });
});

// =============================================================================
// The uniform transport arm — the SAME clauses asserted of BOTH implementations.
// =============================================================================

type Condition =
  | "clean"
  | "cannot_stop"
  | "read_fails"
  | "state_unrecognized"
  | "refuse_launch"
  | "process_read_fails";

interface TransportArm {
  readonly name: string;
  make(condition: Condition): Promise<{ transport: E2bTransport; sandboxId: string }>;
}

const mockArm: TransportArm = {
  name: "MockE2bTransport",
  async make(condition) {
    const transport = new MockE2bTransport();
    const env: Record<string, string> = {};
    if (condition === "cannot_stop") {
      env[DIRECTIVE_KEYS.ignoreCancel] = "1";
      env[DIRECTIVE_KEYS.ignoreKill] = "1";
    }
    if (condition === "read_fails") env[DIRECTIVE_KEYS.readFails] = "1";
    if (condition === "state_unrecognized") env[DIRECTIVE_KEYS.stateUnknown] = "1";
    if (condition === "refuse_launch") env[DIRECTIVE_KEYS.refuseLaunch] = "1";
    if (condition === "process_read_fails") env[DIRECTIVE_KEYS.processReadFails] = "1";
    const { sandboxId } = await transport.create({ templateId: "base", timeoutMs: 5_000, metadata: {}, envVars: env });
    return { transport, sandboxId };
  },
};

/**
 * The REAL transport arm, driven through its injected SDK boundary.
 *
 * ★ WHAT THIS ARM DOES AND DOES NOT PROVE. The code under test is the SHIPPING
 * `real-transport.ts` — its parsing, its verdict derivation, its observation mapping. Only
 * the `e2b` SDK boundary is substituted, with response shapes taken from the
 * `e2b@2.30.5` type declarations.
 *
 * ★★★ AND THE CLAIM THAT USED TO STAND HERE WAS FALSE. It read "it proves that this file
 * cannot manufacture an affirmative from nothing". It did not: `processStatus` returned the
 * affirmative `{state: "gone"}` for any non-empty list whose entries carried no readable
 * numeric pid, and NO CLAUSE IN THIS FILE DROVE THAT SHAPE — so the claim was one no test
 * here could refute. See clause 12, which now does. What this arm proves is bounded: FOR
 * THE RESPONSE SHAPES DRIVEN BELOW, this file answers `unknown` rather than an affirmative.
 * That is a statement about coverage, not about the file, and it proves NOTHING about what
 * the live E2B service returns — which is the keyed arm's job, and the keyed arm reports
 * SKIPPED, never passed, when no key is present.
 */
const realArm: TransportArm = {
  name: "RealE2bTransport (SDK boundary injected)",
  async make(condition) {
    const running = { sandboxId: "sbx-real", state: "running", metadata: {} };
    const stopped = { sandboxId: "sbx-real", state: "stopped", metadata: {} };
    const unclassifiable = { sandboxId: "sbx-real", state: "hibernated", metadata: {} };
    // ★ EACH BACKGROUND LAUNCH MINTS A FRESH PID, as a real OS does, and `list()` reports
    // exactly what was launched. A double that answered the SAME pid to every `run` would
    // make clause 13's replay assertion pass on a provider that launched twice — the
    // discriminator has to be a value only ONE launch could have produced.
    let nextPid = 4242;
    const launched: number[] = [];
    const sdk = {
      getInfo: async () => {
        if (condition === "read_fails") throw new Error("e2b control API unreachable");
        if (condition === "state_unrecognized") return unclassifiable;
        // ★ `cannot_stop` is the E7-F034 condition itself: the signal is issued and the
        // sandbox is STILL RUNNING afterwards. On the pre-fix transport this returned
        // `{delivered: true}` -> `"stopped"`; the mock, under the same condition,
        // reported still-running. That disagreement IS the finding.
        return condition === "clean" ? stopped : running;
      },
      connect: async () => ({
        commands: {
          run: async (_cmd: string, opts: { background?: boolean }) => {
            expect(opts.background).toBe(true);
            if (condition === "refuse_launch") return {};
            const pid = nextPid++;
            launched.push(pid);
            return { pid };
          },
          list: async () => {
            if (condition === "process_read_fails") throw new Error("envd channel dropped");
            // Before any launch there is still one live process to be absent FROM — clause
            // 9's witnessed-absence arm needs a non-empty answer that does not contain the
            // handle it asks about.
            return launched.length > 0 ? launched.map((pid) => ({ pid })) : [{ pid: 4242 }];
          },
          kill: async () => true,
        },
      }),
    };
    return { transport: new RealE2bTransport({ apiKey: "t8-not-a-credential", sdk }), sandboxId: "sbx-real" };
  },
};

const ARMS: readonly TransportArm[] = [mockArm, realArm];

describe.each(ARMS.map((a) => [a.name, a] as const))("T8 transport arm — %s", (_name, arm) => {
  async function providerFor(condition: Condition) {
    const { transport, sandboxId } = await arm.make(condition);
    return { provider: new E2bSandboxProvider({ transport }), sandboxId, transport };
  }

  // --- clause 3: THE NEGATIVE INVARIANT -------------------------------------
  it("clause 3 — a signal that cannot stop the target NEVER yields StopOutcome 'stopped'", async () => {
    const { provider, sandboxId } = await providerFor("cannot_stop");
    expect((await provider.cancel(sandboxId, ctx())).outcome).toBe("ignored");
    expect((await provider.kill(sandboxId, ctx())).outcome).toBe("ignored");
  });

  // --- clause 4: THE POSITIVE CONTROL ---------------------------------------
  it("clause 4 — POSITIVE CONTROL: a target that genuinely stops DOES yield 'stopped'", async () => {
    // Without this, a transport hardcoded to `observed: "unknown"` passes clause 3
    // perfectly and asserts nothing. A checker needs a precision test as much as recall.
    const { provider, sandboxId } = await providerFor("clean");
    expect((await provider.cancel(sandboxId, ctx())).outcome).toBe("stopped");
  });

  // --- clause 5: THE UNKNOWN CASE IS REPRESENTABLE ---------------------------
  it("clause 5 — a read that FAILS is representable, and maps to the escalating verdict", async () => {
    // No implementation may be unable to produce "I could not tell". This is what stops
    // the type's honest inhabitant from being decorative.
    const { provider, sandboxId } = await providerFor("read_fails");
    expect((await provider.cancel(sandboxId, ctx())).outcome).toBe("ignored");
    const started = await providerStart(provider, sandboxId).catch(() => null);
    if (started !== null) {
      const status = await provider.processStatus(sandboxId, started.handle, ctx());
      expect(["running", "unknown", "gone"]).toContain(status.observation.state);
    }
  });

  // --- clause 6: THE PARTIAL / UNRECOGNIZED PAYLOAD (pins B1) ----------------
  it("clause 6 — ★★★ an UNRECOGNIZED record state maps to 'ignored', and explicitly NOT 'stopped'", async () => {
    const { provider, sandboxId } = await providerFor("state_unrecognized");
    const stop = await provider.cancel(sandboxId, ctx());
    // Assert the NEGATIVE explicitly: "stopped" is the value the pre-fix `mapState`
    // default produced, and a test that only checked the positive would pass on the
    // defect. Both arms must agree here — the mock reaches this state through its own
    // directive precisely so the case is not keyed-lane-only.
    expect(stop.outcome).not.toBe("stopped");
    expect(stop.outcome).toBe("ignored");
  });

  // --- clause 8: NO EMPTY HANDLE --------------------------------------------
  it("clause 8 — a launch that cannot be acknowledged REJECTS; no result ever carries handle ''", async () => {
    const refusing = await providerFor("refuse_launch");
    await expect(providerStart(refusing.provider, refusing.sandboxId)).rejects.toBeInstanceOf(
      ProcessLaunchNotAcknowledged,
    );
    const ok = await providerFor("clean");
    const started = await providerStart(ok.provider, ok.sandboxId);
    expect(started.handle).not.toBe("");
    expect(started.handle.length).toBeGreaterThan(0);
  });

  // --- clause 9: `gone` REQUIRES AN ANSWER -----------------------------------
  it("clause 9 — a status read that THREW is unknown/read_failed, never 'gone'", async () => {
    const failing = await providerFor("process_read_fails");
    const started = await providerStart(failing.provider, failing.sandboxId);
    const status = await failing.provider.processStatus(failing.sandboxId, started.handle, ctx());
    expect(status.observation.state).toBe("unknown");
    expect(status.observation.state).not.toBe("gone");
    expect(deriveStopVerdict(status.observation)).toBe("undetermined");

    // The other arm of the same distinction: a read that ANSWERS absence IS "gone".
    //
    // ★ TIGHTENED. This clause used to accept `["gone", "unknown"]`, which is the same
    // permissiveness the whole suite exists to refuse: a transport that answered `unknown`
    // to EVERY handle satisfied it, and so did one that answered `gone` to every handle.
    // The distinction being pinned is precise — this list ANSWERED, and this handle is a
    // well-formed one the answer does not contain — so the expected value is exactly
    // `"gone"`, and the escalating value is now the failure, not an accepted alternative.
    const live = await providerFor("clean");
    const gone = await live.provider.processStatus(live.sandboxId, "999999", ctx());
    expect(gone.observation.state).toBe("gone");
    expect(deriveStopVerdict(gone.observation)).toBe("stopped");
  });

  // --- clause 13: THE PORT'S IDEMPOTENCY CONTRACT, ON THE LAUNCH -------------
  it("clause 13 — ★ a REPLAYED idempotency key returns the recorded launch and starts nothing new", async () => {
    // `ProviderOpContext` says a repeated key "returns the recorded result and does not
    // double-apply (lost-response replay)". `startProcess` is the operation where breaking
    // that is most expensive: a retry after a lost response leaves TWO service instances
    // running in one sandbox, and the caller never learned the first handle — so the second
    // launch is invisible to the very supervisor that would stop it. That is duplicate
    // placement one layer below the epic designed around avoiding it.
    //
    // ★ THE DISCRIMINATOR IS THE HANDLE, NOT THE CALL COUNT. Both arms mint a FRESH handle
    // per real launch (mock: `${prefix}-proc-N`; real: the SDK's pid, which a second
    // `commands.run` would have to re-issue), so a provider that re-invoked the transport
    // could not return the first handle by accident.
    const { provider, sandboxId } = await providerFor("clean");
    const replayCtx: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "t8-replay-1" };
    const first = await provider.startProcess({ sandboxId, command: "sleep", args: ["infinity"], env: {} }, replayCtx);
    const second = await provider.startProcess({ sandboxId, command: "sleep", args: ["infinity"], env: {} }, replayCtx);
    expect(second.handle).toBe(first.handle);
    // The RECORDED result, returned verbatim — a fresh `providerOpId` would mean a second
    // op was minted, which is the thing being ruled out.
    expect(second.providerOpId).toBe(first.providerOpId);
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);

    // POSITIVE CONTROL — a DIFFERENT key is a different launch, so the replay ledger is not
    // just "always return the first handle", which would break every legitimate second
    // process in the same sandbox.
    const third = await provider.startProcess(
      { sandboxId, command: "sleep", args: ["infinity"], env: {} },
      { deadlineMs: 5_000, idempotencyKey: "t8-replay-2" },
    );
    expect(third.handle).not.toBe(first.handle);
  });

  // --- clause 11: ★ THE ARMS AGREE ON CAPABILITY (the E7-F034 shape, pinned) --
  it("clause 11 — ★ no arm claims a graceful process cancel the shipping transport lacks", async () => {
    // THE DOUBLE MUST NOT BE MORE CAPABLE THAN PRODUCTION. `e2b@2.30.5` exposes no per-pid
    // SIGTERM (`Commands.kill` is SIGKILL and takes no signal selector), so a graceful
    // process cancel is reported ABSENT. A mock that instead stopped the process would be
    // E7-F034 rebuilt one layer up — and this clause, asserted of BOTH arms, is what makes
    // that a red rather than a review note.
    const { provider, sandboxId } = await providerFor("clean");
    const started = await providerStart(provider, sandboxId);
    const result = await provider.signalProcess(sandboxId, started.handle, "cancel", ctx());
    expect(result.accepted).toBe("unsupported");
    // ...and it STILL carries a real re-read: the process may have stopped for other reasons.
    expect(result.observation).toBeDefined();
    // Nothing about the process may be derived from `accepted` — the type has no member
    // that could name a stop.
    expect(result).not.toHaveProperty("outcome");
  });
});

async function providerStart(provider: E2bSandboxProvider, sandboxId: string) {
  return provider.startProcess({ sandboxId, command: "sleep", args: ["infinity"], env: {} }, ctx());
}

// =============================================================================
// Clause 12 — ★★★ AN UNCLASSIFIABLE PROCESS LIST IS NOT AN ABSENCE.
//
// ★ THIS CLAUSE IS ASSERTED OF THE REAL ARM EXPLICITLY, AND THAT IS THE POINT.
// `MockE2bTransport` keeps a typed in-memory process store; there is no payload shape it
// could return that its own reader fails to classify, so this condition is STRUCTURALLY
// UNREACHABLE on the mock arm. Folding it into the `describe.each` above would produce a
// clause that passes on the mock by never firing — a test that cannot fire is this
// repository's defining failure class, and hiding one inside the suite written to prevent
// it would be that failure two layers deep. So the arm is named, and only the shipping
// binding is driven.
//
// WHAT IT PINS. `RealE2bTransport.processStatus` walked `commands.list()` looking for a
// numeric `pid` and, finding none, fell through to `return {state: "gone"}` — the
// affirmative absence, from a payload it could not read a single entry of.
// `gone -> deriveStopVerdict -> "stopped"`, the TERMINATING verdict. The realistic
// producer is an SDK FIELD RENAME (`pid` -> `processId`) inside the pinned `^2.30.5`
// range: exactly the class `mapState` was repaired for one method away, rebuilt inside
// this PR's own repair. It was self-inconsistent too — a NON-array payload already
// yielded `unknown/state_unrecognized`; only the unclassifiable-ENTRIES case failed open.
// =============================================================================

describe("T8 clause 12 — RealE2bTransport: a process list it cannot classify is 'unknown', never 'gone'", () => {
  /** Drive the SHIPPING transport with a `commands.list()` that answers `payload`. */
  async function statusOver(payload: unknown) {
    const sdk = {
      getInfo: async () => ({ sandboxId: "sbx-real", state: "running", metadata: {} }),
      connect: async () => ({
        commands: {
          run: async () => ({ pid: 4242 }),
          list: async () => payload,
          kill: async () => true,
        },
      }),
    };
    const provider = new E2bSandboxProvider({
      transport: new RealE2bTransport({ apiKey: "t8-not-a-credential", sdk }),
    });
    return provider.processStatus("sbx-real", "4242", ctx());
  }

  // Every shape a real SDK response could plausibly take that carries no readable numeric
  // pid. `[{processId: 4242}]` is the realistic one — a field rename — and the rest are the
  // partial/typed/null variants that arrive with a degraded or error-shaped body.
  const UNCLASSIFIABLE: ReadonlyArray<[string, unknown]> = [
    ["an SDK field rename", [{ processId: 4242 }]],
    ["entries with no fields at all", [{}]],
    ["entries that are bare strings", ["4242"]],
    ["a pid carried as a string", [{ pid: "4242" }]],
    ["a null entry", [null]],
  ];

  for (const [name, payload] of UNCLASSIFIABLE) {
    it(`★ ${name} → unknown/state_unrecognized, and explicitly NOT 'gone'`, async () => {
      const status = await statusOver(payload);
      // Assert the NEGATIVE first and by name: `"gone"` is the value the defect produced,
      // and a test that only checked the positive would pass on it.
      expect(status.observation.state).not.toBe("gone");
      expect(status.observation).toEqual({ state: "unknown", reason: "state_unrecognized" });
      // ...and the derived verdict is the ESCALATING one, never the terminating one.
      expect(deriveStopVerdict(status.observation)).toBe("undetermined");
      expect(deriveStopVerdict(status.observation)).not.toBe("stopped");
    });
  }

  it("★ a MIXED list whose READABLE entries do not contain the pid is also not an absence", async () => {
    // To claim a pid is ABSENT you must have read every entry: the one you could not read
    // might have been it. Stricter than the minimum the review named, and it is what the
    // `gone` contract actually implies.
    const status = await statusOver([{ pid: 1 }, { processId: 9999 }]);
    expect(status.observation).toEqual({ state: "unknown", reason: "state_unrecognized" });
  });

  it("★ ...but a POSITIVE MATCH beside an unreadable entry is still 'running'", async () => {
    // The rule is about the ABSENCE conclusion only. Finding the pid is a witnessed
    // presence, and an unreadable neighbour cannot unmake it — degrading this to `unknown`
    // would throw away a real observation, which is the opposite failure.
    const status = await statusOver([{ pid: 4242 }, { processId: 9999 }]);
    expect(status.observation.state).toBe("running");
  });

  it("POSITIVE CONTROL — an EMPTY list is a legitimate witnessed absence: 'gone'", async () => {
    // Without this the clause is passed perfectly by a transport hardcoded to `unknown`,
    // which asserts nothing — the same inversion that let `delivered: true` pass every
    // ladder test. An empty answer IS an answer: nothing is running.
    const status = await statusOver([]);
    expect(status.observation.state).toBe("gone");
    expect(deriveStopVerdict(status.observation)).toBe("stopped");
  });

  it("POSITIVE CONTROL — a readable list containing the pid is 'running'", async () => {
    const status = await statusOver([{ pid: 4242 }]);
    expect(status.observation.state).toBe("running");
  });

  it("a readable list NOT containing the pid stays 'gone' — the classifiable path is unchanged", async () => {
    const status = await statusOver([{ pid: 1 }, { pid: 2 }]);
    expect(status.observation.state).toBe("gone");
  });

  it("a NON-array payload keeps its existing answer — the two cases now AGREE", async () => {
    // The self-inconsistency was the tell: this branch was already honest while the
    // unclassifiable-entries branch beside it was not.
    const status = await statusOver({ processes: [] });
    expect(status.observation).toEqual({ state: "unknown", reason: "state_unrecognized" });
  });
});

// =============================================================================
// Clause 7 — the unsupported mode THROWS, on every provider that declares it.
// =============================================================================

describe("T8 clause 7 — a `processSupervisionMode: \"none\"` provider throws and returns no observation", () => {
  const NONE_PROVIDERS: ReadonlyArray<[string, () => SandboxProvider, "unsupported" | "null-object"]> = [
    ["NetworkedProviderDriver", () => new NetworkedProviderDriver({ baseUrl: "http://127.0.0.1:1" }), "unsupported"],
    // ★ The null object is the ONE declared exception, and it is named rather than
    // silently accepted: `createNoopProvider` throws `NoopProviderReachedError` from EVERY
    // op including `checkpoint`/`restore`/`health`, because reaching it at all is a
    // supervisor bug, not a capability question. That is its shipped, deliberate contract
    // and predates this ticket. What clause 7 requires of it is unchanged: it REJECTS, and
    // it never returns an observation.
    ["createNoopProvider (null object)", () => createNoopProvider(), "null-object"],
  ];

  for (const [name, make, kind] of NONE_PROVIDERS) {
    it(`${name} declares "none" and rejects all three`, async () => {
      const provider = make();
      expect(provider.processSupervisionMode).toBe("none");
      const calls = [
        () => provider.startProcess({ sandboxId: "s", command: "c", args: [], env: {} }, CTX),
        () => provider.processStatus("s", "h", CTX),
        () => provider.signalProcess("s", "h", "kill", CTX),
      ];
      for (const call of calls) {
        // `Promise.resolve().then(call)` so a SYNCHRONOUS throw (the null object's shape)
        // is caught the same way an async rejection is — a caller must never receive a
        // resolved observation either way.
        await expect(Promise.resolve().then(call)).rejects.toThrow();
        if (kind === "unsupported") {
          await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(UnsupportedProviderOperation);
        }
      }
    });
  }

  it("★ no implementation names unsupportedness inside an OBSERVATION", () => {
    // `provider_unsupported` was deleted from `ProcessUnknownReason`: it was the one
    // member naming a call that was never made, and it would have given `unknown` two
    // incompatible handlings (escalate-and-retry vs never-call-again). A deleted
    // inhabitant that survives in one implementer is a fork, so the grep is the clause.
    const survivors = walkForPattern(/provider_unsupported/);
    expect(survivors, `provider_unsupported must not survive anywhere: ${survivors.join(", ")}`).toHaveLength(0);
  });
});

// =============================================================================
// Clause 10 — the keyed arm is SKIPPED, never passed, when no key is present.
// =============================================================================

describe("T8 clause 10 — the keyed real-E2B arm", () => {
  const hasKey = typeof process.env.E2B_API_KEY === "string" && process.env.E2B_API_KEY.length > 0;
  const onWindowsWithoutOptIn = process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1";
  const runKeyed = hasKey && !onWindowsWithoutOptIn;

  // ★ `it.skipIf`, never a silent `if (!key) return`. A keyless "green" on the arm whose
  // ENTIRE PURPOSE is to disagree with the double would be this same failure class one
  // level up: the reporter must say SKIPPED so nobody reads the run as evidence.
  it.skipIf(!runKeyed)(
    "against a real E2B account: an unreadable state is not a stop, and a real stop is",
    async () => {
      // Deliberately minimal and deliberately UNRUN here. Whoever holds a key runs it; the
      // structural half of §9.1 is answered from the SDK's type declarations, and the
      // behavioural half is answered only by this.
      const transport = new RealE2bTransport({});
      expect(transport.processSupervisionMode).toBe("handle");
      const provider = new E2bSandboxProvider({ transport });
      const created = await provider.create(
        { resourceLabels: LABELS, command: "sleep", args: ["infinity"], env: {}, workloadType: "batch" },
        ctx(),
      );
      try {
        const started = await provider.startProcess(
          { sandboxId: created.sandboxId, command: "sleep", args: ["infinity"], env: {} },
          ctx(),
        );
        expect(started.handle).not.toBe("");
        const live = await provider.processStatus(created.sandboxId, started.handle, ctx());
        expect(live.observation.state).toBe("running");
        const killed = await provider.signalProcess(created.sandboxId, started.handle, "kill", ctx());
        expect(killed.accepted).toBe("accepted");
        expect(deriveStopVerdict(killed.observation)).toBe("stopped");
        // The capability this lane does NOT have, asserted rather than assumed.
        const graceful = await provider.signalProcess(created.sandboxId, started.handle, "cancel", ctx());
        expect(graceful.accepted).toBe("unsupported");
      } finally {
        await provider.destroy(created.sandboxId, ctx());
      }
    },
  );
});
