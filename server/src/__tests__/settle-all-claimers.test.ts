import { describe, expect, it } from "vitest";

import { settleAllClaimers } from "./helpers/settle-all-claimers.js";

// ★ THE ANTI-REGRESSION PROBLEM THIS FILE SOLVES.
//
// The E3-F034 fix makes a concurrent-claimer race stop leaking into the next test. A test
// that "passes because the leak no longer happens" is indistinguishable from one that
// passes because it stopped looking — the leak only manifested on a slow CI runner in the
// first place, so timing can never be the evidence.
//
// So this pins the PROPERTY instead, with no database and no race: **an early rejection
// must not be reported until every other claimer has settled.** That is the entire
// mechanism of the cascade, stated as something a mutation can break. Reverting
// `settleAllClaimers` to `Promise.all` reds the first test below deterministically, because
// `Promise.all` rejects on a microtask while the slow claimer is still pending.

/** A claimer that stays pending until `finish()` is called, and records that it ran to completion. */
function deferredClaimer(): { promise: Promise<string>; finish: () => void; settled: () => boolean } {
  let settled = false;
  let release: () => void = () => {};
  const promise = new Promise<string>((resolve) => {
    release = () => { settled = true; resolve("finished"); };
  });
  return { promise, finish: () => release(), settled: () => settled };
}

describe("settleAllClaimers — E3-F034 cascade containment", () => {
  it("★ does NOT report an early rejection until every other claimer has settled", async () => {
    const straggler = deferredClaimer();
    // The straggler finishes on a macrotask. `Promise.all` would reject on a MICROtask,
    // i.e. strictly before this timer can run — so the assertion below is a direction, not
    // a race: with `Promise.all` it is always false, with `Promise.allSettled` always true.
    setTimeout(() => straggler.finish(), 20);

    const failing = Promise.reject(Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    }));

    let thrown: unknown;
    let stragglerSettledWhenThrown: boolean | null = null;
    try {
      await settleAllClaimers([failing, straggler.promise], "two-claimer race");
    } catch (error) {
      thrown = error;
      stragglerSettledWhenThrown = straggler.settled();
    }

    expect(thrown).toBeInstanceOf(Error);
    // THE PROPERTY. Nothing from this race is still in flight when the failure surfaces.
    expect(stragglerSettledWhenThrown).toBe(true);
  });

  it("★ a rejected claimer is STILL a failure — the settle does not soften the verdict", async () => {
    const boom = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    await expect(settleAllClaimers([Promise.resolve("ok"), Promise.reject(boom)], "race"))
      .rejects.toThrow(/1 of 2 concurrent claimers REJECTED/);
  });

  it("names the failing claimer, its index and its SQLSTATE — the second half of E3-F034's cost", async () => {
    const boom = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    const error = await settleAllClaimers([Promise.resolve("a"), Promise.reject(boom)], "poll race")
      .then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toContain("poll race");
    expect(error?.message).toContain("[1]");
    expect(error?.message).toContain("55P03");
    expect((error as { cause?: unknown } | null)?.cause).toBe(boom);
  });

  it("returns fulfilled values in claimer order when nothing rejects", async () => {
    const values = await settleAllClaimers(
      [Promise.resolve("first"), Promise.resolve("second"), Promise.resolve("third")],
      "race",
    );
    expect(values).toEqual(["first", "second", "third"]);
  });

  it("summarises beyond the first three rejections instead of printing a wall", async () => {
    const claimers = Array.from({ length: 7 }, (_, index) => Promise.reject(new Error(`boom-${index}`)));
    const error = await settleAllClaimers(claimers, "race").then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toContain("7 of 7 concurrent claimers REJECTED");
    expect(error?.message).toContain("… and 4 more");
  });
});
