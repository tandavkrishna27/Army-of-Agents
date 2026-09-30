/**
 * DSK-004 Lane D — stop leasing, drain, and only then swap (I9, clauses 2 and 3).
 *
 * Almost nothing here is new behaviour, and that is the point. WRK-003 already stops
 * leasing before draining, WRK-005 already stops renewal timers so no renew fires during
 * a drain, and WRK-006 already orders the outbox as stop → flush → close. Lane D wires an
 * update onto those verbs instead of re-deriving them.
 *
 * So the invariant worth testing is a COMPOSITION invariant: the update sequence must be
 * the shared `createLeaseLifecycleSteps` output, not a second list that happens to agree
 * with it today. Two lists that agree by coincidence drift the first time one is edited,
 * and the drift is silent because both still look plausible.
 *
 * ONE THING GENUINELY DIFFERS FROM SHUTDOWN, and it is a policy difference rather than an
 * ordering one. `createShutdownHandler` deliberately SWALLOWS a failing step, because a
 * process that is exiting must exit regardless. An update is not exiting: if the drain
 * fails, in-flight work is still running, and swapping the pointer would kill it. The
 * same steps therefore run under the opposite failure policy — fail closed, leave the
 * pointer alone.
 */

import { describe, expect, it, vi } from "vitest";

import { createLeaseLifecycleSteps } from "../../lifecycle/shutdown.js";
import { createUpdateDrainSteps, runDrainBeforeSwap } from "../drain-before-swap.js";

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    leasing: {
      stopLeasing: () => void calls.push("lease-stop"),
      drain: async () => void calls.push("lease-drain"),
    },
    renewal: { stop: () => void calls.push("renewal-stop") },
    outbox: {
      stopDrain: () => void calls.push("outbox-stop"),
      flush: async () => void calls.push("outbox-flush"),
      closeStore: () => void calls.push("outbox-close"),
    },
  };
}

describe("DSK-004/I9 — the ordering is COMPOSED, not restated", () => {
  it("uses the shared lease steps verbatim, in the shared order", () => {
    // If someone re-derives `[lease-stop, renewal-stop, lease-drain]` inline here, this
    // keeps passing until WRK-003's order changes — and then the update path silently
    // keeps the old one. Comparing against the shared builder is what prevents that.
    const r = recorder();
    const shared = createLeaseLifecycleSteps(r.leasing, r.renewal).map((s) => s.name);
    const update = createUpdateDrainSteps({ leasing: r.leasing, renewal: r.renewal }).map(
      (s) => s.name,
    );
    expect(update).toEqual(shared);
  });

  it("stops leasing BEFORE draining, with renewal stopped in between", () => {
    const r = recorder();
    const names = createUpdateDrainSteps({ leasing: r.leasing, renewal: r.renewal }).map(
      (s) => s.name,
    );
    expect(names.indexOf("lease-stop")).toBeLessThan(names.indexOf("lease-drain"));
    expect(names.indexOf("renewal-stop")).toBeLessThan(names.indexOf("lease-drain"));
  });

  it("puts the outbox AFTER the drain, so work finished during drain is flushed", () => {
    // Clause (3) — the outbox survives — is satisfied by layout (it lives beside the
    // vault, not under the install root). Ordering still matters for what is IN it: a
    // flush before the drain would miss every event the draining work produced.
    const r = recorder();
    const names = createUpdateDrainSteps({
      leasing: r.leasing,
      renewal: r.renewal,
      outbox: r.outbox,
    }).map((s) => s.name);
    expect(names).toEqual([
      "lease-stop",
      "renewal-stop",
      "lease-drain",
      "event-outbox-stop",
      "event-outbox-flush",
      "event-outbox-close",
    ]);
  });

  it("omits renewal and outbox steps when those drivers are not wired", () => {
    const r = recorder();
    expect(createUpdateDrainSteps({ leasing: r.leasing }).map((s) => s.name)).toEqual([
      "lease-stop",
      "lease-drain",
    ]);
  });
});

const logger = { info: () => {}, error: () => {} };

describe("DSK-004 — the swap happens only after every step has settled", () => {
  it("runs the steps in order and swaps last", async () => {
    const r = recorder();
    const swap = vi.fn(async () => void r.calls.push("SWAP"));
    const result = await runDrainBeforeSwap({
      steps: createUpdateDrainSteps({ leasing: r.leasing, renewal: r.renewal, outbox: r.outbox }),
      swap,
      logger,
    });
    expect(result).toEqual({ outcome: "swapped" });
    expect(r.calls).toEqual([
      "lease-stop",
      "renewal-stop",
      "lease-drain",
      "outbox-stop",
      "outbox-flush",
      "outbox-close",
      "SWAP",
    ]);
  });

  it("awaits an ASYNC step before moving on", async () => {
    // A drain that is not awaited is not a drain. If the step sequence fired and
    // returned, the swap would land on top of work that is still running.
    const order: string[] = [];
    const slow = {
      name: "slow-drain",
      stop: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("drain-finished");
      },
    };
    await runDrainBeforeSwap({
      steps: [slow],
      swap: async () => void order.push("SWAP"),
      logger,
    });
    expect(order).toEqual(["drain-finished", "SWAP"]);
  });
});

describe("DSK-004 — a failed drain REFUSES the swap (opposite policy to shutdown)", () => {
  it("does not swap when a step throws, and names the step", async () => {
    const r = recorder();
    const steps = [
      { name: "lease-stop", stop: () => void r.calls.push("lease-stop") },
      {
        name: "lease-drain",
        stop: () => {
          throw new Error("a lease would not settle");
        },
      },
    ];
    const swap = vi.fn();
    const result = await runDrainBeforeSwap({ steps, swap, logger });
    expect(result).toEqual({ outcome: "refused", reason: "step_failed", failedStep: "lease-drain" });
    expect(swap).not.toHaveBeenCalled();
  });

  it("stops at the first failure rather than running the remaining steps", async () => {
    // Continuing past a failed drain would close the outbox while work is still
    // producing events into it.
    const ran: string[] = [];
    const result = await runDrainBeforeSwap({
      steps: [
        {
          name: "lease-drain",
          stop: () => {
            throw new Error("nope");
          },
        },
        { name: "event-outbox-close", stop: () => void ran.push("event-outbox-close") },
      ],
      swap: async () => void ran.push("SWAP"),
      logger,
    });
    expect(result.outcome).toBe("refused");
    expect(ran).toEqual([]);
  });

  it("reports a swap that itself fails, without pretending it succeeded", async () => {
    const result = await runDrainBeforeSwap({
      steps: [],
      swap: async () => {
        throw new Error("pointer write failed");
      },
      logger,
    });
    expect(result).toEqual({ outcome: "refused", reason: "swap_failed", failedStep: null });
  });
});

describe("DSK-004 — caller-supplied garbage is refused, never thrown", () => {
  it("refuses a missing or non-callable swap", async () => {
    for (const bad of [undefined, null, 0, "swap", {}]) {
      const result = await runDrainBeforeSwap({ steps: [], swap: bad as never, logger });
      expect(result.outcome, JSON.stringify(bad) ?? "undefined").toBe("refused");
      expect(result.outcome === "refused" && result.reason).toBe("malformed_input");
    }
  });

  it("refuses non-array steps rather than iterating something else", async () => {
    const swap = vi.fn();
    for (const bad of [undefined, null, 0, "steps", {}]) {
      const result = await runDrainBeforeSwap({ steps: bad as never, swap, logger });
      expect(result.outcome, JSON.stringify(bad) ?? "undefined").toBe("refused");
    }
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses to build steps without a leasing lifecycle", () => {
    for (const bad of [undefined, null, {}, { leasing: {} }]) {
      expect(() => createUpdateDrainSteps(bad as never), JSON.stringify(bad) ?? "undefined").toThrow(
        /leasing/i,
      );
    }
  });
});
