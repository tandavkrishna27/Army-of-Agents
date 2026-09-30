// -----------------------------------------------------------------------------
// SVC-008a A2/A3 — ★★★ IS THE ESCALATION LADDER REACHABLE NOW?
//
// E7-F034's realized harm #3: `cleanup_escalation{escalation_stage}` could only ever
// report `"cancel"` in production, because `RealE2bTransport.signal` always answered
// `{delivered: true}` -> `StopOutcome "stopped"`, so `CleanupAuthority.#convergeOne`'s
// `if (cancel.outcome === "ignored")` was never true and `escalate()` was reached only at
// its one unconditional call site. Meanwhile the two production-metric pinning tests
// assert `escalation_stage="destroy"` — a value production could not emit.
//
// This file answers the question by RUNNING the shipped `CleanupAuthority` over the
// shipped `E2bSandboxProvider` over the shipped `RealE2bTransport` (SDK boundary injected;
// see `svc-008a-witnessed-stop.test.ts` for exactly what that does and does not prove).
//
// ★ FOR A CLASSIFIABLE RECORD, NOTHING ABOUT RESOURCE BEHAVIOUR CHANGES. The forced
// `destroy` after the ladder was always unconditional, so no such sandbox was ever leaked by
// this defect and none is reclaimed differently now. What changes is that the RUNG executes
// and the metric becomes TRUE: "this provider has no graceful stop; every cancellation is a
// hard teardown" — the single most useful fact about the lane, previously unfalsifiable.
//
// ★★★ AND FOR AN UNCLASSIFIABLE ONE, IT CHANGES — this header used to say "nothing about
// resource behaviour changes" full stop, which was false. Such a record was previously
// laundered by `mapState`'s default into `"stopped"`, a terminal state, and ran the ordinary
// ladder to a forced `destroy`. It now throws out of `inspect`, the ownership gate refuses,
// and `#convergeOne` reports "failed" with NO destroy issued — deliberately non-destructive
// (no teardown against a record whose ownership could not be established), and deliberately
// retryable, but a real change, and the one an operator most needs to know about.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { CleanupAuthority, type EffectFence, type ResourceLabels } from "@armyofagents/worker-daemon";

import { E2bSandboxProvider } from "../e2b-provider.js";
import { RealE2bTransport } from "../real-transport.js";
import { METADATA_KEYS } from "../directives.js";

const LABELS: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

const FENCE: EffectFence = {
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  fenceToken: "fence-1",
  deviceGeneration: 7,
  observedSeq: 0,
};

let seq = 0;
const makeCtx = () => ({ deadlineMs: 5_000, idempotencyKey: `esc-${++seq}` });

/**
 * A sandbox that CANNOT be stopped by a signal — i.e. the production condition. `getInfo`
 * keeps reporting `running`; only `kill` (terminate) actually reclaims it.
 *
 * `stateAfterSignal` may be a SEQUENCE, consumed one entry per `getInfo` with the last
 * entry repeating forever. That is what lets a test drive the ORDER in which a record stops
 * being classifiable — see the ordering clauses below, which a single-shot fixture cannot
 * express.
 */
function ladderFixture(opts: { readonly stateAfterSignal: string | readonly string[] }) {
  const calls: string[] = [];
  let terminated = false;
  const states = typeof opts.stateAfterSignal === "string" ? [opts.stateAfterSignal] : opts.stateAfterSignal;
  let reads = 0;
  const currentState = (): string => {
    const state = states[Math.min(reads, states.length - 1)];
    reads += 1;
    return state;
  };
  const record = () => ({
    sandboxId: "sbx-ladder",
    state: terminated ? "stopped" : currentState(),
    metadata: { [METADATA_KEYS.labels]: JSON.stringify(LABELS) },
  });
  const sdk = {
    getInfo: async () => {
      calls.push("getInfo");
      return record();
    },
    kill: async () => {
      calls.push("terminate");
      terminated = true;
      return true;
    },
  };
  const provider = new E2bSandboxProvider({
    transport: new RealE2bTransport({ apiKey: "ladder-not-a-credential", sdk }),
  });
  // Count the provider-level ladder rungs by wrapping, so the assertion is about which
  // RUNGS RAN — not about how many metadata reads happened underneath.
  const rungs: string[] = [];
  const wrapped = new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && (prop === "cancel" || prop === "kill" || prop === "destroy")) {
        return (...args: unknown[]) => {
          rungs.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { provider: wrapped, rungs, calls };
}

function authorityOver(provider: E2bSandboxProvider): CleanupAuthority {
  return new CleanupAuthority({
    provider,
    resourceLabels: LABELS,
    targetGeneration: LABELS.deviceGeneration,
    fence: FENCE,
    deadline: Number.MAX_SAFE_INTEGER,
    epoch: 0,
  });
}

describe("SVC-008a A2 — the `kill` rung EXECUTES against a sandbox a signal cannot stop", () => {
  it("cancel(ignored) -> kill(ignored) -> forced destroy, and the stage reaches 'destroy'", async () => {
    const { provider, rungs } = ladderFixture({ stateAfterSignal: "running" });
    const authority = authorityOver(provider);

    const status = await authority.converge(["sbx-ladder"], makeCtx);

    expect(status).toBe("success");
    // ★ RED BEFORE THE FIX: `cancel` returned "stopped", the `if` at `#convergeOne` was
    // false, `kill` was NEVER CALLED, and the stage stayed at "cancel". Assert the rung
    // list, not just the final stage — a set assertion would pass under a converge that
    // skipped straight to destroy.
    expect(rungs).toEqual(["cancel", "kill", "destroy"]);
    // A3 — the observable an operator reads. `"destroy"` is the value the two shipped
    // pinning tests already assert and production could not previously emit.
    expect(authority.escalationStage()).toBe("destroy");
  });

  it("★★★ an UNREADABLE record does NOT disarm the reaper — it reports 'failed', retryably", async () => {
    // ★ THE DESIGN CONTRADICTION THIS TEST FOUND. SVC-008a §4.2 A-iii ruled `inspect`
    // must THROW on an unclassifiable record, and §6 recorded that `CleanupAuthority`
    // needs "None." code change. Both cannot hold: `#requireOwned` gates every teardown op
    // on `inspect`, and `#convergeOne` caught only `ResourceNotAvailableError` — so the
    // throw escaped `converge()` BEFORE the unconditional forced destroy, leaking a paid
    // resource. That is strictly worse than E7-F034, which leaked nothing.
    //
    // The shipped resolution: `SandboxRecordIndeterminateError` moved onto the PORT and
    // `#convergeOne` reports `"failed"` for it — no false convergence, no teardown against
    // a record whose ownership could not be established, and the resource stays
    // discoverable for the next pass. Non-destructive AND non-silent.
    const { provider, rungs, calls } = ladderFixture({ stateAfterSignal: "hibernated" });
    const authority = authorityOver(provider);

    const status = await authority.converge(["sbx-ladder"], makeCtx);

    expect(status).toBe("failed"); // retryable, and NEVER a false "success"
    // NO rung ran at all: the ownership gate (`#requireOwned` -> `inspect`) refused before
    // `provider.cancel` was reached, which is the correct order — no teardown may be
    // performed against a record whose ownership could not be established.
    expect(rungs).toEqual([]);
    expect(calls).not.toContain("terminate");
  });

  // ★★★ THE ORDERING CLAUSES. A record that classifies ONCE and then does not.
  //
  // The shipped indeterminate handling wrapped the CANCEL rung ONLY. `#requireOwned` gates
  // ALL THREE teardown ops on `inspect`, and a provider record is re-read at every rung — so
  // a record that was readable at cancel and became unreadable at the kill or destroy
  // ownership check threw `SandboxRecordIndeterminateError` straight PAST `converge()`.
  //
  // ★ AND THE THROW IS NOT MERELY UNTIDY: `supervisor.ts` sets `run.cleanedUp = true` BEFORE
  // calling `converge`, so the terminal latch is already consumed when the rejection
  // escapes. The retry is suppressed and the paid sandbox survives until an external reaper
  // finds it — the leak WRK-004 exists to prevent, reached through the repair for E7-F034.
  //
  // ★ A SINGLE-SHOT INDETERMINATE FIXTURE PASSES WITHOUT EXERCISING ANY OF THIS (the test
  // above it is exactly that fixture, and it was green on the defect). Only a fixture that
  // drives the ORDER of classification reaches the later rungs, which is why `ladderFixture`
  // takes a sequence.

  it("★★★ a record that becomes UNREADABLE at the KILL rung reports 'failed' — it does not throw past converge", async () => {
    // reads: 1 inspect(cancel)=running, 2 signal(cancel)=running -> ignored,
    //        3 inspect(kill)=hibernated -> indeterminate.
    const { provider, rungs, calls } = ladderFixture({
      stateAfterSignal: ["running", "running", "hibernated"],
    });
    const authority = authorityOver(provider);

    // RED BEFORE THE FIX: this REJECTED with SandboxRecordIndeterminateError.
    const status = await authority.converge(["sbx-ladder"], makeCtx);

    expect(status).toBe("failed"); // retryable, and NEVER a false "success"
    // The cancel rung ran (the record was still readable then); the kill rung's ownership
    // gate refused, so no teardown was performed against an unreadable record.
    expect(rungs).toEqual(["cancel"]);
    expect(calls).not.toContain("terminate");
  });

  it("★★★ a record that becomes UNREADABLE at the DESTROY rung reports 'failed' too", async () => {
    // reads: 1 inspect(cancel), 2 signal(cancel) -> ignored, 3 inspect(kill),
    //        4 signal(kill) -> ignored, 5 inspect(destroy)=hibernated -> indeterminate.
    const { provider, rungs, calls } = ladderFixture({
      stateAfterSignal: ["running", "running", "running", "running", "hibernated"],
    });
    const authority = authorityOver(provider);

    const status = await authority.converge(["sbx-ladder"], makeCtx);

    expect(status).toBe("failed");
    expect(rungs).toEqual(["cancel", "kill"]);
    expect(calls).not.toContain("terminate");
    // The ladder still ADVANCED to destroy before the gate refused — the escalation is
    // monotonic and the next pass resumes from there rather than restarting at cancel.
    expect(authority.escalationStage()).toBe("destroy");
  });

  it("POSITIVE CONTROL — the destroy RETRY loop still runs when the record stays readable", async () => {
    // Without this, an implementation that returned "failed" from the destroy rung
    // unconditionally would pass both clauses above and reclaim nothing, ever.
    const { provider, rungs, calls } = ladderFixture({ stateAfterSignal: ["running"] });
    const status = await authorityOver(provider).converge(["sbx-ladder"], makeCtx);
    expect(status).toBe("success");
    expect(rungs).toEqual(["cancel", "kill", "destroy"]);
    expect(calls).toContain("terminate");
  });

  it("POSITIVE CONTROL — a sandbox that DOES comply still skips the kill rung", async () => {
    // Without this, an implementation that always escalated would pass both cases above
    // and prove nothing about the ladder's monotonic shape. The ladder must still be a
    // ladder: a compliant cancel skips `kill`.
    const { provider, rungs } = ladderFixture({ stateAfterSignal: "stopped" });
    const authority = authorityOver(provider);
    await authority.converge(["sbx-ladder"], makeCtx);
    expect(rungs).toEqual(["cancel", "destroy"]);
    expect(authority.escalationStage()).toBe("cancel");
  });
});

describe("SVC-008a — the resource is still reclaimed on every CLASSIFIABLE record", () => {
  it("the forced destroy runs unconditionally, exactly as before", async () => {
    for (const state of ["running", "paused", "stopped"]) {
      const { provider, calls } = ladderFixture({ stateAfterSignal: state });
      const status = await authorityOver(provider).converge(["sbx-ladder"], makeCtx);
      // `terminate` is the FIRST and ONLY real termination on this lane, and it happened
      // in every CLASSIFIABLE case. For these three states nothing was leaked before this
      // ticket and nothing is now: what was lost was the RUNG, not the resource. The
      // unclassifiable case is the exception, and it is asserted separately above —
      // deliberately NOT reclaimed, deliberately reported "failed", deliberately retryable.
      expect(calls, `state=${state}`).toContain("terminate");
      expect(status, `state=${state}`).toBe("success");
    }
  });
});
