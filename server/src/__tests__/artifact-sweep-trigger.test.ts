// DAT-011 — the orphan sweep is triggered by artifact-commit events, not by a scheduler.
//
// WHY NOT A SCHEDULER: a per-tenant sweep would have to ENUMERATE ORGANIZATIONS, and the
// tenant repository boundary deliberately has no unscoped reader ("a raw cross-tenant helper
// would sidestep the tenant context and forced RLS"). Building that enumeration for
// housekeeping would punch a hole in the tenancy model. A commit event already arrives
// inside the right tenant context.
//
// ★ The two properties that matter most here are NEGATIVE ones: the sweep must never change
// a commit outcome, and it must never widen what is eligible.

import { describe, expect, it, vi } from "vitest";

import { createSweepTrigger, shouldRunSweep } from "../services/artifact-sweep-trigger.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-08-24T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe("DAT-011 — debounce decision", () => {
  it("runs when an organization has never been swept", () => {
    expect(shouldRunSweep({ lastRunAt: undefined, now: T0, intervalMs: 60_000 })).toBe(true);
  });

  it("★ does NOT run again inside the interval", () => {
    // Commits can be frequent; sweeping on each would re-run the same indexed query for
    // nothing. A mutation removing the debounce dies here.
    expect(shouldRunSweep({ lastRunAt: T0, now: at(59_999), intervalMs: 60_000 })).toBe(false);
  });

  it("runs again once the interval has elapsed", () => {
    expect(shouldRunSweep({ lastRunAt: T0, now: at(60_001), intervalMs: 60_000 })).toBe(true);
  });

  it("treats the exact boundary as not-yet-elapsed", () => {
    expect(shouldRunSweep({ lastRunAt: T0, now: at(60_000), intervalMs: 60_000 })).toBe(false);
  });
});

describe("DAT-011 — trigger", () => {
  function deps(over: Partial<Parameters<typeof createSweepTrigger>[0]> = {}) {
    return {
      runSweep: vi.fn(async () => ({ examined: 0, examinedNothing: true, swept: 0, failed: 0, refusals: {}, actionable: [] })),
      now: () => T0,
      intervalMs: 60_000,
      onError: vi.fn(),
      ...over,
    };
  }

  it("sweeps the organization the event came from", async () => {
    const d = deps();
    const t = createSweepTrigger(d);
    await t.triggerAndWait(ORG);
    expect(d.runSweep).toHaveBeenCalledWith(ORG, T0);
  });

  it("★ debounces per ORGANIZATION, not globally", async () => {
    // A busy org must not starve a quiet one of its sweep. A mutation collapsing the map to
    // a single timestamp dies here.
    const d = deps();
    const t = createSweepTrigger(d);
    await t.triggerAndWait(ORG);
    await t.triggerAndWait(OTHER);
    expect(d.runSweep).toHaveBeenCalledTimes(2);
  });

  it("★ a second event inside the interval does NOT sweep again", async () => {
    const d = deps();
    const t = createSweepTrigger(d);
    await t.triggerAndWait(ORG);
    await t.triggerAndWait(ORG);
    expect(d.runSweep).toHaveBeenCalledTimes(1);
  });

  it("sweeps again after the interval elapses", async () => {
    let clock = T0;
    const d = deps({ now: () => clock });
    const t = createSweepTrigger(d);
    await t.triggerAndWait(ORG);
    clock = at(60_001);
    await t.triggerAndWait(ORG);
    expect(d.runSweep).toHaveBeenCalledTimes(2);
  });

  it("★ a THROWING sweep is swallowed — it must never reach the caller", async () => {
    // The caller is the artifact-commit path. A failed sweep is litter left for next time;
    // a failed commit is lost work. This is the property the whole design turns on.
    const d = deps({ runSweep: vi.fn(async () => { throw new Error("storage down"); }) });
    const t = createSweepTrigger(d);
    await expect(t.triggerAndWait(ORG)).resolves.toBeUndefined();
    expect(d.onError).toHaveBeenCalled();
  });

  it("★ a failed sweep does NOT consume the debounce slot", async () => {
    // Otherwise one transient storage error silences sweeping for that org for a whole
    // interval, and the failure is invisible because the sweep is best-effort.
    let fail = true;
    const d = deps({ runSweep: vi.fn(async () => { if (fail) throw new Error("boom"); return { examined: 0, examinedNothing: true, swept: 0, failed: 0, refusals: {}, actionable: [] }; }) });
    const t = createSweepTrigger(d);
    await t.triggerAndWait(ORG);
    fail = false;
    await t.triggerAndWait(ORG);
    expect(d.runSweep).toHaveBeenCalledTimes(2);
  });

  it("fire-and-forget `trigger` returns immediately and does not reject", () => {
    const d = deps({ runSweep: vi.fn(async () => { throw new Error("boom"); }) });
    const t = createSweepTrigger(d);
    expect(() => t.trigger(ORG)).not.toThrow();
  });
});
