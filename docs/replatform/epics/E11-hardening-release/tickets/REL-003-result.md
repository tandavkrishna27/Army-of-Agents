# REL-003 — DR + migration rehearsal (result)

**Sprint 9 unit 2.** Start SHA (design, committed before code): `1519b650c`. This result
covers the **session-buildable verification core + the operator runbook**. The live
staging rehearsal — the measured RPO/RTO, real backup/restore, pre-0188→prior→candidate,
live missing/corrupt injection, timed rollback — is the **owed operator leg**; REL-003
promotes to done **only on a cited live-rehearsal run**, never on the embedded-PG / fixture
substrate below. This is the honest Sprint-5b end-state (GO-BOOK §9), not a failure.

---

## What landed

### Two NEW pure verifiers (mutation-tested by DELETION, positive-control first)

- **Lane A — `evaluateRecoveredManifestReconciliation(manifest, probes)`**
  (`server/src/services/disaster-recovery/manifest-reconciliation.ts`). Over the
  authoritative `job_artifacts status='committed'` set × `StorageProvider.headObject`
  probes: per-object `verified` / `wrong_prefix` / `missing` / `hash_unverifiable` /
  `hash_mismatch` / `size_mismatch`; verdict `recovered` iff EVERY row verified (I6);
  `promoted` excludes every non-verified object (I7); failures map to the FROZEN
  `QUARANTINE_REASONS` (D3); fail-closed on an unverifiable checksum (D2, I5). The scope
  guard (DE-23) uses the exact FROZEN `objectKeyHasPrefix` semantics —
  `isSafeWorkspacePath` + `expectedAttemptObjectPrefix` (I3). Plus `runManifestReconciliation`
  — the harness that keeps the verifier from being orphaned (I8, the REL-004 anti-orphan
  lesson). **12 unit tests.**
- **Lane C (pure) — `evaluateRollbackCompleteness(actions, state)`**
  (`server/src/services/disaster-recovery/rollback-completeness.ts`). Marker-deletion-only
  → refused `marker_deletion_is_not_rollback` (DE-20 headline, I10); an accepted rollback
  requires a real revert (`snapshot_restored` or `revert0188_single_org`); empty is
  fail-closed refused (D2). **6 unit tests.**

**Mutation line:** the two new verifiers carry guards A-G1..A-G7 and C-G1..C-G3 (design §7).
DELETE each guard (never rewrite to an equivalent), re-run, the named test turns RED,
anchor-matched: **A 7/7 killed · C 3/3 killed · 10/10 total · 0 survivors.** Positive
control FIRST in both (break the classifier / stub the verdict → the classification/refusal
cases go RED, proving the tests exercise the function).

### Three reuse lanes (positive control that the DR scenario reaches the WIRED guard; no new guard, D7)

- **Lane B (embedded-PG)** — `dr-stale-fence-after-restore.integration.test.ts`. Drives the
  REAL `guardActiveFence` → `classifyFence` gate via `acceptEvent`/`runInTenant`. Positive
  control: an active restored fence is ADMITTED (`{leaseId, guarded:true}`). RED: an expired
  lease, an ABSENT lease row (a fence minted after the snapshot), and a fence pinned to the
  pre-restore generation after a re-enroll gen bump (`target_revoked`). I9 + the I13 fence
  half. **4 tests.**
- **Lane C (embedded-PG)** — `dr-marker-rollback.integration.test.ts`. Deleting a
  `distributed_cutover_markers` row leaves the 0188 tenant schema fully intact (DB-level
  I10), and the real `revert0188` refuses on a multi-org instance pointing to snapshot
  restore (I11). **2 tests.**
- **Lane D (pure/node)** — `dr-staging-rollout-invariants.test.ts`. The real
  `docker-compose.staging.yml` passes the EXPORTED `evaluateStagingManifestInvariants`
  (B2 — `checkRolloutPolicy` is private) with rollout parallelism 1; positive controls
  (parallelism 4, missing `update_config`) fire; the FROZEN-v1 identical N/N-1 baseline
  holds via `negotiateProtocolVersion` (I12). **4 tests.**
- **Lane E (embedded-PG)** — `dr-reenroll-revoke.integration.test.ts`. `advanceTargetGeneration`
  re-enroll gen bump (positive control; a stale expected-generation returns null);
  **`revokeExecutionTarget` writes the durable `execution_target_revocations` cutoff row**,
  while `revokeTargetAuthority` bumps the generation + disables the target + revokes the
  worker and writes **NO** cutoff row — the **B1** correction (assert the row against the
  function that actually writes it). I13 enrollment/revocation half. **3 tests.**

**Totals:** 6 files, **31 tests green** (A 12 · C-pure 6 · D 4 · C-embedded 2 · E 3 · B 4).
Pure/node lanes (A, C-pure, D) run everywhere; embedded-PG lanes (B, C-embedded, E) are
Linux-gate lanes (Issue #114), verified locally with `AOA_RUN_WIN_INTEGRATION=1`.

### The gate self-clean (already done by the prep commit; verified intact)

`deferred["REL-003"]` was already removed from
`docs/architecture/distributed-execution-release-tests.json` by the prep commit that landed
the design; the foundation checker admits the two crossings that name REL-003 (DE-20, DE-23)
via `written.has("REL-003")` on disk. `node scripts/check-distributed-execution-foundation.mjs`
→ **PASS** (exit 0); net at rest still 0 errors.

### E11-F002 filed (the one real wiring gap)

`runDatabaseRestore` (`packages/db/src/backup-lib.ts`) is exported from that module but has
**zero production/CLI callers**, is **not** barrel-exported from `@armyofagents/db`, and there
is **no `aoa db:restore` command** (`aoa db:backup` exists). Filed as the byte-equal pair —
`findings.md` `## E11-F002 —` (`**Status:** \`open\``, MED) + `finding-ownership.json`
`"E11-F002": { "status": "owned", "ticket": "REL-003", … }` (C1: the key is `ticket`, not
`owner_ticket`). It carries `ownerStillOpen` because REL-003 has a result doc while the
restore leg stays owed (the WRK-008-style calibration). Resolution rule (C4): when a real
restore entrypoint lands and the live rehearsal exercises it, flip the `findings.md` Status
**and** DELETE the `finding-ownership.json` key in the SAME commit.

### The operator runbook (prepared, not faked)

`REL-003-dr-rehearsal-runbook.md` — the owed live-staging leg, holding the operator/session
boundary. It names the exact restore invocation (`runDatabaseRestore` / `pg_restore`, per
E11-F002); states mobility is DISABLED so MIG-004 is out of the promotion set (C2); ticks the
`execution_target_revocations` fanout by hand (B3, no production scheduler today); and
promotes REL-003 only on a cited live run with measured RPO/RTO vs D5-DR02/DR03.

---

## Review-round-2 corrections applied

- **C1** — E11-F002 finding-ownership key is `ticket`, not `owner_ticket`. ✔ (register green.)
- **B1** — the durable `execution_target_revocations` cutoff row is asserted against
  `revokeExecutionTarget` (not `revokeTargetAuthority`, which only bumps gen + flips status).
  ✔ (Lane E I13b/I13c.)
- **C2** — mobility DISABLED in the initial coding release → MIG-004 inapplicable; stated in
  the runbook boundary + promotion rule. ✔
- **B2** — Lane D drives the exported `evaluateStagingManifestInvariants`, not the private
  `checkRolloutPolicy`. ✔
- **C3** (DR04 identity subsumed by object_key+sha256 for coding artifacts), **C4** (resolve =
  flip Status + DELETE key same commit), **B3** (fanout hand-tick) — reflected in the finding
  + runbook.

---

## Adversarial review (of the IMPLEMENTATION)

Three independent read-only reviewers against the committed source (a source verifier of the
new verifiers; a skeptic tasked to slip a corrupt/missing object past the reconciler or admit
a stale fence after restore; a completeness critic mapping every acceptance clause to a test
or runbook step and every new guard to a mutation kill).

- **Source verifier:** one substantive finding (MED, rising to HIGH on a `..`-resolving
  provider like `local_disk`) — the scope guard dropped the `isSafeWorkspacePath` half of the
  FROZEN `objectKeyHasPrefix`, so a `..`-traversal key with matching bytes could be `verified`
  and `promoted`. **Fixed** (commit `6de324e0f`): A-G4 now requires `isSafeWorkspacePath`, a
  new test covers the `..`-key case, and the A-G4 mutation is still killed by deletion.
  Everything else (classification order, fail-closed undefined-checksum/size, the verdict
  quantifier + promoted exclusion, the anti-orphan harness, the rollback guard ordering)
  assessed correct.
- **Skeptic** (tasked to slip a corrupt/missing object past the reconciler or admit a stale
  fence after restore): **all attacks REFUTED — no surviving fail-open.** Attack A (bad object
  as good): every vector refuted (undefined `contentLength`→`size_mismatch`; foreign-org key
  →`wrong_prefix`; `objectKey===prefix`→`wrong_prefix`; duplicate keys benign; NaN/negative
  size→`size_mismatch`). Attack B (admit a stale fence): the positive control is genuine —
  `acceptEvent`'s FIRST statement is `guardActiveFence` and `{guarded:true}` only comes from a
  successful guard, so the RED cases (expired/absent-row/gen-bump) refuse INSIDE the guard, not
  at an unrelated earlier check (the E1-F008 trap). Rollback/marker lanes sound. It recorded two
  non-exploitable caveats — the `isSafeWorkspacePath` gap (already fixed in `6de324e0f`) and a
  `=== undefined` vs falsy checksum guard (latent brittleness). **The falsy hardening was applied**
  (A-G5 now `!probe.checksumSha256`; a new empty-string test; mutation still killed).
- **Completeness critic:** **PASS on all five checks.** Every acceptance clause maps to a green
  test or a cited operator step (the four measure/live clauses are OPERATOR-only in both §2 and
  §8, not faked); I1–I13 all have a test that could turn RED (I8 anti-orphan genuine; I13's two
  halves both covered); the mutation guards are distinct deletable lines with covering tests
  (kill directions spot-checked); the E11-F002 pair is register-correct (key `ticket`, not
  `owner_ticket`); the operator/session boundary + C2/B3 hold. Its one gap — "`REL-003-result.md`
  does not exist" — is closed by this file. Its one nit — the design §9 step 8 prose still named
  `revokeTargetAuthority` for the revoke — is fixed to `revokeExecutionTarget` (B1).

No HIGH/BLOCKING survived. The two implementation fixes (A-G4 safe-path, A-G5 falsy) and the
design §9-step-8 alignment are the only changes the review produced.

---

## Honest end-state

**Verifiers + reuse lanes + operator runbook shipped and green; the live staging rehearsal is
OWED.** REL-003 does **not** promote to done here. `E7-1` and every dormant clause are
untouched — a green buildable core is not a live rehearsal, and this result does not claim
one. `E11-F002` stays `open`, owned by REL-003, until a real restore entrypoint lands and the
cited live rehearsal exercises it.

## Registers + CI

All five registers pass at tip (`gate-clause-wiring`, `finding-ownership`,
`ticket-graph-coverage`, `guard-inventory`, `execution-census`) plus the foundation checker
(exit 0). No new `check-*.mjs` (no guard-inventory bump); tests are vitest `*.test.ts` (no
execution-census bump); `worker-protocol` FROZEN untouched; no `AOA_*` added; no
secret/provider key serialized into any prompt/event/log (Decision #104). This is a
`code=true` PR, so `ci-required` rides the full heavy suite (verify shards / e2e / migrations
/ policy / brand-check).
