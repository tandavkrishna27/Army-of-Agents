/**
 * E0-F013 Decision 3.2 — the WRITE BOUND on the tenant-less denial sink, proven
 * with an injected sink and an injected clock so the bound itself is the subject
 * and no database is involved.
 *
 * ★ WHY THE BOUND EXISTS. The fourteen tenant-less deny sites record to the
 * operator-only sink, and every one is reachable without a credential or a
 * validated tenant. The founder attached a write bound to the ruling precisely
 * because an unbounded recorder call there would let a prober flood the
 * operator's ONLY evidence table (`activity_log`). This file proves a flood of
 * M ≫ N attempts yields at most N + 1 rows per (surface, source-key) window AND
 * that the suppressed remainder is recorded, not silently dropped.
 *
 * ★ THE COARSE KEY CANNOT BE ROTATED BY THE ATTACKER. A separate arm proves that
 * varying the caller-supplied `companyId`/`entityId` (which a prober varies
 * infinitely) does NOT mint a fresh bucket — the bucket is keyed on
 * (surface, sourceKey) only, so the cap holds however the attacker shapes the
 * request body.
 */
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@armyofagents/db";
import {
  createBoundedDenialRecorder,
  SUPPRESSED_DENIALS_REASON,
  SUPPRESSED_DENIALS_ENTITY_TYPE,
  type DenialSink,
} from "../services/bounded-denial-recorder.js";
import type { SecurityDenialInput } from "../services/security-denial-audit.js";

/** A fake persistence seam that records every write instead of touching PG. */
function fakeSink(): { sink: DenialSink; writes: SecurityDenialInput[] } {
  const writes: SecurityDenialInput[] = [];
  const sink: DenialSink = async (_db, input) => {
    writes.push(input);
    return `row-${writes.length}`;
  };
  return { sink, writes };
}

const DB = {} as Db;

function baseInput(overrides: Partial<SecurityDenialInput & { sourceKey?: string | null }> = {}) {
  return {
    companyId: null,
    organizationId: null,
    crossing: "DE-21",
    surface: "live_events_upgrade_unattributed",
    reason: "agent_key_unknown",
    actorType: "agent" as const,
    actorId: "unknown",
    entityType: "live_events_stream",
    entityId: "probed-company",
    control: "test",
    sourceKey: "203.0.113.7",
    ...overrides,
  };
}

describe("bounded-denial-recorder — the write bound (E0-F013 Decision 3.2)", () => {
  it("★ FLOOD PROOF: M ≫ N attempts in one window write ≤ N rows, and the suppressed remainder is aggregated into ONE row", async () => {
    const { sink, writes } = fakeSink();
    const now = vi.fn(() => 1_000_000);
    const N = 5;
    const M = 500;
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: N,
      windowMs: 60_000,
      now,
      sink,
    });

    let recorded = 0;
    let suppressed = 0;
    for (let i = 0; i < M; i += 1) {
      // The attacker varies the caller-supplied fields every request. It must not
      // help them: the bucket is keyed on (surface, sourceKey), not these.
      const r = await recorder.record(DB, baseInput({ entityId: `victim-${i}`, companyId: null }));
      if (r.outcome === "recorded") recorded += 1;
      else suppressed += 1;
    }

    // At most N full rows were written; the rest were suppressed (counted, not lost).
    expect(recorded).toBe(N);
    expect(suppressed).toBe(M - N);
    expect(writes).toHaveLength(N);

    // Force the aggregate for the pending suppressed count (a periodic sweep or the
    // next window's first hit does this in production).
    const emitted = await recorder.flush(DB);
    expect(emitted).toBe(1);

    // Total rows for the whole flood ≤ N + 1 (the O(1) aggregate). Flood-proof.
    expect(writes).toHaveLength(N + 1);
    const aggregate = writes[writes.length - 1];
    expect(aggregate.reason).toBe(SUPPRESSED_DENIALS_REASON);
    expect(aggregate.entityType).toBe(SUPPRESSED_DENIALS_ENTITY_TYPE);
    expect(aggregate.companyId).toBeNull();
    expect((aggregate.details as Record<string, unknown>)?.suppressedCount).toBe(M - N);
    // The aggregate keeps the reserved surface so slice 1 hides it and the operator
    // reader shows it.
    expect(aggregate.surface).toBe("live_events_upgrade_unattributed");
  });

  it("★ THE CAP CANNOT BE BYPASSED by rotating the caller-supplied company/entity", async () => {
    const { sink, writes } = fakeSink();
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: 3,
      windowMs: 60_000,
      now: () => 5_000,
      sink,
    });

    // 100 hits, each with a DIFFERENT caller-supplied companyId AND entityId, all
    // from the SAME coarse source key. If the bucket keyed on those, this would
    // write 100 rows. It must write exactly the cap.
    for (let i = 0; i < 100; i += 1) {
      await recorder.record(
        DB,
        baseInput({ companyId: null, entityId: `probe-${i}`, sourceKey: "198.51.100.9" }),
      );
    }
    expect(writes).toHaveLength(3);
  });

  it("distinct source keys get independent budgets (a per-source cap, not a global one)", async () => {
    const { sink, writes } = fakeSink();
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: 2,
      windowMs: 60_000,
      now: () => 7_000,
      sink,
    });
    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
      for (let i = 0; i < 10; i += 1) {
        await recorder.record(DB, baseInput({ sourceKey: ip }));
      }
    }
    // 3 sources × 2 rows each = 6 full rows (each source independently capped).
    expect(writes).toHaveLength(6);
  });

  it("distinct surfaces get independent budgets", async () => {
    const { sink, writes } = fakeSink();
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: 2,
      windowMs: 60_000,
      now: () => 9_000,
      sink,
    });
    for (const surface of ["live_events_upgrade_unattributed", "cloud_plugin_execution"]) {
      for (let i = 0; i < 10; i += 1) {
        await recorder.record(DB, baseInput({ surface, sourceKey: "172.16.0.5" }));
      }
    }
    expect(writes).toHaveLength(4);
  });

  it("a new window resets the budget AND flushes the prior window's suppressed count on the next hit", async () => {
    const { sink, writes } = fakeSink();
    let clock = 0;
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: 2,
      windowMs: 1_000,
      now: () => clock,
      sink,
    });

    // Window 1: 5 hits → 2 rows + 3 suppressed.
    for (let i = 0; i < 5; i += 1) await recorder.record(DB, baseInput());
    expect(writes).toHaveLength(2);

    // Advance past the window. The first hit of window 2 flushes window 1's
    // aggregate (suppressed=3) and then writes a fresh full row.
    clock = 1_500;
    await recorder.record(DB, baseInput());
    // writes now: 2 (w1 full) + 1 (w1 aggregate) + 1 (w2 full) = 4.
    expect(writes).toHaveLength(4);
    const aggregate = writes[2];
    expect(aggregate.reason).toBe(SUPPRESSED_DENIALS_REASON);
    expect((aggregate.details as Record<string, unknown>)?.suppressedCount).toBe(3);
  });

  it("★ CONCURRENCY PROOF: N parallel rollovers across a window boundary write ≤ cap+1 rows per bucket (claim-then-await), NOT N", async () => {
    const { sink, writes } = fakeSink();
    let clock = 0;
    const cap = 1;
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: cap,
      windowMs: 1_000,
      now: () => clock,
      sink,
    });

    // Prime the bucket in window 1 with a pending suppressed tail. This matters:
    // it makes the rollover branch actually reach `await emitAggregate` (which is
    // only awaited when there is a suppressed sample), which is the exact yield
    // the pre-fix code straddled. First hit → 1 full row; second → over cap →
    // suppressed=1, sample set.
    await recorder.record(DB, baseInput());
    await recorder.record(DB, baseInput());
    const writesAfterPriming = writes.length;
    expect(writesAfterPriming).toBe(1); // only the single full row so far

    // Advance PAST the window, then fire N denials for the SAME (surface, source)
    // bucket concurrently. Every one observes the expired bucket. Under the old
    // await-before-reset ordering they ALL rolled over → N aggregate rows + N full
    // rows (2N total, cap bypassed). With claim-then-await the shared bucket is
    // reset synchronously before any await, so exactly one call rolls over and the
    // rest see the fresh window.
    clock = 2_000;
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, () => recorder.record(DB, baseInput())),
    );

    const batchWrites = writes.length - writesAfterPriming;
    // The invariant: per (surface, source) bucket per window, at most `cap` full
    // rows + at most ONE aggregate row — even under N concurrent calls straddling
    // the boundary. NOT N. (Pre-fix this was 2N = 100.)
    expect(batchWrites).toBeLessThanOrEqual(cap + 1);
    expect(batchWrites).toBeLessThan(N);

    // And the prior window's suppressed tail was preserved (one aggregate carrying
    // the suppressed count), never lost to the race.
    const aggregates = writes.filter((w) => w.reason === SUPPRESSED_DENIALS_REASON);
    expect(aggregates).toHaveLength(1);
    expect((aggregates[0]?.details as Record<string, unknown>)?.suppressedCount).toBe(1);
  });

  it("★ MEMORY IS BOUNDED: past maxKeys, the oldest bucket is evicted, flushing its suppressed count first (no evidence loss)", async () => {
    const { sink, writes } = fakeSink();
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: 1,
      windowMs: 60_000,
      maxKeys: 3,
      now: () => 11_000,
      sink,
    });

    // Fill the first bucket past its cap so it carries a pending suppressed count.
    await recorder.record(DB, baseInput({ sourceKey: "ip-A" })); // 1 full row
    await recorder.record(DB, baseInput({ sourceKey: "ip-A" })); // suppressed=1
    expect(recorder.size()).toBe(1);

    // Add new source keys until the map would exceed maxKeys=3. Inserting the 4th
    // distinct key evicts ip-A, and eviction must FLUSH ip-A's suppressed count.
    await recorder.record(DB, baseInput({ sourceKey: "ip-B" }));
    await recorder.record(DB, baseInput({ sourceKey: "ip-C" }));
    const writesBeforeEvict = writes.length;
    await recorder.record(DB, baseInput({ sourceKey: "ip-D" }));

    expect(recorder.size()).toBeLessThanOrEqual(3);
    // The eviction emitted ip-A's aggregate (suppressed=1) plus the ip-D full row.
    const evictionAggregate = writes
      .slice(writesBeforeEvict)
      .find((w) => w.reason === SUPPRESSED_DENIALS_REASON);
    expect(evictionAggregate, "eviction dropped a bucket without flushing its suppressed count").toBeTruthy();
    expect((evictionAggregate?.details as Record<string, unknown>)?.suppressedCount).toBe(1);
  });

  it("never throws when the underlying sink throws — the refusal still stands", async () => {
    const throwingSink: DenialSink = async () => {
      throw new Error("db down");
    };
    const recorder = createBoundedDenialRecorder({
      maxRowsPerWindow: 5,
      now: () => 13_000,
      sink: throwingSink,
    });
    // Must resolve (not reject) even though the sink throws.
    const r = await recorder.record(DB, baseInput());
    expect(r.outcome).toBe("recorded");
    expect(r.id).toBeNull();
  });
});
