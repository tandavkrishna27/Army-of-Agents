// -----------------------------------------------------------------------------
// DEP-011 Slice A — the pure INERT `reconcileReaper` proven against fakes.
//
// A seeded fake fleet (orphan / live / unknown, some already-gone, some transient-
// `failed`, some throwing, some STRUCTURALLY-INVALID) + a fake `resolveTruth` oracle.
// The fake `list` reproduces `E2bSandboxProvider.list`'s sandboxId-keyed page cursor
// (`findIndex(pageToken)+1`, destroyed rows excluded) so snapshot-first is a REAL test:
// a reclaim-in-scan mutant would shift the cursor and mis-handle survivors.
//
// Assertions (a)-(h) map to DEP-011 §R.4; the mutation sweep below each block names the
// mutant it kills. `E2bSandboxProvider` is deliberately NOT named here (a hand-rolled
// fake), and this is a `.test.ts` (excluded from `check-gate-clause-wiring`).
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type {
  CleanupResult,
  ListInput,
  ListResult,
  ProviderOpContext,
  ResourceLabels,
  ResourceSummary,
  SandboxState,
} from "@armyofagents/worker-daemon";

import {
  reconcileReaper,
  type ReaperVerdict,
  type ReconcileReaperDeps,
  type ReconcileReaperResult,
} from "../reconcile-reaper.js";

// --- fixtures ----------------------------------------------------------------

const VALID_LABELS: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

/** What `reconcileCleanup` does for a given sandbox. */
type CleanupBehavior = "success" | "gone" | "failed" | "throw";

interface Seed {
  readonly sandboxId: string;
  /** Overrides on the valid label tuple (e.g. drop leaseId to make it invalid). */
  readonly labels?: Partial<ResourceLabels> | null;
  readonly generation?: number;
  readonly state?: SandboxState;
  readonly hasLiveLease?: boolean;
  readonly behavior?: CleanupBehavior;
}

function summaryOf(seed: Seed): ResourceSummary {
  const labels =
    seed.labels === null
      ? ({} as ResourceLabels) // parse-failure shape: E2bSandboxProvider.list defaults {}
      : { ...VALID_LABELS, ...(seed.labels ?? {}) };
  const generation = seed.generation ?? (seed.labels === null ? 0 : labels.deviceGeneration);
  return {
    sandboxId: seed.sandboxId,
    resourceLabels: labels,
    generation,
    state: seed.state ?? "running",
    hasLiveLease: seed.hasLiveLease ?? false,
  };
}

/** A fake provider exposing only the `list` + `reconcileCleanup` the reaper touches.
 * `list` paginates exactly like the real E2B driver so cursor-shift is testable. */
class FakeProvider {
  readonly #summaries: ResourceSummary[];
  readonly #behavior = new Map<string, CleanupBehavior>();
  readonly #destroyed = new Set<string>();
  /** Ordered log of every provider op — "list" or "reconcile:<id>". */
  readonly events: string[] = [];
  readonly reconcileCalls: string[] = [];
  #opId = 0;

  constructor(seeds: readonly Seed[]) {
    this.#summaries = seeds.map(summaryOf);
    for (const s of seeds) this.#behavior.set(s.sandboxId, s.behavior ?? "success");
  }

  isDestroyed(id: string): boolean {
    return this.#destroyed.has(id);
  }

  async list(input: ListInput, _ctx: ProviderOpContext): Promise<ListResult> {
    this.events.push("list");
    const all = this.#summaries
      .filter((s) => !this.#destroyed.has(s.sandboxId))
      .sort((a, b) => (a.sandboxId < b.sandboxId ? -1 : a.sandboxId > b.sandboxId ? 1 : 0));
    let start = 0;
    if (input.pageToken != null) {
      const idx = all.findIndex((s) => s.sandboxId === input.pageToken);
      start = idx + 1;
    }
    const page = all.slice(start, start + input.pageSize);
    const nextPageToken =
      start + input.pageSize < all.length ? page[page.length - 1]!.sandboxId : null;
    return { providerOpId: `list-${this.#opId++}`, resources: page, nextPageToken };
  }

  async reconcileCleanup(sandboxId: string, _ctx: ProviderOpContext): Promise<CleanupResult> {
    this.events.push(`reconcile:${sandboxId}`);
    this.reconcileCalls.push(sandboxId);
    const behavior = this.#behavior.get(sandboxId) ?? "success";
    const providerOpId = `cleanup-${this.#opId++}`;
    if (behavior === "throw") throw new Error(`provider fault on ${sandboxId}`);
    if (behavior === "failed") {
      // Transient — the LIVE sandbox SURVIVES (not destroyed). Retried next pass.
      return { providerOpId, cleanupStatus: "failed" };
    }
    // "success" or already-"gone": both idempotently converge to success.
    this.#destroyed.add(sandboxId);
    return { providerOpId, cleanupStatus: "success" };
  }
}

/** A fake oracle. Records every batch it was handed, and returns exactly `verdicts`
 * (an id absent from `verdicts` is therefore absent from the map → defaults to skip). */
function makeOracle(verdicts: Record<string, ReaperVerdict>) {
  const batches: ResourceSummary[][] = [];
  const resolveTruth: ReconcileReaperDeps["resolveTruth"] = async (summaries) => {
    batches.push([...summaries]);
    const map = new Map<string, ReaperVerdict>();
    for (const s of summaries) {
      const v = verdicts[s.sandboxId];
      if (v !== undefined) map.set(s.sandboxId, v);
    }
    return map;
  };
  return { resolveTruth, batches };
}

const ctx: ProviderOpContext = { deadlineMs: 5_000, idempotencyKey: "reaper-sweep" };

function depsFor(
  provider: FakeProvider,
  resolveTruth: ReconcileReaperDeps["resolveTruth"],
  overrides: Partial<ReconcileReaperDeps> = {},
): ReconcileReaperDeps {
  return {
    provider,
    resolveTruth,
    makeCtx: () => ctx,
    now: () => 1_000,
    ...overrides,
  };
}

// --- the whole-fleet sweep: (a),(b),(c),(e),(g),(h) --------------------------

describe("reconcileReaper — the fail-closed whole-fleet sweep", () => {
  it("reclaims ONLY confirmed orphans; skips live/unknown/absent; skips invalid without the oracle", async () => {
    const seeds: Seed[] = [
      { sandboxId: "sbx-orphan-1", behavior: "success" },
      { sandboxId: "sbx-orphan-gone", behavior: "gone" }, // (g) already-gone = success
      { sandboxId: "sbx-orphan-supersed", generation: 2, behavior: "success" }, // (h) any-generation
      { sandboxId: "sbx-orphan-failed", behavior: "failed" }, // (e) transient failed
      { sandboxId: "sbx-live-1", hasLiveLease: true }, // (b) live → skip
      { sandboxId: "sbx-unknown-1" }, // (b) unknown → skip
      { sandboxId: "sbx-absent" }, // map-absent → default unknown → skip
      { sandboxId: "sbx-invalid-nolease", labels: { leaseId: "" } }, // (c) invalid
      { sandboxId: "sbx-invalid-gen0", generation: 0 }, // (c) invalid (gen-0 sentinel)
    ];
    const provider = new FakeProvider(seeds);
    const oracle = makeOracle({
      "sbx-orphan-1": "orphan",
      "sbx-orphan-gone": "orphan",
      "sbx-orphan-supersed": "orphan",
      "sbx-orphan-failed": "orphan",
      "sbx-live-1": "live",
      "sbx-unknown-1": "unknown",
      // "sbx-absent" deliberately omitted
    });

    const result = await reconcileReaper(depsFor(provider, oracle.resolveTruth));

    // (a) only the four orphans were reconciled — never live/unknown/absent/invalid.
    expect(new Set(provider.reconcileCalls)).toEqual(
      new Set(["sbx-orphan-1", "sbx-orphan-gone", "sbx-orphan-supersed", "sbx-orphan-failed"]),
    );

    // Counts (disjoint, summing to scanned).
    const expected: ReconcileReaperResult = { reaped: 3, skipped: 1, unknown: 4, failed: 1 };
    expect(result).toEqual(expected);
    expect(result.reaped + result.skipped + result.unknown + result.failed).toBe(seeds.length);

    // (e) the transient-failed orphan's LIVE sandbox SURVIVES (never destroyed).
    expect(provider.isDestroyed("sbx-orphan-failed")).toBe(false);
    // …the three real reaps did destroy.
    expect(provider.isDestroyed("sbx-orphan-1")).toBe(true);
    expect(provider.isDestroyed("sbx-orphan-gone")).toBe(true);
    expect(provider.isDestroyed("sbx-orphan-supersed")).toBe(true);

    // (c) the two structurally-invalid summaries never reached the oracle.
    expect(oracle.batches).toHaveLength(1);
    const oracledIds = oracle.batches[0]!.map((s) => s.sandboxId);
    expect(oracledIds).not.toContain("sbx-invalid-nolease");
    expect(oracledIds).not.toContain("sbx-invalid-gen0");
    expect(oracledIds).toHaveLength(7);
  });

  // MUTATION — default the map-miss to "orphan" (`?? "orphan"`): "sbx-absent" would be
  //   reclaimed → killed (reconcileCalls would contain it; unknown would drop to 3).
  // MUTATION — treat "unknown" as reclaimable (drop the `verdict !== "orphan"` skip):
  //   "sbx-unknown-1"/"sbx-absent" destroyed (mass-kill) → killed by the reconcileCalls set.
  // MUTATION — remove the structural pre-filter (oracle sees all): oracledIds length 9,
  //   and if the oracle marked an invalid id "orphan" it would be reclaimed → killed by (c).
  // MUTATION — count a `failed` cleanup as `reaped` (`else reaped++`): reaped 4 / failed 0
  //   and isDestroyed("sbx-orphan-failed") assertion → killed by (e).
});

// --- (h) any-generation, isolated (incl. a wildly-superseded generation) -----

describe("reconcileReaper — any-generation reclaim", () => {
  it("reclaims a confirmed orphan regardless of generation (no generation-equality gate)", async () => {
    const provider = new FakeProvider([
      { sandboxId: "sbx-gen-2", generation: 2, behavior: "success" },
      { sandboxId: "sbx-gen-99", generation: 99, behavior: "success" },
    ]);
    const oracle = makeOracle({ "sbx-gen-2": "orphan", "sbx-gen-99": "orphan" });

    const result = await reconcileReaper(depsFor(provider, oracle.resolveTruth));

    expect(result).toEqual({ reaped: 2, skipped: 0, unknown: 0, failed: 0 });
    expect(new Set(provider.reconcileCalls)).toEqual(new Set(["sbx-gen-2", "sbx-gen-99"]));
  });

  // MUTATION — add a `summary.generation === deps.identity...` equality gate: a superseded
  //   orphan would be skipped → killed (reaped would drop below 2).
});

// --- (c) the oracle can NEVER reach a structurally-invalid summary ------------

describe("reconcileReaper — structural pre-filter is absolute", () => {
  it("never reclaims an invalid summary even when the oracle would call it an orphan", async () => {
    const provider = new FakeProvider([
      { sandboxId: "sbx-invalid", labels: null }, // {} labels + gen 0
      { sandboxId: "sbx-ok-orphan", behavior: "success" },
    ]);
    // A hostile/buggy oracle that would mark the invalid id an orphan — but it never
    // receives it (pre-filtered), so the map key is dead.
    const oracle = makeOracle({ "sbx-invalid": "orphan", "sbx-ok-orphan": "orphan" });

    const result = await reconcileReaper(depsFor(provider, oracle.resolveTruth));

    expect(provider.reconcileCalls).toEqual(["sbx-ok-orphan"]);
    expect(provider.isDestroyed("sbx-invalid")).toBe(false);
    expect(result).toEqual({ reaped: 1, skipped: 0, unknown: 1, failed: 0 });
    // proof the oracle never saw it
    expect(oracle.batches[0]!.map((s) => s.sandboxId)).toEqual(["sbx-ok-orphan"]);
  });

  // MUTATION — pass `summaries` (not the pre-filtered set) to resolveTruth AND iterate it:
  //   the invalid id would be reconciled → killed (reconcileCalls would include it).
});

// --- (d) snapshot-first: the fleet is fully listed BEFORE any reclaim --------

describe("reconcileReaper — snapshot-first", () => {
  it("lists the entire multi-page fleet before any reclaim, handling each row exactly once", async () => {
    const seeds: Seed[] = ["a", "b", "c", "d", "e"].map((k) => ({
      sandboxId: `sbx-${k}`,
      behavior: "success" as const,
    }));
    const provider = new FakeProvider(seeds);
    const oracle = makeOracle(Object.fromEntries(seeds.map((s) => [s.sandboxId, "orphan"])));

    const result = await reconcileReaper(depsFor(provider, oracle.resolveTruth, { pageSize: 2 }));

    // All five reclaimed exactly once.
    expect(result).toEqual({ reaped: 5, skipped: 0, unknown: 0, failed: 0 });
    expect(provider.reconcileCalls.sort()).toEqual([
      "sbx-a",
      "sbx-b",
      "sbx-c",
      "sbx-d",
      "sbx-e",
    ]);
    // ★ Every `list` precedes every `reconcile` — a reclaim-in-scan mutant (which
    //   destroys mid-pagination) would interleave them and shift the sandboxId cursor.
    const firstReconcile = provider.events.findIndex((e) => e.startsWith("reconcile:"));
    const lastList = provider.events.lastIndexOf("list");
    expect(lastList).toBeLessThan(firstReconcile);
    // 3 pages over 5 rows at pageSize 2.
    expect(provider.events.filter((e) => e === "list")).toHaveLength(3);
  });

  // MUTATION — list-and-reclaim per page (no snapshot): after destroying sbx-a/sbx-b, the
  //   next list's pageToken=sbx-b findIndex is -1 → re-lists from the top → double/att
  //   handling → killed by the exactly-once reconcileCalls + the ordering assertion.
});

// --- (f) a per-target throw is contained; the sweep continues ----------------

describe("reconcileReaper — per-target containment", () => {
  it("contains a throwing reclaim and still reclaims the orphans after it", async () => {
    // Sorted order: sbx-1 (success), sbx-2 (throw), sbx-3 (success). The throw is in the
    // MIDDLE so a real reclaim must land AFTER it for containment to hold.
    const provider = new FakeProvider([
      { sandboxId: "sbx-1", behavior: "success" },
      { sandboxId: "sbx-2", behavior: "throw" },
      { sandboxId: "sbx-3", behavior: "success" },
    ]);
    const oracle = makeOracle({ "sbx-1": "orphan", "sbx-2": "orphan", "sbx-3": "orphan" });

    const result = await reconcileReaper(depsFor(provider, oracle.resolveTruth));

    // The sweep did not abort: all three were attempted; sbx-1 & sbx-3 reaped, sbx-2 failed.
    expect(provider.reconcileCalls).toEqual(["sbx-1", "sbx-2", "sbx-3"]);
    expect(result).toEqual({ reaped: 2, skipped: 0, unknown: 0, failed: 1 });
    expect(provider.isDestroyed("sbx-1")).toBe(true);
    expect(provider.isDestroyed("sbx-3")).toBe(true);
    expect(provider.isDestroyed("sbx-2")).toBe(false); // threw — survives
  });

  // MUTATION — drop the per-target try/catch: sbx-2's throw aborts the sweep, sbx-3 is
  //   never reached → killed (reconcileCalls would be ["sbx-1","sbx-2"], and reconcileReaper
  //   would reject instead of resolving).
});
