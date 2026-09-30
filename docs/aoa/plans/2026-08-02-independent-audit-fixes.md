# Independent Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the two findings my independent adversarial audit confirmed on HEAD `4fd39a80` (branch `claude/multitenant-cloud`, worktree `C:/Users/TK/.aoa/wt/mt-cloud`, PR #316): (A1) the ungated adapter-readiness CLI probe that runs a generation under the operator's ambient login on cloud, and (A2) the non-atomic company-create that can orphan a company on a transient fault.

**Architecture:** Two independent fixes. A1 gates two probe entry points with the existing D1 guard (`assertUnsandboxedMultitenantAllowed`) — no-op self-hosted, refuses local/non-runsc on cloud absent the opt-in. A2 wraps the company row + operator membership in one transaction, mirroring the shipped Fix 5 (`createSelfServeOrganization`). No schema change, no migration.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM (`postgres`), vitest. Server test cmd (server has NO `test` script): `pnpm test:run <pattern>` from the worktree root. Typecheck: `pnpm -r typecheck`.

---

## Findings → Task map

| # | Finding | Severity | Task |
|---|---------|----------|------|
| A1 | Adapter readiness/test-environment probe (`agents.ts:680`, `providers.ts:559`) spawns `claude`/`codex` under the operator's ambient login on cloud_auth — the one CLI sink not gated like extraction/compaction/D1 | P2 | Task 1 |
| A2 | `POST /companies` + import `new_company` create the company row and the founder membership in SEPARATE un-transactioned steps → a fault between them leaves an unrecoverable orphan company (Fix 5 fixed this for org-create only) | P3 | Task 2 |

---

### Task 1: Gate the adapter-readiness probe on cloud (A1)

**Root cause:** `adapter.testEnvironment` spawns a real one-shot `claude --print`/`codex exec` generation. For the default LOCAL target it inherits the host env (strips only `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, keeps `CLAUDE_CONFIG_DIR`/`HOME`/`CODEX_HOME`), so on cloud_auth it runs under the operator's `~/.claude` / codex login. Two entry points call it with NO deployment-mode check: the test-environment route (`routes/agents.ts:680`, target = `acquiredEnvironment?.configPatch.executionTarget` — null ⇒ local) and `probeAndRecord` (`routes/providers.ts:559`, no executionTarget at all ⇒ always local). Every other CLI sink in the PR fails closed on cloud (extraction/compaction `throw` on `tenantIsolationEnforced()`; heartbeat/crew/Commander via the D1 guard). The probe was missed. Fix: gate both with the D1 guard on the effective target — it is a no-op self-hosted and on genuinely-isolated (runsc/provider-sandbox) targets, and refuses the local/non-runsc case on cloud unless `AOA_ALLOW_UNSANDBOXED_MULTITENANT=1` (identical opt-in to the run sinks).

**Files (THREE probe entry points, not two — plan-review caught the third):**
- Modify: `server/src/routes/agents.ts` (before `adapter.testEnvironment` ~:680)
- Modify: `server/src/routes/providers.ts` (`probeAndRecord`, before `adapter.testEnvironment` ~:559)
- Modify: `server/src/routes/commander-verify.ts` (before `adapter.testEnvironment` ~:59 — a DIRECT `testEnvironment` call, no executionTarget ⇒ always local, reachable by every founder on cloud during the Commander onboarding Verify step)
- Test: `server/src/__tests__/adapter-probe-cloud-guard.test.ts` (new) or extend existing agents/providers route tests
- VERIFY (likely out of scope): `server/src/services/health/company-health.ts:236` also calls `testEnvironment` on the `openclaw` adapter — confirm openclaw's `testEnvironment` is an HTTP/config check (NOT a `claude`/`codex` local generation) before declaring the sink class fully closed; gate it too only if it spawns a local generation.

- [ ] **Step 1: Write the failing tests**

The guard `assertUnsandboxedMultitenantAllowed(target, { tenantIsolationEnforced, sink })` (`server/src/services/unsandboxed-multitenant-guard.ts`) THROWS on cloud_auth + a local/undefined target absent the opt-in env, and is a no-op otherwise. `isUnsandboxedLocalTarget(null)===true`. Write tests proving the two probe entry points do NOT spawn a generation on cloud_auth with a local target:
- Prefer a focused unit/route test: set `setDeploymentMode("cloud_auth")`, ensure `AOA_ALLOW_UNSANDBOXED_MULTITENANT` is unset, invoke the probe path (or the extracted gate helper) with a null/local executionTarget → assert it returns a graceful "unavailable on AoA Cloud" outcome AND that `adapter.testEnvironment` (mock) was NOT called.
- A self-hosted case: `setDeploymentMode("local_trusted")` → the probe runs as before (guard no-op).
- (If wiring a full route test is heavy, extract a tiny `assertProbeAllowedOnCloud(target)` / inline gate and unit-test that + the mode reset in `afterEach`.)

Read `routes/agents.ts:594-719` and `routes/providers.ts:502-606` first to match the real result/outcome shapes (`AdapterEnvironmentTestResult` for agents; the `{ outcome, checks, testedAt }` for providers).

- [ ] **Step 2: Run — verify FAIL** (`pnpm test:run adapter-probe-cloud-guard` or the chosen pattern) — the probe currently spawns regardless of mode.

- [ ] **Step 3: Implement the gate**

Import `assertUnsandboxedMultitenantAllowed` from `../services/unsandboxed-multitenant-guard.js` and `tenantIsolationEnforced` from `../config/deployment-mode.js` in both route files.

**`agents.ts`** — the gate MUST sit INSIDE the existing `try { const result = await adapter.testEnvironment(...) } finally { releaseRunLease }` block (i.e. at ~:679, immediately before the `adapter.testEnvironment` call at :680) so the `return` in the gate's `catch` still triggers the inner `finally` (releases any acquired environment lease) AND the outer `finally` (`releaseProbeSlot`). Do NOT place it before the `try` — an early return there leaks the lease. Gate on the EFFECTIVE target (`acquiredEnvironment?.configPatch.executionTarget ?? null`) and return the REAL `AdapterEnvironmentTestResult` shape (`packages/adapter-utils/src/types.ts:432` = `{ adapterType, status: "pass"|"warn"|"fail", checks, testedAt }` — there is NO `ok` field; the UI discriminates on `status`):
```ts
      // A1: the readiness probe is a CLI-generation sink. On cloud_auth a local /
      // non-runsc target would spawn `claude`/`codex` under the OPERATOR's ambient
      // host login — refuse it like the run sinks (D1 guard) + extraction/compaction.
      // No-op self-hosted and on genuinely-isolated (runsc/provider-sandbox) targets.
      try {
        assertUnsandboxedMultitenantAllowed(
          acquiredEnvironment?.configPatch.executionTarget ?? null,
          { tenantIsolationEnforced: tenantIsolationEnforced(), sink: "adapter readiness probe" },
        );
      } catch {
        res.json({
          adapterType: type,
          status: "fail" as const,
          checks: [{
            code: "readiness_unavailable_on_cloud",
            level: "error",
            message: "Adapter readiness testing is unavailable on AoA Cloud (a local probe would run on the shared host). Configure a sandboxed execution environment or test self-hosted.",
          }],
          testedAt: new Date().toISOString(),
        });
        return; // do NOT spawn — the inner+outer finally still release the lease + slot
      }
```
Confirm `AdapterEnvironmentCheck`'s field names (`code`/`level`/`message`) against the real type when writing the check.

**`commander-verify.ts`** (~:59) — a direct `adapter.testEnvironment({ companyId, adapterType, config })` with NO executionTarget (always local). Gate with a null target before the call; on refusal return a blocking result (e.g. a 422 or a `status:"fail"` verify result with the cloud message) so onboarding stays on the Verify step and no generation spawns. Match `commander-verify.ts`'s own result/response shape (read it).

**`providers.ts` `probeAndRecord`** — it never has an executionTarget (always local). Before `adapter.testEnvironment` (~:559), gate with a null target (⇒ local ⇒ refused on cloud). On refusal, record the readiness as failed/unavailable (so a stale `verified` row is overwritten) with the cloud message, and return WITHOUT spawning:
```ts
      if (tenantIsolationEnforced()) {
        try {
          assertUnsandboxedMultitenantAllowed(null, { tenantIsolationEnforced: true, sink: "adapter readiness probe" });
        } catch {
          await recordReadiness(db, {
            companyId, providerId: descriptor.id, scope, outcome: "failed",
            checks: [{ code: "readiness_unavailable_on_cloud", level: "error",
              message: "Provider readiness testing is unavailable on AoA Cloud (a local probe would run on the shared host)." }],
            testedByUserId: req.actor.type === "board" ? (req.actor.userId ?? null) : null,
          });
          return { outcome: "failed", checks: [...], testedAt: new Date().toISOString() };
        }
      }
```
Match `recordReadiness`'s real signature + the `{ outcome, checks, testedAt }` return shape from the surrounding code. Do this AFTER the probe-slot acquire so it still respects the single-flight slot (or before — either is fine as long as no spawn happens). Note `tenantIsolationEnforced()` here also correctly still allows the probe when the opt-in env is set (the guard doesn't throw then), matching the run sinks.

- [ ] **Step 4: Run — verify PASS + no regression** (`pnpm test:run adapter-probe-cloud-guard`, then `pnpm test:run "agents-adapter|providers"` — confirm the existing self-hosted probe tests stay green; the guard is a no-op off cloud). `pnpm -r typecheck`.

- [ ] **Step 5: Commit**
```bash
git add server/src/routes/agents.ts server/src/routes/providers.ts server/src/routes/commander-verify.ts server/src/__tests__/adapter-probe-cloud-guard.test.ts
git commit -m "fix(providers): gate all three adapter-readiness probe sinks on cloud (no operator-login CLI generation on the shared host)"
```

---

### Task 2: Make company-create atomic with the founder membership (A2)

**Root cause:** `POST /companies` (`routes/companies.ts:310-314`) calls `svc.create(...)` — which inserts the company row (`createCompanyWithUniquePrefix`, `services/companies.ts:119-137`, a bare `db.insert` that commits immediately) — and THEN, as a separate un-transactioned step, `access.ensureRealOperator(company.id, userId)` (writes authUsers + company membership + founder role + org membership, `services/access.ts:284-335`). If any of those throws after the company row commits, the company exists with NO membership for anyone — unrecoverable in cloud_auth (repair routes need `instance_admin`, which cloud mints none; the orphan is excluded from the org∩company list). The import `new_company` path (`services/company-portability.ts` ~:2179 create then ~:2202 ensureRealOperator) has the same gap. Fix 5 already solved this for org-create (`createSelfServeOrganization`, `services/organizations.ts:120-145`): the org insert + `ensureOrgOwner` run in ONE `db.transaction`, with the slug-retry loop OUTSIDE. Mirror it for company-create.

**Files:**
- Modify: `server/src/services/companies.ts` (add an atomic `createWithOperator` mirroring `createSelfServeOrganization`; factor the best-effort seeders so they run OUTSIDE the tx)
- Modify: `server/src/services/access.ts` (make `ensureRealOperator` bindable to a tx handle — e.g. `accessService(tx).ensureRealOperator(...)`, the way Fix 5 uses `buildOrgAccess(tx)`)
- Modify: `server/src/routes/companies.ts` (call the atomic path instead of `svc.create` + `access.ensureRealOperator`)
- Modify: `server/src/services/company-portability.ts` (import `new_company` path — same atomic path)
- Test: `server/src/__tests__/company-create-atomicity.integration.test.ts` (new; Linux-gated `describe.skipIf(process.platform !== "linux")` embedded-PG — flip `skipIf(false)` to run locally, REVERT before commit) OR a mock-DB unit test if a deterministic operator-failure injection is cleaner

- [ ] **Step 1: Read the full paths first**

Read: `createCompanyWithUniquePrefix` in FULL (`services/companies.ts:119` through the end of the function — it runs inline best-effort seeders after the insert: `seedCompanyRootFolder`, the Commander-team seeding, etc.); `svc.create` (its wrapper); how `accessService` is constructed (does `accessService(db)` return `{ ensureRealOperator, ... }` bound to `db`? — that's what lets `accessService(tx)` bind to a tx); `routes/companies.ts:300-360` (the create route + all post-create seeders + activity log); `company-portability.ts` around the `new_company` create + `ensureRealOperator`; and `createSelfServeOrganization` (`services/organizations.ts:120-145`) as the exact template.

- [ ] **Step 2: Write the failing test**

Prove that when `ensureRealOperator` throws, NO company row survives (atomic rollback). Options:
- Integration (preferred if the embedded-PG harness is reusable): create a company with an injected `ensureRealOperator` failure (e.g. a buildAccess whose `ensureRealOperator` rejects) and assert (a) the create rejects AND (b) `companies` has no row for that name/prefix (rolled back). Also a happy-path: create succeeds → company row + owner company membership + founder role + org membership all present.
- Or a mock-DB unit test asserting the insert + `ensureRealOperator` run on the SAME `tx` handle (structural), plus that a thrown `ensureRealOperator` propagates without a committed row.

RED: against the current non-atomic code, the failure-injection leaves the company row committed (test asserting no-row fails).

- [ ] **Step 3: Make `ensureRealOperator` tx-bindable**

In `access.ts`, ensure the access service can be built on a transaction handle so `ensureRealOperator` (and its internal `ensureMembership`, the `userRoles`/`organizationMemberships` inserts, and the `companiesTable.organizationId` read at :320) all run on the passed handle. Mirror how Fix 5 does `buildOrgAccess(tx).ensureOrgOwner`. If `accessService(handle)` already parameterizes its `db`, just pass `tx`; otherwise thread an optional handle. Keep the default (`db`) behavior unchanged for all existing callers.

- [ ] **Step 4: Add the atomic `createWithOperator` + extract ONLY the Group-A seeders**

There are TWO distinct seeder groups (plan-review — do NOT fold them together):
- **Group A** — currently INLINE in `createCompanyWithUniquePrefix` (`companies.ts:139-210`): root folder, `ensureInternalAgentConfig`, `ensureInfrastructureAgents` (Commander), `provisionCompanyCrew`, gated by the `isCrewMarketplaceManaged` read. OPERATOR-INDEPENDENT.
- **Group B** — currently ROUTE-ONLY (`routes/companies.ts:322-343`): `materializeCompanyProfileFromGlobal` (needs `operatorId`), `seedAoaNativeSkills`, `ensureCommanderAgent` re-run (QA-BUG-007). OPERATOR-DEPENDENT.

Extract **Group A ONLY** into a shared best-effort helper `seedNewCompanyBestEffort(companyId, requestedByUserId)` (NO operator param). Both `svc.create` (unchanged, operator-free, tx-free — keeps `companies-prefix-conflict.test.ts` passing) and the new `createWithOperator` call it after their row insert. **Leave Group B in the route** (see Step 5). **Do NOT** add Group B to the import path (`company-portability.ts` never ran it — folding it in would newly seed native skills/profile on every bundle import and could collide with the bundle's `selectedSkills`).

CRITICAL when extracting Group A (2C): keep the `isCrewMarketplaceManaged` read BEFORE any `kind='aoa'` write (read-before-write gate, companies.ts:186) and `ensureInternalAgentConfig` BEFORE `ensureInfrastructureAgents`; keep the gate's `db.select().from().where().limit()` shape BYTE-IDENTICAL (`companies-prefix-conflict.test.ts` asserts on it). And (2B) `ensureInfrastructureAgents` (companies.ts:197) is NOT currently `.catch`-wrapped — WRAP it best-effort inside `seedNewCompanyBestEffort` so a post-commit seeder throw can't reject `createWithOperator` after the tx committed.

Add `createWithOperator` mirroring `createSelfServeOrganization` (co-located in the company service closure so it can reuse the existing `isIssuePrefixConflict` 23505 detector at `companies.ts:91` — nothing new to write; take `buildAccess` as a PARAMETER to avoid a companies↔access circular import; cast `tx as unknown as Db` like `organizations.ts:136`):
```ts
// Atomicity (A2, mirrors Fix 5's createSelfServeOrganization): the company-row
// insert and the founder's operator membership/role/org-membership run in ONE
// db.transaction, so a transient fault can never leave an orphan company. The
// issue-prefix retry loop stays OUTSIDE the tx (each attempt = a fresh tx with
// exactly one insert + ensureRealOperator); a 23505 prefix conflict (isIssuePrefixConflict)
// aborts only that attempt and retries; a NON-conflict error (e.g. ensureRealOperator
// failing) re-throws out of the loop and the tx rolls back (no orphan).
async function createWithOperator(data, opts, ownerUserId, buildAccess) {
  const base = deriveIssuePrefixBase(data.name);
  let suffix = 1;
  let created;
  while (suffix < 10000) {
    const candidate = `${base}${suffixForAttempt(suffix)}`;
    try {
      created = await db.transaction(async (tx) => {
        const company = (await tx.insert(companies).values({
          ...data,
          organizationId: data.organizationId ?? DEFAULT_ORGANIZATION_ID,
          issuePrefix: candidate,
        }).returning())[0];
        const operatorId = await buildAccess(tx as unknown as Db).ensureRealOperator(company.id, ownerUserId);
        return { company, operatorId };
      });
      break;
    } catch (e) {
      if (!isIssuePrefixConflict(e)) throw e;
      suffix += 1;
    }
  }
  if (!created) throw new Error("Unable to allocate unique issue prefix");
  await seedNewCompanyBestEffort(created.company.id, opts.requestedByUserId ?? null); // Group A, AFTER the committed tx
  return created;
}
```
Grep the callers of the company service `.create(` first — there are exactly two (`routes/companies.ts:310`, `company-portability.ts:2179`); both move to `createWithOperator`; `svc.create` stays as-is for the test.

- [ ] **Step 5: Switch the route + import path to the atomic path**

- `routes/companies.ts:310-314`: replace the `svc.create(...)` + `access.ensureRealOperator(...)` pair with `const { company, operatorId } = await svc.createWithOperator({ ...req.body, requireBoardApprovalForNewAgents, organizationId }, { requestedByUserId: req.actor.userId ?? null }, req.actor.userId, (tx) => accessService(tx))`. **KEEP Group B in the route exactly as today** (`materializeCompanyProfileFromGlobal(db, company.id, operatorId, operatorId)`, `seedAoaNativeSkills`, the `ensureCommanderAgent` re-run — all after `createWithOperator` returns), using the RETURNED `operatorId`. Group A already ran inside `createWithOperator`; do NOT re-run it here (no double-seed). The `logActivity` + response stay as-is.
- `company-portability.ts` (import `new_company`, ~:2179/:2202): replace the `companies.create(...)` + `ensureRealOperator(...)` pair with `createWithOperator(...)`; set `targetCompany = created.company` and DELETE the now-redundant `ensureRealOperator` call at ~:2202. Group A runs inside (preserving the import's crew-provisioning intent). Do NOT add Group B to the import. Confirm the surrounding import flow is NOT already inside a top-level `db.transaction` at this site (plan-review verified it is not — `createWithOperator`'s tx is top-level, no nested savepoint).

- [ ] **Step 6: Run tests + typecheck; REVERT any skipIf flip**

`pnpm test:run company-create-atomicity`, `pnpm test:run "companies|company-portability|access"`, `pnpm -r typecheck` (exit 0). If an integration test used a flipped `skipIf`, revert to `process.platform !== "linux"`. Verify a normal create still produces company + owner membership + founder role + org membership (happy path) and all seeders still run.

- [ ] **Step 7: Commit**
```bash
git add server/src/services/companies.ts server/src/services/access.ts server/src/routes/companies.ts server/src/services/company-portability.ts server/src/__tests__/company-create-atomicity.integration.test.ts
git commit -m "fix(companies): create company + founder membership atomically (no orphan company on transient fault; mirrors Fix 5)"
```

---

## Post-batch verification (controller)

- [ ] Full suite with REAL exit capture: `pnpm test:run > /tmp/mt-suite6.log 2>&1; echo "VITEST_EXIT=$?" >> /tmp/mt-suite6.log`. Classify reds; anything touching a changed file that fails in ISOLATION is real (watch for call-arg assertions broken by the company-create signature change — grep `svc.create`/`.create(`).
- [ ] `pnpm -r typecheck` (exit 0)
- [ ] `node scripts/check-forbidden-tokens.mjs`
- [ ] `pnpm db:generate` → no new migration
- [ ] Confirm any integration `skipIf` is back to `process.platform !== "linux"`
- [ ] Final holistic cross-cutting review over the whole batch diff
- [ ] Push; PR comment (note this batch came from my OWN independent adversarial audit, not a Codex round — the P2 probe sink was the 4th operator-login CLI sink the reviews missed); tell the user to run their own review

## Notes

- Task 1 is the priority (a reachable cloud-isolation gap of a class already fixed 3×; it's really THREE probe sinks). Task 2 is a robustness fix (P3, rare transient fault, no isolation breach / no data loss). Plan-review verified Task 2's transaction (Fix 5 mirror) is feasible and low-risk: `ensureRealOperator` is cleanly tx-bindable (`accessService(db)` closes over `db`, no nested transaction), the `isIssuePrefixConflict` 23505 detector already exists (`companies.ts:91`), the import site is not in a top-level tx (no nesting surprise), and there are exactly two `.create(` callers. The compensating-delete fallback is NOT needed. The only real risk is the seeder handling — handled by the Group-A-only extraction + keeping Group B in the route (Step 4/5).
