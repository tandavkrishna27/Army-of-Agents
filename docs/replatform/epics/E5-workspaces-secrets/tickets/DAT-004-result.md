# DAT-004 Result — Lease-scoped secret broker

**Status:** COMPLETE — implemented per the committed design, adversarial-reviewed, all local gates green. Epic completion is the Integration Gate Owner's call.
**Epic:** `E5-workspaces-secrets`. **Design:** [`DAT-004-design.md`](DAT-004-design.md). **Source:** `program-design.md:645-651`.
**Process:** terrain-map Workflow → orchestrator re-verification → committed design → implementer subagent → adversarial-review Workflow (5 security-dimension finders → refute-by-default verifiers) → orchestrator re-verify all gates + read all 3 security-core files + reconcile every verdict (re-tracing refutations) + fix fail-first → this doc.

---

## 1. Outcome

A **pure control-plane + DB** lease-scoped secret broker — the complete opaque-handle wire contract is already FROZEN (`secretHandleRefSchema`), so DAT-004 adds **zero wire ops/fields, zero worker-protocol edits**:
- **Widened `job_secret_handles`** (migration 0250, nullable non-secret binding + audit columns; **no value column ever**) → zero keystone reconciliation.
- **Guarded mutator `resolveExecutionSecret`** — `guardActiveFence` FIRST → load handle by `(org,job,handle)` (org/company/attempt proven by the fence) → re-derive the dispatching owner from the LOCKED `jobs` row → re-check `company_memberships` in-tx → `authorizeSecretResolve` (the pure decision) → audit-as-columns → returns the AUTHORIZED non-secret binding, **never a value**. Registered in `GUARDED_JOB_MUTATORS` + `GOVERNED_FENCE_SURFACE` + the contract.
- **Server `secret-broker.ts`** — resolves the fence identity before any broker access (the DAT-002 no-early-probe lesson), dispatches by `ref_kind` **only after** fenced authorization, returns the value only to an in-process delivery seam (never the wire); `device_local` → a valueless handoff descriptor; the default brokers throw (fail-closed until DAT-005 wires them).
- **Pure `authorizeSecretResolve` + a `policy`-lane vectors gate.**

**Security invariants proven:** no-value-to-sandbox, no-list (null-GUC → 0 rows), no-plaintext-on-wire (no value column; frozen forbidden-keys), audit-only-metadata, re-check-at-resolve (revoke/rotate/membership-loss/fence/target-replacement deny at resolve without rebuilding envelopes).

---

## 2. Adversarial review + fixes

The review (workflow `wf_08493551-7aa`; 5 dimensions; 2 CONFIRMED/PLAUSIBLE + 4 REFUTED; 3 verifiers died on retry-cap, adjudicated by the orchestrator) surfaced a genuine **HIGH secret-leak the orchestrator's own read had missed**. Reconciling every verdict against my read of `authorizeSecretResolve`, `resolveExecutionSecret`, and `secret-broker.ts`:

| # | Finding | Sev | Verdict | Disposition |
|---|---------|-----|---------|-------------|
| **A** | `authorizeSecretResolve` enforces the *generic* `materialization×use_policy` invariant but **never binds `ref_kind`→policy** — a `connector_oauth` handle mislabelled `env`+`sandbox_local_only` passes authz, and `dispatchResolvedSecret` then resolves the real OAuth token and hands it to the **sandbox env**, breaking invariant #1 for the one ref_kind whose model is headers-only | **HIGH** | **CONFIRMED** | **FIXED** — bind `connector_oauth ⇒ fence_proxy+proxy`, `device_local ⇒ not remote_server_fenced` |
| **C** | A network-use handle (`fence_proxy`/`remote_server_fenced`) admitted with a **null destination** → the value is dispatched to the proxy seam unbound | MED | (finding) | **FIXED** — require a non-null destination for network-use policies |
| **D** | The vectors mirror `decideResolve` was never bound to the real `authorizeSecretResolve` and **already diverged** (undefined handling) — the gate couldn't see it | MED | **CONFIRMED** | **FIXED** — reconciled the mirror + a test runs the real fn against the committed fixture |
| **B** | `device_local` resolve never checks `provider_credentials.state` → an activation-revoked underlying credential still yields a handoff | HIGH (finder) | verifier died | **DEFERRED (residual)** — the `ref_id ↔ provider_credentials` contract isn't pinned (impl uses non-UUID refIds; the OS broker/DSK validates the underlying credential when reading it via the handoff; the handle-level `status` already gates handle revocation). Tracked. |
| — | jobs row not row-locked for owner re-derivation | MED | REFUTED | No fix: `executorPrincipal*` is immutable (set at submission) — no TOCTOU; the guard proves the (org,company,job) identity |
| — | owner-membership re-check omits an org bound | LOW | REFUTED | No fix: `companyId` (proven by the fence) scopes the membership; a company is within one org |
| — | audit committed before value dispatch (over-counts) | LOW | (finding) | No fix: the count reflects authorized resolves (the authorization is the atomic event; delivery is separate) |

**The A fix is exactly why the adversarial review exists** — a real HIGH OAuth-token-to-sandbox leak that a green suite (whose vectors mirrored the same gap) passed, and that the orchestrator's own first read missed (I noted `sandbox_local_only` is by-design for provider keys but did not check that `connector_oauth` is constrained to the proxy). Fail-first proven: reverting the `connector_oauth` binding, the real `authorizeSecretResolve` **admits** the leak vector (`expected 'admit' to be 'ref_kind_policy_conflict'`), and the new fixture-binding test catches it — then restored.

---

## 3. Gate table (all GREEN, re-run after fixes)

| Gate | Result |
|------|--------|
| `db` / `server` typecheck | clean |
| `secret-broker.integration` (`AOA_RUN_WIN_INTEGRATION=1`) | 17 pass |
| `secret-resolve-authz` (pure + fixture-binding) | 18 pass (16 + 2 binding) |
| `secret-broker-dispatch` | 6 pass |
| `job-fence-surface.contract` | 8 pass (`resolveExecutionSecret` guards before any read) |
| `e2-serving-role-correction` / `job-control-legacy-grants.contract` | 27 pass (widen inherits the grant — no drift) |
| `artifact-lifecycle-schema-contract` | 3 pass (0250 snapshot/journal contiguous) |
| `check-secret-resolve-vectors.mjs` (+ `node --test`) | PASS (5 admit, 14 reject) / 11 pass |
| `check:distributed-foundation` / `check:frozen-worker-protocol-v1` | PASS / OK (zero edits) |
| `pnpm install --frozen-lockfile` | Done (no dep change) |

---

## 4. Non-goals + residual risks

Non-goals (deferred): **DAT-005** (the fence-aware egress proxy that MATERIALIZES the value + destination enforcement + redaction — DAT-004 only binds + authorizes + resolves), DAT-007 (tool surface), **DSK/E10** (OS keystore + per-OS local-broker tests), DEP-006/CLI-001 (provider-management creds). Residuals: **(B) the `device_local` underlying-credential activation-revocation check** (needs the `ref_id ↔ provider_credentials` UUID contract pinned; the OS broker validates on read) — tracked; the `bound_target_generation` pin (D5, net-new); the broker seam must scope `ref_id` by `companyId` (DAT-005 contract; the current `resolveSecretValue` is company-scoped).

---

## 5. Doc drift to surface (not self-fixed)

`epics/README.md:25` says E5 = `DAT-001–DAT-006`; `program-design.md` defines `DAT-001–DAT-007`. Integration Gate Owner's reconciliation.
