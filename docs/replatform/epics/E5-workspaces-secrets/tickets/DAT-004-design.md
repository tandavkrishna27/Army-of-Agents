# DAT-004 Design — Lease-scoped secret broker

**Status:** `design` (reviewable artifact; implementation follows via per-slice fail-first TDD + distinct adversarial review)
**Epic:** `E5-workspaces-secrets` (fourth ticket). **Authoritative source:** `program-design.md:645-651`.
**Depends on (all complete):** JOB-004 (`guardActiveFence`), JOB-009, TEN-004 (`job_secret_handles` composite FK), PRT-005 (frozen `secretHandleRefSchema`). DAT-001/002/003 complete this session. Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.
**Grounded by:** the DAT-004 terrain-map (5 readers + synthesis); the highest-leverage claims re-verified in `C:\e3` by the orchestrator — the frozen `secretHandleRefSchema` (policy.ts:171-196), the `job_secret_handles` skeleton (schema:1-44, no service consumer), and the `readSecretHandle` guard-first template (job-control.ts:2528-2537).

---

## 1. Scope + framing

**Outcome (program-design.md):** extend the existing secret + MCP-OAuth broker paths with **opaque execution handles** resolved only for an **active compatible lease + per-request fence authorization**, and define the same lease/fence broker contract for a **device-local personal credential** without creating a competing token store.

**DAT-004 is a pure control-plane + DB ticket — ZERO wire ops, ZERO wire fields, ZERO worker-protocol edits (frozen).** The complete opaque-handle wire contract is **already frozen**:
- `secretHandleRefSchema` (policy.ts:171-196, verified): `{handleId: opaque branded UUID, materialization: proxy|env|file, usePolicy: fence_proxy|remote_server_fenced|sandbox_local_only}`, `.strict()`, **never bytes**. Fail-closed cross-field invariants: `proxy ⇒ fence_proxy` only; `env`/`file` cannot claim `fence_proxy` (so `sandbox_local_only` can never authorize a network destination); `env` targets are POSIX var-**names**, `file` targets live under `/run/aoa-secrets/` no `..`; `addForbiddenWireKeyIssues` recursively rejects any nested token.
- Handles ride the JOB envelope (`jobEnvelopeBaseSchema.secretHandles`, job.ts:343) → embedded into the worker via the lease offer. There is **no** `secret_resolve`/`broker`/`materialize` wire op (the closed 10-op list). **Resolution is in-band + behind the fence proxy.**

DAT-004 **does not build a competing token store**; it maps opaque handles → the four existing value stores and resolves them behind the fence, generalizing the MCP-OAuth pattern (*value never placed in a spec — only rendered into headers/env at delivery, owner-refused*).

---

## 2. The security invariants (what every test must prove)

1. **No-value-to-sandbox.** A resolved value returns ONLY to the fence-aware proxy / remote service seam; never into a wire message, never the sandbox env for a network-use handle.
2. **No-list.** No worker-facing list op exists (closed 10-op list); the job envelope declares exactly which handles apply; the non-owner `aoa_app` worker path with no tenant GUC sees zero rows (FORCE RLS).
3. **No-plaintext-on-wire.** Already enforced by the frozen `FORBIDDEN_WIRE_KEYS` recursive check; the widened DB row stores **no bytes** — only identifiers/enums/timestamps.
4. **Audit-only-metadata.** The control plane persists status/owner/timestamps, never the value.
5. **Re-check-at-resolve.** Lease active + fresh-clock expiry + full-fence match + live target generation + owner membership are ALL re-evaluated per request — nothing is baked into the dispatched envelope, so revoke/rotate/membership-loss/fence-or-target-replacement take effect without rebuilding it.

---

## 3. Decisions

### D1 — WIDEN `job_secret_handles` (nullable, non-secret binding columns); no new table
The skeleton's own comment reserves "the RICH secret model (materialization, canaries, rotation) … deferred to E5 (additive)" — widening IS the intended move, and (proven thrice this session) it costs **zero keystone reconciliation** (table-level grant + row-level RLS policy + live-schema-derived column ACL all auto-cover nullable additions; `POLICY_COUNTS` unchanged; contract test stays green). No service consumer exists (verified), so the widen is purely additive. Migration `0250` via `pnpm db:generate` + C14 `IF NOT EXISTS` guards + snapshot + journal; **no custom RLS migration** (0211 covers all columns row-level).

New nullable columns (no value, ever):
- `ref_kind` (enum text): `company_secret | connector_oauth | provider_key | device_local` — the non-secret discriminator telling the resolver which legacy broker to dispatch to.
- `ref_id` (text): the non-secret pointer into the chosen broker (`company_secrets.id` / `mcp:oauth:<id>` name / `provider:<id>` name / `provider_credentials.id`-or-target-slug). Never a value.
- `owner_principal_kind` / `owner_principal_id` (text): denormalized from the job at mint, for `device_local`/owner-bound handles.
- `materialization` (`proxy|env|file`) + `use_policy` (`fence_proxy|remote_server_fenced|sandbox_local_only`): mirror the wire ref so the resolver **re-checks the sandbox-vs-proxy invariant server-side** (defense-in-depth against a hand-built envelope).
- `destination` (text, nullable, non-secret): the bound egress destination/networkPolicyRef — DAT-004 **binds**; DAT-005 **enforces**.
- `bound_target_generation` (integer, nullable): pins the handle to the placed target generation (D5).
- Audit-as-columns: `status` (`active|revoked`), `last_resolved_at`, `resolve_count`, `revoked_at`.

### D2 — New guarded mutator `resolveExecutionSecret` (the resolve model)
Mirrors `readSecretHandle` + the DAT-002/003 fence-first template. In one `runInTenant(org)` tx:
1. **`guardActiveFence(input)` FIRST** → locked `{lease, attempt}` (proves the full 13-field identity: org/company/job/attempt/worker/target/target-generation/fence + live-generation cutoff + fresh-clock expiry + non-terminal). Reuse verbatim — a stale/replaced fence or a bumped target generation throws `stale_fence`/`target_revoked` before any row read.
2. Load the WIDENED handle row by `(org, job, handle)` (company + attempt proven solely by the fence guard — matches `readSecretHandle`, do not loosen).
3. **Re-derive the dispatching owner from the LOCKED `jobs` row** (`executorPrincipalKind/Id`, jobs.ts:52-55 — the `ActiveFenceRequest` carries NO owner). For owner-bound (`device_local`) handles, re-check `company_memberships`/`user_roles` in the same tx → deny on membership loss (`provider_credentials.ownerUserId` is `ON DELETE restrict`, so revocation is an explicit `state` read, not an auto-cascade).
4. **Re-verify the `materialization`×`use_policy` invariant + `bound_target_generation`** against the live lease/target (fence-first-then-verify).
5. Dispatch by `ref_kind` to the legacy broker to obtain the value.
6. Return the value ONLY to the fence-aware proxy / remote service — never to the sandbox. Append `resolveExecutionSecret` to `GUARDED_JOB_MUTATORS` (job-fence.ts) + `GOVERNED_FENCE_SURFACE` (job-fencing.ts) + `job-fence-surface.contract.test.ts` (the coupling — one name to 3 places, per DAT-002-D2).

### D3 — Broker dispatch variants (generalize the existing chokepoints)
- **`connector_oauth`** → `usePolicy=fence_proxy`, `materialization=proxy`; refresh via the existing `mcp_connector_oauth_refresh_leases` fencing-token lease; the token is rendered into proxy request headers at delivery — never a spec, never the sandbox (the exact existing MCP pattern, `mcp-connectors.ts:331-382`).
- **`provider_key` / `company_secret`** → `env`/`file` + `sandbox_local_only` or `remote_server_fenced` per destination; resolve via `resolveSecretValue` (secrets.ts:455-498) / the provider resolver. **Closes the E2B host-side-materialization gap** (`one-shot-sandbox-cli.ts:172-274`) by moving resolve behind the fence.
- **`device_local`** (owner-bound, `owner_desktop` target, `owner_device_only`) → `sandbox_local_only` (CLI, no egress) or `fence_proxy`; the value **never leaves the OS keystore** — DAT-004 resolves the control-plane reference + authorization and returns a **handoff descriptor** to the DSK/E10 OS broker seam. Control-plane identity/status = the existing company-scoped `provider_credentials` row (`kind`/`state`/`ownerUserId`, verified schema:10-45), referenced by `ref_id`; **DAT-004 records identity/status/audit only, never the value.** (DSK-001/002 in E10 implement the OS keystore + per-OS local-broker tests — confirmed split.)

### D4 — Audit-as-columns (zero-reconciliation)
The control-plane audit surface = the widened columns (`status`/`last_resolved_at`/`resolve_count`/`revoked_at`) written in the same resolve tx. A **new append-only distributed audit table would cost the full keystone checklist**; audit-as-columns costs zero. Control plane reads identity/status/audit; never a value. (The legacy `secret_access_events` is company-scoped, not in the distributed serving set — left untouched.)

### D5 — `bound_target_generation` binds the handle to its placement (defense-in-depth)
`guardActiveFence` already invalidates a **stale lease** after a target-generation bump (→ `target_revoked`). D5 additionally pins the handle: `bound_target_generation` is set at mint from the job's placed target generation; resolve requires `handle.bound_target_generation === lease.targetGeneration` when set — so a re-placed job on a new generation must mint a fresh handle rather than reuse a handle bound to the replaced generation (the acceptance's "binds … target generation"). Nullable → skip the check when unset (backward-compatible).

### D6 — Pure `authorizeSecretResolve` decision function + vectors gate
A pure `authorizeSecretResolve(lease, handleRow, jobOwner, membership, liveTargetGeneration) → admit | <closed refusal code>` drives the mutator and a `policy`-lane vectors gate (mirroring DAT-002/003). Refusal codes map to the frozen closed `PROTOCOL_ERROR_CODES` where surfaced (fence → `stale_fence`/`target_revoked`/`attempt_terminal`; everything else coarse `malformed`, non-disclosing).

### D7 — Verification profile: server+DB (DAT-002 clone), all dormant behind `AOA_DISTRIBUTED_EXECUTION_ENABLED`
No new `AOA_*` env (reuse the flag → `brand-check` unaffected); `worker-protocol-contract-bytes` + `distributed-contract` stay green (frozen + zero grant drift); migration is C14-additive.

---

## 4. Slice plan (fail-first TDD)

1. **Pure `authorizeSecretResolve` + vectors (verify lane, no PG).** Vectors: wrong-tenant/job, stale/replaced fence, target-generation mismatch, target disabled, terminal attempt, owner-membership-loss, `sandbox_local_only`+network-destination (deny), `env`/`file` claiming `fence_proxy` (deny), unknown `ref_kind` (deny). Write RED first.
2. **Widen `job_secret_handles`** (0250, nullable + C14 + snapshot). Assert schema-sibling + `artifact-lifecycle-schema-contract` + `job-control-legacy-grants.contract` (auto-derived column ACL) + `e2-serving-role-correction` stay green.
3. **`resolveExecutionSecret` guarded mutator** — RED that it fails closed if not in `GUARDED_JOB_MUTATORS` + `GOVERNED_FENCE_SURFACE` + contract; then add; assert guard-before-read via the AST contract.
4. **Broker dispatch by `ref_kind`** — each variant returns the value ONLY via the proxy/remote seam; `device_local` returns a handoff descriptor, never a value; no-value assertion (grep the return shape for any byte field).
5. **Audit-as-columns** write on resolve/revoke/rotate; assert no value column exists.
6. **Embedded-PG integration** (`AOA_RUN_WIN_INTEGRATION=1`): wrong tenant/job/target/owner, stale/replaced fence, worker-partition (null GUC → zero rows = no-list), membership removal, rotation/revocation via `device_generation` bump, direct-platform-materialization denial, plaintext-token rejection. Model: `artifact-transfer-commit.integration.test.ts`.

---

## 5. Gate + verification profile

Local: `pnpm db:generate` (0250 + snapshot + journal) + `artifact-lifecycle-schema-contract`; `db`/`server` typecheck; `AOA_RUN_WIN_INTEGRATION=1 vitest run` the resolve integration + schema-siblings + fence-surface + legacy-grants contract + e2-serving-role; `node scripts/check-secret-resolve-vectors.mjs` (+ `node --test`); `check:distributed-foundation` (no drift), `check:frozen-worker-protocol-v1` (zero edits), `pnpm install --frozen-lockfile` (no dep). CI `ci-required`: `verify`/`lint`/`e2e`/`e2e-pgvector`/`migrations`/`distributed-contract` + always-on `policy` (new vectors) + `brand-check` + `worker-protocol-contract-bytes`. Blast-radius budget: schema-sibling column-list + fence-surface contract (mutator add).

---

## 6. Non-goals (deferred)

- **DAT-005** — the fence-aware egress **proxy that materializes** the value + destination enforcement + redaction. DAT-004 binds the destination + authorizes + resolves; it does NOT build the proxy (confirm the seam only).
- **DAT-007** — MCP/agent tool surface for handles.
- **DSK/E10 (DSK-001/002)** — the OS-protected keystore + per-OS local-broker implementation/tests. DAT-004 is control-plane contract only.
- **DEP-006 / CLI-001** — provider-MANAGEMENT credential lifecycle (distinct from this tenant broker).
- Do NOT touch worker-protocol, add a wire op, add a new distributed table, or store any secret value in `job_secret_handles`.

---

## 7. Residual risks / open decisions

- **Company↔org seam:** `provider_credentials` is company-scoped; `job_secret_handles` is org-scoped. Resolution re-derives the company from the LOCKED `jobs` row, so the `device_local` handle's `ref_id → provider_credentials.id` is validated against the job's company at resolve (no new org-scoped credential table). Flag for review.
- **`bound_target_generation` (D5):** a net-new binding not in existing code; chosen conservatively (pin + check). Review to confirm the acceptance wording requires handle-level pinning vs lease-level (guardActiveFence) sufficiency.
- **`ref_kind` value set:** pinned to the four legacy stores; a fifth would need a resolver branch.
- **Device-local handoff seam:** DAT-004 returns a handoff descriptor for `device_local`; the actual OS-keystore read is DSK/E10 — the seam must be inert-until-DSK.

---

## 8. Decisions ledger

| ID | Decision |
|----|----------|
| DAT-004-D1 | Widen `job_secret_handles` (nullable non-secret binding + audit columns); zero keystone reconciliation; no secret value ever stored. |
| DAT-004-D2 | New guarded mutator `resolveExecutionSecret`: guardActiveFence FIRST → owner re-derive + membership re-check → invariant + generation re-verify → broker dispatch → value only to the fence proxy, never the sandbox. |
| DAT-004-D3 | Dispatch by `ref_kind` to the four existing stores; generalize the MCP-OAuth never-in-a-spec pattern; `device_local` returns a handoff descriptor (value stays in the OS keystore). |
| DAT-004-D4 | Audit-as-columns (zero-recon); control plane records identity/status/audit, never value. |
| DAT-004-D5 | `bound_target_generation` pins the handle to its placement (defense-in-depth over the lease-level generation check). |
| DAT-004-D6 | Pure `authorizeSecretResolve` decision + `policy`-lane vectors gate. |
| DAT-004-D7 | server+DB profile; dormant behind `AOA_DISTRIBUTED_EXECUTION_ENABLED`; no new env; frozen + grant gates stay green. |
