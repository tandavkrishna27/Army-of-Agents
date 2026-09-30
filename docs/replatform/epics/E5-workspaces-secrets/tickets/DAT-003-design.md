# DAT-003 Design — Patch output and conflict quarantine

**Status:** `design` (reviewable artifact; implementation follows via per-slice fail-first TDD + distinct adversarial review)
**Epic:** `E5-workspaces-secrets` (third ticket).
**Authoritative source:** `docs/replatform/program-design.md:638-643`.
**Depends on (complete):** DAT-002 (`938e6016e`, artifact commit + widened `job_artifacts` + `commitArtifactVersion`) + DAT-001 (`bc72e6eb3`, snapshot producer + two digests). Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.
**Grounded by:** the DAT-003 terrain-map (5 readers + synthesis); load-bearing claims re-verified in `C:\e3` by the orchestrator (frozen patch schema `artifacts.ts:214-254`; no existing patch code; `job_artifacts` has no patch/apply columns; the two-digest crux `snapshot/hashing.ts:10-15`).

---

## 1. Scope + framing

**Outcome (program-design.md:641):** represent coding output as a patch (base→result) with base/result hashes, and provide an **explicit apply/review service**.
**Acceptance (:642):** a **matching base applies deterministically**; a **mismatched base NEVER auto-applies**; **binary + large outputs use artifact references**.

Two halves, both net-new (verified — zero existing patch code):
- **Producer** (worker-daemon): a pure set-diff of two DAT-001 `WorkspaceManifestV1` entry lists → a frozen `WorkspacePatchManifestV1`.
- **Apply/review service** (server): given a committed `workspace_patch`, decide **apply** (base matches) vs **conflict-quarantine** (base mismatch), fence-guarded, one-tx.

**DAT-003 rides the frozen DAT-002 `artifact_commit` op — no new wire op.** `workspace_patch` is a frozen `ARTIFACT_KIND` (`artifacts.ts:263`); the patch manifest JSON is the artifact **content** at `objectKey`, committed via the existing `commitArtifactVersion`. The frozen protocol has exactly 10 ops and deliberately has **no** apply/promote/patch op (and rejects an apply/promote field on every shape), so **apply is a server service, not a wire op**. worker-protocol is FROZEN — not extended.

---

## 2. The frozen contract (verified `artifacts.ts:214-254`)

`workspacePatchManifestV1Schema`: `{protocolVersion:1, organizationId, companyId, jobId, attempt, artifactId, base: workspaceBaseV1Schema, baseManifestHash, resultManifestHash, operations[]}` (`.strict()`). Op vocabulary (`patchOperationSchema`, discriminated on `op`): `create`/`modify` = `{op, path, resultSha256, sizeBytes}`; `delete` = `{op, path}`; `rename` = `{op, fromPath, path, resultSha256, sizeBytes}`. Two superRefines: **`baseManifestHash !== resultManifestHash`** and **destination-`path` uniqueness** (`op.path` for every op incl. rename's destination; `rename.fromPath` excluded from the dedup). **No inline diff bytes, no `baseSha256`, no binary flag** — every mutated file is referenced by `resultSha256` (content-addressed), so binary + large outputs are artifact references **by construction**.

---

## 3. Decisions

### D1 — Producer in `packages/worker-daemon/src/patch/build-patch.ts` (worker-daemon, mirrors DAT-001)
`buildWorkspacePatch(base: WorkspaceManifestV1, result: WorkspaceManifestV1, ctx) → WorkspacePatchManifestV1`. A pure in-memory set-diff of `base.entries` vs `result.entries` keyed by `path`: result-only → `create`; both-present, `sha256` differs → `modify`; base-only → `delete` candidate. **Rename detection:** a `delete`-candidate path whose `sha256` equals a `create` path's `sha256` (1:1, content-identical) folds into one `rename{fromPath, path, resultSha256, sizeBytes}`. Deterministic op order via `compareUtf8`/`sortSnapshotEntries` (reuse `snapshot/hashing.ts:55-70`). `baseManifestHash`/`resultManifestHash` from `computeManifestHash` (`hashing.ts:107-109`). **Final fail-closed gate:** `workspacePatchManifestV1Schema.parse()` (throws on hash-equal or dup destination path). Git NOT required (the diff is over manifests). Boundary-legal (worker-protocol + pino + `node:*`). Directory entries are ignored by the diff (only file entries carry content); a directory-only change surfaces via its files.

### D2 — Apply/review is a server service `server/src/services/patch-apply.ts` (mirrors artifact-commit.ts)
Inside `runInTenant`, behind default-off `AOA_DISTRIBUTED_EXECUTION_ENABLED`, one tx:
1. **`guardActiveFence` FIRST** (stale/terminal/revoked precede every content check — the DAT-002 invariant).
2. Load the committed `workspace_patch` `job_artifacts` row + its persisted `base_manifest_hash`/`result_manifest_hash` (D4).
3. **Base revalidation (the correctness crux, D3):** resolve the job's current accepted base; **match → apply**; **mismatch → conflict-quarantine (NEVER auto-apply)**.
4. Idempotent: re-apply of an already-applied patch is a no-op returning `applied`.
Reject/verify vocabulary maps to the frozen closed `PROTOCOL_ERROR_CODES` exactly as DAT-002 (fence → `stale_fence`/`attempt_terminal`/`target_revoked`; base mismatch is not a protocol error — it is an *applied=false, disposition=conflict_quarantined* outcome, surfaced for review, not a wire rejection).

### D3 — Base revalidation anchors on a COMMITTED prior version's manifestHash, never a re-capture
**The crux (verified `snapshot/hashing.ts:10-15`):** DAT-001 emits two digests. `contentRevision` excludes capture metadata (repeatable content identity); **`manifestHash` includes capture metadata (capturedAt/artifactId/provenance) and is the value committed**. So revalidating `baseManifestHash` against a *freshly re-captured* target manifest would **never** match. Base revalidation therefore compares `patch.baseManifestHash` to the **currently-accepted base manifestHash of a stored committed version**, resolved as:
- the `result_manifest_hash` of the most-recent `apply_status='applied'` `workspace_patch` for the job; else
- the committed base `workspace_snapshot`'s manifestHash for the job.

**Convention pinned:** a `workspace_snapshot` artifact's object content IS the canonical `WorkspaceManifestV1` serialization, so its committed `sha256` (object hash, DAT-002) equals its `manifestHash`. The apply service resolves the initial base via the committed `workspace_snapshot` row's `sha256`. (Residual: the producer/worker must upload canonical bytes; flagged §7.) `decideApply(patch, currentBase) → apply iff currentBase !== null && patch.baseManifestHash === currentBase`. On apply, the accepted base advances to `patch.resultManifestHash` (the next patch must chain to it).

### D4 — Persistence: WIDEN `job_artifacts` (nullable additive), not a new table
`job_artifacts` has `kind` (can be `'workspace_patch'`) but no patch/apply columns (verified). Add nullable: `base_manifest_hash`, `result_manifest_hash`, `apply_status` (`'pending'|'applied'|'conflict_quarantined'`, default null). **Zero keystone grant reconciliation** (DAT-002 proved widening inherits the whole-table `aoa_app` grant + RLS + policy; `e2-serving-role-correction` + `distributed-foundation` re-verify). Migration `0249` via `pnpm db:generate` + C14 `IF NOT EXISTS` guards + snapshot + journal. The `commitArtifactVersion` mutator is extended (or a sibling `recordPatchApplyState` mutator added — decide at impl to avoid a signature ripple, per DAT-002-D2) to write these on the workspace_patch row. Conflict quarantine = `apply_status='conflict_quarantined'` (a control-plane disposition — **NOT** the frozen device-auth `quarantine/` prefix, which is stale-fence upload-time output for DAT-006). Never promotes; forces explicit review.

### D5 — Binary/large + duplicate-result: near-zero net-new
Binary/large is not wire-special-cased — every op references `resultSha256`, so large/binary files are content-addressed artifact references that ride the DAT-002 commit path; duplicate content dedupes naturally by hash. Duplicate-result (same `(org, job, attempt, artifactId)`) reuses DAT-002's idempotent `onConflictDoNothing` partial-unique — no version bump, one row.

### D6 — Op-vs-base structural consistency (defense-in-depth, scoped)
A matching `baseManifestHash` guarantees the ops were diffed against that exact base (the producer computed them), so op-vs-base re-validation is redundant for an honest patch. A forged patch (matching hash, bogus ops) is defended by: the producer's `.parse()`, the base-hash match, and — as optional hardening — loading the base snapshot manifest content and asserting `create.path` absent / `modify.path`+`delete.path`+`rename.fromPath` present in `base.entries`. DAT-003 pins the **base-hash match** as the primary gate; the content-fetch op-validation is **noted, deferred to a hardening pass** unless review deems it in-scope (it needs a base-manifest object fetch, DAT-002 `headObject`/`getObject` style).

---

## 4. Slice plan (fail-first TDD)

1. **S1 producer set-diff (daemon, vectors-style).** base+result manifests → expected create/modify/delete ops; determinism + UTF-8 ordering. Fail-first before `build-patch.ts`.
2. **S2 rename detection + schema gate.** identical-sha base-only→result-only → `rename`; dup destination path + hash-equal rejection via `.parse()`.
3. **S3 persistence migration `0249`.** widen `job_artifacts` (nullable + `apply_status`); `db:generate` + C14 + snapshot; run schema-sibling + `artifact-lifecycle-schema-contract` + migration-journal tests (the JOB-011 drift lesson).
4. **S4 commit wrapper + duplicate-result (server, embedded-PG).** commit `kind='workspace_patch'` via `commitArtifactVersion` writing base/result hashes; duplicate-result idempotency.
5. **S5 base-match → apply (server integration).** matching base → `apply_status='applied'`, base advances; guard-first (`stale_fence` precedes).
6. **S6 mismatched base → conflict quarantine (server integration).** never auto-applies; `apply_status='conflict_quarantined'`; idempotent re-apply; a stale patch (old base) after an advancement is quarantined.
7. **S7 vectors gate.** `scripts/check-workspace-patch-vectors.mjs` (+`.test.mjs`) — pure `decideApply` (match→apply, mismatch→quarantine) + diff-determinism vectors; wire into the always-on `policy` job (cross-platform-honest, the only OS-portable lane). Mirror `check-artifact-commit-vectors.mjs`.

---

## 5. Gate + verification profile

Local: `pnpm db:generate` (0249 + snapshot + journal) + `artifact-lifecycle-schema-contract`; `db`/`server` typecheck; `AOA_RUN_WIN_INTEGRATION=1 vitest run` the patch-apply integration + schema-siblings + fence-surface contract; `worker-daemon exec vitest run` (the producer, hermetic); `node scripts/check-workspace-patch-vectors.mjs` (+ `node --test`); `check:distributed-foundation` (no drift — widen); `check:frozen-worker-protocol-v1` (zero edits); `check:worker-daemon-boundary` (producer stays worker-protocol+pino); `pnpm install --frozen-lockfile` (no dep change — the diff needs no lib). CI `ci-required`: `policy` (new patch vectors) + `brand-check` + `worker-protocol-contract-bytes` always-on; `verify`/`lint`/`e2e`/`e2e-pgvector`/`migrations`/`distributed-contract` (schema touch). Blast-radius budget: schema-sibling column-list + fence-surface contract (if a mutator is added).

---

## 6. Non-goals (deferred)

- Frozen device-auth quarantine handlers (`quarantine_grant`/`finalize`) → DAT-006 (stale-fence upload-time output; distinct from apply-time conflict quarantine).
- Founder-facing review route / Inbox surface for the explicit apply/review action → later route/UI ticket; DAT-003 ships the deterministic apply/review **service** (callable), not the HTTP/UI trigger.
- Materializing the result onto a live desktop folder → DAT-006 (reconcile local workspaces).
- Founder refinement loop (Decisions #69/#70) — immutable-version review UI, not the worker-patch applier.
- Extending worker-protocol; relaxing DAT-001 `limits.ts` (bytes-by-reference already sidesteps inlining).

---

## 7. Residual risks / open decisions

- **Canonical-snapshot-upload convention (D3):** base revalidation resolves the initial base via the committed `workspace_snapshot`'s `sha256` == `manifestHash`, which holds only if the snapshot object bytes are the canonical serialization. Flagged; the worker producer must uphold it (or DAT-003 adds an explicit `manifest_hash` column populated at snapshot commit — a small DAT-002 touch).
- **Apply trigger:** DAT-003 delivers the callable service; whether apply is auto (post-commit) or founder-explicit is a wiring decision deferred to the route/UI ticket. The service defaults to explicit invocation.
- **Op-vs-base structural validation (D6):** primary gate is the base-hash match; content-fetch op-validation deferred unless review deems it in-scope.
- **Apply-chain concurrency:** two patches racing to advance the same base — the fence lock + the applied-base resolution (latest applied) serialize; the loser sees an advanced base → conflict-quarantine. Verify under the fence lock.

---

## 8. Decisions ledger

| ID | Decision |
|----|----------|
| DAT-003-D1 | Producer = worker-daemon pure manifest set-diff + rename detection; `.parse()` fail-closed gate; no git. |
| DAT-003-D2 | Apply/review = server service, one-tx `guardActiveFence`-first (no wire op; frozen forbids apply/promote). |
| DAT-003-D3 | Base revalidation compares `baseManifestHash` to a COMMITTED prior version's manifestHash (never a re-capture); apply advances the accepted base to `resultManifestHash`. |
| DAT-003-D4 | Widen `job_artifacts` (nullable `base_manifest_hash`/`result_manifest_hash`/`apply_status`); zero keystone reconciliation; conflict quarantine = a control-plane disposition, not the frozen `quarantine/` prefix. |
| DAT-003-D5 | Binary/large = content-addressed artifact refs by construction; duplicate-result reuses DAT-002 idempotency. |
| DAT-003-D6 | Base-hash match is the primary apply gate; op-vs-base content validation deferred to hardening. |
