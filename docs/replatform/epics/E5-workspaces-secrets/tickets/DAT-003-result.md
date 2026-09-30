# DAT-003 Result — Patch output and conflict quarantine

**Status:** COMPLETE — implemented per the committed design, adversarial-reviewed, all local gates green. Epic completion is the Integration Gate Owner's call.
**Epic:** `E5-workspaces-secrets`. **Design:** [`DAT-003-design.md`](DAT-003-design.md). **Source:** `program-design.md:638-643`.
**Process:** terrain-map Workflow → orchestrator re-verification → committed design → implementer subagent → adversarial-review Workflow (5 finders → refute-by-default verifiers) → orchestrator re-verify all gates + read security files + reconcile every verdict (re-tracing refutations) + fix fail-first → this doc.

---

## 1. Outcome

Two net-new halves + persistence, all riding the FROZEN DAT-002 `artifact_commit` op (`workspace_patch` is an artifact kind — no new wire op):
- **Producer** `packages/worker-daemon/src/patch/build-patch.ts`: a pure in-memory set-diff of two DAT-001 `WorkspaceManifestV1` entry lists → a frozen `WorkspacePatchManifestV1` (create/modify/delete + 1:1 rename fold; UTF-8 destination-path order; `.parse()` fail-closed).
- **Apply/review** `server/src/services/patch-apply.ts` + the guarded `recordPatchApplyState` mutator: one-tx, `guardActiveFence`-first, fence identity resolved **before any object-store read** (the DAT-002 lesson), objectKey prefix-bound to the auth org/job/attempt; base revalidation → `applied` (accepted base advances) vs `conflict_quarantined` (never auto-applies).
- **Persistence:** widened `job_artifacts` (nullable `base_manifest_hash`/`result_manifest_hash`/`apply_status`, migration 0249) → **zero keystone reconciliation** (`e2-serving-role-correction` + `distributed-foundation` green).

**Key implementer divergences (both sound):** a **sibling `recordPatchApplyState` mutator** (not extending `commitArtifactVersion` — avoids its test-caller ripple, per DAT-002-D2); base/result hashes persisted at **apply** (from the committed, integrity-verified patch object) not commit. The base-revalidation crux (D3) holds: compare `patch.baseManifestHash` to a committed prior version's manifestHash, never a re-capture.

---

## 2. Adversarial review + fixes

The review (workflow `wf_6d7969a3-741`; 9 findings → 9 verdicts) returned 2 CONFIRMED + 1 PLAUSIBLE + 6 REFUTED. The orchestrator independently read `patch-apply.ts`, `recordPatchApplyState`, and `build-patch.ts`, and reconciled every verdict — **including re-tracing the refutations** (the DAT-002 lesson). **4 fixes applied fail-first** (revert→observe-fail→restore proven); the rest documented.

| # | Finding | Sev | Verdict | Disposition |
|---|---------|-----|---------|-------------|
| #2 | `conflict_quarantined` not sticky — a re-invoked quarantined patch re-decides and could auto-flip to `applied`, bypassing "mismatched base never auto-applies" | MED | **CONFIRMED** | **FIXED** — sticky short-circuit: a quarantined patch stays quarantined on re-apply |
| #8 | Patch vectors fixture never bound to the real producer ("cannot silently diverge" unenforced) | MED | **CONFIRMED** | **FIXED** — a producer test runs the real `buildWorkspacePatch` over every fixture diff vector |
| #3 | Base bootstrap resolves the **most-recent** committed snapshot, not the **declared** base → over-rejects a clean apply when a job has >1 committed snapshot (a retry re-captures) | HIGH (finder) → **REFUTED** (verifier: "not reachable in the current single-snapshot flow") | **FIXED as hardening** (orchestrator, my own pre-review finding) — existence-based decision, informative current-base kept separate |
| #5 | An exec-bit/metadata-only change → misleading "no differences" throw | MED | **PLAUSIBLE** | **FIXED** — accurate diagnostic ("metadata not representable as file operations"); mode-drop itself is a frozen-protocol limit (documented) |
| — | Cross-attempt concurrent applies fork the base chain (fence lock is per-attempt) | HIGH/MED | **REFUTED** | No fix: needs two simultaneously-live leases for one job — the single-active-lease placement model prevents it (documented residual) |
| — | Apply trusts re-parsed object hashes; object sha256 not re-verified vs the committed row | LOW | (documented) | No fix: the object is content-addressed + immutable (DAT-002-verified), objectKey bound to the committed row, and the parsed manifest self-identifies (org/job/attempt/artifactId) |

**On #3 — reconciling a refutation:** the finder confirmed it; its verifier refuted it as "not reachable in the current flow." Re-tracing (the DAT-002 lesson): the refutation is only *not-currently-reachable* (true for single-snapshot jobs), but a **retried attempt that re-commits a base snapshot yields >1 committed snapshot**, and "most-recent" then over-rejects a clean apply. My first fix conflated the decision with the response's informative `currentBaseManifestHash` (broke an existing test); the shipped fix **separates them** — existence-of-the-declared-base drives the decision, while `currentBaseManifestHash` still reports the actual current head (latest applied result, else most-recent snapshot). All prior tests preserved.

Fail-first proven for #2/#3/#5 (reverted to the buggy behavior → the 3 regressions failed as predicted — sticky flipped to applied, multi-snapshot quarantined-not-applied, wrong throw message — while the 10 original tests + #8 stayed green → then restored).

---

## 3. Gate table (all GREEN, re-run after fixes)

| Gate | Result |
|------|--------|
| `db` / `server` / `worker-daemon` typecheck | clean |
| `worker-daemon exec vitest run` | **92 files / 364 tests** (producer + 2 review regressions) |
| dist purity (`tsc --listFilesOnly`) | **0** test doubles; `worker-daemon build` clean |
| `check:worker-daemon-boundary` | PASS (producer stays worker-protocol+pino+node:*) |
| `patch-apply.integration` (`AOA_RUN_WIN_INTEGRATION=1`) | **12 pass** (10 + 2 review regressions) |
| `job-fence-surface.contract` | 8 pass (`recordPatchApplyState` guards before any tx access) |
| `e2-serving-role-correction` / `job-control-legacy-grants.contract` | 27 pass (widen inherits the grant — no drift) |
| `artifact-lifecycle-schema-contract` | 3 pass (0249 snapshot/journal contiguous) |
| `check-workspace-patch-vectors.mjs` (+ `node --test`) | PASS (4 diff, 3 apply) / 10 pass |
| `check:distributed-foundation` / `check:frozen-worker-protocol-v1` | PASS / OK (zero edits) |
| `pnpm install --frozen-lockfile` | Done (no dep change) |

---

## 4. Non-goals + residual risks

Non-goals (deferred): frozen device-auth quarantine handlers (DAT-006); founder review route/UI; result materialization onto a live folder (DAT-006); worker-daemon consumer wiring. Residuals: the frozen patch format cannot carry the executable bit (a mode-only change is unrepresentable — documented, fail-closed with an accurate diagnostic); cross-attempt concurrent applies (prevented by the single-active-lease model; not serialized in code); the canonical-snapshot-upload convention (`workspace_snapshot` object `sha256` == its `manifestHash`) the base resolution relies on; base-hash match is the apply gate (op-vs-base content validation deferred to hardening, D6).

---

## 5. Doc drift to surface (not self-fixed)

`epics/README.md:25` says E5 = `DAT-001–DAT-006`; `program-design.md` defines `DAT-001–DAT-007`. Integration Gate Owner's reconciliation.
