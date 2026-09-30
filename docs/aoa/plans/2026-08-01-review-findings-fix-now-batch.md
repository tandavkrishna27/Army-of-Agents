# Whole-PR Review — Fix-Now Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Fresh implementer per task, TDD, review after each. Steps use `- [ ]`.

**Goal:** Close the fix-now findings from the whole-PR pre-landing review (dual Codex/MeteoriteLabs) on `claude/multitenant-cloud` (#316), plus stabilize the `DefineDepartments` flake blocking the gate.

**Architecture:** Each task is independent and localized. All are code-only except Task 6 (a PR-body claims-accuracy edit, done by the coordinator, not a subagent). The deferred set (real gVisor/org-threading initiative, URL-namespace multi-org UX, assignment↔connection constraint) is OUT OF SCOPE — separate follow-up branch.

**Verification rule (learned):** inventory/canonical-list tests + suite-isolation flakes only surface on the full Linux suite. Before EACH push, run the **full server unit suite AND the full ui unit suite locally** (Windows runs both; integration/e2e stay on CI). Never push on a subset.

**Verdict provenance:** six parallel read-only investigations (2026-08-01) pinned each finding's mechanism + fix. `#6a` (0195 duplicate) was re-confirmed a FALSE ALARM — no task.

## Plan-review corrections (APPLIED — from the plan review)

- **Task 2 (revert guard) — placement + tests:** place the later-migration guard **INSIDE `sql.begin`, AFTER the authoritative single-org recheck** (NOT the pre-`begin` check). This keeps the existing 2-org negative test and the TOCTOU race test green (their single-org refusal fires first). The existing POSITIVE integration test must be restructured: after applying the full chain, **DELETE the 0189–0196 rows from `drizzle.__drizzle_migrations`** (simulate a "0188-latest" DB — the schema/FKs stay, so FIX-A dependent-FK-drop is still exercised) THEN call `revert0188` → succeeds. ADD a NEW test: full chain + 1 org, journal rows intact → `revert0188` REFUSES with the later-migration message.
- **Task 3 (extraction copy) — invert existing tests:** `ui/src/pages/__tests__/DiscussionDetail.extraction.test.ts:107-127` asserts the cloud copy matches `/Settings → Providers/` AND `showSettings === true`; both must be INVERTED (cloud extraction copy no longer points at Settings; `showSettings` becomes **false** — no actionable Settings path for CLI-only extraction on cloud). This intentionally reverses the D3/#27 copy (built on the wrong premise).
- **Task 6 (D1 guard) — put nuance in `assertUnsandboxedMultitenantAllowed`, not `isUnsandboxedLocalTarget`; two tests flip:** `server/src/__tests__/unsandboxed-multitenant-guard.test.ts:20,91` (a runtime-less `sandbox-docker` now refused → invert those asserts) and `server/src/__tests__/heartbeat-execution-target.test.ts:347-357` (the "hardened sandbox no-ops the guard" case — add `runtime:"runsc"` to keep it a valid allowed example). Feasibility CONFIRMED: `runtime` exists on the target type and the guard already receives the full resolved target at the heartbeat + crew sinks (no call-site threading needed).
- **Task 5 (break-glass) — grounded details:** the grants table user column is **`operatorUserId`** (not `userId`); `canOrg` has `db` via its service closure; add imports `operatorBreakGlassGrants`, `isNull`, `gt`; on the org-wide-grant branch keep `&& orgRoleCan(m.role, cap)` so a future non-owner materialized role can't over-grant.
- **Task 1 (LiveEvents) — imports:** only `companies` + `organizationMemberships` are needed (`organizations` is NOT; `companyMemberships` already imported).

---

### Task 1: [#1] cloud_auth board sessions on the LiveEvents WebSocket

**Why:** `live-events-ws.ts authorizeUpgrade` cookie/session branch is gated `authenticated`-ONLY, so cloud_auth board users hit `/events/ws` (no bearer token) → 403 → no realtime/presence/run updates. A correct cloud_auth implementation already exists in the sibling `upgrade-auth.ts`.

**Files:**
- `server/src/realtime/live-events-ws.ts` — `authorizeUpgrade` (~130-192). NOTE: this file is git-flagged **binary** (pre-existing NUL in a comment); edits work, but `git diff` is opaque — verify by reading the file.
- Reference: `server/src/services/upgrade-auth.ts` `authorizeCompanyUpgrade` cloud_auth branch (~78-144).
- Test: `server/src/__tests__` — a unit test for the exported `authorizeUpgrade` (upgrade-auth already exports+tests its analog).

- [ ] **Step 1: Failing test** — cloud_auth cookie session with active org+company membership → `authorizeUpgrade` returns a board actor; company-membership-without-org → null; no-membership → null; `authenticated` regression stays working; the CSWSH Origin check (added last batch, runs before the mode split) still applies.
- [ ] **Step 2: Run → FAIL** (cloud_auth currently returns null at the `!== "authenticated"` gate).
- [ ] **Step 3: Implement** — widen the mode gate to allow `cloud_auth`; after resolving `userId`, add a cloud_auth branch mirroring `upgrade-auth.ts:102-144`: read `companies.organizationId` for `companyId` (null → return null); require an active `organizationMemberships` row for `(userId, org)` AND an active `companyMemberships` row for `(userId, companyId)` (company-without-org denied); return `{ companyId, actorType: "board", actorId: userId }`. Add imports for `organizations`/`organizationMemberships`/`companies` as needed. Keep the `authenticated` branch unchanged. (If clean, extract a shared cloud_auth-membership helper reused by both files; else a direct mirror is fine.)
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Regression** — server typecheck clean; `local_trusted` + agent-token paths untouched.
- [ ] **Step 6: Commit** — `fix(ws): authorize cloud_auth board sessions on the live-events websocket`

---

### Task 2: [#5] revert-0188 must refuse when later migrations are applied

**Why:** `revert-0188.ts` drops the org schema + inbound FKs but deletes ONLY the 0188 journal hash, leaving 0189-0196 marked applied. On AoA's hash-set migrator a forward redeploy re-runs 0188 alone while 0189-0196 stay applied → base org tables back but the dependent FKs/indexes those phases added (and revert dropped) are never restored → permanently inconsistent schema. Running the "reversibility escape hatch" on the current HEAD silently corrupts migration state.

**Files:**
- `packages/db/src/revert-0188.ts` — `revert0188()`; add a fail-closed guard in the cheap pre-check (alongside the single-org check ~42-43), reusing `compute...JournalHash`'s approach.
- Test: `packages/db/src/__tests__/revert-0188-guard.test.ts` (source-string) + the integration test.

- [ ] **Step 1: Failing test** — an embedded-PG integration case (extend `revert-0188.integration.test.ts`): apply the FULL chain (through 0196), seed one org, call `revert0188` → it REJECTS with a "later migrations applied" refusal (RED: today it proceeds and corrupts state). Keep the existing "1 org → succeeds" positive case BUT that fixture must now stop the chain at 0188 (or the guard makes it refuse) — adjust: the positive single-org success path is only valid when 0188 is the latest applied; if the harness applies through 0196, the correct new behavior is refusal, so re-scope the positive test to a chain truncated at 0188, or assert refusal on the full chain.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in the pre-`begin` guard, read `packages/db/src/migrations/meta/_journal.json`, take every entry ordered AFTER `0188_organizations` (idx > 188), compute each migration file's `sha256` the same way `compute0188JournalHash` does, and `SELECT` from `drizzle.__drizzle_migrations WHERE hash = ANY(...)`. If any later-migration hash is present, `throw` a refusal (sibling to `singleOrgRefusal`, e.g. "revert-0188 refused: migrations after 0188 are applied — restore the pre-0188 snapshot instead"). Place it in the cheap pre-check (no ACCESS-EXCLUSIVE recheck needed — migration history isn't racing inserts). A full 0196→0188 reverse is OUT OF SCOPE.
- [ ] **Step 4: Run → PASS.** Confirm `revert-0188-guard.test.ts` still green (add the refusal string it can grep if desired).
- [ ] **Step 5: Regression** — db typecheck clean.
- [ ] **Step 6: Commit** — `fix(db): revert-0188 refuses when migrations after 0188 are applied (no inconsistent history)`

---

### Task 3: [#8] Correct the cloud extraction guidance copy

**Why:** Extraction is CLI-only (never reads a provider key), but two cloud onboarding strings tell founders that setting a per-company **provider key** enables **extraction** — a fix that cannot work. Provider keys enable agents/Commander/embeddings, NOT extraction.

**Files:**
- `ui/src/onboarding/CloudProviderKeyNotice.tsx` (~2-6 doc comment, ~21-25 copy) — drop "extraction" from the "agents, Commander, and extraction run on a per-company provider key" claim (agents/Commander/embeddings is correct).
- `ui/src/pages/DiscussionDetail.tsx` (~156-159, the `multiTenant` `extractionFailureMessage`) — stop claiming a provider key enables extraction. On cloud, the honest message is that extraction is unavailable on AoA Cloud (a CLI login isn't actionable on the shared host either) pending the deferred org-provider extraction sink.
- Test: the component/page tests that assert these strings, if any (grep for the current strings); else a snapshot/render assertion.

- [ ] **Step 1: Failing test** — assert `CloudProviderKeyNotice` no longer says "extraction" and `DiscussionDetail`'s cloud_auth extraction-failure copy no longer promises "set a provider key … extraction". (RED against current strings.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — reword both. Keep the agents/Commander/embeddings claim (correct). For the cloud extraction-failure copy, state extraction is unavailable on cloud (not "set a key").
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Regression** — ui typecheck; any DiscussionDetail/onboarding tests green.
- [ ] **Step 6: Commit** — `fix(ui): cloud extraction guidance no longer points at a non-working provider-key path`

---

### Task 4: [#2] Commander must fail closed on cloud_auth resolver errors

**Why:** `cli-mode.ts` `resolveCommanderSpawnEnvPatch` catch (~737-744) rethrows ONLY `provider_unavailable`; every other error (DB fault in the candidate-row read, dynamic-import/config/topology failures) returns `{}` → Commander borrows the operator's ambient host login on the shared cloud host. The comment already claims "fails closed — never borrow a host login," which it doesn't for those errors. (Reachable only on cloud_auth + the `AOA_ALLOW_UNSANDBOXED_MULTITENANT` opt-in, since D1 refuses Commander by default — practical P2, cheap fix.)

**Files:**
- `server/src/services/internal-agent/cli-mode.ts` (~737-744 catch)
- Test: a focused unit test for the catch decision (extract a tiny pure helper if the catch is hard to test directly, matching the repo's pure-function test pattern).

- [ ] **Step 1: Failing test** — on `tenantIsolationEnforced()` (cloud_auth), a non-`provider_unavailable` error (e.g. a DB error) from the resolver is RETHROWN (fails closed), not swallowed to `{}`; on self-hosted, the same error still degrades to `{}` (host login, unchanged); `provider_unavailable` still rethrows in both. RED before (cloud_auth currently swallows non-`provider_unavailable`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in the catch, before the `logger.warn`/`return {}`, add `if (tenantIsolationEnforced()) throw err;` (rethrow ALL errors on cloud_auth). Keep the existing `provider_unavailable` rethrow (now redundant on cloud_auth but harmless; keep for self-hosted). Correct the misleading comment. Self-hosted behavior byte-identical.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Regression** — server typecheck; commander cli-mode neighbor tests green; confirm the rethrown error still surfaces as an error chunk downstream (not an unhandled crash).
- [ ] **Step 6: Commit** — `fix(commander): fail closed on cloud_auth resolver errors instead of borrowing the host login`

---

### Task 5: [#4] Break-glass grants must not read as ordinary org owners

**Why:** `operator-break-glass.ts materializeMembership` writes a plain org `owner` row (with `createdByBreakGlass=true`; no company column exists on `organization_memberships`), and `organization-access.ts canOrg` authorizes org-wide capabilities straight from that row — never checking the break-glass flag, the grant's live TTL, or its company scope. A company-scoped grant would confer org-wide owner powers past TTL until the sweeper runs. LATENT today (no grant-issuing route wired; only the sweeper), so fix now as defensive hardening BEFORE any grant route ships.

**GROUND FIRST:** read `server/src/services/organization-access.ts` (`canOrg`, `getMembership`, the owner capability matrix), `server/src/services/operator-break-glass.ts` (`materializeMembership`, the grants table `operator_break_glass_grants` shape: `companyId`, `expiresAt`, `revokedAt`, `organizationId`), and `server/src/routes/authz.ts hasActiveBreakGlass` (the correct live-TTL primitive the DATA plane already uses). Confirm the exact columns before coding.

**Files:**
- `server/src/services/organization-access.ts` — `canOrg` (make it break-glass-aware).
- Test: a unit/integration test for `canOrg` with a break-glass-created membership.

- [ ] **Step 1: Failing test** — a `canOrg(org, user, "execution_target:manage")` where the user's only org membership is `createdByBreakGlass=true` from a COMPANY-scoped grant (grant `companyId` set) → returns **false** (no org-wide caps). And: a break-glass membership from an ORG-WIDE grant (`companyId IS NULL`) with a LIVE TTL → returns the capability; the SAME after `expiresAt` (or `revokedAt` set) → false. A normal (non-break-glass) owner membership → unchanged (true). RED before (today any active owner row → true regardless).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — in `canOrg`, after fetching the membership: if `m.createdByBreakGlass === true`, do NOT grant caps from `m.role`; instead look up the live grant(s) for `(organizationId, userId)` in `operator_break_glass_grants` with `revokedAt IS NULL AND expiresAt > now()`, and grant the capability ONLY if a live grant exists whose scope covers it — specifically an ORG-WIDE grant (`companyId IS NULL`). A company-scoped grant (`companyId` set) confers ZERO org-wide capabilities (org_memberships can't express company-scoped org caps). Non-break-glass memberships keep the existing `orgRoleCan(m.role, cap)` path unchanged.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Regression** — server typecheck; org-access + execution-target/org-spend route tests green; confirm normal org owners are unaffected.
- [ ] **Step 6: Commit** — `fix(authz): canOrg is break-glass-aware — company-scoped grants confer no org-wide owner caps`

---

### Task 6: [#3] Fail-closed on non-gVisor sandbox-docker under cloud_auth

**Why:** A tenant-authored `sandbox-docker` environment runs as hardened `runc` + `--network bridge` on the shared host, and `assertUnsandboxedMultitenantAllowed` exempts it (treats "not `local`" as "isolated"). On cloud_auth without a configured gVisor pool (the default), this is a reachable weaker-than-promised isolation boundary (bridge egress to cloud metadata). The full gVisor `runsc`+`network:none` enforcement is the deferred initiative; the cheap fix-now is to make the D1 guard refuse a non-`runsc` docker target on cloud_auth (fail closed, consistent with D1's `local` refusal) rather than run it as runc.

**GROUND FIRST:** read `server/src/services/unsandboxed-multitenant-guard.ts` (`isUnsandboxedLocalTarget`, `assertUnsandboxedMultitenantAllowed`), and confirm the resolved target shape at the call sites (does the guard receive the resolved `{ type, runtime, network }` or just `{ type }`? — the fix must be able to see `runtime`). Check `heartbeat.ts:4569` `resolveGuardedAdapterExecutionContext` + the crew/Commander guard call sites.

**Files:**
- `server/src/services/unsandboxed-multitenant-guard.ts` — treat a docker/sandbox-docker target whose `runtime !== "runsc"` as "unsandboxed" for the cloud_auth refusal (so it's blocked unless `AOA_ALLOW_UNSANDBOXED_MULTITENANT` is set, exactly like a `local` target).
- Test: extend the guard's unit test.

- [ ] **Step 1: Failing test** — on `tenantIsolationEnforced()` with `AOA_ALLOW_UNSANDBOXED_MULTITENANT` unset: a `sandbox-docker`/docker target with `runtime !== "runsc"` → `assertUnsandboxedMultitenantAllowed` THROWS (refused); a `runsc` target → allowed; a `local` target → still throws (unchanged); with the opt-in set → allowed. Self-hosted (`tenantIsolationEnforced()` false) → unaffected (always allowed). RED before (non-runsc docker currently exempt → no throw).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — extend the guard: a target is "requires-sandbox" when it's `local` OR (a docker/sandbox-docker family target whose `runtime !== "runsc"`). If the guard doesn't currently receive `runtime`, thread the resolved runtime/target into it at the call sites. Keep the `AOA_ALLOW_UNSANDBOXED_MULTITENANT` opt-in and self-hosted exemption. Update the guard's docstring (it currently says "sandbox-docker / provider-sandbox: safe on shared infra" — that's the false assumption).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Regression** — server typecheck; heartbeat/crew/commander guard call sites still compile + pass; a `runsc` pooled target still runs.
- [ ] **Step 6: Commit** — `fix(exec): fail closed on non-gVisor docker targets under cloud_auth (D1 guard)`

---

### Task 7: [flake] Stabilize DefineDepartments idempotency test

**Why:** `ui/src/onboarding/inflight/__tests__/DefineDepartments.test.tsx` "is idempotent — reuses an existing same-named department (no second create)" passes in isolation (14/14 local) but fails intermittently in the full parallel Linux suite — blocking the required `verify` gate. Not caused by this PR (onboarding untouched); a suite-isolation/timing flake.

**GROUND FIRST:** read the test + `DefineDepartments` component. Find the non-determinism — likely a missing `await waitFor`/`findBy` on the async create/reuse, a shared module-level mock/state not reset between tests, or an unawaited state update (React `act` warning). Reproduce by running the whole `ui/src/onboarding/inflight/__tests__` dir (not the file alone) to surface the ordering dependency.

**Files:**
- `ui/src/onboarding/inflight/__tests__/DefineDepartments.test.tsx` (and/or the component if the flake is a real race).
- Test: the file itself.

- [ ] **Step 1: Reproduce** — run the full `inflight/__tests__` dir (and, if needed, a broader ui run) to trip the flake; identify the exact async gap (`waitFor` on the "no second create" assertion, or a `beforeEach` reset).
- [ ] **Step 2: Implement the stabilization** — replace timing-fragile assertions with `findBy*`/`await waitFor`; ensure per-test mock/state reset (`beforeEach`); wrap state-changing interactions in `act`/`userEvent` as the repo does elsewhere. Do NOT weaken the assertion (it must still prove no second create happens).
- [ ] **Step 3: Verify determinism** — run the file 5× and the dir 5× locally, all green. (If the flake was a real component race, fix the component and note it.)
- [ ] **Step 4: Commit** — `test(onboarding): stabilize DefineDepartments idempotency flake (await async reuse)`

---

## Coordinator-only (not a subagent task)

### #7-copy — claims-accuracy
The coordinator edits the **PR #316 description** (and any doc that states "P1–P5 backend + API complete") to state that P4/P5 land the schema + resolver scaffolding in an **intentionally-inert** state (org id is `null` at every runtime sink; org-default resolution, org concurrency, and the provider create/assign API are the **deferred agent→org-threading initiative**), so reviewers don't read it as shipped. No code — there is no user-exposed inert surface to feature-gate (the create/assign API doesn't exist). Do this at push time via `gh pr edit`.

---

## Self-Review
- **Coverage:** #1,#5,#8,#2,#4,#3 + the flake each have a task; #7-copy is the coordinator PR-body edit; #6a is correctly no-task (false alarm). Deferred set (#7-init, #3-full, #9, #6b) is out of scope.
- **Grounding gaps flagged:** Tasks 5(#4), 6(#3), 7(flake) require ground-first (grant columns / guard target shape / flake root cause) — implementers must confirm before coding.
- **Verify discipline:** FULL server + ui unit suites locally before EACH push (the inventory/flake lesson).
- **live-events-ws.ts** is git-binary (pre-existing NUL) — Task 1's diff is opaque; review by reading the file.
