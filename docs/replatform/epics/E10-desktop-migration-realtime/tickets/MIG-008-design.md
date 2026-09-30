# MIG-008 Design — Reconcile legacy E2B leases/resources + move E2B provider-control authority (additive)

**Status:** `design` (reviewable artifact; fail-first TDD + distinct adversarial review). **Medium ticket, but larger blast radius than the CLI-00x series — it reconciles the LIVE-deployed PR#320 lease/resource model and moves credential authority. Scoped ADDITIVE: nothing rips out a live path, so deployed E2B execution is never destabilized.**
**Epic:** `E10 — desktop-migration-realtime` (first executed ticket). **Authoritative source:** `program-design.md:976-982`.
**Depends on (all landed + verified):** CLI-001 (E2B adapter provider), CLI-004 (cleanup reconciliation), JOB-006 (fence reaper), DEP-006 (credential confinement), DEP-008 (isolation conformance). Frozen `worker-protocol` v1 + the worker-daemon `SandboxProvider` port + `DE-*` threat docs — never edited.
**Grounded by:** the MIG-008 terrain-map (4 readers + synth) with every load-bearing claim **independently re-verified** in `C:\e3` (see §2). It gates CLI-006 alongside MIG-003, and is a hard prerequisite of the MIG-005/006/007/002 cutover.

---

## 1. Scope + framing

**Outcome (program-design.md:978):** inventory + reconcile PR#320 environment leases, warm/paused resources, provider labels, reapers, and E2B provider-control credentials BEFORE any current execution sink transfers ownership.

**Acceptance (program-design.md:980):** every live/paused legacy lease/resource → ONE immutable mapping OR terminal cleanup record; active effect authority is NEVER translated into a distributed fence; warm agent + Commander leases, ephemeral one-shot/crew leases, workspace/preview refs, and failed cleanup are covered; E2B provider credentials move from the current server-side runtime into the adapter-management boundary with rotation, old-key denial, kill, and cleanup continuity; NO unmapped/unattributable resource remains at closure.

**The thesis.** The target cleanup machinery already exists (CLI-004 `CleanupAuthority`/`reconcile`, CLI-001's confined E2B provider + `real-transport.ts` credential boundary, JOB-006's disjoint fence reaper). MIG-008 is the **reconciliation layer + the additive credential-authority move** over the legacy `environment_leases` model. It is **additive by construction**: it introduces a durable append-only crosswalk + a reconciler + a credential-authority path, and it **never** removes the live legacy inline provider or its lease writers (those retire at MIG-006/007). This keeps the deployed E2B path byte-unchanged while establishing the pre-cutover reconciliation + the boundary as the credential source of truth.

**The core safety invariant that shapes everything:** *active effect authority is NEVER translated into a distributed fence.* A live/active legacy lease (a sandbox the legacy `adapter.execute` is executing in) must NOT be assigned a synthesized `ResourceLabels` fence — that would let the distributed reaper revoke a sandbox from under a running legacy run. Enforced structurally: the reconciler emits a **terminal cleanup record** (not a fence mapping) for any row with a live handle; only genuinely terminal (released/failed/no-live-handle) rows get a durable terminal record, and no legacy row is ever routed into `EffectAuthority`.

| Workstream | Kind | Responsibility |
|---|---|---|
| Crosswalk table (`legacy_resource_reconciliation`) | new schema (`db:generate`) | ONE immutable append-only record per legacy lease/resource — a MAPPING or a TERMINAL cleanup record; the closure store |
| Reconciler service | new | inventory every `environment_leases` row (all 5 types) + failed-cleanup + the platform-default `environments` resource; classify by (status, provider, owner); emit one crosswalk record each; race-safe via the paused-status CAS; compose CLI-004 cleanup for `cleanupStatus='failed'`; NEVER synthesize a fence for a live row |
| Closure gate | new | assert every inventoried row has exactly one crosswalk record; surface any unmapped/unattributable resource |
| Credential-authority move (additive) | new | the adapter boundary (`real-transport.ts`) becomes the credential source of truth: default key from the confined env read, per-company BYO key injected via `RealE2bTransportOptions.apiKey`; a key-generation attribution tag + an AoA-side old-key-denial primitive (refuse to resolve/inject a superseded key) |
| Reuse CLI-004 + JOB-006 + the provider | reuse | teardown ladder, orphan sweep, fence reaper, isolation conformance — referenced, never re-derived |

**Additive.** No live path removed; no frozen contract edit; no `DE-*` edit. The migration follows the DEP-006 dual grant-surface + C14 idempotency pattern.

---

## 2. Load-bearing facts (each independently re-verified in `C:\e3`)

1. **One polymorphic lease table.** `environment_leases` (`packages/db/src/schema/environment_leases.ts:10-75`), company-scoped (`companyId` NOT NULL cascade `:14`), discriminated by `leasePolicy` (`:31`) + owner column. `status` ∈ active|released|expired|failed|retained|paused (`constants.ts:474`); `paused` = held E2B snapshot (`releasedAt` NULL); `cleanupStatus` ∈ pending|success|failed (`:485`). E2B ref = `provider`+`providerLeaseId` (the sandboxId) + `metadata.providerMetadata` (apiKey-scrubbed by `sanitizeProviderMetadata` `environment-runtime.ts:385-392`).
2. **5 lease/resource TYPES** (all rows of the one table + the resource): ephemeral one-shot/crew (killed at run-end), warm ORG agent (paused), warm Commander (paused, keyed on `commanderConversationId`), workspace/preview ref (the `executionWorkspaceId` FK — no persisted preview resource; preview URLs live-resolved), and the leasable `environments` row (platform-default E2B env, **deterministic uuidv5 id** `platform-default-environment.ts:109-111`, operator key deliberately NOT stored `:44-47`). `cleanupStatus='failed'` is a distinct terminal class (`warm-sandbox-reaper.ts:82-88`).
3. **Credential chokepoint.** `resolveE2bApiKey(config, env) = config.apiKey ?? env.E2B_API_KEY` (`sandbox-provider-runtime.ts:569-575`) — the SOLE server-side E2B key read. Per-company BYO arrives as `config.apiKey` (injected via `resolveRuntimeProviderConfig`/`runtime_provider_keys`→`company_secrets`, `environment-runtime.ts:340-383`). **The paradox is resolved:** CLI-001's `real-transport.ts:53-59 requireApiKey(explicit?) = explicit ?? process.env.E2B_API_KEY` with `RealE2bTransportOptions.apiKey` (`:45-48`) already accepts an injected per-company key — so the move is *default-from-confined-env + BYO-injected*, no rework. The static boundary checker (`scripts/check-sandbox-e2b-provider-boundary.mjs`) asserts `E2B_API_KEY` appears in no other leaf source.
4. **Fence disjointness (the core invariant's enforcement).** `job-reconciliation.ts` + `job-control.ts` NEVER read `environment_leases` (grep-verified empty). The fence model (`leases` + `EffectAuthority`/`CleanupAuthority`, distinct objects; `effect-authority.ts:74 withdraw()` terminal) is object-separated from the legacy effect-authority lease model. A legacy active lease has no path into `EffectAuthority`.
5. **Race-safe claim = the paused-status CAS.** `expireLeaseIfPaused` paused→expired guarded by `AND status='paused'` BEFORE any provider kill (`environments.ts:310-327`); the reaper's loser skips destroy (`warm-sandbox-reaper.ts:70-77`). The reconciler MUST claim paused rows with the same `AND status='paused'` CAS so it cannot race a live warm-resume.
6. **Rotation/old-key-denial ABSENT today.** Rotation exists only at the secret layer (`company_secret_versions` 'latest', `runtime_provider_keys.secretId` repointable); nothing propagates a rotated key to in-flight sandboxes, and NO key-generation tag exists on `environment_leases`. Old-key-denial must be BUILT (AoA-side).
7. **Existing patterns:** `distributed_cutover_markers` (DEP-003, C14 custom-RLS platform marker — pattern for the migration's RLS/grants) + `marketplace_reconciliation_operations` (reconciliation-ops shape). Neither is the per-lease crosswalk; MIG-008 adds its own.

---

## 3. Invariants (each gets a test)

1. **One record per resource, none unmapped at closure.** Every `environment_leases` row + the platform-default `environments` resource yields exactly ONE crosswalk record (mapping or terminal); the closure gate finds zero unmapped/unattributable rows.
2. **Active authority never → fence.** A row with a live handle (active/paused with a live sandbox) is NEVER assigned a synthesized `ResourceLabels` fence; it gets a terminal cleanup record (or is left for drain), never routed into `EffectAuthority`.
3. **Race-safe.** The reconciler claims a paused row only via the `AND status='paused'` CAS, so it can never race a concurrent warm-resume (loser no-ops).
4. **All 5 types + failed-cleanup covered.** ephemeral, warm-org, warm-commander, workspace/preview-ref, platform-default env, and `cleanupStatus='failed'` each have a classification + a record.
5. **Credential authority at the boundary.** The boundary resolves the default key from the confined env and the per-company key via injection; the server-side inline read is superseded as the *authority* for reconciled/new work (additive — the live inline path is untouched until MIG-006/007).
6. **Old-key denial (AoA-side).** A superseded key generation is refused at resolve/inject time; a lease is attributed with its key-generation tag. (Live kill-switch enforcement composes with REL-004 — deferred.)
7. **Credential never persisted.** No crosswalk record or tag carries key material (reuse `sanitizeProviderMetadata`; platform-default omits the operator key).
8. **Isolation conformance intact.** DEP-008's 8 isolation invariants (redaction / no-oracle / ladder) still pass post-move.

---

## 4. Decisions

### D1 — A new company-scoped immutable crosswalk table `legacy_resource_reconciliation`
`db:generate` a new table (company-scoped, matching `environment_leases`): `{id, companyId, environmentLeaseId (nullable FK), environmentId (nullable), resourceType, legacyStatus, provider, providerLeaseId (nullable), disposition ('mapped'|'terminal_cleanup'|'unattributable'), resourceLabelsHash (nullable — only for a mapping), keyGeneration (nullable), cleanupOutcome (nullable), reason, createdAt}`, **append-only** (no update path), with a unique index on `(environmentLeaseId)` (+ a synthetic key for the platform-default env resource) so re-running the reconciler is idempotent (one record per resource). Follow the DEP-006 dual grant-surface (legacy-grants manifest + `appTablePrivileges()`) + the C14 idempotency hand-append; RLS per the E2 tenant-table pattern (company-scoped tenant data, FORCE RLS). *Company-scoped (not org-scoped): the source is company-scoped, the closure is per-company, and a `ResourceLabels`-org mapping is recorded as the `resourceLabelsHash` field, not the table's tenant key.*

### D2 — Reconciler: classify-and-record, race-safe, fence-safe
A service pass that, per `environment_leases` row: (a) classifies by (status, provider, owner) into one of the 5 types; (b) decides disposition — **live handle (active/paused)** → `terminal_cleanup` via CLI-004's cleanup composition OR left-for-drain with a mapping record that carries NO synthesized fence (records the partial `ResourceLabels` from owner FKs as a hash for attribution only); **released/expired/failed/no-handle** → `terminal_cleanup` record; **unclassifiable** → `unattributable` (surfaced, never silently dropped). Paused rows are claimed with the `AND status='paused'` CAS. `cleanupStatus='failed'` rows compose CLI-004's reconcile as the terminal record (no duplication). The platform-default `environments` resource gets its own record (its uuidv5 id is never reminted). **No row is ever assigned a live fence** (Invariant 2).

### D3 — Additive credential-authority move
Establish the adapter boundary as the credential source of truth for reconciled/new work: default key from the confined `real-transport.ts` env read; per-company BYO key resolved (reuse `resolveRuntimeProviderConfig`) and injected via `RealE2bTransportOptions.apiKey` — **never** persisted. Add a **key-generation attribution tag** (a monotonic per-company key-generation counter derived from the `company_secret_versions`/`runtime_provider_keys` pointer) recorded on the crosswalk + resolvable at inject time; an **AoA-side old-key-denial** primitive refuses to resolve/inject a superseded generation. **The live inline `resolveE2bApiKey` path is NOT removed** — it is retired when MIG-006/007 cut crew/one-shot execution over; MIG-008 makes the boundary authoritative additively. Preserve kill + cleanup-continuity (reuse `real-transport.ts terminate` + CLI-004).

### D4 — Closure gate + rollback safety
A closure assertion: every inventoried `environment_leases` row + the platform-default env has exactly one crosswalk record; any `unattributable` disposition is reported (not tolerated silently). **Cutover-rollback safety** (no fence synthesized for a live lease; the reconciler is re-runnable + idempotent) is enforced + tested; the LIVE cutover-rollback exercise (transfer ownership then roll back) is at MIG-002/005/006/007 (deferred — those tickets own the ownership transfer).

---

## 5. Non-goals / scope honesty (deferrals)

1. **No live execution cutover / ownership transfer** — MIG-008 is the pre-cutover reconciliation; MIG-002/005/006/007 own the transfer + its live rollback. The legacy `adapter.execute` remains the sole executor (CLI-005's convert is inert).
2. **The legacy inline `'e2b'` provider + its lease writers are NOT removed** — retired at MIG-006/007. MIG-008 is additive.
3. **Old-key-denial LIVE kill-switch enforcement composes with REL-004** (provider kill-switch) — MIG-008 builds the AoA-side attribution tag + resolve/inject refusal; the live force-kill of sandboxes tagged with a superseded generation is REL-004's primitive (deferred).
4. **No new hosted-API call** (Rule #11); **no frozen `worker-protocol`/port/`DE-*` edit.** The migration uses `pnpm db:generate` (never hand-authored DDL) + C14 idempotency guards as the narrow exception.
5. **Preview/runtime-service references** beyond the `executionWorkspaceId` FK (e.g. `workspace_runtime_services` live preview URLs) are live-resolved, not persisted resources — out of the inventory (documented; confirmed no persisted preview resource exists).

---

## 6. CI + acceptance mapping

| Acceptance clause (L980) | Where satisfied | Gate |
|---|---|---|
| one immutable mapping OR terminal record per live/paused resource | D1 crosswalk + D2 reconciler | `verify` |
| active effect authority never → distributed fence | D2 terminal-only for live rows; object separation (fact 4) | `verify` |
| warm/Commander/ephemeral/workspace/failed-cleanup covered | D2 5-type classification + failed-cleanup composition | `verify` |
| credentials move to the adapter-management boundary | D3 boundary-authoritative + per-company injection | `verify` |
| rotation + old-key denial | D3 key-generation tag + AoA-side resolve/inject refusal (live kill-switch = REL-004, deferred §5.3) | `verify` |
| kill + cleanup continuity | reuse `real-transport.ts terminate` + CLI-004 | `verify` |
| no unmapped/unattributable resource at closure | D4 closure gate | `verify` |

**Gate recommendation for implementation:** fail-first — write the closure/one-record + never-fence-a-live-lease + CAS-race + old-key-denial assertions RED before the reconciler/credential wiring, then GREEN; distinct adversarial review before the result doc. Disposition = scope-honest `pass` on in-process/mocked evidence (no live cutover; that is MIG-002/005/006/007).

---

## 7. Risks / open questions (resolved or deferred)

- **Crosswalk table scope (company vs org):** resolved D1 — company-scoped (matches source + closure); org attribution recorded as `resourceLabelsHash`, not the tenant key.
- **`ResourceLabels` synthesis vs terminal for live rows:** resolved — terminal-only for live rows (never a synthesized live fence, Invariant 2); a mapping record carries only a partial-attribution hash, never a leasable fence.
- **Old-key-denial without a key-version API:** resolved — AoA-side (attribution tag + resolve/inject refusal); live kill = REL-004 (deferred §5.3).
- **CLI-004 ownership of `cleanupStatus='failed'`:** the reconciler COMPOSES CLI-004's reconcile as the terminal record — no duplicate cleanup path.
- **Legacy inline provider coexistence:** confirmed retained until MIG-006/007 (additive move).
- **Mid-flight-dead run leaving an ACTIVE lease with no reaper (terrain claim #5):** the reconciler inventory attributes these (active + live handle → terminal cleanup or drain record) — closing the gap that `warm-sandbox-reaper` (paused-only) leaves.
