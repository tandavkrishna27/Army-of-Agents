// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β1 — the AM-local per-key async mutex.
//
// The serialization primitive under BOTH β1 concurrency mechanisms: the
// per-(identity,idempotencyKey) create mutex (spanning check -> create -> record,
// so two same-key creates can't double-provision) and the per-sandboxId TOCTOU
// lock (spanning inspect -> dispatch in gateOwnedOp). It is a plain in-process
// lock — it does NOT serialize across adapter-manager replicas (deploy-owed, β1.6).
//
// The invariants proven here:
//   - same key -> strictly serialized (no interleave at the awaited body);
//   - DISTINCT keys -> genuinely concurrent (no false contention);
//   - EVICT ON DRAIN — a settled key leaves the map (an attacker-supplied sandboxId
//     / a garbage identity can't grow it without bound);
//   - a THROWING body releases the lock (never wedges the key) and still evicts.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { KeyedMutex } from "../keyed-mutex.js";

/** A manually-resolvable barrier, so a test controls exactly when a body completes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("KeyedMutex — same key serializes", () => {
  it("a second runExclusive on the same key waits for the first to fully settle", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const firstBody = deferred();

    const a = mutex.runExclusive("k", async () => {
      events.push("A:start");
      await firstBody.promise; // hold the lock until the test releases it
      events.push("A:end");
      return "a";
    });
    // B is enqueued while A holds the lock. It must NOT start until A ends.
    const b = mutex.runExclusive("k", async () => {
      events.push("B:start");
      return "b";
    });

    // Let microtasks flush — A has started, B has NOT (the lock is held).
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["A:start"]);

    firstBody.resolve();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    // Strictly serialized: A fully before B.
    expect(events).toEqual(["A:start", "A:end", "B:start"]);
  });
});

describe("KeyedMutex — distinct keys are concurrent", () => {
  it("two different keys run their bodies at the same time (no false contention)", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const holdA = deferred();
    const holdB = deferred();

    const a = mutex.runExclusive("k1", async () => {
      events.push("A:start");
      await holdA.promise;
      return "a";
    });
    const b = mutex.runExclusive("k2", async () => {
      events.push("B:start");
      await holdB.promise;
      return "b";
    });

    await Promise.resolve();
    await Promise.resolve();
    // BOTH started before either finished — genuine concurrency across keys.
    expect(events.sort()).toEqual(["A:start", "B:start"]);

    holdA.resolve();
    holdB.resolve();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });
});

describe("KeyedMutex — evict on drain", () => {
  it("a settled key leaves the map (size returns to 0)", async () => {
    const mutex = new KeyedMutex();
    expect(mutex.size).toBe(0);
    const hold = deferred();
    const running = mutex.runExclusive("k", async () => {
      await hold.promise;
    });
    await Promise.resolve();
    expect(mutex.size).toBe(1); // held
    hold.resolve();
    await running;
    // Drained -> the key is gone. A garbage/attacker key can't accumulate.
    expect(mutex.size).toBe(0);
  });

  it("many distinct keys all evict after draining", async () => {
    const mutex = new KeyedMutex();
    await Promise.all(
      Array.from({ length: 50 }, (_v, i) => mutex.runExclusive(`k-${i}`, async () => i)),
    );
    expect(mutex.size).toBe(0);
  });
});

describe("KeyedMutex — a throwing body releases the lock", () => {
  it("a rejection does not wedge the key; a later acquire runs and the key evicts", async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.runExclusive("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The key must be free — a subsequent acquire runs to completion.
    const result = await mutex.runExclusive("k", async () => "recovered");
    expect(result).toBe("recovered");
    expect(mutex.size).toBe(0);
  });

  it("a rejection in the first holder still lets a queued waiter run", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const hold = deferred();
    const a = mutex.runExclusive("k", async () => {
      events.push("A:start");
      await hold.promise;
      throw new Error("A failed");
    });
    const b = mutex.runExclusive("k", async () => {
      events.push("B:start");
      return "b";
    });
    await Promise.resolve();
    expect(events).toEqual(["A:start"]); // B queued behind A
    hold.resolve();
    await expect(a).rejects.toThrow("A failed");
    expect(await b).toBe("b"); // B still ran after A's failure
    expect(events).toEqual(["A:start", "B:start"]);
    expect(mutex.size).toBe(0);
  });
});
