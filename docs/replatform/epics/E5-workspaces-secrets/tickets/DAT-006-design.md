# DAT-006 Design — Reconcile local workspaces + orphan output

**Epic:** `E5-workspaces-secrets`. **Source:** `program-design.md:659-664`. **Depends on:** FND-002, JOB-006, WRK-007, DAT-003, PRT-007 (all landed).
**Status:** DESIGN. Terrain-mapped (5 readers → synthesizer, `wf_20599d20-eb8`) + all 8 load-bearing claims orchestrator-re-verified against `C:/e3` before writing.

---

## 1. Outcome + the one framing insight

Admit explicit **local folder grants**, stage isolated snapshots, and reconcile **desktop/dedicated** results against the declared **base / owner / placement / attempt / lease / fence** via **valid promotion** or **quarantine**. Matching active output commits idempotently; expired / replaced / wrong-owner / locality-denied / base-mismatched / duplicate output never overwrites the source tree. Orphan upload uses a **distinct quarantine prefix/operation**, retains hashes/provenance, and **cannot update the old attempt**. Applying a patch revalidates the current local base.

**★ FRAMING INSIGHT (re-verified):** the FROZEN worker-protocol v1 **already ships the entire `quarantine_*` device-auth wire surface** — `expectedQuarantineObjectPrefix()` (`artifacts.ts:81`), `QUARANTINE_REASONS` (`:488`), `quarantineGrantPayloadV1Schema`/`quarantineUploadGrantV1Schema`/`quarantineFinalizePayloadV1Schema`/`quarantineUploadReceiptV1Schema` (disposition **`z.literal("quarantined")` only**, `:661`), transport ops `quarantine_grant`/`quarantine_finalize` on `audience:"device_session"` (`transport.ts:397/418`) — and the WRK-007 daemon **already builds/signs/POSTs both ops** (`worker-daemon/src/lease/quarantine.ts:155/197/286`) **into a void** (grep `server/src` for `quarantineGrant|quarantineFinalize` = 0 handlers). **So DAT-006 is mostly: wire the frozen device-auth quarantine surface SERVER-side + admit folder grants + the reconcile/promotion path — ZERO worker-protocol edits.**

**Non-goals:** the live cross-process device→server channel is real today (the daemon already POSTs); DAT-006 stands up the server end. No new wire op, no second registry. Desktop OS keystore / MIG cutover / cross-target mobility are out of scope. Self-hosted behavior byte-identical (distributed path dormant behind default-off `AOA_DISTRIBUTED_EXECUTION_ENABLED`).

---

## 2. The table decision (re-verified)

| Concern | Decision | Why |
|---|---|---|
| **Orphan / reconcile disposition** | **WIDEN `job_artifacts`** (nullable additive cols) | Zero-keystone (proven 4×): the whole-table `aoa_app` grant + FORCE-RLS (0211) covers new nullable cols; the legacy-grants per-column ACL matrix auto-resolves an ungranted new col to `aclIsNull:true` (`job-control-legacy-grants.contract.test.ts:571-574`). Confirmed all DAT-002/003 cols are nullable + table empty (`job_artifacts.ts:27-32`). |
| **Local-folder-grant admission** | **ONE NEW tenant-scoped RLS table `folder_grants`** | Wrong lifetime/ownership-grain/cardinality for a widen — it is the durable `(owner_user, execution_target, declared base/path, granted/revoked)` record the frozen `folderGrantId` uuid resolves to. Re-verified `folderGrantId` resolves to nothing server-side today (only in frozen protocol + daemon). Cost: the TEN-006 keystone bump (see §5). |
| **Locality (allowed/denied)** | **DECIDED, never stored** | Read frozen `PLACEMENT_MATRIX`/`DATA_LOCALITIES` (`job.ts:68/88`) × the attempt's committed `placementOwner`/`placementTargetScope`/`placementTargetGeneration` (`job_attempts.ts`). No locality column. |

### 2a. `job_artifacts` widen (migration 0252, nullable additive)
- `orphan_disposition text` — `null` for ordinary rows; the DAT-006 orphan row carries **`status='quarantined'`** (a value `findCommitted` never returns, so the `job_artifacts_committed_identity_uidx WHERE status='committed'` partial-unique **structurally cannot** let an orphan collide-update a committed attempt).
- `quarantine_reason text` — a member of the frozen `QUARANTINE_REASONS` (`stale_fence|late_output|hash_mismatch|wrong_prefix|size_mismatch|unknown_artifact|corrupt_checkpoint`).
- `observed_lease_id uuid`, `observed_fence_token text` — **non-authoritative** provenance recorded from the orphan payload (never used for authorization — mirrors the frozen `quarantineGrantPayloadV1Schema` `observedLeaseId`/`observedFenceToken`).
- Reuses existing `object_key` (must start `quarantine/`), `sha256`, `size_bytes`, `sensitivity='restricted'`, `kind`.
- **NOT** `apply_status` — schema comment `job_artifacts.ts:52-55` already declares `apply_status='conflict_quarantined'` is a distinct in-band DAT-003 disposition, NOT the frozen `quarantine/` object prefix.

### 2b. `folder_grants` (NEW, TEN-006 per-table RLS pattern)
Model on `workers`/`leases`: composite-FK to `execution_targets(targetAuthorityKey, id)`, `owner:<org>:<user>` authority-key CHECK, `deviceGeneration`, `granted_at`/`revoked_at`, `declared_base_path`, `folder_grant_id uuid` (the value the frozen `snapshotProvenance.folderGrantId` resolves to). Per-table FORCE RLS + C14 `--custom` drizzle policy (Decision #122). Semantics (`accepted-caveats.md`): permission to **read/stage** the declared content, **NOT** to keep writing to a live user folder after lease loss.

---

## 3. Two mutators (resolves the terrain-map's guarded/unguarded contradiction)

**(A) `recordOrphanQuarantine` → `EXPECTED_UNGUARDED` (device-authed, dead-lease-tolerant).** An orphan is precisely a dead-fence output; calling `resolveWorkerFenceContext`/`guardActiveFence` would throw `stale_fence` and defeat the purpose. Same species as the reaper surface already in `EXPECTED_UNGUARDED` (`requestCancellation`, `reapExpiredLeases`, … — re-verified present, they "act when the fence is stale"). Auth = `verifyWorkerOperationProof` (re-verified: returns `{organizationId, targetId, targetGeneration, deviceThumbprint}` from JWT+Ed25519 proof, **no lease**; authority "checked later inside the operation's single runInTenant transaction") + an in-tx **device-only** recheck of `targetId`+`deviceGeneration` against current target authority (assemble from `worker-fence-context` `lockWorkerLeaseAuthority`/`normalizePlacementRegistryTarget` **without** the lease step). Refusals → `target_revoked`, **never** `stale_fence`. Registered in `EXPECTED_UNGUARDED` (1 place) + the surface contract.

**(B) Promotion reconcile → REUSE existing GUARDED mutators; add NO new guarded mutator.** A matching-active-fence promotion of a desktop/dedicated result reuses `commitArtifactVersion` (fenced verified-commit, DAT-002) for a snapshot and `recordPatchApplyState` (fenced base-revalidation, DAT-003) for a patch — both already fence-first and in `EXPECTED_GUARDED` (re-verified count = **10**; no 11th needed). DAT-006 adds only the **locality gate** ahead of these (decided from `PLACEMENT_MATRIX` × committed placement) + folder-grant resolution. This keeps the guarded surface + its 3-place coupling (`GUARDED_JOB_MUTATORS`/`GOVERNED_FENCE_SURFACE`/`EXPECTED_GUARDED`) **untouched**.

### 3a. Reject-vocab mapping onto the CLOSED `PROTOCOL_ERROR_CODES` (`errors.ts:22`) — never invent a code, never disclose foreign-tenant existence
- **expired / replaced** → guard `stale_fence` → wire `stale_fence`; orphan reason `stale_fence`.
- **wrong-owner** → decided inside the identity match (re-homed target matches no row) → `stale_fence`; generation-cutoff → `target_revoked`. Never a distinct "owner" code.
- **locality-denied** → post-admission (fence active) → coarse `malformed` (DAT-004/005 non-disclosing convention); add no protocol code.
- **base-mismatch** → NOT an error, a **disposition**: `conflict_quarantined` (DAT-003, never auto-applies); orphan analog = reason `late_output` + distinct prefix.
- **duplicate** → NOT an error, an **idempotent no-op**: design the orphan insert on a partial-unique natural key → replay DO-NOTHING (mirror `commitArtifactVersion`/`recordPatchApplyState alreadyApplied:true`).

---

## 4. Server wiring (all net-new server-side; daemon already emits)

1. Two routes in `worker-control.ts` on `device_session` audience: `POST …/quarantine-grants`, `POST …/quarantine-finalize` (skeleton = safeParse → maxBytes → `verifyWorkerOperationProof` → service → `sendWorkerOperationProtocolError`).
2. **quarantine-grant service** — mirror `artifact-transfer-grant.ts` but bind the **`quarantine/` prefix** (`expectedQuarantineObjectPrefix`), ≤5-min TTL (`QUARANTINE_MAX_TTL_MS`), **no live-fence requirement** (device-auth only); `presignPut`; self-validate via `quarantineUploadGrantV1Schema.parse()`.
3. **quarantine-finalize service** — `headObject` integrity (fail-closed on missing sha/size), then `recordOrphanQuarantine` (writes the `status='quarantined'` orphan row). Structurally incapable of touching the committed attempt row (no `commitArtifactVersion` call, no promote/apply field — the frozen finalize receipt has none). Precedent: `job-output-bridge.ts` treats quarantine as metadata-only, "never touches terminal/summary state."
4. **folder-grant admission service + resolver** — admit an explicit grant (owner + execution_target + declared base) → `folder_grants` row; resolve `folderGrantId` at stage/reconcile time to gate that a captured path is within the declared base.
5. **locality decision** — pure helper reading `PLACEMENT_MATRIX` × committed placement; `owner_device_only` output against a shared/differently-owned target → deny transfer.

---

## 5. INERT-until-wired + keystone/gate cost

- `folder_grants` + admission resolver can land as **schema + resolver only** (the frozen `folderGrantId` points at nothing today) — inert until a capture/reconcile path reads it; default-off distributed posture.
- `job_artifacts` orphan cols are inert until quarantine-finalize writes them (nullable, no existing reader).
- The device-session routes are dormant until the (already-emitting) daemon reaches a live server.
- **KEYSTONE COST (the one non-zero reconciliation):** the NEW `folder_grants` RLS table forces bumping the legacy-grants certificate set — `RLS_RELATIONS` / `FORCE_RLS_RELATIONS` / `POLICY_COUNTS` / `RLS_POLICY_MANIFEST` + a `*_NEW_PATH_GRANTS` constant + `RELATION_ACL_MANIFEST` rows (`job-control-legacy-grants.contract.test.ts`). The contract asserts exact counts (fail-first). The `job_artifacts` widen needs **none** of this.
- **Foundation docs gate** (`check-distributed-execution-foundation.mjs`): if the design edits the late-output/authority section, keep the exact tokens (`validateLateOutput`: "authoritative state"/"auto-applied" negations + "quarantine prefix") and JSON↔MD register parity; cite the defined `#### DAT-006` heading (`program-design.md:659`).

---

## 6. Fail-first TEST LIST (mirrors acceptance bullets)

Path/escape (schema+service): (1) grant admits only declared base; out-of-base path → reject. (2) symlink → unrepresentable/reject. (3) case-collision → reject (`addPathCollisionIssues`). (4) special-file / `../` / absolute → `isSafeWorkspacePath` reject. (5) likely-secret exclusion honored.
Dirty/untracked: (6) dirty tree staged as isolated snapshot, source unmutated. (7) untracked/generated provenance preserved.
Fence/auth reconcile: (8) matching active fence+owner+placement+attempt+lease → valid promotion, idempotent commit. (9) disconnect→restart mid-reconcile → converges, no double-commit. (10) stale/expired fence → `stale_fence`, source untouched, output→quarantine. (11) replacement attempt → `stale_fence`/quarantine, no overwrite. (12) wrong-owner → `stale_fence`/`target_revoked` (no owner disclosure). (13) locality-denied (`owner_device_only` vs shared target) → policy reject. (14) locality-allowed (`transfer_allowed`) → promotes.
Base revalidation: (15) current base matches declared → apply advances base. (16) base-mismatch → `conflict_quarantined`, never auto-applies. (17) create/rename/delete/binary patch each revalidate current local base.
Orphan/storage: (18) orphan → distinct `quarantine/` prefix, retains sha256+size+provenance, `disposition="quarantined"` only. (19) orphan cannot update the committed attempt (partial-unique `status='committed'` excludes it). (20) duplicate finalize → idempotent DO-NOTHING. (21) partial write / full disk → fail-closed. (22) orphan recovery after daemon restart → converges to same quarantined record. (23) repeated reconciliation → idempotent, no drift.
Contract: (24) `recordOrphanQuarantine` in `EXPECTED_UNGUARDED`; guarded surface + 3-place coupling UNCHANGED (no new guarded mutator); legacy-grants certificate counts bumped exactly for `folder_grants`.

---

## 7. Load-bearing claims — re-verified by the orchestrator (not just the terrain map)

1. **Promotion reuses existing guarded mutators; only the orphan mutator is new (unguarded).** ✓ (`commitArtifactVersion`/`recordPatchApplyState` already fenced + in `EXPECTED_GUARDED`; reaper species in `EXPECTED_UNGUARDED` is the orphan template.)
2. **`EXPECTED_GUARDED` = 10 exactly.** ✓ (read the list: acceptEvent, authorizeArtifactCommit, commitArtifactVersion, recordPatchApplyState, readSecretHandle, resolveExecutionSecret, completeAttempt, recordServiceHealth, applyProjectionReceipt, ackControlCommand.)
3. **New `folder_grants` RLS table forces the legacy-grants certificate bump.** ✓ premise (TEN-006 pattern) — the implementer bumps + the contract enforces exactness.
4. **`job_artifacts` nullable widen = zero keystone.** ✓ (`job_artifacts.ts:27-32` + auto-`aclIsNull` contract `:571-574`.)
5. **Foundation docs gate token/parity requirements.** ✓ noted (§5).
6. **Device-only auth without a lease.** ✓ (`verifyWorkerOperationProof` returns target+generation from proof; authority rechecked in-tenant-tx.)
7. **`folderGrantId` resolves to nothing server-side today.** ✓ (grep: only frozen protocol + daemon + tests.)
8. **`apply_status` (DAT-003 in-band) vs frozen `quarantine/` prefix (DAT-006) stay distinct.** ✓ (schema comment `job_artifacts.ts:52-55` already declares the boundary.)

**Doc drift (NOT self-fixed):** `epics/README.md` says E5 = DAT-001–006; `program-design.md` defines DAT-001–007.
