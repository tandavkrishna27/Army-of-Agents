# DAT-002 Result — Direct upload/download and fenced artifact commit

**Status:** slices 1–6 COMPLETE + adversarial-reviewed + all local gates green; **live-MinIO round-trip (slice 7) deferred** as a focused Linux-CI follow-up (per the design's slice-7 escape hatch). Epic completion is the Integration Gate Owner's call.
**Epic:** `E5-workspaces-secrets`. **Design:** [`DAT-002-design.md`](DAT-002-design.md). **Source:** `program-design.md:631-636`.
**Process:** terrain-map Workflow → orchestrator re-verification → committed design → implementer subagent → adversarial-review Workflow (5 finders → refute-by-default verifiers) → orchestrator re-verify all gates + read security files + reconcile every verdict + fix each confirmed defect fail-first → this doc.

---

## 1. Outcome

Server-side implementation of two FROZEN worker-protocol ops — `artifact_transfer_grant` (scoped presigned upload/download grant) and `artifact_commit` (fenced, verified commit) — plus a widened `job_artifacts`, a `commitArtifactVersion` guarded mutator, S3 presigning, and an in-process MinIO-free integration suite. Distributed-flag-gated; legacy asset path untouched; zero worker-protocol edits.

**Key decisions held (design §2):** D1 widen `job_artifacts` in place (nullable additive + partial-unique) → **zero keystone grant-manifest reconciliation** (verified: `distributed-foundation` + `e2-serving-role-correction` green); D2 sibling `commitArtifactVersion` mutator (no `authorizeArtifactCommit` signature ripple); D3 presign via `@aws-sdk/s3-request-presigner`, strictly-https grant URL, SHA256-via-object-checksum fail-closed; D4/D5 upload needs a live fence, download tenant-scoped, commit one-tx fence-first with `stale_fence` precedence; D6/D7 grant-TTL expiry + two-tier verification.

**Reject-vocabulary reconciliation (forced by the frozen closed 13-code `PROTOCOL_ERROR_CODES`):** no `wrong_prefix`/`size_mismatch`/`upload_incomplete` codes exist → sha mismatch → `event_hash_mismatch`; wrong-prefix/size/tenant/missing → `malformed` (coarse + **non-disclosing** — a tenant mismatch must not reveal a foreign resource); fence → `stale_fence`/`attempt_terminal`/`target_revoked`. Precise internal reasons live in `ArtifactCommitRejection` + the independent vectors gate.

---

## 2. Adversarial review + fixes

The review (5 finders → refute-by-default verifiers; workflow `wf_6553a67b-6e8`) surfaced 9 findings → 8 verdicts (1 verifier died, adjudicated by the orchestrator). The orchestrator independently read `artifact-commit.ts`, `artifact-transfer-grant.ts`, `worker-fence-context.ts`, `commitArtifactVersion`, and the frozen schemas, and reconciled every verdict. **4 confirmed defects fixed fail-first; 3 refutations accepted; 1 refutation OVERRIDDEN (the review's own trace was wrong).**

| # | Finding | Sev | Verdict | Disposition |
|---|---------|-----|---------|-------------|
| A | `headObject` ran BEFORE the fence-identity tx → a caller could distinguish foreign-object-exists (→ `stale_fence` HTTP error) from missing (→ 200 `rejected`), a **cross-tenant existence oracle on committed artifacts** | HIGH | review REFUTED (traced foreign-exists → `malformed`); **orchestrator OVERRODE** — `resolveWorkerFenceContext` throws `stale_fence` *before* the prefix check, so the two responses differ | **FIXED** — moved `headObject` inside `runInTenant`, after `resolveWorkerFenceContext` |
| B | Upload grant presigned `expectedObjectKey` without an auth-org prefix check → presigned PUT into a foreign org's namespace | HIGH | CONFIRMED (also found by the orchestrator pre-review) | **FIXED** — mirror the download branch's `expectedAttemptObjectPrefix` check before `presignPut` |
| C | Upload grant could re-issue a PUT for an ALREADY-committed key → overwrite immutable bytes a reader still trusts | MED | CONFIRMED | **FIXED** — reject the upload grant when `findCommitted` exists (Rule #7 / Decisions #43/#45) |
| D | Grant advertises `maxBytes` but nothing enforces it (presign drops it; commit only checks declared==actual) → unbounded object size | MED | CONFIRMED | **FIXED** — server-authoritative absolute cap (`maxArtifactBytes`, default 5 GiB) rejected at commit |
| — | Terminal-attempt replay → `rejected(attempt_terminal)` not `committed` | MED | REFUTED | No fix: intended uniform fence-first-on-terminal (returning `committed` to a revoked worker would weaken the fence-authority model); idempotency is scoped to within an active fence |
| — | `versionNumber` racy per-(org,job) ordinal | MED | REFUTED | No fix: documented best-effort; frozen field only requires a positive int; no consumer keys on it |
| — | `headObject`-before-tx "precedence violation" | MED | REFUTED | No fix: `headObject`-before-tx is documented/intended; the fence-first invariant governs the mutator's size/sha comparisons (which ARE fence-first). Only the *oracle* sub-claim (A) was real. |

**The override (A) is the reconciliation the process exists for.** The refuting verifier claimed foreign-object-exists reaches the prefix check and returns `malformed` (same as missing → no oracle). But `resolveWorkerFenceContext` runs inside `runInTenant` and throws `stale_fence` (a `JobLeasingError` → HTTP protocol error) for a foreign job **before** the prefix check is ever reached — so exists → HTTP error and missing → 200 `rejected malformed` are **observably different**. The orchestrator had independently found this by reading, pre-review; the fix (probe the store only after the fence identity is resolved) closes it because the objectKey's job segment is then bound to the caller's own validated job.

All 4 fixes have fail-first regression tests (observed failing on the unfixed code: foreign-org upload → `upload_granted`; re-upload committed → `upload_granted`; oversize → `committed`; oracle → `headObject` called once), then passing after the fix.

---

## 3. Gate table (all GREEN, re-run by the orchestrator after fixes)

| Gate | Result |
|------|--------|
| `server typecheck` / `db typecheck` / `shared typecheck` | clean |
| `artifact-transfer-commit.integration` (`AOA_RUN_WIN_INTEGRATION=1`) | **17 pass** (13 original + 4 security regressions) |
| `storage-s3-presign` | 4 pass |
| `job-fence-surface.contract` | 8 pass (`commitArtifactVersion` guards before any tx access) |
| `job-control-legacy-grants.contract` | 7 pass (widen inherits the whole-table grant — no drift) |
| `e2-serving-role-correction.integration` | 20 pass (new columns keep exact `aoa_app` authority) |
| `tenant-rls-enforcement` unit+integration / `job-fencing` / `job-output-parity` / `worker-enrollment-rls` | 55 pass (no widen blast radius; `authorizeArtifactCommit` callers intact) |
| `artifact-lifecycle-schema-contract` | 3 pass (0248 snapshot/journal chain contiguous) |
| `check-artifact-commit-vectors.mjs` (+ `node --test`) | PASS (2 accept, 7 reject) / 14 pass |
| `check:distributed-foundation` | PASS |
| `check:frozen-worker-protocol-v1` | OK (zero edits) |
| `pnpm install --frozen-lockfile` | Done (sole dep add `@aws-sdk/s3-request-presigner`) |

---

## 4. Deferred: live-MinIO round-trip (slice 7)

The D1 MinIO is HTTP-only; the frozen grant `url` is strictly `https`, so the live presigned-PUT round-trip needs MinIO-over-TLS (self-signed cert + `NODE_EXTRA_CA_CERTS` in the test-runner + a compose service + the network-matrix checker update). Per the design's slice-7 escape hatch, slices 1–6 landed CI-green with the **full fail-closed acceptance proven in-process** (prefix/hash/size/tenant/fence/idempotency + the 4 security regressions), and the live direct-upload-bypass + toxiproxy incomplete-upload + download round-trip remain a focused Linux-CI follow-up (DEC-03 authority proof). Tracked as a follow-up task.

---

## 5. Non-goals (deferred) + residual risks

Non-goals: quarantine server handlers (DAT-006); worker-daemon consumer of the ordinary path; rich versioning/branching; a server-side pending-upload reaper (grant-TTL suffices); the presigner-credential broker (DAT-004). Residuals: the https/MinIO-TLS live tier (§4); SHA256 verification depends on object-store checksums (fail-closed if absent); `versionNumber` best-effort ordinal; nullable rich columns (completeness is an application invariant via `status='committed'` + partial-unique).

---

## 6. Doc drift to surface (not self-fixed)

`epics/README.md:25` says E5 = `DAT-001–DAT-006`; `program-design.md` defines `DAT-001–DAT-007`. Integration Gate Owner's reconciliation.
