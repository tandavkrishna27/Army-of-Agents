# DAT-006 Result — Reconcile local workspaces + orphan output

**Status:** COMPLETE — implemented per the committed design, adversarial-reviewed, all local gates green. Epic completion is the Integration Gate Owner's call.
**Epic:** `E5-workspaces-secrets`. **Design:** [`DAT-006-design.md`](DAT-006-design.md). **Source:** `program-design.md:659-664`.
**Process:** terrain-map Workflow (5 readers → synth) → orchestrator re-verified all 8 load-bearing claims → committed design → implementer subagent → adversarial-review Workflow (5 security-dimension finders → refute-by-default verifiers) → orchestrator re-verify all gates + read all 6 security-core files + reconcile every verdict (re-tracing refutations) + fix fail-first → this doc.

---

## 1. Outcome

Wire the FROZEN device-auth `quarantine_*` surface server-side + admit local-folder grants + build the reconcile/promotion primitives. Zero worker-protocol edits. One nullable `job_artifacts` widen (0252) + one NEW `folder_grants` RLS table (0252 table DDL + 0253 custom RLS).

- **`recordOrphanQuarantine`** — the ONE new mutator, **UNGUARDED** (`EXPECTED_UNGUARDED`; no `guardActiveFence` — an orphan is a dead-fence output). Device-only recheck (target existence + generation), attempt→target binding (see §2 fix #1), org-scoped `unknown_job` pre-check (foreign/absent read identically → no oracle), idempotent insert on a `WHERE status='quarantined'` partial-unique DISJOINT from the committed one.
- **`resolveWorkerDeviceContext`** — the device-scoped auth (proof-replay → `unauthorized`; authority lock + `ackAuthorityCurrent` under fresh clock + active target + profile/generation touch → `target_revoked`) that STOPS before the lease step; never throws `stale_fence`.
- **quarantine-grant / quarantine-finalize services + 2 `device_session` routes** — grant binds the write key to `expectedQuarantineObjectPrefix(auth.org, job, attempt)` + ≤5-min TTL; finalize does fail-closed `headObject` integrity then records. Promotion **reuses** the existing guarded `commitArtifactVersion`/`recordPatchApplyState` — the guarded surface stays `EXPECTED_GUARDED`=10, 3-place coupling untouched.
- **`folder_grants`** (NEW RLS table) + admission/resolver; **locality** decided from `PLACEMENT_MATRIX` × committed placement (pure helper).

**Keystone bump (the one non-zero reconciliation):** `folder_grants` added to `RLS_RELATIONS` 20→21, `FORCE_RLS_RELATIONS` 19→20, `POLICY_COUNTS` total 29→30 + the ACL manifest — the legacy-grants contract asserts these exactly. The `job_artifacts` widen needed none (nullable additive; auto-`aclIsNull`).

---

## 2. Adversarial review + fixes

The review (workflow `wf_3a05bc14-3af`; 5 dimensions; **5 confirmed/plausible, 3 refuted, 0 verifier-died**) surfaced a genuine authz gap the orchestrator's own read had missed. Reconciling every verdict against my read of `recordOrphanQuarantine`, `resolveWorkerDeviceContext`, both quarantine services, the 0253 RLS migration, and `folder-grant-path.ts`:

| # | Finding | Sev | Verdict | Disposition |
|---|---------|-----|---------|-------------|
| **1** | `recordOrphanQuarantine` authorized by device + (org,job)-existence only — **never bound the presented attempt to the caller's target**. DAT-006 targets are OWNER-scoped, so a fully-enrolled worker T_b could forge a `quarantined` row against ANOTHER owner's job/attempt in the same org (RLS is org-grain) | MED | **CONFIRMED** | **FIXED** — load the attempt `(org,job,attemptNumber)` and require `placementTargetId === input.targetId`; mismatch/missing → coarse `unknown_job`→`malformed` (non-disclosing) |
| **4** | `resolveCapturedPath` (DB single-path gate) returned `isPathWithinBase(...)` ONLY — it **never applied the `isLikelySecretPath` floor** the batch `admitCapturedPaths` enforces, so `<base>/.env`, `id_rsa`, `*.pem`, `credentials` were admissible inside the base | MED | **PLAUSIBLE** | **FIXED** — `&& !isLikelySecretPath(...)` so the single-path resolver matches the always-on secret floor |
| **2** | Divergent idempotent replay (same job/attempt/identifier, a NEW object) is a DO-NOTHING, but the receipt was rebuilt from the **new body** → an acknowledged receipt that lies about what is durably quarantined | LOW | **CONFIRMED** | **FIXED** — build the receipt STRICTLY from the stored row (`outcome.artifact.*`), never the request body |
| **3** | A concurrent same-tenant job delete racing the (org,job) pre-check → the composite FK raises `23503` → a raw 500 instead of the coarse `malformed` | LOW | **PLAUSIBLE** | **FIXED** — catch `23503` on the insert → `OrphanQuarantineRejection('unknown_job')`→`malformed` |
| **5** | The locality gate (`decideOutputTransfer`) has ZERO non-test callers — "locality-denied never overwrites source" is not enforced end-to-end | LOW | **PLAUSIBLE** | **DOCUMENTED (inert seam)** — per design §3B/§5 the live promotion reconcile channel is the E4-D12 inert seam (like DAT-005's proxy channel); the helper is built + unit-tested (9 tests), wiring is deferred. Residual. |
| — | `admit()` throws `invalid_base` on a revoke race | LOW | REFUTED | No fix — no `revoked_at` writer exists yet; race unreachable (re-verified). |
| — | `owner_device_only` enforced at owner not device granularity (no `placementTargetGeneration` on `TransferDestination`) | MED | REFUTED | No fix now — the locality helper is inert (finding #5); when wired, add device-generation granularity. Residual. |
| — | Rich internal locality/`invalid_base` vocab has no wire-coarsening path yet | LOW | REFUTED | No fix now — inert; when wired, map to coarse `malformed`. Residual. |

**Finding #1 is exactly why the adversarial review exists** — a real cross-owner authenticated write my own first read missed (I checked device + (org,job) but not that the ATTEMPT was placed on the caller's target). **Fail-first proven** (revert→confirm-fail→restore): with the binding disabled, a worker re-homing an attempt to a foreign `placement_target_id` and finalizing gets `expected 'quarantined' to be 'rejected'` (the forge succeeds); #2's revert shows the replay receipt returns `.../second.bin` not the stored `.../first.bin`; #4's revert admits `project/src/.env`. All three restored → green.

---

## 3. Gate table (all GREEN, re-run after fixes)

| Gate | Result |
|------|--------|
| `db` / `server` / `worker-daemon` typecheck | clean |
| `quarantine.integration` + `folder-grant.integration` (`AOA_RUN_WIN_INTEGRATION=1`) | 18 pass (incl. the 3 new fail-first regressions) |
| `folder-grant-path` (pure) + `reconcile-locality` (pure) | 5 + 9 pass |
| `job-fence-surface.contract` | 8 pass (`recordOrphanQuarantine` in `EXPECTED_UNGUARDED`; `EXPECTED_GUARDED`=10 untouched) |
| `job-control-legacy-grants.contract` | 7 pass (21-table RLS / 20 FORCE / 30-row — the `folder_grants` keystone bump) |
| `e2-serving-role-correction` + `artifact-lifecycle-schema-contract` | 23 pass (0252/0253 snapshots contiguous; `folder_grants` is aoa_app-owned, not serving-role) |
| DAT-004/005 regression (secret-broker, artifact-transfer/commit, patch-apply) | no regression |
| `check:distributed-foundation` / `check:frozen-worker-protocol-v1` | PASS / OK (zero worker-protocol edits) |
| worker-daemon import-boundary / bundled-snapshot | clean / PASS |

---

## 4. Non-goals + residual risks

Non-goals (deferred): the **live device→server promotion reconcile channel** (the locality gate + folder-grant resolver land as built-but-unwired helpers ahead of the existing guarded `commitArtifactVersion`/`recordPatchApplyState` — the wiring is the E4-D12 inert seam, like DAT-005's proxy), the desktop OS keystore (DSK/E10), MIG cutover / cross-target mobility.

Residuals (all tied to wiring the promotion channel — spawned/tracked):
- **Locality gate end-to-end** (finding #5): wire `decideOutputTransfer` immediately before the promotion commit; add **device-generation granularity** to `TransferDestination` (refuted R2) and **coarsen** the rich locality/`invalid_base` vocab to `malformed` on the wire (refuted R3).
- **Folder-grant revoke path** (refuted R1): no `revoked_at` writer exists yet; when added, revisit the `admit()` re-select-on-conflict robustness.

---

## 5. Post-merge CI fix (honest record)

The initial DAT-006 push (`0569bdcca`) FAILED Linux CI: 32 tests red in `distributed-execution-db-startup.integration.test.ts` (the `verify` job only — migrations/policy/distributed-contract all green). The local gate set above did NOT include that subprocess-heavy suite, and the manifest CONTRACT tests (legacy-grants/e2-serving-role, which passed) validate the manifest internally and never exercise the startup gate's `appTablePrivileges()` consumer. **Root cause:** the widen registered `folder_grants` in the manifest (`APP_SERVING_RELATIONS`/`RLS_RELATIONS`/`POLICY_COUNTS`/ACL manifests) but not in `appTablePrivileges()` (`server/src/db/distributed-execution-databases.ts:99`), which spreads each `*_NEW_PATH_GRANTS` and omitted `FOLDER_GRANTS_NEW_PATH_GRANTS` — so the gate expected aoa_app to have zero folder_grants privileges while migration 0253 grants four, and every full-gate boot threw an authority-drift error. **Fix `13d462f66`:** import + spread `FOLDER_GRANTS_NEW_PATH_GRANTS` into `appTablePrivileges()`. CI re-run (`13d462f66`) = `success`, all required checks green. **New rule:** any ticket touching a serving-role/RLS table must run `distributed-execution-db-startup.integration.test.ts` locally.

## 6. Doc drift to surface (not self-fixed)

`epics/README.md` says E5 = DAT-001–006; `program-design.md` defines DAT-001–007. Integration Gate Owner's reconciliation.
