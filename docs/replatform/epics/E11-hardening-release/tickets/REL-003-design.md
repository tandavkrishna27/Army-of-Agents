# REL-003 — Disaster recovery and migration rehearsal (design)

**Depends on** DEP-006, MIG-002, E10-REALTIME-FOUNDATION — all landed (Sprint 9 unit 2,
"dependency-ready"; GO-BOOK §4 "Sprint 9").
**Outcome:** prove database and required object-byte restore, object-manifest reconciliation,
worker re-enrollment/revocation, schema rollout, and rollback procedure.
**Acceptance (program-design.md `#### REL-003`):** restored state does not accept stale fences;
database and versioned object-store RPO/RTO meet D5; every object referenced by the recovered
authoritative manifest set restores with matching bytes/hash/size/scope; injected missing/corrupt
objects fail the restore and are quarantined; missing required current objects prevent
full-service recovery from passing; rollout order supports N-1 workers; rehearse full post-cutover
recovery from the CM-015 pre-0188 snapshot to the prior release and forward recovery to the
candidate; marker deletion alone is never accepted as rollback.
**Test (program-design.md `#### REL-003`):** staging database + object-store backup/restore,
pre-0188 snapshot→prior-release restore and forward-recovery rehearsal, complete recovered-manifest
byte/hash verification, injected missing/corrupt objects, stale-fence rejection, marker-deletion
negative, and rollback exercise with measured recovery time.

> **Read `§1` and `§2` first.** REL-003 is *not* one buildable unit. It is a buildable
> **verification core** (pure verifiers + rehearsal-scenario tests over already-wired guards, all
> fail-first + mutation-tested) **plus an operator-owed live staging rehearsal** that alone
> supplies the measured RPO/RTO and the real backup/restore. This is the Sprint-5b shape
> (GO-BOOK §9 "Sprint 5b"): the session builds and proves the logic and prepares the runbook;
> only the operator reaches live staging and authorizes any spend; **REL-003 promotes to done
> only on a cited live-rehearsal run**, never on a local/mock substitute.

---

## ★★ Review round 2 (orchestrator) — corrections to fold in at execution

A three-way adversarial review (boundary + wired-substrate reviewer; a skeptic told to REFUTE the
E11-F002 vacuity and the "testable without live infra" claim; a completeness critic on clause
coverage / D5 numbers / mutation completeness) ran against this design. **Core verdict: sound.** The
skeptic REFUTED both attacks (E11-F002 is real — `runDatabaseRestore` is not even barrel-exported; the
buildable core is genuinely fixture-/embedded-PG-testable). The D5-DR numbers, the mutation table, the
gate interaction (§10), and the promotion rule were all affirmed. Two MED corrections (one CI-breaking)
+ four smaller ones, applied at the cited sections:

- **C1 (CI-breaking — FIXED inline in §11).** The finding-ownership entry key is **`ticket`**, NOT
  `owner_ticket` (`finding-ownership.mjs` reads `entry.ticket`; a wrong key → `malformed_declaration`
  reds the always-on `policy` job — contradicting §12's own "keeps it green"). Entry shape:
  `"E11-F002": { "status": "owned", "ticket": "REL-003", "reason": … }`.
- **B1 (MED — FIXED inline in §0.3 / §2 / §5 I13 / §6 Lane E).** The durable `execution_target_revocations`
  cutoff row is written by **`revokeExecutionTarget`** (`server/src/services/execution-targets.ts:376`,
  via `job-operations.ts:317`, an `aoa_operator` path), NOT `revokeTargetAuthority` — which only bumps
  the generation and flips `execution_targets.status='disabled'` + `workers.status='revoked'`. Assert the
  record row against `revokeExecutionTarget`; assert the gen-bump/status against `revokeTargetAuthority`.
  (Following the old wording literally would assert a row that no production code in that path writes —
  the "clause nobody wrote" trap.) Lane E stays BUILDABLE (embedded-PG).
- **C2 (LOW-MED — classify the mobility clause).** The acceptance's tail — "If desktop/dedicated
  mobility is enabled, MIG-004 evidence is an additional release prerequisite" — was unclassified.
  Resolution: mobility is **DISABLED** in the initial coding release (the gate's D6-05 disabled-mobility
  path), so the MIG-004 prerequisite is inapplicable — state that in §2 and the §9 promotion rule; if a
  staging row ever advertises `fenced_restart`, add MIG-004 evidence to the promotion set.
- **B2 (LOW — §6 Lane D wording).** `checkRolloutPolicy` is a PRIVATE function
  (`staging-manifest-invariants.mjs:363`); only `evaluateStagingManifestInvariants` (`:625`) is exported.
  The positive control must drive the exported aggregate with a full fixture compose, not import
  `checkRolloutPolicy` directly.
- **C3 (LOW — DR04 identity scope).** D5-DR04 names "artifact/checkpoint identity"; Lane A's I1–I7 cover
  hash/size/prefix/exists/unverifiable/verdict/promoted. For coding-release artifacts, identity is
  subsumed by the per-row `object_key`+`sha256` pairing; "checkpoint identity" is a service-workload
  (SVC, Sprint 8) concern outside coding-release DR scope — state this in §0.1/Lane A so a reader knows
  it is deliberately folded, not missing.
- **C4 (LOW — §11 resolve-commit rule).** Resolving E11-F002 requires flipping the `findings.md` Status
  **and deleting the `finding-ownership.json` key in the SAME commit** (else `stale_declaration` reds) —
  the programme's standing "resolve = flip status + DELETE key same commit" rule.
- **B3 (INFO — §9 step 8 runbook).** The `execution_target_revocations` fanout worker
  (`createExecutionTargetRevocationFanout`) has no production scheduler today (test-only caller), so the
  runbook must tick it explicitly on embedded-PG and must NOT assume live convergence.

---

## 0. Verified state at tip

Verified at tip **`5ecef8d174b0e38d628bcdf65bfc7cd7d5581f15`** (`5ecef8d17`). **Line numbers rot —
re-verify every `path:line` at execution start** (GO-BOOK §2.1/§2.2); living-doc citations are by
section/id and are stable.

### 0.1 The normative gate REL-003 must satisfy — `test-gates.md` D5-DR

The acceptance maps almost one-to-one onto the disaster-recovery block of the D5 gate
(`docs/replatform/test-gates.md`, §"D5 — Staging HA, load, and disaster recovery gate"):

| id | Requirement (verbatim intent) |
|---|---|
| **D5-DR01** | Same-candidate restore: DB backup/restore + object-manifest reconciliation on the same candidate. |
| **D5-DR02** | Database objectives (INITIAL): **RPO ≤15 min, full-service RTO ≤4 h**. |
| **D5-DR03** | Object-store objectives (INITIAL): **RPO ≤15 min** (age of newest committed manifest whose bytes are recoverable); reconciliation **RTO ≤4 h** from restore start until every referenced object is verified readable **or the restore is declared failed**. |
| **D5-DR04** | Object integrity: every recovered-manifest object matches recorded **SHA-256, byte size, tenant/Org scope, object prefix, artifact/checkpoint identity**. Inject ≥1 missing + ≥1 corrupt; neither promoted/served; a pass has **zero** unresolved missing/mismatched authoritative objects. |
| **D5-DR05** | Quarantine: missing/mismatched objects are quarantined, never silently promoted. |
| **D5-DR06** | Restored fences: restored state rejects every pre-restore stale fence. |
| **D5-DR07** | Restore rollout: worker re-enrollment/revocation + the applicable frozen-baseline or non-identical N/N-1 protocol rollout succeed after restore. |

The RPO/RTO *numbers* live only here — `test-gates.md` D5-DR02/DR03. The D5 *topology* (2 CP
replicas, ≥4 workers over 2 failure domains, external PG/object-store, managed secret store,
canary rollout, backup/restore + revocation exercises) is `program-design.md` §"D5: Staging".

### 0.2 Trust crossings REL-003 is the release test for

REL-003 is named as the release test by exactly **two Critical crossings** in
`docs/architecture/distributed-execution-threat-controls.json`:

- **DE-20** (Critical, lane D5) — *Duplicate executor across the legacy cutover*;
  `ownerTickets: ["MIG-002","MIG-008","REL-003"]`; verification *"cutover, drain, and rollback
  rehearsal"*. → the rollout / rollback / marker-negative / N-1 clauses.
- **DE-23** (Critical, lane D5) — *Cross-tenant backup or restore*;
  `ownerTickets: ["REL-003","DAT-002"]`; verification *"disaster-recovery and migration
  rehearsal"*. → the backup/restore + manifest-reconciliation (bytes/hash/size/**scope**) + quarantine clauses.

These two are why landing this design self-cleans the gate (see §10).

### 0.3 Substrate (with caller counts — the vacuity discipline, GO-BOOK §2.3)

| Concern | Symbol / file | Callers today | For REL-003 |
|---|---|---|---|
| DB backup | `runDatabaseBackup` — `packages/db/src/backup-lib.ts:586` | **wired**: `cli/src/commands/db-backup.ts:61` (`aoa db:backup`) | operator backup leg |
| DB restore | `runDatabaseRestore` — `packages/db/src/backup-lib.ts:1056` | **ZERO production/CLI callers** — only two `*.test.ts` reference it. **No `aoa db:restore` command exists.** | **Finding E11-F002 (§11).** Runbook must wrap it (or `pg_restore`) explicitly. |
| Stale-fence predicate | `isActiveFence` / `classifyFence` — `packages/db/src/repositories/tenant/job-fence.ts:467,482` | **wired**: the real admission gate `packages/db/src/repositories/tenant/job-control.ts:1125-1128` (`classifyFence` → `JobFenceError`, then `isActiveFence` defense-in-depth) | Lane B drives the real gate |
| Authoritative object manifest | `job_artifacts` rows `status='committed'` — `packages/db/src/schema/job_artifacts.ts` | columns `object_key`, `sha256`, `size_bytes`, `organization_id`, `attempt` (DAT-002) | the "recovered authoritative manifest set" |
| Object probe | `StorageProvider.headObject` → `HeadObjectResult{ exists, contentLength, checksumSha256 }` — `server/src/storage/types.ts` | wired (S3/MinIO/local providers) | Lane A per-object byte/hash/size check |
| Object scope/prefix | `expectedAttemptObjectPrefix` / `expectedQuarantineObjectPrefix` — `packages/worker-protocol/src/artifacts.ts:76,81` (FROZEN) | wired (quarantine + commit paths) | Lane A scope check |
| Quarantine vocabulary | `QUARANTINE_REASONS` — `packages/worker-protocol/src/artifacts.ts:488` (FROZEN): `stale_fence,late_output,hash_mismatch,wrong_prefix,size_mismatch,unknown_artifact,corrupt_checkpoint` | wired | Lane A disposition names |
| CM-015 snapshot machinery | `runCutover0188Preflight` + `createPgSnapshotAdapters` — `server/src/services/cutover-0188-preflight.ts:145,368` | **wired** via own `main()` (docker migrate-entrypoint, `AOA_0188_CUTOVER_OPT_IN=1`) | the pre-0188 snapshot (operator leg) |
| Cutover marker | `distributed_cutover_markers` (`candidate_sha`, `snapshot_ref`, `snapshot_checksum`) — `packages/db/src/schema/distributed_cutover_markers.ts` | operator-write / app read-only | Lane C marker-negative |
| Schema revert (escape hatch) | `revert0188` — `packages/db/src/revert-0188.ts:95`; refuses on 2+ orgs (`:76`) or later migrations applied (`:89`), both pointing to *"restore the pre-0188 snapshot instead"* | script-only by design (`tsx src/revert-0188.ts`); integration test `packages/db/src/__tests__/revert-0188.integration.test.ts` | Lane C: proves marker-delete ≠ rollback |
| Re-enrollment | `advanceTargetGeneration` — `packages/db/src/repositories/tenant/worker-enrollment.ts:368` (bumps `execution_targets.device_generation`) | **wired**: `server/src/services/worker-enrollment.ts:429` | Lane E |
| Revocation (authority) | `revokeTargetAuthority` — `worker-enrollment.ts:557` (bumps generation + `execution_targets.status='disabled'` + `workers.status='revoked'`) | **wired**: `server/src/middleware/worker-session-auth.ts:338` | Lane E |
| Revocation (durable cutoff row) | `revokeExecutionTarget` — `server/src/services/execution-targets.ts:376` writes `execution_target_revocations` (`aoa_operator` path) — **NOT** `revokeTargetAuthority` (B1) | **wired**: `server/src/services/job-operations.ts:317` | Lane E |
| N/N-1 rollout policy | `checkRolloutPolicy` in `scripts/lib/staging-manifest-invariants.mjs:363-384` — `EXPECTED_ROLLOUT_PARALLELISM=1`, bounded `order` + `max_failure_ratio` for CP + workers | **wired** into `scripts/check-staging-manifest.mjs` (`policy` job, DEP-006) | Lane D asserts it |
| Rollback dial | per-sink rollout dial `distributed-execution-rollout-source.ts` (MIG-002) — canary/enabled/disabled per Org per sink; **"Rollback needs no restart"** (`MIG-002-dial-result.md` §1) | wired | Lane C/D + operator rollback |

**Conclusion of the caller count:** every guard an acceptance clause leans on is wired **except
the database RESTORE invocation path** — `runDatabaseRestore` has no operator entrypoint. That is
the one real vacuity here, filed as E11-F002, and it directly shapes the runbook (the operator
cannot type `aoa db:restore` today).

---

## 1. The finding that reframes the ticket

Opening REL-003 as "one more REL verifier ticket" is wrong twice.

**First: half of it cannot be a session build.** The clauses that carry *numbers* — "RPO/RTO meet
D5", "backup/restore", "pre-0188 snapshot→prior-release→candidate forward recovery", "rollback
exercise with measured recovery time" — are *measurements against live external infrastructure*
(external PostgreSQL, an object store, 2 CP replicas, ≥4 workers over 2 failure domains). No unit
or embedded-PG test produces a real RPO/RTO. Passing one off as the rehearsal would be the
programme's central vacuous-green trap at its highest-stakes moment (GO-BOOK §9 "Sprint 5b"). So
REL-003 is drawn as **buildable verification logic now + an operator-run live rehearsal owed**.

**Second: the one true wiring gap is the restore path, not a missing verifier.** `runDatabaseBackup`
ships behind `aoa db:backup`; `runDatabaseRestore` ships behind **nothing** (§0.3). A DR ticket
whose acceptance says "prove database … restore" has a restore *function* that no operator command
invokes. This is the DSK-002 / REL-004 lesson again — *count the callers before believing an
acceptance clause*. It is filed as **E11-F002** and resolved inside REL-003's scope by giving the
rehearsal harness/runbook an explicit restore invocation (§9, §11).

Everything else the acceptance leans on is already wired (§0.3), so the session's build is: **one
new pure reconciliation verifier**, **one new pure rollback-completeness verifier**, and **three
rehearsal-scenario suites that drive existing wired guards in the restore/rollback context** —
each fail-first, each with a positive control, the two new verifiers mutation-tested by deletion.

---

## 2. The crux — the buildable-vs-operator boundary

Every REL-003 acceptance clause, classified. **BUILDABLE** = a session can write it fail-first and
(for a new guard) mutation-test it against fixtures / embedded-PG, with no live infra.
**OPERATOR** = requires the live staging substrate and/or a measured number; the session prepares
the runbook, never a green.

| Acceptance clause | D5-DR | Buildable now? | How |
|---|---|---|---|
| restored state does not accept stale fences | DR06 | **BUILDABLE** (Lane B) | embedded-PG: restore a fixture snapshot, replay a post-snapshot fence → real `classifyFence` gate returns `stale_fence`; positive control = a genuinely-active restored fence is accepted |
| every object in the recovered authoritative manifest restores with matching **bytes/hash/size/scope** | DR04 | **BUILDABLE** (Lane A) | new pure `evaluateRecoveredManifestReconciliation(manifest, probes)`: per-row check `exists` ∧ `checksumSha256===sha256` ∧ `contentLength===sizeBytes` ∧ `objectKey` under `expectedAttemptObjectPrefix` |
| injected missing/corrupt objects fail the restore and are **quarantined** | DR04/DR05 | **BUILDABLE** (Lane A) — logic; **OPERATOR** — live injection | verifier classifies a missing/hash/size/prefix failure to a `QUARANTINE_REASONS` disposition; the *live* store injection (DR04 "inject ≥1 missing + ≥1 corrupt") is an operator step |
| missing required current objects **prevent full-service recovery from passing** | DR04 | **BUILDABLE** (Lane A) | verifier verdict is `recovered` iff **every** authoritative row is `verified`; any unresolved missing/mismatch → `failed` |
| marker deletion alone is **never accepted as rollback** | DE-20 | **BUILDABLE** (Lane C) | new pure `evaluateRollbackCompleteness(actions,state)` refuses a `marker_deleted`-only rollback; embedded-PG proof that deleting the marker row leaves the 0188 schema/data intact, and that `revert0188` refuses (2-org / later-migrations) pointing to snapshot restore |
| rollout order supports **N-1 workers** | DR07 | **BUILDABLE** (Lane D) | assert staging compose rollout policy (`checkRolloutPolicy`: parallelism 1, bounded order + failure ratio) + FROZEN-v1 identical N/N-1 baseline compatibility |
| worker **re-enrollment/revocation** succeed after restore | DR07 | **BUILDABLE** (Lane E) | embedded-PG: after restore, `advanceTargetGeneration` bumps generation; `revokeExecutionTarget` writes the `execution_target_revocations` cutoff (B1, not `revokeTargetAuthority`); a pre-restore-generation fence is stale |
| database & versioned object-store **RPO/RTO meet D5** | DR02/DR03 | **OPERATOR** | measured on live external PG + object store; §9 runbook |
| staging **database + object-store backup/restore** | DR01 | **OPERATOR** | real `aoa db:backup` + restore-harness (E11-F002) + real object-store snapshot on the live substrate |
| pre-0188 snapshot → **prior-release restore → forward recovery to candidate** | DE-20/DE-23 | **OPERATOR** | the full CM-015 rehearsal on live staging; `runCutover0188Preflight`/`createPgSnapshotAdapters` are the wired seam it exercises |
| **rollback exercise with measured recovery time** | DE-20 | **OPERATOR** | dial flip to legacy + snapshot restore, timed, on live staging |

**Honest end-state (state it in the result doc):** *verifiers + rehearsal harness + runbook
shipped; the live staging rehearsal (measured RPO/RTO, real backup/restore, pre-0188→prior→candidate,
live missing/corrupt injection, timed rollback) is owed by the operator; REL-003 promotes only on a
cited rehearsal run.* Do **not** mock-substitute the live rehearsal.

---

## 3. The decisions the ticket turns on

- **D1. The authoritative manifest set is `job_artifacts` where `status='committed'`.**
  `granted` and `quarantined` rows are disjoint partial-unique states (`job_artifacts.ts`
  `job_artifacts_committed_identity_uidx` / `_granted_` / `_quarantined_`) and are **not**
  authoritative — a granted (never-committed) or quarantined (dead-fence) object is not "required
  current". Reconciliation runs over the committed set only. This is what "required current
  objects" means precisely.

- **D2. An object the store cannot checksum FAILS CLOSED.** `HeadObjectResult.checksumSha256` is
  `undefined` when the store cannot supply a digest; DAT-002 already "fails closed rather than
  commit an unverifiable hash" (`storage/types.ts`). Reconciliation inherits it: an unverifiable
  object is `hash_unverifiable`, never `verified` — a recovery cannot pass on objects it could not
  integrity-check. (Mirrors REL-004 D2/D4 "absence is a refusal".)

- **D3. Reconciliation reuses the FROZEN quarantine vocabulary; it does not invent one.**
  `hash_mismatch` / `size_mismatch` / `wrong_prefix` are members of `QUARANTINE_REASONS`
  (`worker-protocol/artifacts.ts:488`). A missing object is `missing` (there is nothing to
  quarantine, but the recovery verdict still fails). Nothing in `packages/worker-protocol` changes
  (FROZEN).

- **D4. Scope is a *prefix* check, and it is the cross-tenant guard (DE-23).** An object whose
  `object_key` is not under `expectedAttemptObjectPrefix({org,job,attempt})` is `wrong_prefix` —
  which is exactly a restore reintroducing/misplacing a foreign-tenant object. The scope clause is
  not cosmetic; it is DE-23's "provenance-checked restore".

- **D5. A rollback is a state transition, not a marker delete.** Deleting a
  `distributed_cutover_markers` row removes a *gate marker keyed by `candidate_sha`* — the 0188
  tenant tables, org-referencing FKs, distributed data, and the rollout dial all remain. The real
  rollback is (a) restore the pre-0188 snapshot, or (b) `revert0188` (single-org only; it *refuses*
  otherwise and tells the operator to snapshot-restore — `revert-0188.ts:76-93`), plus flipping the
  MIG-002 dial back to legacy ("Rollback needs no restart", `MIG-002-dial-result.md` §1).
  `evaluateRollbackCompleteness` encodes this: a rollback whose action set is *only* `marker_deleted`
  is **refused**.

- **D6. N/N-1 for the initial release is the FROZEN-v1 identical baseline.** `worker-protocol` is
  frozen v1; the first distributed release runs the same baseline on both sides
  (`test-gates.md` D5-HA03), so N-1 workers are byte-identical and trivially interchangeable. The
  buildable proof is the compose rollout policy (one version-skewed replica at a time). A
  *non-identical* N/N-1 producer/consumer suite is required only for the first protocol-changing
  release — **out of scope** here (§13), owned by whichever ticket unfreezes the protocol.

- **D7. Reuse, do not restate (REL-004 D5).** Lane B drives the *real* `classifyFence` gate, not a
  re-implementation; Lane C drives the *real* `revert0188` refusals; Lane E drives the *real*
  `advanceTargetGeneration`/`revokeTargetAuthority`. Only the two genuinely-absent pieces — manifest
  reconciliation and rollback-completeness — are new code.

---

## 4. Lane split

| Lane | Scope | New guard? | Clause(s) | Substrate |
|---|---|---|---|---|
| **A** | `evaluateRecoveredManifestReconciliation` — pure manifest↔store byte/hash/size/scope verifier + verdict | **NEW** (mutation-tested) | bytes/hash/size/scope; injected missing/corrupt quarantined; missing-required-blocks-pass | pure unit |
| **B** | stale-fence rejection after restore | reuse wired `classifyFence` (positive control) | DR06 | embedded-PG |
| **C** | `evaluateRollbackCompleteness` + marker-delete-negative | **NEW** (mutation-tested) + reuse `revert0188` refusals | marker-deletion-never-rollback | pure unit + embedded-PG |
| **D** | rollout order supports N-1 workers | reuse wired `checkRolloutPolicy` + frozen-v1 baseline (positive control) | DR07 rollout half | fixture / static |
| **E** | re-enrollment/revocation after restore | reuse wired `advanceTargetGeneration`/`revokeTargetAuthority` (positive control) | DR07 enrollment half | embedded-PG |
| **O** | **operator** live staging rehearsal | — | RPO/RTO, real backup/restore, pre-0188→prior→candidate, live injection, timed rollback | live staging (runbook §9) |

Lane A first: it is the only wholly-new verification surface and the one that, if left as a bare
runbook line, would let "restore integrity" describe a check that does not run.

---

## 5. Invariants

Every guard below is mutation-tested **by deletion** before its lane lands (GO-BOOK §2.2). The two
NEW verifiers (Lane A, Lane C) carry the mutation table (§7); the reuse lanes (B, D, E) carry a
**positive control** proving the test reaches the already-mutation-tested production guard.

| # | Invariant | Lane | Proven by |
|---|---|---|---|
| I1 | A recovered-manifest object whose stored bytes hash ≠ recorded `sha256` is `hash_mismatch`, never `verified` | A | reconciliation unit |
| I2 | A recovered-manifest object whose `contentLength` ≠ recorded `size_bytes` is `size_mismatch` | A | reconciliation unit |
| I3 | A recovered-manifest object whose `object_key` is not under its `expectedAttemptObjectPrefix` is `wrong_prefix` (cross-tenant/misplaced) | A | reconciliation unit |
| I4 | A recovered-manifest object the store reports `exists:false` is `missing` | A | reconciliation unit |
| I5 | An object the store cannot checksum (`checksumSha256===undefined`) is `hash_unverifiable`, never `verified` (fail-closed) | A | reconciliation unit |
| I6 | The verdict is `recovered` **iff every** authoritative row is `verified`; any non-verified row → `failed` (missing-required blocks pass) | A | reconciliation unit |
| I7 | A quarantined/failed disposition is never counted as promoted/served | A | reconciliation unit |
| I8 | The reconciliation verifier is **invoked by the rehearsal harness**, not orphaned (the REL-004 I4 anti-orphan rule) | A | harness call-site test |
| I9 | After restore, a pre-restore (post-snapshot) fence is rejected as `stale_fence` by the real gate; a genuinely-active restored fence is accepted | B | embedded-PG scenario + positive control |
| I10 | A rollback whose only action is `marker_deleted` is **refused**; deleting the marker row leaves the 0188 schema/data intact | C | rollback-completeness unit + embedded-PG |
| I11 | `revert0188` refuses on 2+ orgs / later-migrations-applied, directing to snapshot restore (marker-only rollback is not a substitute) | C | reuse `revert0188` refusal + positive control |
| I12 | Rollout order supports N-1 workers: compose declares parallelism 1 + bounded order/failure-ratio, and the frozen-v1 baseline is identical N/N-1 | D | `checkRolloutPolicy` assertion + baseline case |
| I13 | After restore, `advanceTargetGeneration` bumps the generation; `revokeExecutionTarget` writes the durable `execution_target_revocations` cutoff (NOT `revokeTargetAuthority`, which only bumps gen + flips status — B1); a fence pinned to the pre-restore generation is stale | E | embedded-PG scenario + positive control |

---

## 6. Fail-first TDD (RED for the written reason; positive control FIRST)

For **each** lane, the order is: (1) a positive control that breaks the function/harness outright
and proves the suite goes RED (if it stays green the test never reached the code — GO-BOOK §2.2);
(2) the real RED case; (3) minimal implementation; (4) GREEN; commit.

- **Lane A (reconciliation).** Positive control: stub `evaluateRecoveredManifestReconciliation` to
  `return { verdict: "recovered", dispositions: [] }` unconditionally → the mismatch cases below
  fail to fire (proves they exercise the function). Then RED cases, each expecting a specific
  disposition/verdict on a hand-built `(manifest[], probes[])`:
  - matching bytes/size/scope → `verified`, verdict `recovered` (the truest green);
  - hash flipped → `hash_mismatch`, verdict `failed`;
  - size off by one → `size_mismatch`;
  - key moved out of prefix (or into another org's prefix) → `wrong_prefix`;
  - probe `exists:false` → `missing`, verdict `failed` (missing-required blocks pass);
  - probe `checksumSha256:undefined` → `hash_unverifiable`, verdict `failed`;
  - a quarantined/failed disposition is absent from the "promoted/verified" set.
  Then implement the guards G1–G7 (§7) minimally.
- **Lane B (stale-fence after restore).** Positive control: seed a genuinely-active fence in the
  restored fixture and assert admission **succeeds** — proves the harness reaches the gate. RED:
  restore a fixture snapshot taken at T0; replay a fence minted at T1>T0 (its lease/attempt row is
  absent in the restored DB, or its generation is pre-restore) → the real `job-control` admission
  (`classifyFence` → `JobFenceError("stale_fence")`) rejects. No new guard; the gate is already
  mutation-tested by its own ticket.
- **Lane C (marker-negative).** Positive control: `evaluateRollbackCompleteness` stubbed to
  `accepted` unconditionally → the marker-only case fails to fire. RED (pure): `actions:["marker_deleted"]`
  with `state` showing organizations table present → `refused` (reason `marker_deletion_is_not_rollback`).
  RED (embedded-PG): delete the `distributed_cutover_markers` row, assert `organizations` +
  org-referencing FKs still present (marker delete changed no tenant state); call `revert0188` on a
  2-org DB and assert `singleOrgRefusal` fires (the accepted rollback path is snapshot-restore).
- **Lane D (N-1 rollout).** Positive control: feed `checkRolloutPolicy` a compose with
  `parallelism: 4` and assert a violation (proves the check runs). RED/GREEN: the real
  `docker-compose.staging.yml` passes `checkRolloutPolicy` (parallelism 1, bounded order +
  `max_failure_ratio`), and the frozen-v1 baseline identity holds (same protocol digest both sides).
- **Lane E (re-enroll/revoke after restore).** Positive control: assert `advanceTargetGeneration`
  on a *matching* expected-generation **succeeds** (returns next gen). RED: after restore, a fence
  pinned to the pre-restore generation is stale. `revokeTargetAuthority` bumps the generation and flips
  `execution_targets.status='disabled'` + `workers.status='revoked'`; the durable
  `execution_target_revocations` cutoff row is written by **`revokeExecutionTarget`**
  (`server/src/services/execution-targets.ts:376`, via `job-operations.ts:317`), NOT
  `revokeTargetAuthority` (B1) — assert the record row against `revokeExecutionTarget`, the
  gen-bump/status against `revokeTargetAuthority`.

Lanes B/C-embedded/E are `*.integration.test.ts` on embedded-PG — **Linux/CI only** (Windows
embedded-PG caveats; MEMORY: windows-embedded-pg-integration-tests). Lanes A and C-pure are
`*.test.ts` unit suites that run everywhere.

---

## 7. Mutation table (the two NEW verifiers)

DELETE each guard (never rewrite to an equivalent — `return false && x` measures nothing, GO-BOOK
§2.2); re-run; confirm the named test goes RED; **print whether the anchor matched**. Report as
*N killed / 0 survivors* with the anchor-matched note.

### Lane A — `evaluateRecoveredManifestReconciliation`

| # | Guard (deleted) | Test that turns RED |
|---|---|---|
| A-G1 | `exists` check (existence → `missing`) | I4 missing-object case |
| A-G2 | `checksumSha256 === sha256` (→ `hash_mismatch`) | I1 hash-flip case |
| A-G3 | `contentLength === sizeBytes` (→ `size_mismatch`) | I2 size-off-by-one case |
| A-G4 | `objectKey` under `expectedAttemptObjectPrefix` (→ `wrong_prefix`) | I3 moved-key / foreign-prefix case |
| A-G5 | `checksumSha256 === undefined` fail-closed (→ `hash_unverifiable`) | I5 undefined-checksum case |
| A-G6 | verdict = `recovered` **iff all** verified (the `every` quantifier) | I6 one-missing-among-many still-`recovered`? case |
| A-G7 | exclusion of quarantined/failed from the promoted set | I7 promoted-set case |

### Lane C — `evaluateRollbackCompleteness`

| # | Guard (deleted) | Test that turns RED |
|---|---|---|
| C-G1 | refuse when action set is only `marker_deleted` | I10 marker-only case |
| C-G2 | require a real revert action (snapshot-restore OR single-org `revert0188`) for `accepted` | I10 "accepted needs a real revert" case |
| C-G3 | fail-closed on empty/unknown action set (absence is refusal, D2 style) | empty-actions case |

Lanes B/D/E add **no** new guard; their protection is the production guard's own mutation coverage
(its ticket) plus the positive control in §6 proving the REL-003 scenario reaches it. Prove
equivalence for any surviving mutant by deleting both the guard and its backstop and showing the
suite then fails (GO-BOOK §2.2 "a surviving mutant is a question").

---

## 8. Acceptance → test / operator-step map

| Acceptance clause | Turns RED (buildable) OR cited operator step |
|---|---|
| restored state does not accept stale fences | Lane B integration test (I9) |
| every object restores with matching bytes/hash/size/scope | Lane A unit (I1–I6) + **operator** §9 step 6 (over the real recovered manifest) |
| injected missing/corrupt objects fail + quarantined | Lane A unit (I1–I5,I7) + **operator** §9 step 7 (live inject ≥1 missing + ≥1 corrupt, DR04) |
| missing required current objects prevent full-service recovery passing | Lane A verdict (I6) + **operator** §9 step 6 verdict |
| marker deletion alone is never accepted as rollback | Lane C unit + embedded-PG (I10,I11) |
| rollout order supports N-1 workers | Lane D (I12) + **operator** §9 step 8 (rolling deploy on ≥4 workers) |
| worker re-enrollment/revocation succeed after restore | Lane E integration (I13) + **operator** §9 step 8 |
| database & object-store RPO/RTO meet D5 | **operator** §9 steps 4–6, measured vs D5-DR02/DR03 |
| staging DB + object-store backup/restore | **operator** §9 steps 3–5 |
| pre-0188 snapshot → prior-release restore → forward recovery to candidate | **operator** §9 steps 2–5 (DE-20/DE-23, DR01) |
| rollback exercise with measured recovery time | **operator** §9 step 9 (timed) |

No acceptance clause is left without either a RED test or a cited operator step — and no operator
step is passed off as a session green.

---

## 9. Operator runbook (live staging rehearsal — the owed leg)

**Boundary (state it and hold it — GO-BOOK §9 "Sprint 5b").** The **session** builds/repairs the
harness (including the E11-F002 restore wrapper), runs every unit + embedded-PG lane green, and
prepares this runbook. Only the **operator** reaches the D5 staging substrate, authorizes any
spend, and runs the campaign; if the session cannot reach live staging it STOPS here and hands over
the runbook. Secrets (object-store keys, DB URLs, the E2B/provider key) are operator-held — never
entered or handled by the session (Decision #104; never serialize a key into any prompt/event/log).

**Precondition.** D5 topology up (`program-design.md` §"D5"): 2 CP replicas, ≥4 workers over 2
failure domains, external PostgreSQL + object store, managed secret store, canary rollout enabled.
Candidate image SHA recorded (`AOA_0188_CANDIDATE_SHA`).

**Steps (capture evidence at each; all evidence lands under `docs/replatform/qa/<date>-REL-003-rehearsal/`
and is retained ≥180 days per `test-gates.md` RET-01):**

1. **Baseline.** Record candidate SHA, worker fleet (IDs, generations, failure domains), the
   `job_artifacts status='committed'` manifest snapshot (row count + total bytes).
2. **Pre-0188 snapshot (CM-015).** Run the operator-gated preflight
   (`server/src/services/cutover-0188-preflight.ts main()` via the migrate entrypoint,
   `AOA_0188_CUTOVER_OPT_IN=1`) → capture `snapshot_ref` + `snapshot_checksum` from the
   `distributed_cutover_markers` row.
3. **Backup.** `aoa db:backup --json` (record `backupFile`, `sizeBytes`, connection source) **and**
   the object-store snapshot (bucket versioning / copy) at a recorded fault instant `T_fault`.
4. **Prior-release restore.** Restore the pre-0188 snapshot into the prior-release database — via
   the **E11-F002 restore wrapper** (`runDatabaseRestore`, or `pg_restore` for the custom-format
   dump). Record restore start `T_restore_start`.
5. **Forward recovery to candidate.** Re-run migrations forward to the candidate; bring CP + workers
   up migration-first. Record `T_full_service` (first successful lease on the recovered fleet).
6. **Manifest reconciliation (the wired verifier over REAL objects).** Run the Lane-A verifier over
   the recovered `status='committed'` manifest × live `headObject` probes → assert verdict
   `recovered`, **zero** unresolved missing/mismatched. Record the reconciliation RTO
   (`T_recon_done − T_restore_start`).
7. **Injected fault (DR04).** Delete ≥1 authoritative object and corrupt ≥1 (flip a byte) in the
   recovered store; re-run reconciliation → verdict `failed`, the two objects quarantined
   (`wrong`/`hash_mismatch`/`missing`), **none promoted/served**.
8. **Restore rollout (DR07).** Rolling-deploy the candidate across the ≥4 workers (parallelism 1) —
   verify N-1 workers keep serving; re-enroll one worker (`advanceTargetGeneration`) and revoke one
   (`revokeExecutionTarget` — the durable operator cutoff row, per B1; `revokeTargetAuthority` only
   bumps the generation + flips status) → the revoked worker's next governed request is refused
   within the D5/DSK timing.
9. **Rollback exercise (timed).** Flip the MIG-002 dial back to legacy (no restart) and, for the
   schema, restore the pre-0188 snapshot (or `revert0188` if single-org). **Assert deleting the
   marker row alone is NOT the rollback** (the tenant tables persist). Record rollback recovery
   time.

**Measurement vs D5 (record pass/fail):** DB RPO = `T_fault − newest recoverable DB commit` ≤15 min;
DB full-service RTO = `T_full_service − T_restore_start` ≤4 h (DR02). Object-store RPO ≤15 min;
reconciliation RTO ≤4 h (DR03).

**Promotion rule.** REL-003 promotes to done **only** on a cited rehearsal run (date + evidence dir
+ the two DE-20/DE-23 crossings' verification) that measured RPO/RTO within D5-DR02/DR03 and passed
DR01/DR04–DR07 on the live substrate. Absent that, the honest end-state is *"verifiers + harness +
runbook shipped; live staging rehearsal owed"* — a legitimate, respected outcome (GO-BOOK §9), not
a failure. Never promote on an embedded-PG or fixture substitute.

---

## 10. The gate interaction — what the landing commit MUST touch (★ verify first)

The just-shipped **REL-FOUNDATION-GATE** (Sprint 9 unit 1) makes `<id>-design.md` existence the
admissibility key, and reds on a **stale** deferral. Verified at tip:

- `scripts/check-distributed-execution-foundation.mjs` `parseWrittenRelTickets` (≈`:811-826`)
  matches `/^(REL-\d+)-design\.md$/` — landing **`REL-003-design.md` adds `REL-003` to `written`**.
- `validateReleaseTestDeferrals` (≈`:868-892`, the stale branch `:881-885`):
  `if (written.has(id)) → "deferral REL-003 is stale … remove the deferral"`. This error is pushed
  in the always-on `policy` job → `ci-required` reds.
- `docs/architecture/distributed-execution-release-tests.json` currently declares
  `deferred["REL-003"]` and its own `reason` says the deferral is **transitional — "MUST be removed
  in the same commit that lands REL-003-design.md"**.

**Therefore the commit that lands this design MUST also delete `deferred["REL-003"]` from
`docs/architecture/distributed-execution-release-tests.json`.** This is the gate's self-cleaning
mechanism working as intended: `checkCrossingReleaseTest` (≈`:779-802`) re-admits the two crossings
that name REL-003 (DE-20, DE-23) via `written.has("REL-003")` (disk) instead of the deferral, so
they stay green. Net at rest: still 0 errors.

**Execution/commit touch-list:**
1. **This file** — `docs/replatform/epics/E11-hardening-release/tickets/REL-003-design.md`
   (the ticket's Start SHA; GO-BOOK §2.2 "commit the design before any code").
2. **Delete `deferred["REL-003"]`** from `docs/architecture/distributed-execution-release-tests.json`
   — same commit as (1). (REL-001/002/005 stay deferred.)
3. Run `node scripts/check-distributed-execution-foundation.mjs` → **exit 0** (prove rest-green).
4. The code lanes (A–E) land in their own fail-first commits after the design (GO-BOOK §2.2 order),
   plus the E11-F002 restore-wrapper.
5. File **E11-F002** (§11) — `findings.md` heading + a byte-equal `finding-ownership.json` key, same
   commit as the discovery.

---

## 11. Findings to file (byte-equal pair, GO-BOOK §2.4)

This design does not itself edit `findings.md` / `finding-ownership.json` (doc-only session). The
**execution** files this in the discovery commit, in the E11 format
(`## E11-F0NN — <title>` with em-dash/hyphen, never a colon; `**Status:** \`open\``):

> **`## E11-F002 — the database restore path has no operator entrypoint`**
> **Status:** `open` · Severity: **MED** · owner **REL-003**.
> `runDatabaseRestore` (`packages/db/src/backup-lib.ts:1056`) is exported and unit-tested but has
> **zero production/CLI callers** — only `*.test.ts`. `aoa db:backup` exists
> (`cli/src/commands/db-backup.ts`); there is **no `aoa db:restore`**. A DR ticket whose acceptance
> says "prove database … restore" therefore has no operator invocation for the restore leg.
> **Resolution (in REL-003 scope):** the rehearsal harness/runbook wraps `runDatabaseRestore`
> explicitly (or an `aoa db:restore` command is added); until then the runbook's restore step names
> the exact `pg_restore`/wrapper invocation. Owned by REL-003, resolved when the harness lands.

`finding-ownership.json` gets `"E11-F002": { "status": "owned", "ticket": "REL-003", "reason": … }`
in the **same commit** (the `check-finding-ownership` register reds otherwise — a new open finding
is born `undeclared_finding`). **The key is `ticket`, not `owner_ticket`** (C1: `finding-ownership.mjs`
reads `entry.ticket`; a wrong key → `malformed_declaration` reds the always-on `policy` job).
**Resolution commit (C4):** when the harness lands, flip this finding's `findings.md` Status **and
delete this `finding-ownership.json` key in the SAME commit**, or `stale_declaration` reds.

---

## 12. Register interactions (verified — no surprise reds)

- **`check-ticket-graph-coverage`** stays green: `expandTicketIdsFromFilename`
  (`scripts/lib/ticket-graph-coverage.mjs:41`, `/^([A-Z]{2,5}-(\d{3})…)/`) extracts `REL-003` from
  the filename, and the authority node `#### REL-003` exists in `program-design.md`
  (parsed by `parseAuthorityNodes` `:65`, `/^####\s+([A-Z]{2,5}-\d{3})\s/`). REL-003 has a numeric
  id, so — unlike REL-FOUNDATION-GATE — it **is** graph-tracked; the node's pre-existence is what
  keeps the new file green.
- **`check-execution-census`** needs **no** bump: it tracks only `*.test.mjs`
  (`scripts/check-execution-census.mjs:46`). REL-003's suites are vitest `*.test.ts` under
  `packages/db/src/__tests__/` and `server/src/__tests__/` — not census-tracked.
- **`check-guard-inventory`** needs **no** bump: it tracks `check-*.mjs`. REL-003 adds no new
  `check-*.mjs` (it reuses `check-staging-manifest.mjs`/`checkRolloutPolicy` for Lane D).
- **`check-finding-ownership`**: the E11-F002 pair (§11) keeps it green.
- The `distributed-execution-release-tests.json` edit is a **data input**, tracked by no register
  beyond the foundation checker itself (§10).

This is a **`code=true`** PR once the lanes land (`packages/*`, `server/src/*`, `cli/*`,
`scripts/*.mjs` data), so `ci-required` rides the full suite (verify shards / e2e / migrations /
policy / brand-check), not `policy` alone.

---

## 13. Non-goals (with owners)

- **The live staging rehearsal itself, and any measured RPO/RTO number.** Operator (Lane O, §9).
  The session never fabricates a measurement.
- **A non-identical N/N-1 producer/consumer protocol suite.** Deferred until the first
  protocol-changing release; `worker-protocol` is FROZEN v1 (D6). Owner: whichever ticket unfreezes
  the protocol; tracked by `test-gates.md` D5-HA03.
- **The kill-switch write path / a rollback UI.** GO-BOOK §5 debt ("Kill switch has no write path")
  and REL-005 scope.
- **The other D5 lanes** — HA (DR-free failover), load/fairness/SLO (D5-L*). REL-002 owns load;
  REL-003 owns only the DR block (DR01–DR07).
- **Object-store *encryption*-at-rest key scoping (DE-23 confidentiality arm).** DAT-002/DEP-006
  own the encrypted-backup mechanism; REL-003 verifies provenance/scope on restore, not the KMS
  design.
- **Adding a general-purpose `aoa db:restore` UX beyond the rehearsal need.** E11-F002 resolves the
  restore-invocation gap minimally (a harness wrapper); a polished CLI command is optional.

---

## 14. Risks

- **R1 — the rehearsal is passed off as done on a fixture green.** The programme's central trap.
  Mitigated by the explicit promotion rule (§9) and the completeness-critic review question: *does
  the evidence chain reach the LIVE substrate, or stop at embedded-PG?*
- **R2 — the reconciliation verifier ships orphaned** (REL-004's I4 lesson: verifiers with no
  caller). Mitigated by I8 (the harness call-site test) — the verifier is invoked by the rehearsal
  harness, not only its own unit.
- **R3 — the stale/marker/rollout lanes drive a wired guard but never reach it** (E1-F008: a
  refusal suite with no positive control). Mitigated by the positive control mandated first in every
  reuse lane (§6).
- **R4 — the landing commit forgets to delete `deferred["REL-003"]`** → stale-deferral red on every
  PR. Mitigated by §10 as an explicit commit-touch step + the exit-0 gate check.
- **R5 — Windows CI skips the embedded-PG lanes** (B/C-embedded/E). Accepted: they are Linux-gate
  lanes; the pure units (A, C-pure) cover everywhere, and the required Linux `e2e`/`migrations`
  lanes run the integration suites.

## 15. Rollback

Doc-only until the code lanes land. If a lane must be reverted: the reconciliation/rollback
verifiers are additive pure modules (delete + their tests); the reuse lanes are tests only. Reverting
**must also restore `deferred["REL-003"]`** to the manifest in the same commit (the inverse of §10),
or the foundation checker reds the other way (a crossing names a ticket that is now neither on disk
nor deferred). The design file and the manifest entry move together, both directions.

## 16. Count the callers (summary)

- `classifyFence`/`isActiveFence` — **wired** (job-control.ts:1125-1128). Lane B is honest.
- `advanceTargetGeneration` (worker-enrollment.ts:429) / `revokeTargetAuthority`
  (worker-session-auth.ts:338) — **wired**. Lane E is honest.
- `runCutover0188Preflight` — **wired** via `main()` (migrate entrypoint). Operator leg is honest.
- `revert0188` — script-only **by design** (manual escape hatch); its refusals are the Lane C
  mechanism.
- `checkRolloutPolicy` — **wired** into `check-staging-manifest.mjs` (`policy`). Lane D is honest.
- `runDatabaseRestore` — **ZERO** production/CLI callers → **E11-F002**; the one clause satisfied
  by a function nothing calls, fixed in-scope by the runbook/harness wrapper.
- `evaluateRecoveredManifestReconciliation` / `evaluateRollbackCompleteness` — **new**; their caller
  is the rehearsal harness (I8), never orphaned.
