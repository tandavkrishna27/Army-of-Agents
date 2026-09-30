// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β1 — an AM-local per-key async mutex.
//
// The serialization primitive under BOTH β1 concurrency mechanisms:
//   - the per-(identity, idempotencyKey) CREATE mutex — spanning check -> create ->
//     record so two same-key creates on ONE instance can't double-provision;
//   - the per-sandboxId TOCTOU lock — spanning inspect -> dispatch in `gateOwnedOp`.
//
// ★ HONESTLY IN-PROCESS. It serializes ONLY within a single adapter-manager
// instance. The scope allows replicas 1-3 (`adapter-manager-scope.md`), across
// which this lock has no reach — that cross-replica gap is deploy-owed (β1.6). It
// is defense-in-depth here; the durable ledger's write-once CAS is the authority.
//
// ★ EVICT ON DRAIN. The key is keyed by an ATTACKER-SUPPLIED value (a crafted
// `sandboxId`, a foreign identity), so a per-key entry that outlived its last
// waiter would be an unbounded-growth vector. Each key's chain deletes itself when
// it settles with no newer waiter attached, so the map holds only IN-FLIGHT keys.
// -----------------------------------------------------------------------------

/**
 * A per-key async mutex. `runExclusive(key, fn)` runs `fn` only after every prior
 * acquisition of the SAME key has settled; distinct keys never contend. The lock is
 * released whether `fn` resolves OR throws, and the key evicts once its chain drains.
 */
export class KeyedMutex {
  // Per key: a promise that settles when the CURRENT tail of that key's queue
  // finishes. A new waiter chains onto it; when a waiter is the tail and it
  // settles, it removes itself (evict on drain).
  readonly #tails = new Map<string, Promise<void>>();

  /** Number of keys with an in-flight or queued holder. Observability for the
   * evict-on-drain invariant (a foreign/garbage key must not accumulate). */
  get size(): number {
    return this.#tails.size;
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait behind whatever currently holds the key (its failure must NOT reject the
    // waiter — a prior body's error is that caller's, not ours), then run our body.
    const predecessor = this.#tails.get(key) ?? Promise.resolve();
    const run = predecessor.then(() => fn());

    // Our tail settles (never rejects) when `run` settles, so the NEXT waiter chains
    // cleanly regardless of our outcome. Stored SYNCHRONOUSLY so a concurrent
    // acquire in the same tick sees us as its predecessor.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);

    try {
      return await run;
    } finally {
      // Evict on drain: only if no later waiter has replaced us as the tail.
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
