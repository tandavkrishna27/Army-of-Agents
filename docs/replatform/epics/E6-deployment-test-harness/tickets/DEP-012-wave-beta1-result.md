# DEP-012 — Slice 3 · Wave β1 — RESULT

**Status:** SHIPPED (CI pending). Builds on the SHIPPED gated wire (Slice 1 · Units A + B1 + B2).
Scope executed: the two HARD parts of Slice 3 — the **durable, identity-namespaced idempotency ledger**
(which forces **create-gating**) + the **TOCTOU / `sandboxId`-reuse lock** — component-tested on the MOCK.

**NOT in this wave (β2 / deploy, unchanged from the design split):** hosting the real `E2bSandboxProvider` +
the new `adapter-manager-boundary.mjs` guard + the keyed HOSTED-provider conformance lane (β2); the empirical
non-reuse fact + the §S1.5 foreign-id ordering assertion (deploy/keyed); the per-run Company model key
(Slice 4); the through-the-daemon seam (DEP-011). Still on `MockE2bTransport`.

**worker-daemon + `cleanup-authority.ts` + the supervisor + the authoritative port UNTOUCHED** (git-verified:
the changed set is `packages/adapter-manager/**` + `packages/provider-wire/src/driver.ts` +
`scripts/test-inventory.json` only). The A/B1/B2 suites are GREEN after the Step-0 migration.

---

## What shipped

Five net-new adapter-manager pieces + a one-arg driver change + the server wiring:

1. **`keyed-mutex.ts` — `KeyedMutex`.** An AM-local per-key async lock (promise-chained), the serialization
   primitive under BOTH β1 concurrency mechanisms. Same key strictly serializes; distinct keys run concurrently;
   **evict on drain** (the map holds only in-flight keys, so an attacker-supplied `sandboxId` / identity can't
   grow it without bound); released whether the body resolves OR throws. Honestly IN-PROCESS — no cross-replica
   reach (deploy-owed, §β1.6).

2. **`idempotency-ledger.ts` — `IdempotencyLedger`.** A durable, per-key file-backed store keyed by
   **(identity, idempotencyKey)** where **identity = an UNAMBIGUOUS encoding of `cap.ownedLabels`** — the raw
   ordered 7-tuple as a fixed-order JSON array (field boundaries preserved). **NOT `hashResourceLabels`** (its
   `.join(" ")` is non-injective — the space-shift bypass B1 rejected). The on-disk FILENAME is a SHA-256 over
   that unambiguous logical key (collision-resistant because its INPUT is). The store **reimplements the
   `FileRecordStore` write-once CAS idiom** (temp → `fsync` → `link()` [EEXIST = `already_present`] →
   **PARENT-DIR fsync**) — `FileRecordStore` is not barrel-exported, so the ledger carries no worker-daemon
   internals beyond the exported custody symbols (`STRICT_FILE_MODE`, `ownerOnlyViolation`, `OwnerOnlyDeps`) and
   MUST carry the parent-dir fsync (the WRK-014 lesson). Reads fail-closed (corrupt/insecure → throw, never
   `null`; ENOENT → `null`).

3. **`create-gate.ts` — `gateCreate`.** A DISTINCT shape from `gateOwnedOp` (no inspect): **verify** →
   **`labelsEqual(spec.resourceLabels, cap.ownedLabels)`** (the caller creates only its OWN-labeled sandbox —
   closes the arbitrary-foreign-labels hole; uniform refusal else) → **the ledger** → **`provider.create` with a
   STRIPPED `idempotencyKey` (`""`)**. The strip makes the durable ledger the SOLE idempotency authority: the
   provider's own key-alone `#idempotency` (`e2b-provider.ts:156`) can never echo tenant A's sandbox to tenant B
   on a cross-identity replay. Concurrency: the per-(identity,key) mutex spans check → create → record, PLUS a
   **check-after-create** (on `already_present`: tear down this call's just-created loser, then return the
   recorded winner) so exactly one sandbox survives.

4. **`server.ts` — create joins the gated ops.** `create` added to `GATE_REQUIRED_OPS` AND a `routeGated`
   `case "create"` (the create-gate, NOT `gateOwnedOp`) in the SAME change; `create` KEEPS its raw Map handler
   for the KEYLESS path (Unit A back-compat, byte-identical). New option `idempotencyLedgerDir` (used only when
   gated; defaults to a fresh OS temp dir — per-instance, ephemeral, out-of-tree). The gated `gateDeps` now
   carries a per-server `sandboxLock`, and a `createGateDeps` carries the ledger + a per-server `createLock`.

5. **`owned-op-gate.ts` — the TOCTOU lock (option (b)).** `gateOwnedOp` now holds an AM-local per-`sandboxId`
   lock across inspect → owned-check → dispatch, acquired **AFTER** `verifyOrUniform` (verify OUTSIDE the lock —
   an unauthenticated caller must not acquire a lock), released in `runExclusive`'s finally, evicted on drain.
   **Honestly PARTIAL:** it serializes only THIS instance's inspect+dispatch — NOT E2B's TTL destroy+reassign,
   NOT a second replica. Defense-in-depth; the real fix is the (c) proven-non-reuse invariant (deploy-owed).

6. **`driver.ts` — one arg.** `create` now passes `this.#capability` (`#post` already types
   `op: ProviderOperation` + threads an optional capability). An ungated server ignores it (create's Unit-A body
   is byte-identical when it is absent); a keyed server refuses on absence with the uniform error.

### Step 0 (executed FIRST) — migrate the shipped B1/B2 setup helpers

Gating `create` reds the B1/B2 gated-server setup creates (their `createSandbox` was capability-LESS). Migrated:
`gate.test.ts` + `owned-op-gate.test.ts` `createSandbox(labels)` now **mint + attach a capability whose
`ownedLabels` MATCH the labels it creates**; the FOREIGN / SAME_COARSE setups mint their OWN foreign capability
(the foreign sandbox created AS the foreign tenant — the correct model). One inline setup-create (gate.test.ts
generation-skew) migrated the same way. **A/B1/B2 GREEN** after the migration (55 → still green; the migration
was small and as-expected — no premise invalidation).

### Test evidence

adapter-manager: **83 tests** (was 55) across 8 files — **+28 new** in 4 new files:
`keyed-mutex.test.ts` (6), `idempotency-ledger.test.ts` (7), `create-gate.test.ts` (10), `toctou-lock.test.ts`
(5). provider-wire unchanged and green (the driver create-arg change is covered by its component/codec suites).
Full β1.4 fail-first TDD: every RED test confirmed to fail for the RIGHT reason before implementation.

---

## Mutation table (β1.4 step 7 — each mechanism mutated individually, a live test kills each)

| # | Mutation | Killed by | Result |
|---|----------|-----------|--------|
| 1 | un-strip (pass `ctx` unchanged to `provider.create`) | create-gate ★ THE STRIP (B gets A's sandbox; `createKeys ≠ ["",""]`) | ✅ killed |
| 2 | ledger identity = space-join (`hashResourceLabels`-style `.join(" ")`) | ledger UNAMBIGUOUS: space-shift → DISTINCT keys + no A→B leak | ✅ killed (2 tests) |
| 3 | drop the create mutex (call the body directly) | create-gate one-instance mutex (`provider.create` called ONCE) | ✅ killed |
| 4 | drop the spec-label match (`labelsEqual`) | create-gate FOREIGN spec-labels → uniform RNA | ✅ killed (2 tests) |
| 5 | drop the parent-dir fsync | ledger durable-publish idiom (fsyncParentDir after link) | ✅ killed |
| 6 | drop the TOCTOU lock | TOCTOU serialization + acquires-once | ✅ killed |
| 7 | drop the check-after-create teardown | cross-replica "exactly ONE survives" | ✅ killed |

★ **Mutations 3 and 7 ISOLATE**: dropping the mutex reds the ONE-instance test while the cross-replica test's
check-after-create still limits damage; dropping the check-after-create reds the cross-replica test while the
mutex still serializes ONE instance — proving BOTH the mutex and the check-after-create are independently
load-bearing. The un-strip (1) + space-join (2) mutations are the two headline LEAK mutations; both killed.

---

## Adversarial review (4 dimension reviewers + 1 skeptic, refute-from-source, default-refuted)

Ran per-dimension reviewers (create-gate, the ledger, the concurrency, the TOCTOU lock) + a SKEPTIC charged to
LEAK A's sandbox to B (the strip + the ledger-key collision) and to DOUBLE-PROVISION (the concurrent race).

**Verdict: 0 HIGH/BLOCKING.** The skeptic's Attack A (leak A→B) was fully REFUTED at every vector (the
unconditional strip; the injective JSON-tuple ledger key namespaced by the VERIFIED identity; Ed25519
non-forgeability; a HIT can only return same-identity data). Attack B (double-provision) was REFUTED
single-instance (mutex + write-once CAS); the cross-replica double-survival is real ONLY on a shared volume
(β1.6, NOT the shipped per-instance-temp-dir default) AND a teardown failure, and is honestly disclosed as a
TTL-bounded orphan, not a hidden β1 claim.

### What survived and was FIXED — one LOW

**LOW (create-gate + concurrency reviewers) — corrupt-own-ledger-entry on `already_present` stranded the
loser.** The check-after-create re-read the winner BEFORE tearing down the loser, so a throwing winner-lookup (a
corrupt own-key entry) skipped the teardown → a TTL-bounded orphan (the β1.6 crash-orphan class). **FIXED:**
`gateCreate` now tears the loser down FIRST (it is definitively a loser — `link()` EEXIST'd on another writer's
entry and each create mints a fresh id), THEN reads the winner (fail-closed on an unreachable `null`). A RED-first
unit test (fake ledger whose winner-read throws) proves the loser is reclaimed despite the failed read.

### Reviewer notes recorded, NOT re-guarded (with reasons)

- **Non-finite numeric labels (ledger reviewer, LOW) — REFUTED as reachable, documented.** `attempt` /
  `deviceGeneration` = `NaN`/`Infinity` both JSON-stringify to `"null"`, colliding two identities in the ledger
  key while `labelsEqual` (`===`) treats them as distinct. Closed UPSTREAM twice over: the wire codec serializes
  `Infinity`/`NaN` to `null`, which `isValidCapability` rejects as malformed; and `labelsEqual` refuses a `NaN`
  attempt at the create-gate label-match. A non-finite identity can never reach the key over the wire — kept as an
  explicit invariant comment in `key()`, not re-guarded (defense already doubled).
- **TOCTOU dispatcher re-entrancy (concurrency reviewer) — latent, not current.** Every wired `dispatch` is a
  direct `provider.*` call; none re-enters `gateOwnedOp` on the same `sandboxId`. A future re-entrant dispatcher
  would self-deadlock — recorded as a one-line CAUTION comment in `gateOwnedOp`.

---

## Guards (whole set — all green)

`check-ticket-graph-coverage` (DEP-012 present), `check-finding-ownership`, `check-guard-inventory`,
`check-gate-clause-wiring` (re-run — `create` joins the gated ops; no DEP-012 clause entry exists, stays green),
`check-execution-census`, `check-worker-daemon-boundary` (**PASS — worker-daemon untouched**),
`check-sandbox-e2b-provider-boundary` (PASS), `check-test-inventory` (adapter-manager floor re-pinned 4 → 8 for
the 4 new test files — NO over-reach into db/server), `check-boot-roots-provider-free` (the ledger's file store
adds NO boot root — it is a runtime store, not a bin). **NOT** `check-image-deps-stages` / `dockerfile-static`
(β1 adds no image); **NO** new package → NO new `vitest` `projects[]` / Dockerfile COPY.

---

## What Wave β2 + deploy inherit (recorded)

- **β2:** the real-transport composition-root bin (`new E2bSandboxProvider({ transport: createRealE2bTransport() })`,
  refuse-not-degrade) + the new `adapter-manager-boundary.mjs` guard (confine `e2b` / `E2B_API_KEY` /
  `sandbox-e2b-provider` to that one bin) + `sandbox-e2b-provider` devDep→dep + the keyed HOSTED-provider
  conformance lane (curated subset, NOT wire-end-to-end).
- **★ Multi-replica double-provision (deploy).** The scope allows adapter-manager replicas 1-3; β1's TOCTOU lock
  is IN-PROCESS and the ledger defaults to a PER-INSTANCE local temp dir — neither serializes across replicas, so
  a create replay routed to a different replica MISSES → double-provision. Deploy-owed: a SHARED-VOLUME ledger +
  the check-after-create teardown (the MECHANISM ships + is tested here with a simulated shared dir); the
  in-process lock stays defense-in-depth.
- **★ create-then-record crash-orphan (deploy/hardening).** A crash AFTER `provider.create` but BEFORE the ledger
  commit leaves a created-but-unrecorded sandbox → a restart replay re-provisions → a SAME-tenant orphan (bounded
  by the sandbox TTL). `record-intent-first` would close it but is not expressible over write-once `saveIfAbsent`.
- **★ The mint ≡ `labelsFor` invariant (DEP-011).** The capability mint must produce `ownedLabels`
  FIELD-FOR-FIELD identical to `labelsFor(handoff)` (`supervisor.ts:205-215`) that `createSpecFor` stamps —
  including the NUMERIC `attempt`/`deviceGeneration` (`labelsEqual` uses `===`). Any type/normalization drift
  SILENTLY REFUSES legit creates under the create-gate.
- **★ The (c) non-reuse assertion (deploy/keyed).** Assert + a keyed test that a destroyed E2B id is never
  re-minted; if TRUE the TOCTOU is vacuous and the (b) lock is pure defense-in-depth. The §S1.5 foreign-id
  ordering assertion is also deploy-owed.
- **Watch:** B2's `reconcile_cleanup` semantic inversion may FIRST surface under a real E2B TTL-expiry once β2's
  real transport lands (DEP-011's remit; β2 makes TTL expiry real).

---

## Claims NOT proven here (deferred, by design)

- **Real E2B id reuse is EMPIRICAL and untested** — the mock never reuses ids (`mock-transport.ts`), so the
  TOCTOU lock's necessity + the (c) non-reuse fact are deploy/keyed-owed, not proven on the mock.
- **Cross-replica exactly-once is NOT claimed** — the in-process lock + per-instance local ledger do not
  serialize across replicas; only the shared-volume MECHANISM is deploy-owed. The check-after-create is proven
  with a SIMULATED shared dir (two instances, one backend), not a real multi-replica deployment.
- **The `mint ≡ labelsFor` field-for-field invariant is NOT proven** — no real control-plane mint exists in β1
  (component tests mint with a TEST keypair). DEP-011 owns it.
- **No real transport / boundary guard / conformance** — β2. Still `MockE2bTransport`; single-tenant loopback; no
  daemon, no mTLS, no deploy.
- **The best-effort teardown residual** — if `provider.destroy` throws on the loser, the winner is still returned
  and the loser is a TTL-bounded orphan (the deploy-owed crash-orphan class), not a failed create.
