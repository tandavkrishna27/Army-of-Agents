# Pre-Landing Blockers Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 5 confirmed-real isolation/authz/correctness gaps (+ 1 latent-but-dangerous FK) that a whole-PR pre-landing review found on `claude/multitenant-cloud` (#316), so the multi-tenant control plane is genuinely merge-ready.

**Architecture:** Each fix is independent and localized. Five are code-only; one (#8a) is a schema FK change requiring a Drizzle migration. Every fix follows the existing tenant-isolation invariant already enforced by `assertCompanyAccess` / `resolveExecutionTargetForRun` — we are extending that invariant to the endpoints that opted out of it. Self-hosted `local_trusted` behavior must remain unchanged; the new gates key on `tenantIsolationEnforced()` / role where the codebase already does.

**Tech Stack:** Express 5, Drizzle ORM + PostgreSQL, Vitest (mock-db unit tests + embedded-postgres integration tests, the latter `describe.skipIf(process.platform === "win32")`).

**Verdict source:** six parallel read-only investigations (2026-08-01), each pinned the exact file:line + mechanism + fix. `#7` (0195 NULL-org) was investigated and dismissed as a false alarm — no task.

**Ordering:** Task 1 first (the HIGH, now-reachable merge-blocker). Tasks 2–6 in any order (disjoint files). Commit per task.

---

### Task 1: [#1 HIGH] Gate existing-company import on founder/team_lead

**Why:** `POST /import` in `existing_company` mode applies only `assertBoard` + `assertCompanyAccess` (membership, not role) + per-section gates for `agents`/`workflowTemplates`/task-assignment. A `team_member` can therefore import a bundle that overwrites company settings (incl. `requireBoardApprovalForNewAgents=false`), skills (agents execute skills → behavior injection), `internal_agent_config` (`crewAutonomyLevel`, `budgetMonthlyCents`, `enabledCapabilities`), and `budget_policies` (`hardStopEnabled=false`) — all ungated. Reachable now in `authenticated` + `cloud_auth`.

**Files:**
- Modify: `server/src/routes/companies.ts` (the `POST /import` handler + its `authorize` callback, ~lines 196–259 / 225–238)
- (If needed) Modify: `server/src/services/company-portability.ts` (`getImportAuthorizationContext` / `ImportAuthorizationContext`, ~165–230) to surface `importsInternalAgentConfig` / `importsBudgetPolicies` flags
- Test: `server/src/__tests__/mt-import-authz.integration.test.ts` (extend — this is the existing D2 real-DB import-authz suite) OR a route unit test alongside it

**Approach (confirmed by investigation):** the simplest complete fix — any existing-company import is by definition a company-structure mutation, so gate the whole existing-company branch on `founder`/`team_lead`, then keep a stricter **founder-only** gate for the two founder-plane sections (`internal_agent_config`, `budget_policies`). Preview/export stay read-only (membership only).

- [ ] **Step 1: Write the failing test** — a `team_member` importing into an existing company is rejected. Extend `mt-import-authz.integration.test.ts` (real embedded-PG; seed a company with a `team_member` actor). Assert `POST /import` with `target.mode="existing_company"`, `include:{ company:true }` (or skills/internalAgentConfig/budgetPolicies) returns **403** for a `team_member`, and **succeeds** for `founder`/`team_lead`. Add a case: a `team_lead` importing `internalAgentConfig`/`budgetPolicies` is **403** (founder-only), a `founder` succeeds.

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run --root server src/__tests__/mt-import-authz.integration.test.ts` (flip `skipIf` to run on Windows, revert after). Expected: FAIL (team_member currently succeeds).

- [ ] **Step 3: Implement** — in `server/src/routes/companies.ts`, in the `POST /import` handler, after `assertCompanyAccess(db, req, existingCompanyId)` and once the plan/target is known to be `existing_company`, add `await assertRole(db, req, existingCompanyId, "founder", "team_lead")`. Then in the existing `authorize` callback, add founder-only gates for the two sensitive sections, mirroring the existing `importsAgents` pattern:
  ```ts
  if (ctx.importsInternalAgentConfig || ctx.importsBudgetPolicies) {
    await assertRole(db, req, existingCompanyId, "founder");
  }
  ```
  Surface `importsInternalAgentConfig` / `importsBudgetPolicies` on `ImportAuthorizationContext` in `company-portability.ts` (`importsInternalAgentConfig = include.internalAgentConfig && !!manifest.internalAgentConfig`, `importsBudgetPolicies = include.budgetPolicies && (manifest.budgetPolicies?.length ?? 0) > 0`). Confirm `assertRole(db, req, companyId, ...roles)` signature in `server/src/middleware/rbac.ts`.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS. Revert the `skipIf` flip.

- [ ] **Step 5: Regression** — run the existing D2 cases in the same file (founder/team_lead import agents still works; new_company path unaffected). `pnpm --filter @armyofagents/server typecheck` clean.

- [ ] **Step 6: Commit** — `git commit -m "fix(import): gate existing-company import on founder/team_lead (+ founder-only for internal-agent-config/budget)"`

---

### Task 2: [#6] Validate trusted Origin on cookie-authenticated WS upgrades

**Why:** Neither the preview WS (`handlePreviewProxyUpgrade` → `authorizeCompanyUpgrade`) nor the LiveEvents WS (`authorizeUpgrade`) validates the `Origin` header on the cookie/session branch. This is a Cross-Site WebSocket Hijacking (CSWSH) gap. `SameSite=Lax` blocks a random third-party origin today, but it's exploitable from a same-site sibling subdomain and regresses fully if cookies ever move to `SameSite=None`. The trusted-origin allowlist already exists.

**Files (CORRECTED per plan review):**
- Modify: `server/src/services/upgrade-auth.ts` (`authorizeCompanyUpgrade` — add `trustedOrigins?: string[]` to opts + Origin check on the cookie branch, before session resolution)
- Modify: `server/src/services/preview-proxy.ts` (`handlePreviewProxyUpgrade` opts type must ALSO carry `trustedOrigins` — it forwards `opts` to `authorizeCompanyUpgrade` at :195, or TS errors / the field silently drops)
- Modify: `server/src/realtime/live-events-ws.ts` (`authorizeUpgrade` — same check; **EXPORT it** so it's testable; its cookie branch is `authenticated`-only, place the check after the local_trusted return ~:140 and before `resolveSessionFromHeaders` ~:146)
- Modify: `server/src/index.ts` — **HOIST** `effectiveTrustedOrigins` (currently a block-scoped `const` at ~:617, NOT in scope at the upgrade wiring :683/:692) to an outer `let` (like `resolveSessionFromHeaders`/`authReady`), then thread it into both upgrade `opts`
- Test: `server/src/__tests__/upgrade-auth.test.ts` (extend for `authorizeCompanyUpgrade`) AND a case for the now-exported `live-events-ws.ts authorizeUpgrade` (parity — otherwise the live-events check is untested)

- [ ] **Step 1: Write the failing test** — extend `upgrade-auth.test.ts`: on the cookie (no-token) branch, an upgrade whose `Origin` is NOT in the trusted allowlist returns `null` (rejected) BEFORE session resolution; an upgrade with a trusted `Origin` proceeds to the existing membership checks; the bearer-token (agent) branch is unaffected by Origin. Pass `trustedOrigins` via `opts`.

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run --root server src/__tests__/upgrade-auth.test.ts`. Expected: FAIL (no Origin check exists).

- [ ] **Step 3: Implement** — add `trustedOrigins?: string[]` to the `authorizeCompanyUpgrade` opts. On the cookie branch (`!token`, deploymentMode `authenticated`|`cloud_auth`), before `resolveSessionFromHeaders`, read `req.headers.origin` and reject (`return null`) if it is missing/empty or not in `trustedOrigins`. Do the same in `live-events-ws.ts authorizeUpgrade`. In `index.ts`, pass the already-computed `effectiveTrustedOrigins` (line ~617) into both `opts`. Treat a missing Origin on the cookie path as untrusted (browsers always send it on WS handshakes; agents use bearer tokens which skip this check).

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Regression** — server typecheck clean; local_trusted (no-token, no session) path unchanged (it returns a board actor before reaching the cookie branch — confirm the Origin check is only on the `authenticated`/`cloud_auth` cookie branch, not local_trusted).

- [ ] **Step 6: Commit** — `git commit -m "fix(ws): validate trusted Origin on cookie-authenticated preview + live-events upgrades (CSWSH)"`

---

### Task 3: [#5] Route crew provider resolution like heartbeat (no legacy-key pre-injection)

**Why:** `runAoaAgent` calls `resolveAdapterConfigForRuntime` (agent env **+ company-key fallback**) at `runner.ts:523`, injecting the legacy company key into `currentEnv` before the unified resolver runs. The resolver's Step-0 `agent_env_override` short-circuits on that injected key, so the `provider_assignments` lookup never runs → the legacy company key masks **every** assignment (including a founder's explicit agent→connection pin). Heartbeat does it right: it resolves only agent env up front and defers the company key to the resolver's Step 4.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts:523` (`resolveAdapterConfigForRuntime` → `resolveEnvBindings`)
- Modify: `server/src/services/internal-agent/aoa-agents/__tests__/runner-binding-resolution.test.ts` (this structural-lock test currently pins the buggy ordering)

- [ ] **Step 1: Write/adjust the failing test** — in `runner-binding-resolution.test.ts`, assert that the up-front runtime prep calls `resolveEnvBindings` (agent env only) and does NOT pre-inject the company key into the resolver's `currentEnv`; i.e. when a matching `provider_assignments` row exists AND a legacy company key exists, the resolved credential source is the assignment, not `agent_env_override`. (If a pure runner test is hard, add a focused resolver-ordering test asserting `currentEnv` passed to `resolveProviderCredential` does not contain the company key when the agent has no own binding.)

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run --root server src/services/internal-agent/aoa-agents/__tests__/runner-binding-resolution.test.ts`. Expected: FAIL (currently pins `resolveAdapterConfigForRuntime` first).

- [ ] **Step 3: Implement (CORRECTED per plan review — do NOT collapse `runtimeBaseConfig`)** — `runtimeBaseConfig` is reused as the FULL adapter config (`.env` at :576, and the whole object at `applyResolvedCredential(runtimeBaseConfig, …)` :586). Do NOT reassign it to a bare env map. Instead mirror heartbeat (`heartbeat.ts:3217/3222-3223`):
  1. Add `const resolvedEnv = await secretService(db).resolveEnvBindings(agent.companyId, baseConfig.env, { consumerType:"agent", consumerId:agent.id, actorType:"agent", actorId:agent.id })` (agent env only — NO company-key fallback).
  2. At :576 pass `currentEnv: resolvedEnv` (not `runtimeBaseConfig.env`).
  3. At :586 pass `applyResolvedCredential({ ...baseConfig, env: resolvedEnv }, resolvedCredential)` (preserve the adapter config fields — command/cwd/model/args — with the resolved env).
  Remove the up-front `resolveAdapterConfigForRuntime` call at :523 (its only purpose was env+company-key; env now comes from `resolveEnvBindings`). The company key still flows through `resolveDeps.legacyResolveConfig` (:558-564) at resolver Step 4 for the no-assignment case (idempotent re-resolve of already-string env — confirmed safe). Also check the "probe" path (:519) for the same pre-injection and fix if present.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Regression** — run the crew-run / provider-resolution neighbor tests + server typecheck. Confirm the no-assignment case still gets the legacy company key (Step 4), so companies without assignments are unaffected.

- [ ] **Step 6: Commit** — `git commit -m "fix(crew): resolve agent env only before provider resolver so assignments outrank the legacy company key"`

---

### Task 4: [#4] Derive actor.companyIds intersected with active org memberships

**Why:** `/companies` and `/companies/stats` scope by `req.actor.companyIds` (company memberships only), unlike `assertCompanyAccess` which requires org **and** company membership. The two endpoints silently enforce half the tenant invariant, so any future org-membership revocation (or imperfect backfill) leaks company metadata + stats the detail endpoint correctly denies. Root-fix at the source closes list, stats, and every other `companyIds` reader.

**Files:**
- Modify: `server/src/middleware/auth.ts` (~68–76 and the mirror at ~157–166 — how `req.actor.companyIds` is built)
- Test: `server/src/__tests__/companies-scope-pushdown.integration.test.ts` (extend the existing Fix-4 real-DB suite) or an auth-middleware unit test

- [ ] **Step 1: Write the failing test** — seed (embedded-PG) a user with an active `company_memberships` row for company C whose owning org the user is NOT an active `organization_memberships` member of. Assert that in `cloud_auth`/`tenantIsolationEnforced()`, `GET /companies` and `GET /companies/stats` do NOT include C. (And a positive case: a user with both memberships sees C.)

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run --root server src/__tests__/companies-scope-pushdown.integration.test.ts` (flip skipIf). Expected: FAIL (C leaks into the list).

- [ ] **Step 3: Implement (with the join + empty-guard per plan review)** — in `auth.ts`, in BOTH builders (session ~:92 and board-key ~:183), when `tenantIsolationEnforced()`, build `req.actor.companyIds` from a `companyMemberships ⋈ companies` join (`import { companies, inArray }`) filtered to `companies.organizationId IN (activeOrganizationIds)` AND `company_memberships.status='active'`. **Guard the empty case:** if `activeOrganizationIds` is empty → `companyIds = []` (fail-closed; do NOT pass `inArray(x, [])` unguarded). Keep the self-hosted (`local_trusted`/`authenticated`) derivation UNCHANGED (gate the new intersection on `tenantIsolationEnforced()`, which is cloud_auth-only). This is consistent with `assertCompanyAccess`, so no legitimately-accessible company is newly hidden.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS. Revert skipIf.

- [ ] **Step 5: Regression** — the 4-actor journey harness + existing companies-scope-pushdown cases stay green; server typecheck clean; confirm the detail endpoint (`assertCompanyAccess`) behavior is unchanged.

- [ ] **Step 6: Commit** — `git commit -m "fix(authz): scope actor.companyIds to active org memberships (list/stats parity with assertCompanyAccess)"`

---

### Task 5: [#8b] Worker heartbeat must not resurrect a disabled target

**Why:** `registerWorkerHeartbeat` does `UPDATE execution_targets SET status = input.status ?? 'active' WHERE id = targetId` with no status guard, so a heartbeat flips a `disabled` target back to `active` — defeating an operator's "take this worker out of rotation" action.

**Files:**
- Modify: `server/src/services/execution-targets.ts` (`registerWorkerHeartbeat`, ~53–68)
- Test: `server/src/__tests__/execution-targets-worker-token.integration.test.ts` (extend) or a focused heartbeat test

- [ ] **Step 1: Write the failing test** — seed a target at `status:'disabled'`; call `registerWorkerHeartbeat(db, { targetId })`; assert `updated === 0` and the row is STILL `disabled` (not resurrected). Positive: an `active`/`draining` target heartbeats normally (`updated === 1`).

- [ ] **Step 2: Run to verify it fails** — run the test (flip skipIf if integration). Expected: FAIL (disabled row gets resurrected, `updated === 1`).

- [ ] **Step 3: Implement** — add `ne(executionTargets.status, "disabled")` to the `UPDATE`'s `WHERE`: `.where(and(eq(executionTargets.id, input.targetId), ne(executionTargets.status, "disabled")))`. A disabled row now yields `updated === 0`, and the route already returns 404 on `updated === 0` (`routes/execution-targets.ts:130-133`) so the worker learns it's deactivated. Import `and`/`ne` from `drizzle-orm`.

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS. Revert skipIf.

- [ ] **Step 5: Regression** — server typecheck clean; existing worker-token/heartbeat tests green.

- [ ] **Step 6: Commit** — `git commit -m "fix(execution-targets): heartbeat must not reactivate a disabled target"`

---

### Task 6: [#8a] Cascade-delete a deleted org's execution targets (migration)

**Why:** `execution_targets.organization_id` FK is `ON DELETE SET NULL`. Since `organization_id IS NULL` is the security-defining "system/shared, operator-trusted" signal (cross-tenant visible, custom-network allowed), deleting an org would silently PROMOTE its dedicated targets into trusted shared infra. Org-delete isn't shipped yet (latent), but this must be `CASCADE` before that feature exists (per founder: org-delete will be a Settings/Lobby action like company archive).

**Files:**
- Modify: `packages/db/src/schema/execution_targets.ts:19` (`onDelete: "set null"` → `onDelete: "cascade"`)
- Create (generated): `packages/db/src/migrations/0196_*.sql` + `meta/` via `pnpm db:generate`
- Test (CORRECTED per plan review): a **REQUIRED** embedded-PG integration test that deleting an org row CASCADE-deletes its execution_targets AND leaves NO promoted NULL-org row (the schema-literal "FK is cascade" assertion is vacuous for a security property — it passes the instant the TS is edited; the real behavior must be proven against the DB). Keep a migration-contract check that the generated SQL is a single `ALTER … DROP CONSTRAINT … ADD CONSTRAINT … ON DELETE CASCADE`.

- [ ] **Step 1: Write the failing test (REQUIRED = the real-DB behavior test)** — embedded-PG integration (skipIf win32 + initdbFlags): apply the chain incl. the new migration, seed an org + a `dedicated_worker` execution_target with that `organization_id`, `DELETE FROM organizations WHERE id=<org>`, then assert the target row is **gone** (0 rows) — NOT surviving with `organization_id = NULL`. (Optionally also a migration-contract test that the generated SQL is a single `ALTER … ON DELETE CASCADE`.)

- [ ] **Step 2: Run to verify it fails** — run the integration test against the CURRENT schema (still `set null`): the org-delete leaves the target alive with `organization_id = NULL`, so the "0 rows" assertion FAILS. (flip skipIf to run locally, revert after.)

- [ ] **Step 3: Implement** — change the schema to `.references(() => organizations.id, { onDelete: "cascade" })` and update the `// nullable = system/shared` comment to note that org deletion now cascades tenant targets (they never survive as system rows). Run `pnpm db:generate` to emit the migration (`0196_*`, an `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ... ON DELETE CASCADE`). Confirm the migration's `when` timestamp is greater than 0195's (the earlier #1 lesson — journals must be strictly increasing).

- [ ] **Step 4: Run to verify it passes** — contract test PASS; `pnpm db:generate` reports NO further drift; migration-journal-contiguity + the new-migration-when-ordering hold.

- [ ] **Step 5: Regression** — `pnpm --filter @armyofagents/db typecheck` + full db build clean; the migration applies on the real chain (idempotency: the generated ALTER should be safe; add `IF EXISTS` guards per Decision C14 if drizzle-kit doesn't).

- [ ] **Step 6: Commit** — `git commit -m "fix(db): cascade-delete a deleted org's execution targets instead of promoting them to system (migration 0196)"`

---

## Self-Review

**Spec coverage:** all 5 confirmed-real findings + the latent-dangerous #8a have a task (Tasks 1–6). #7 correctly has no task (false alarm). The deferred items (#2 revert-0188 re-upgrade doc, #3 URL-namespace, #9 PR-retarget CI, #10 P5/gVisor) are intentionally out of scope — separate follow-ups.

**Placeholder scan:** each task names exact files + the concrete edit + a concrete RED→GREEN test + a commit. Where an exact line depends on current file state, the investigation line-refs are cited for the implementer to confirm.

**Type consistency:** `assertRole(db, req, companyId, ...roles)` (Task 1) matches `rbac.ts`; `resolveEnvBindings` (Task 3) matches the heartbeat path; `ne`/`and` from drizzle-orm (Task 5); `effectiveTrustedOrigins` (Task 2) is the existing `index.ts` value.

**Cross-cutting after all tasks:** run the FULL server suite (not just affected files — the round-5 lesson: a mock-DB test outside the touched files can break) via Linux CI (push) or a local full `pnpm test:run`; add a **cross-tenant/RBAC invariant sweep** as a follow-up guard; the live 2-account `cloud_auth` proof stays on QA/staging.
