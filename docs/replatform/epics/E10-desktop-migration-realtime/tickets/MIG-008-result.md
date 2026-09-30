# MIG-008 Result — Reconcile legacy E2B leases/resources + additive credential-authority move

**Status:** `complete + review-fixed (no-key core green)`. First E10 ticket. An ADDITIVE reconciliation layer + credential-authority move over the LIVE-deployed PR#320 `environment_leases` model — nothing rips out a live path, so deployed E2B execution is undisturbed.
**Disposition:** `pass` (scope-honest: in-process/mocked evidence; no live cutover — that is MIG-002/005/006/007).
**Date opened (UTC):** `2026-08-19`. **Start SHA:** `83d5f31ed` (design). **Design:** `MIG-008-design.md`.
**Implementer:** Claude subagent (general-purpose, fail-first, no commit). **Reviewer:** Claude adversarial-review Workflow (4 dimensions → refute-by-default verify, 18 agents) + controller independent re-verification + fix round.

## What shipped
Behind no runtime wiring yet (dormant forward-infrastructure — invoked by the deferred cutover sequence), all additive:
- **`legacy_resource_reconciliation`** — a new company-scoped, **append-only** crosswalk table (migration `0256_dizzy_bedlam.sql`: drizzle DDL + a hand-APPENDED C14/RLS block mirroring the DEP-003 cutover-marker 0233 operator-metadata pattern — `aoa_operator` WRITE, `aoa_app` READ-only-outside-tenant, FORCE RLS, fully idempotent). Both grant surfaces updated (`job-control-legacy-grants.ts` manifest + `distributed-execution-databases.ts` privileges) with matching `POLICY_COUNTS: 2`.
- **Reconciler** (`legacy-resource-reconciliation.ts` pure + `-store.ts` drizzle) — classifies every `environment_leases` row (all 5 types) + failed-cleanup + the platform-default env into ONE mapping OR terminal-cleanup record; claims paused rows via the verified `AND status='paused'` CAS; **never synthesizes a distributed fence for a live lease** (structural — no `EffectAuthority` dependency); composes CLI-004 as the terminal record for `cleanupStatus='failed'`.
- **Closure gate** (`assertClosure`) — surfaces `unattributable`/duplicate; "no unmapped at closure" holds by construction (a record minted per inventoried resource) + the DB unique index.
- **Additive credential-authority move** (`e2b-credential-authority.ts` + `-wiring.ts`) — the boundary (`real-transport.ts`) is the credential source of truth; per-company BYO injected via `RealE2bTransportOptions.apiKey` (reuse `resolveRuntimeProviderConfig`); a secret-aware key-generation tag + an AoA-side old-key-denial primitive. The live inline `resolveE2bApiKey` path is NOT removed (retires at MIG-006/007).

## Review findings → resolution (13 raw → 9 REFUTED, 4 CONFIRMED)

### mustFix (fixed, fail-first RED→GREEN)
1. **CONFIRMED (MEDIUM) — old-key denial was NOT secret-aware (secret repoint defeats it).** `deriveE2bKeyGeneration` returned the per-secret `companySecretVersions.version`, but `runtime_provider_keys.secretId` is repointable and versions restart at 1 per secret. The ordinary "replace my E2B key" rotation (old secret v5 → fresh secret v1) made `assertKeyGenerationCurrent(5, 1)` → `5 < 1 === false` → **the rotated-away key was accepted**, silently defeating D3/Invariant 6. **Fix:** the generation identity is now the SECRET-AWARE composite `"<secretId>:<version>"`; `assertKeyGenerationCurrent` refuses a different backing secret unconditionally (a repointed-away key is always superseded) and an older version only within the same secret; fails closed on an unparseable string. Schema column `key_generation` `integer`→`text` (migration cleanly regenerated, C14 re-appended, `db:generate` stable). New RED→GREEN tests: the repoint case + the fail-closed case.

### LOW (fixed in the same pass — cosmetic/hygiene)
2. Contract-test title pinned stale magnitudes ("22/21/31") vs the enforced oracles (23/22/33) → retitled.
3. Schema comment named a phantom `cleanupOutcome` (`live_handle_terminal`, never emitted) + omitted real values → corrected to the produced set.
4. Dead branch: `already_terminal` was unreachable (`hasLiveHandle` provably false at that point) → collapsed to `no_handle`.

### Refuted (no change — the review corrected the controller's own two MEDIUM hypotheses + others)
- **assertClosure "vacuous"** — REFUTED: `unmapped`/`duplicates` are `[]` **by construction** (a record is minted per inventoried resource) + the DB unique index; the one substantive obligation (surface `unattributable`) is genuinely reachable. A DB read-back would be *less* correct against the append-only immutable table (idempotent re-runs return false on every insert; historical rows for since-deleted leases would false-positive as orphans).
- **operator-metadata RLS deviation** — REFUTED, safe: it fails closed on the tenant path (org GUC set → zero rows → invisible to tenants; no cross-company leak), matches the documented DEP-003 pattern, and no reader relies on RLS for isolation.
- **credential reads `env.E2B_API_KEY` server-side** — REFUTED (cosmetic): the legacy path already reads it; the default flows through the existing chokepoint; strict D3 prose-fidelity is optional.
- Dormant reconciler + `delegated_cli004` record-label + active-without-handle + 'retained' classification + null-generation — all REFUTED as documented deferrals / intended design.

## Scope-honesty deferrals (documented, consistent with §5/§7 + the E3/E4 dormant-infrastructure precedent)
1. **The reconciler + credential resolver have no runtime call site yet** — dormant forward-infrastructure invoked by the deferred cutover sequence (MIG-002/005/006/007), exactly like E3/E4 shipped the parity bridges dormant until CLI-005 consumed them. §5.1/§6 disclose the "scope-honest pass on mocked evidence, no live cutover."
2. **`delegated_cli004`** is a faithful terminal RECORD label; the actual sandbox teardown is CLI-004's `CleanupAuthority` at cutover (§7 "no duplicate cleanup path") — the acceptance requires a record, not a live teardown.
3. **Live cutover-rollback** → MIG-002/005/006/007; **old-key kill-switch enforcement** → REL-004 (§5.3). MIG-008 builds only the AoA-side resolve/inject refusal.

## Commands (controller re-run)
| Command | Result |
|---|---|
| all 3 MIG-008 suites (post-fix) | **40 passed** (was 38; +2 secret-aware denial cases) |
| repoint-denial + fail-closed tests | RED (bare-version accepted the rotated-away key) → **GREEN** (secret-aware refuses) |
| `tsc --noEmit` (db + server) | clean |
| `pnpm db:generate` | one migration `0256`; re-run reports "No schema changes" (stable) |
| `check-distributed-execution-foundation.mjs` | PASS |
| eslint (changed source) | clean |

## Residual risk
1. **Live-catalog integration tests are Linux-CI-only** (skipped on Windows) — the grant/RLS manifests are internally consistent (the contract unit test re-derives all three surfaces + the RLS certificate at 23/22/33) and the migration mirrors the proven 0233 pattern, so the exact-catalog certificate should match on CI.
2. **The reconciler + credential resolver + drain are dormant until the deferred cutover tickets wire them** (documented above).
3. No frozen `worker-protocol`/port/`DE-*` edit; no hosted-API call; Drizzle-only with the C14 hand-append; no live path removed.

## Gate recommendation
`ready for independent review` — the MEDIUM secret-aware old-key-denial defect is fixed fail-first, the 3 LOW hygiene items resolved, the closure/RLS/dormancy questions ruled REFUTED with evidence, and the no-key core is green (40 unit/contract + foundation + stable migration).

## Review attempt history
| Attempt | Reviewer | Disposition | Evidence/findings |
|---:|---|---|---|
| 1 | Claude adversarial-review Workflow (18 agents) + controller re-verification | `approved after fix` | 13 raw → 9 REFUTED + 4 CONFIRMED (1 MEDIUM mustFix: secret-aware old-key denial — fixed fail-first; 3 LOW hygiene — fixed). The controller's own two MEDIUM hypotheses (closure-vacuous, RLS-isolation) were REFUTED by the review with evidence. 40 unit/contract green; foundation PASS; migration stable. |
