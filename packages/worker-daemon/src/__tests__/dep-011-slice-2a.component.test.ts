// -----------------------------------------------------------------------------
// DEP-011 Slice 2a — the WORKER side: the per-run provider factory seam, the
// capability threading, the null-object late-binding (§2a.3) and the honest-cleanup
// timing (§2a.5). Ships INERT.
//
// This drives `createSupervisor` DIRECTLY with `makeRunProvider` + a hand-fed handoff
// + an injected clock, so the timing-sensitive supervisor logic is deterministic. The
// per-run provider is a FAKE (the real `NetworkedProviderDriver` lives OUTSIDE the
// daemon's boundary — §2a.1 — and importing it here would create a `pnpm -r build`
// cycle). The REAL minted-cap ↔ REAL gated-server crossing (a: cap verifies, b: the
// model key crosses the wire into the provider) is proven end-to-end in the
// adapter-manager component test `dep-011-slice-2a-crossing.component.test.ts`, which
// sits below the provider-wire/e2b/provider-capability cluster with no cycle. Here we
// prove the WORKER seam: the driver is built AFTER redemption, the model key reaches
// the per-run provider's create env (provider.peek), the value + cap sig NEVER leak to
// the supervisor's events or logs, and every abnormal path is null-object-safe.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { createSupervisor } from "../supervisor/supervisor.js";
import { SandboxNotFoundError, type SandboxProvider } from "../supervisor/provider.js";
import { NoopProviderReachedError } from "../supervisor/noop-provider.js";
import { createMetrics } from "../metrics/metrics.js";
import type { Logger } from "../logging/logger.js";
import type { OwnedLabelsCapabilityLike } from "../lease/owned-labels-capability.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";
import { collectingSink, handoffLabels, makeHandoff, SUPERVISOR_IDENTITY } from "./support/supervisor-fixtures.js";

const REDEEMED_VALUE = "sk-ant-fixture-dep011-2a-000";
const CAP_SIG = "dep011-2a-cap-sig-marker";
/** The fake provider derives this id from the handoff's job/attempt/lease labels. */
const SANDBOX_ID = `fake-sbx-${POLL_FIXTURE_IDS.job}-1-${POLL_FIXTURE_IDS.lease}`;
/** The exact labels `labelsFor(handoff)` produces — the cap's `ownedLabels`. */
const RUN_LABELS = handoffLabels();

/** A cap-like object (the fake provider is un-gated, so no real signature is needed — the real
 * cap↔gate verification is the adapter-manager crossing test). */
function capLike(expiresAt: number): OwnedLabelsCapabilityLike {
  return { v: 1, audience: "adapter-manager", ownedLabels: RUN_LABELS, expiresAt, sig: CAP_SIG };
}

function spyLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const rec = (...args: unknown[]): void => {
    lines.push(JSON.stringify(args));
  };
  const logger = {
    info: (...a: unknown[]) => rec("info", ...a),
    warn: (...a: unknown[]) => rec("warn", ...a),
    error: (...a: unknown[]) => rec("error", ...a),
    flush: async () => {},
  } as unknown as Logger;
  return { logger, lines };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function settle(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

describe("DEP-011 Slice 2a — fail-fast construction", () => {
  it("both provider AND makeRunProvider set ⇒ throws (which authority does buildRun build?)", () => {
    expect(() =>
      createSupervisor({
        provider: createFakeSandboxProvider({}),
        makeRunProvider: () => createFakeSandboxProvider({}),
        identity: SUPERVISOR_IDENTITY,
        eventSink: collectingSink(),
        redactionCanaries: [],
        materializeRunSecrets: async () => ({ env: {}, canaries: [] }),
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("makeRunProvider WITHOUT materializeRunSecrets ⇒ throws (the rebuild would never run)", () => {
    expect(() =>
      createSupervisor({
        makeRunProvider: () => createFakeSandboxProvider({}),
        identity: SUPERVISOR_IDENTITY,
        eventSink: collectingSink(),
        redactionCanaries: [],
      }),
    ).toThrow(/requires materializeRunSecrets/);
  });
});

describe("DEP-011 Slice 2a — the per-run driver is built AFTER redemption + the crossing lands (b/c)", () => {
  it("the driver is built post-redemption: create/execute/destroy hit the makeRunProvider provider, and the model key CROSSES into its create env (provider.peek)", async () => {
    const provider = createFakeSandboxProvider({});
    let factoryCalls = 0;
    const { logger, lines } = spyLogger();
    const sink = collectingSink();
    const supervisor = createSupervisor({
      makeRunProvider: () => {
        factoryCalls += 1;
        return provider;
      },
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: () => 1000,
      logger,
      // the redeemed model key + its per-run canary + the run capability, as materialize yields them.
      materializeRunSecrets: async () => ({
        env: { ANTHROPIC_API_KEY: REDEEMED_VALUE },
        canaries: [REDEEMED_VALUE],
        capability: capLike(9_999_999),
      }),
    });
    await supervisor.accept(makeHandoff());

    // The factory ran ONCE, AFTER redemption (never at buildRun); the run went create→execute→destroy.
    expect(factoryCalls).toBe(1);
    const ops = provider.calls().filter((c) => !c.replayed).map((c) => c.op);
    expect(ops).toEqual(["create", "execute", "destroy"]);
    expect(supervisor.activeRunCount()).toBe(0);

    // (b) the redeemed model key CROSSED into the per-run provider's create env (provider.peek).
    expect(provider.peek(SANDBOX_ID)?.env.ANTHROPIC_API_KEY).toBe(REDEEMED_VALUE);

    // (c) #104 containment — the value + the cap sig NEVER reach the supervisor's emitted events…
    const events = JSON.stringify(sink.events);
    expect(events.includes(POLL_FIXTURE_IDS.lease), "positive control: real event content present").toBe(true);
    expect(events.includes(REDEEMED_VALUE), "redeemed value absent from events").toBe(false);
    expect(events.includes(CAP_SIG), "cap sig absent from events").toBe(false);
    // …NOR the worker logs (positive control: the run leaseId is logged).
    const logs = lines.join("\n");
    expect(logs.includes(POLL_FIXTURE_IDS.lease), "positive control: real log content present").toBe(true);
    expect(logs.includes(REDEEMED_VALUE), "redeemed value absent from logs").toBe(false);
    expect(logs.includes(CAP_SIG), "cap sig absent from logs").toBe(false);
  });
});

describe("DEP-011 Slice 2a — fail-closed + null-object late-binding + honest cleanup", () => {
  it("(d) ZERO-CAPABILITY fail-closed — redemption succeeds but yields NO cap ⇒ no driver, no create, a diagnosable terminal", async () => {
    let factoryCalls = 0;
    const sink = collectingSink();
    const supervisor = createSupervisor({
      makeRunProvider: () => {
        factoryCalls += 1;
        return createFakeSandboxProvider({});
      },
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      now: () => 1000,
      materializeRunSecrets: async () => ({ env: {}, canaries: [] }), // NO capability
    });
    await supervisor.accept(makeHandoff());
    expect(factoryCalls, "no driver built with capability:undefined").toBe(0);
    expect(supervisor.activeRunCount(), "no run leaked").toBe(0);
    const terminal = sink.events.find((e) => e.eventType === "terminal");
    expect(terminal?.payload).toMatchObject({ status: "failed", errorCode: "no_run_capability" });
  });

  it("(e) a cancel delivered MID-REDEMPTION does not throw or strand — the null-object authorities absorb it (no TypeError)", async () => {
    const provider = createFakeSandboxProvider({});
    const mat = deferred();
    const { logger, lines } = spyLogger();
    const supervisor = createSupervisor({
      makeRunProvider: () => provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      redactionCanaries: [],
      now: () => 1000,
      logger,
      materializeRunSecrets: async () => {
        await mat.promise;
        return { env: {}, canaries: [], capability: capLike(9_999_999) };
      },
    });
    const handoff = makeHandoff();
    const running = supervisor.accept(handoff);
    // The run is registered and BLOCKED at redemption (null-object authorities in place).
    await settle(() => supervisor.activeRunCount() === 1, 1000);
    // Deliver the cancel DURING the redemption window — reaches escalateCleanup with NO try/catch.
    await supervisor.cancel(handoff.leaseId, "cancel_mid_redemption");
    mat.resolve();
    await expect(running).resolves.toBeUndefined();
    expect(supervisor.activeRunCount(), "run cleaned up, no map leak").toBe(0);
    // The null-object never let an EFFECTFUL op through, and nothing NPE'd.
    const logs = lines.join("\n");
    expect(logs).not.toContain("TypeError");
    expect(logs).not.toContain(NoopProviderReachedError.name);
  });

  it("(f) an EXPIRED cap at the happy destroy records a DISTINCT `orphaned` outcome — never `success`/`failed`, converge NEVER called", async () => {
    let clock = 1000;
    const gate = deferred();
    const provider = createFakeSandboxProvider({ executeGate: gate.promise });
    const metrics = createMetrics();
    const sink = collectingSink();
    const supervisor = createSupervisor({
      makeRunProvider: () => provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      redactionCanaries: [],
      metrics,
      now: () => clock,
      // cap valid at create (clock 1000 < 5000), expires before the run ends.
      materializeRunSecrets: async () => ({ env: {}, canaries: [], capability: capLike(5000) }),
    });
    const running = supervisor.accept(makeHandoff());
    // Hold at execute (create already succeeded), then advance the clock PAST the cap expiry.
    await settle(() => provider.callCount("execute") >= 1, 1000);
    clock = 6000;
    gate.resolve();
    await running;

    const prom = metrics.renderPrometheus();
    // The run terminal is still `succeeded` (frozen — the orphan is a cleanup outcome, not a terminal).
    const terminal = sink.events.find((e) => e.eventType === "terminal");
    expect(terminal?.payload).toMatchObject({ status: "succeeded" });
    // A DISTINCT `orphaned` cleanup outcome, present and NOT masked as success/failed.
    expect(prom).toContain('cleanup_outcome{outcome="orphaned"} 1');
    expect(prom).not.toContain('cleanup_outcome{outcome="success"}');
    expect(prom).not.toContain('cleanup_outcome{outcome="failed"}');
    // converge was NEVER called — NO teardown op reached the provider.
    expect(provider.callCount("destroy")).toBe(0);
    expect(provider.callCount("cancel")).toBe(0);
    expect(provider.callCount("kill")).toBe(0);
  });

  it("(f2) escalateCleanup with an EXPIRED cap orphans CLOCK-FIRST — never the gate-masking converge", async () => {
    let clock = 1000;
    const gate = deferred();
    const provider = createFakeSandboxProvider({ executeGate: gate.promise });
    const metrics = createMetrics();
    const supervisor = createSupervisor({
      makeRunProvider: () => provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      redactionCanaries: [],
      metrics,
      now: () => clock,
      materializeRunSecrets: async () => ({ env: {}, canaries: [], capability: capLike(5000) }),
    });
    const handoff = makeHandoff();
    const running = supervisor.accept(handoff);
    await settle(() => provider.callCount("execute") >= 1, 1000);
    clock = 6000; // the lease-clamped cap is now expired
    await supervisor.cancel(handoff.leaseId, "cancel_expired");
    gate.resolve();
    await running;

    const prom = metrics.renderPrometheus();
    expect(prom).toContain('cleanup_outcome{outcome="orphaned"} 1');
    expect(prom).not.toContain('cleanup_outcome{outcome="success"}');
    // CLOCK-FIRST: NO gate-masking teardown op reached the provider (the standard converge would
    // have cancelled/destroyed the fake and reported a FALSE success).
    expect(provider.callCount("destroy")).toBe(0);
    expect(provider.callCount("cancel")).toBe(0);
  });

  it("(g) a genuinely-gone sandbox (cap STILL valid on re-read) → `success`, NOT a false orphan", async () => {
    const clock = 1000;
    const gate = deferred();
    // create/execute succeed; the sandbox is GONE at teardown (inspect → SandboxNotFoundError →
    // #requireOwned maps to the uniform RNA). The cap stays valid, so RNA means GONE → success.
    const base = createFakeSandboxProvider({ executeGate: gate.promise });
    const goneProvider: SandboxProvider = {
      ...base,
      inspect: async () => {
        throw new SandboxNotFoundError();
      },
    };
    const metrics = createMetrics();
    const supervisor = createSupervisor({
      makeRunProvider: () => goneProvider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      redactionCanaries: [],
      metrics,
      now: () => clock,
      materializeRunSecrets: async () => ({ env: {}, canaries: [], capability: capLike(9_999_999) }),
    });
    const handoff = makeHandoff();
    const running = supervisor.accept(handoff);
    await settle(() => base.callCount("execute") >= 1, 1000);
    // Cancel while held at execute ⇒ escalateCleanup ⇒ convergeNetworked over the GONE sandbox.
    await supervisor.cancel(handoff.leaseId, "cancel_gone");
    gate.resolve();
    await running;

    const prom = metrics.renderPrometheus();
    // A valid cap + RNA = genuinely gone = success, never a false orphan.
    expect(prom).toContain('cleanup_outcome{outcome="success"} 1');
    expect(prom).not.toContain('cleanup_outcome{outcome="orphaned"}');
  });
});
