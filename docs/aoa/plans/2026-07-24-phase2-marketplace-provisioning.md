# Phase 2 — Marketplace Provisioning — Implementation Plan

> ## ✅ PLANNED SCOPE COMPLETE (2026-07-25) — except T2.4, which needs product-owner sign-off
>
> **Shipped:** T2.1 · T2.2 · T2.3 (+ **T2.3b/c/d/e**, all discovered mid-flight) ·
> T2.5 · T2.6 · T2.7 · T2.8 · T2.9 · T2.10. Every task went through
> implement → spec review → code-quality review → fix round; several took three
> rounds. Decisions **#111–#115** recorded.
>
> **The headline:** the phase's own deliverable **never worked** until T2.3d/T2.3e.
> Every live company create failed on `triggers[].enabled` (a `.strict()` schema
> vs. what all 9 published crew agents actually declare), and once that was fixed
> the installed crew was **inert** (`paused`, excluded by 6 execution paths) and
> on the **wrong adapter**. Neither was findable from the test suite: every
> fixture hand-wrote agent bodies, and the bundled snapshot carries only the
> catalog *index* — trigger data lives in the separately-fetched `agent.json`.
> Both were found only because someone measured against the **live catalog**.
> Verbatim published bodies are now checked in under
> `server/src/__tests__/__fixtures__/published-catalog/`.
>
> **Exit criterion now holds and is proven** — the bootstrap integration test
> calls the real agent-selection query with a deliberately-paused control row, so
> it cannot pass for free.
>
> **BLOCKED — T2.4** touches two external public repos
> (`MeteoriteLabs/aoa-marketplace`, `aoa-marketplace-cdn`). Not started; needs an
> explicit go-ahead. Its pre-publish checklist has grown three consequences from
> this phase's findings — read it before authorising.
>
> **Follow-ups this phase generated** (all filed with reproduction detail, none
> started): T2.7b (fence-aware + line-ending-safe splitting) · T2.8b (byte-derive
> the skill `customized` flag) · T2.8c(a)(b) · T2.9b/c/d/e · `task_4ede0b60`
> (41 integration files share a fail-open setup guard).


> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** company creation installs the crew **from the marketplace** (not legacy hardcoded seeders), each agent arrives with its declared skills, and an upstream agent/skill change flows down through detect → notify → diff → merge **without discarding founder edits**.

**Architecture:** the machinery already exists on both sides — `installTeam` is fully implemented, the catalog is published and coherent, and the update pipeline (`checkCrewUpdates`, auto-apply/notify, `skill-auto-updater`) runs on boot + every 24h. **Phase 2 is wiring, not authoring** — with one exception (T2.4) that needs upstream catalog content.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), Express, Drizzle, Vitest, Playwright.

**Branch:** `feat/viewer-upgrade` (stacking on Phase 1 — product-owner decision 2026-07-24).

**Non-goals:** Phase 3 viewer completion; crew file-output detection (W3b, filed); idempotent crew retry (filed); crew-as-team-members (filed design initiative).

---

## Verified preconditions (re-checked 2026-07-24 — do NOT re-derive, DO verify anything you depend on)

**Code side (all still true after Phase 1):**
- `teams.parentProjectId` is `notNull()` with `onDelete: cascade` (`packages/db/src/schema/teams.ts:12`).
- `ensureAllCrewAgents` is still all-or-nothing and bundles **Commander** (`:55`) and **Steward** (`:61`) with the crew seeders (`ensure-all-crew.ts:54-67`).
- Company creation calls `installTeam` **zero times** (grep of `services/companies.ts` + `routes/companies.ts`).
- `/updates/:id/diff` rejects non-skill with 400 (`marketplace-company.ts:307-308`); `/updates/:id/merge` rejects with 404 (`:386-387`).

**Catalog side (live CDN, `generatedAt` 2026-07-24T04:06Z):**
- 514 items: **498 skills, 11 agents, 4 plugins, 1 team** (`team:aoa-curated/default-crew`).
- Published agents: Adjutant, Chronicler, Engineer, Librarian, Memory Keeper, Navigator, Planner, Reviewer, Scout, GitHub Issue Triager, Senior Engineer.
- **Steward is NOT published** → T2.4 required.
- **Chronicler, Memory Keeper, Navigator declare ZERO skills** → T2.4 required.
- ~~The bundled fallback `ui/src/aoa-marketplace-snapshot.json` mirrors the CDN (D11 offline bootstrap works).~~
  **❌ REFUTED during T2.3 (2026-07-24). D11 offline bootstrap does NOT work.**
  The snapshot carries only the catalog **index**. `installTeam` then fetches the
  team body, **every** agent template, and every skill body over the network
  (`team-installer.ts:109`, `:121`, `:140` — published skills have
  `content.inline === null`, so their bodies are fetched too). Independently
  confirmed. Consequences, which are product-level, not just test-level:
  - A genuinely network-isolated instance **always** degrades to the legacy
    seeders and therefore gets a permanently non-updateable `@legacy` crew —
    the exact condition this phase exists to eliminate.
  - No amount of snapshot injection can make creation offline-capable; that
    would need bundled resource bodies, not just an index.
  - Any test asserting "offline → marketplace roster" is only honest if it also
    stubs the resource fetches, and must not be described as proving offline
    bootstrap. Recorded on Decision #112.

**The single root cause this phase fixes:** company create runs the legacy seeders, which stamp `templateOrigin` `…@legacy`, and `crew-updater.ts:151` skips `@legacy` rows **forever** — so every company is permanently frozen out of the update pipeline that is already built and running.

---

## Standing rules for this phase (scars from Phase 1 — do not relearn them)

1. **Verify, don't infer.** A prior version of this plan asserted "the catalog doesn't exist"; it did. Every factual claim in your report needs a `file:line`, a query result, or a command output.
2. **Discriminator discipline.** A test must only be able to pass for the right reason. If success and failure produce the same observable, add a distinguishing assertion. (Phase 1 shipped a "regression guard" that could not fail, and five suites silently traversing a catch.)
3. **Gates fail closed.** A guard that skips when identity/scope is missing is a hole. "Safe because the caller always sets X" is not a guarantee.
4. **Docblocks must not over-promise.** If a function says "never throws", prove it or narrow the claim.
5. **Drizzle only** — `pnpm db:generate`, never hand-written SQL (Critical Rule #1).
6. **`pnpm test:run`**, never bare root-level `vitest` (nested worktrees break it; they are off-limits).
7. **Process:** never run two committing subagents in one worktree simultaneously — the git index is shared and their commits race. Sequential, or separate worktrees.

---

## Sequencing — T2.1 and T2.2 GATE T2.3

- **T2.1 before T2.3:** `installTeam` hard-requires a department that does not exist at company-create time. Without the nullable parent there is nowhere to install to.
- **T2.2 before T2.3:** `isCrewMarketplaceManaged` suppresses the *entire* `ensureAllCrewAgents`. The moment T2.3 makes a company marketplace-managed, Commander and Steward stop being seeded — Inbox Hub curation breaks silently.

Order: **T2.1 → T2.2 → T2.3 → T2.3b → T2.3c → T2.3d → T2.3e → T2.5 → T2.4 → T2.6 → T2.7 → T2.8 → T2.9 → T2.10 → T2.8b → T2.7b**. (T2.5 protected-origins before T2.4 so Steward is protected the moment it becomes marketplace-managed.)

---

## T2.1 — Decouple the crew team from departments (D21)

**Why:** AoA crew are **company-wide singletons**; parenting them to a department is semantically wrong *and* fragile — `onDelete: cascade` means deleting that department deletes the crew team row.

**Files:** `packages/db/src/schema/teams.ts`, migration via `pnpm db:generate`, `server/src/services/marketplace-install/team-installer.ts` (~`:81-84` precondition, `:276` `parentProjectId`), `server/src/routes/marketplace-installs.ts` (~`:338` the 400).

- [ ] **Step 1: Failing tests.**
  - `installTeam` succeeds with `targetDepartmentId: null` and writes a `teams` row with `parentProjectId: null`.
  - A department-scoped install still parents correctly (regression).
  - **Deleting a department does NOT cascade away a company-wide crew team** (the discriminator — this is the bug nullability fixes).
  - The **route-level 400** for a *user-initiated* team install that omits a department is **preserved** (only the internal bootstrap path may omit it).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Make `teams.parentProjectId` nullable.** `pnpm db:generate`. Existing rows keep their parent — do not backfill.
- [ ] **Step 4: Relax `installTeam`'s precondition** so a null `targetDepartmentId` is valid; keep the existing validation when one IS supplied (a supplied id must still exist and be `type:'department'`).
- [ ] **Step 5: Run → PASS.** **Step 6: Verify + commit.**
```bash
git commit -m "feat(marketplace): allow company-wide teams with no parent department (D21)"
```

---

## T2.2 — Narrow the crew-seeding gate (P8d)

**Why:** `ensureAllCrewAgents` is all-or-nothing and every caller skips the whole function when marketplace-managed (`index.ts:796-800`, `internal-agent.ts:139-140`). Commander and Steward live inside it.

> **Plan correction (2026-07-24, found during execution):** there are **three**
> call sites, not two. The third is `services/companies.ts:~136-158` (company
> create), which does not call `isCrewMarketplaceManaged` — it carries an
> **inline duplicate** of the same query. Worse, `ensureInternalAgentConfig`
> sat *inside* that gated block, so the moment T2.3 makes a company
> marketplace-managed the company would get **no `internal_agent_config` row
> at all** (no autonomy dial, no provider/model config). Both were fixed as
> part of T2.2.

**Files:** `server/src/services/internal-agent/aoa-agents/ensure-all-crew.ts`, its **three** callers (`index.ts`, `routes/internal-agent.ts`, `services/companies.ts`).

- [ ] **Step 1: Failing test** — for a marketplace-managed company, the **crew** seeders are skipped while the **infrastructure** seeders (Commander, Steward) still run. Discriminator: assert Commander/Steward were ensured AND a crew role (e.g. Scout) was not.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Split** into `ensureCrewAgents` (the marketplace-owned roster) and `ensureInfrastructureAgents` (Commander + Steward, until T2.4 publishes Steward). `isCrewMarketplaceManaged` gates **only** the crew half. Keep `ensureAllCrewAgents` as a thin wrapper if callers depend on it — do not break the boot path.
- [ ] **Step 4: Run → PASS.** **Step 5: Verify + commit.**
```bash
git commit -m "fix(crew): gate only crew seeders on marketplace management (Commander/Steward always seeded)"
```

---

## T2.3 — Install the crew at company creation (P8, P8c) — ✅ SHIPPED 2026-07-24

> Landed across `9d0918162` → `c57142e5e` → `52e118108` (build + 3 review rounds,
> two full reviews plus a focused review of the fix-round logic). Decision #112.
> Two implementer push-backs were upheld: the prescribed `isCrewMarketplaceManaged`
> degrade guard was wrong (it matches Commander/Steward seeded moments earlier and
> would trade a silent clobber for a silent crewless company) — replaced with the
> `crewTeamIsInstalled` witness; and the plan's Step 5 "remove the pre-install
> gate" was declined because after T2.2 the gate anchors a live regression guard.

**This is the task that unfreezes the whole update pipeline.**

**Files:** `server/src/services/companies.ts` (~`:135-157`), `server/src/services/marketplace-install/orchestrator.ts` (`:243`), `server/src/services/marketplace-install/team-installer.ts`, catalog fetch + snapshot fallback.

### Pre-decided before implementation (2026-07-24) — do NOT relitigate mid-task

> **Execution notes (2026-07-24) — what differed from this plan.**
>
> 1. **The pre-install gate was KEPT, not removed** (Step 5). After T2.2 it is
>    `isCrewMarketplaceManaged`, and it is what pins the read-before-write
>    ordering that `aoa-bootstrap-wiring.test.ts` (`stampsOriginOnSeed`)
>    guards; it also short-circuits a concurrent create that already installed
>    the crew. One indexed query. See Decision #112 point 8.
> 2. **Step 3 as written is not achievable, and the plan's framing of it is
>    wrong in a second way.** The bundled snapshot carries only the catalog
>    **index**. `installTeam` fetches `team.json` + every `agent.json` over the
>    network, and published skills have `content.inline === null` so their
>    bodies are fetched too. So "creation never depends on the network" is
>    FALSE: a genuinely offline instance resolves a catalog from the snapshot
>    and then fails the install, degrading to legacy. The offline test proves
>    what is actually true — *CDN* down + snapshot present + resource fetches
>    stubbed → marketplace roster. Recorded as a known limitation on Decision
>    #112.
> 3. **`ensureAllCrewAgents` did not need deleting** — T2.2 had already
>    deleted it. The degrade calls `ensureCrewAgents`, as specified.
> 4. Hazards 2, 3 and 4 were all re-verified and all hold: no
>    `ensure-reviewer.ts` exists (9 required agents vs 8 legacy seeders);
>    `ui/src/aoa-marketplace-snapshot.json` is gitignored at `.gitignore:60`;
>    the boot sync is unawaited at `aoa-marketplace.ts` `startSyncLoop`.
> 5. Bonus finding: `loadCachedCatalog`'s docblock claimed it was "used by the
>    company bootstrap path (companies.ts)". It had **zero** production
>    callers. Corrected.


A reviewer flagged that T2.3 hits a hard throw at `orchestrator.ts:243`
(`"Team install requires targetDepartmentId"`), and that the choice was
"bypass the orchestrator (losing the operation store + rollback) vs. revisit
the throw". **Decision: go through the orchestrator and relax the throw.**
Verified before deciding:

1. **The user-facing guard is at the route, not the orchestrator.**
   `routes/marketplace-installs.ts:338` returns 400 for an agent/team install
   with no `targetDepartmentId`, and it fires **before** `startInstallOperation`.
   So relaxing the orchestrator throw loosens **no HTTP path** — it is a
   redundant backstop for traffic the route already rejected. Leave the route
   400 exactly as it is; T2.1 deliberately preserved it.
2. **Bypassing would fork the install path.** The orchestrator owns the
   `marketplace_install_operations` record, `cascadeResults`, and
   `idempotencyKey` dedupe — all of which **T2.7 (diff/merge) and T2.8
   (re-materialization) build on**. A second, divergent bootstrap path is the
   exact trap class this project keeps paying for.
3. **Relax it to team-only null tolerance**, citing D21 / Decision #111
   (null parent = company-wide). The agent branch never passes
   `targetDepartmentId` to `installAgent` at all, so nothing else moves.
4. **`requestedByUserId` needs no schema change.** The column is nullable
   (`marketplace_install_operations.ts:47`) though `StartInstallOpts` types it
   `string`; company create has the founding user's id, so pass it.
5. **Use a deterministic `idempotencyKey`** (e.g. `bootstrap-crew:<companyId>`).
   `startInstallOperation:76-79` returns the existing operation on a key hit,
   which makes a retried or concurrent create incapable of double-installing
   the crew. Do not skip this — company create already retries on issue-prefix
   collision.

- [x] **Step 1: Read the existing pre-install gate** (`companies.ts:135-147`) and understand why it can never fire (it checks for a non-`@legacy` agent *before* any install could have run). Note T2.2 has since hoisted `ensureInternalAgentConfig` out of that block — do not push it back in.
- [x] **Step 2: Failing integration test (L4, real DB)** — a newly created company has the marketplace crew: real `agent:aoa-curated/…` `templateOrigin` (**not** `@legacy`), non-null `templateVersion`, and populated `skillKeys`. Model on `server/src/__tests__/*.integration.test.ts`; Windows-runnable (`initdbFlags: ["--encoding=UTF8","--locale=C"]`, honour `AOA_RUN_WIN_INTEGRATION=1`). **It must actually run — say so plainly if it skips.**
- [x] **Step 3: Failing test — offline path.** With the network stubbed out, the **bundled snapshot** produces the same roster (D11). This is the discriminator that proves creation never depends on the network.

  > **⚠️ This step as originally written is UNSOUND — read before writing it.**
  > Verified 2026-07-24:
  > **`ui/src/aoa-marketplace-snapshot.json` is gitignored** (`.gitignore:60`).
  > It is fetched at build time by `pnpm fetch-catalog`; it is NOT in the repo.
  > So this test would pass on a dev machine that happens to have run
  > `fetch-catalog` and prove **nothing** in CI or a fresh clone, where
  > `bundledSnapshotProvider` (`app.ts:468-486`) catches the failed import and
  > returns `null` — i.e. no fallback at all.
  > **The test must inject a snapshot fixture** (or stub
  > `bundledSnapshotProvider`) rather than depend on the file existing. If you
  > write a test whose outcome depends on whether `fetch-catalog` has been run,
  > you have written a test that lies.

- [x] **Step 3b: Failing test — the cold-cache race.** This is the failure mode most likely to ship silently, and nothing in the plan covered it.
  **The problem:** the bundled snapshot only reaches the cache *inside*
  `syncCatalog`'s catch, and only when the cache is empty
  (`aoa-marketplace.ts:119-131`). The boot sync is **fire-and-forget** —
  `startSyncLoop()` calls `void this.sync()` unawaited (`:78-88`). So on a
  fresh instance a company created in the first seconds after boot can find
  `loadCachedCatalog` still `null`, degrade to the legacy seeders, and be
  provisioned with the `@legacy` roster — **precisely the state Phase 2 exists
  to eliminate**, arrived at non-deterministically and invisible afterwards.
  **Required:** company create must not depend on the background loop winning a
  race. Await catalog availability at the create path with a bounded timeout
  (falling back to snapshot, then to legacy), and test that a create with an
  empty cache and a not-yet-completed sync still produces the marketplace
  roster. Assert on the resulting `templateOrigin`, not on whether a call was
  made.
- [x] **Step 4: Run → FAIL.**
- [x] **Step 5: Implement.** Call `installTeam("team:aoa-curated/default-crew")` from company create with `targetDepartmentId: null` (T2.1), live catalog → snapshot fallback. **Never block or fail company creation on install failure** — degrade to the legacy seeders and log loudly, so a marketplace outage cannot break onboarding. Remove the now-unreachable pre-install gate.

  **Two constraints on the fallback, found during T2.2 review — do not rediscover:**
  1. **Call `ensureCrewAgents`, NOT `ensureAllCrewAgents`.** After T2.2,
     `ensureInfrastructureAgents` has *already run* at `companies.ts:139`
     before the gate. The union would redundantly re-run Commander + Steward
     (idempotent, but wrong intent). `ensureAllCrewAgents` currently has zero
     production callers and exists only for this decision — if you pick
     `ensureCrewAgents`, say so and consider deleting the union.
  2. **The legacy fallback under-provisions, silently.** The legacy seeders
     cover 8 roles; `team:aoa-curated/default-crew`'s `requires[]` names **9**,
     including `agent:aoa-curated/aoa-reviewer` — and **no `ensure-reviewer.ts`
     exists anywhere in the tree** (verified). So a company created during a
     marketplace outage gets a roster permanently missing Reviewer, with
     nothing distinguishing it from a complete one. "Log loudly" must therefore
     name *which* roles the fallback could not provide — a generic "install
     failed, using legacy seeders" is not sufficient to diagnose this later.
- [x] **Step 6: Run → PASS.** Verify the legacy path still works as the fallback.
- [x] **Step 7: Verify + commit.**
```bash
git commit -m "feat(marketplace): install the default crew from the marketplace at company creation"
```

---

## T2.3b — Make crew provisioning repairable (the one-way door) — ✅ SHIPPED 2026-07-24

> **Execution notes — one plan instruction was overturned, deliberately.**
>
> 1. **"Reuse `provisionCompanyCrew`" is right for ONE of the three degraded
>    states and wrong for the most important one.** For a `@legacy`/NULL-origin
>    company, `installTeam` inserts a fresh row per roster entry and
>    `resolveAgentNameConflict` renames each collision — so re-running the
>    provisioner mints `Scout-2` / `Reviewer-2` / `default-crew-2`, all carrying
>    the same `templateOrigin`, and leaves the ORIGINAL rows (the ones tasks and
>    runs point at) still `@legacy` and still frozen out. It repairs nothing.
>    Deleting the legacy rows instead is worse — they own work by id.
>    So the `unmanaged` state is repaired by **adoption**: re-point each existing
>    row at its catalog template in place via `applyCrewAgentUpdate` (which gained
>    an optional `setTemplateOrigin` so origin + version + content land in one
>    transaction). Agent ids, names, titles, roles and adapters survive.
>    Adoption claims exactly the rows a fresh install would have collided with,
>    which is why it cannot duplicate them. `provisionCompanyCrew` IS reused
>    verbatim — for the `crewless` state, where nothing can collide.
>    This is proven by a permanent ABLATION test.
> 2. **Diagnosis-before-action is the whole safety property.** `repairCompanyCrew`
>    always classifies first (`healthy` / `operation-row-stale` / `crewless` /
>    `unmanaged`); the classification is the only thing standing between repair
>    and a duplicate roster.
> 3. **Step 4 was already done** — `claimOperationForDispatch` (T2.3 fix round)
>    already claims `pending`/`failure`/stale-`running`. Confirmed, built on.
> 4. **The plan's Step 4b case 2 needed narrowing.** "Operation row is not
>    `success`" is NOT the same as "stale": a FRESH `running` row belongs to a
>    live install. Repair seals only rows that `claimOperationForDispatch` would
>    actually claim (`failure`, `pending`, `running` older than
>    `OPERATION_CLAIM_STALE_AFTER_MS`) and never `requested`.
> 5. Repair also writes the `teams` row + `team_members` links an install would
>    have written, which is exactly what the already-wired `reconcileTeamMembers`
>    needs to install roster members with no legacy counterpart (Reviewer).

### Post-review revision (2026-07-24) — adoption is POINTER-ONLY

Two review blockers changed the design after the first build. Both are recorded
because the rejected shape is the one a future reader will reach for first.

**1. Repair must not touch agent CONTENT.** The first build adopted a legacy row
by calling `applyCrewAgentUpdate`. That runs
`materializeManagedBundle(..., { replaceExisting: true })`, whose first act is
`fs.rm(root, { recursive: true, force: true })` on the directory holding the
founder's instruction edits — **outside the transaction**, and **without reading
`agentUpdatePolicy`** (default `notify`). Proven by ablation: forcing the
transaction to fail leaves the DB row legacy and the founder's file *gone*.

Adoption now rewrites exactly two columns — `templateOrigin` and
`templateVersion` (`ADOPTED_TEMPLATE_VERSION = "0.0.0-legacy"`, a sentinel that
can never equal a published version, so the row never claims content it has not
seen). Instructions, `skillKeys`, `runtimeConfig`, triggers and adapter are left
exactly as the founder has them. That is enough to un-freeze the company;
`checkCrewUpdates` then routes the content change through the company's own
policy — auto-apply, or a founder-visible pending update. Repair also fires a
`marketplace.crew_repaired` notification.

*Known consequence:* on the default `notify` policy the founder gets a pending
**agent** update, and the agent diff/merge path is not built until **T2.7**
(`/updates/:id/diff` 400s on non-skill today). That gap is visible and temporary,
and is not new — it already applies to every marketplace-managed company on
`notify`. It is strictly better than the alternative, which was silent
destruction.

**2. Adoption is ALL-OR-NOTHING, in one transaction.** A partial adoption plus a
team row is the worst reachable state: `reconcileTeamMembers` cannot distinguish
"no local counterpart" (Reviewer, intended) from "adoption failed here", so it
installs a renamed duplicate — after which the original row is unreachable
*forever*, because the next repair sees the origin already present and skips it.
A single transient 503 was enough to reach it. If any roster member that has a
local row cannot be adopted, repair now writes nothing. `reconcileTeamMembers`
additionally refuses to install a roster member whose name is already held by an
unmanaged `kind='aoa'` row (which also closes the legacy-Steward/Chronicler
duplicate that T2.4 would otherwise hit).

**3. Adoption installs the roster's `company_skills`.** `installTeam` writes one
row per required skill; adoption did not, so a repaired crew advertised skill
keys `handleUseSkill` could not resolve — and the Reviewer that reconcile
installs next inherited the same dangling keys.

**4. Classification is roster-driven, not name-list-driven.** The hardcoded
infrastructure name set is gone. Diagnosis is `healthy` /
`operation-row-stale` / `degraded`; the crewless-vs-unmanaged split is made
against `team.json` inside repair, where the roster is authoritative. This is
what makes the T2.4 Steward move safe: a legacy Steward will name-match its
roster entry and be adopted rather than duplicated.

**5. Smaller corrections.** The cooldown moved *into* `repairCompanyCrew` so the
route is gated too (with an explicit `force` override); a fail-closed skip no
longer consumes pass budget (five unrepairable companies were starving the
sixth forever); pass counters split into
`skippedFailClosed`/`skippedCooldown`/`skippedOverBudget`; the pass gates on the
crew **team item** being present rather than on "a catalog exists"; repair stands
aside while a bootstrap install is genuinely in flight; and the whole repair runs
in one transaction behind `pg_advisory_xact_lock(companyId)` with an
in-transaction re-read.

> **Why a lock and not a unique index on `teams (companyId, templateOrigin)`.**
> The index was the other option offered. It would change `installTeam`'s
> semantics for *every* caller — a founder installing the same team twice into
> one company would hard-fail instead of getting a suffixed slug — which is a
> product decision beyond this task. The lock plus sealing the operation row
> inside the same transaction (on its unique idempotency key) excludes both a
> concurrent repair and a concurrent bootstrap. Filed as a follow-up.

### Second review round (2026-07-24) — the rename hazard, and the real skill installer

**F1 was a regression I introduced.** Removing `INFRASTRUCTURE_AGENT_NAMES` to
fix B4 also removed the signal a refusal depended on, and the refusal went with
it instead of being re-expressed. `PATCH /agents/:id` lets a founder rename a
crew agent without touching `templateOrigin`, so a name-only match read a
renamed crew as *crewless* and installed a second parallel crew beside the rows
that own every task, run and assignment — permanently, because the company then
reads `healthy`. Reproduced by ablation.

Fixed by matching the roster to local rows on **name OR legacy-origin slug**.
`backfillCrewTemplateOrigin` writes `aoa-curated/standard-crew/<slug>@legacy`
once at boot and nothing rewrites it, so the slug survives every rename and is
the join key that actually holds. A renamed crew is now *adopted in place*,
keeping the founder's names. The same matching closes **F2** (partial rename),
and `reconcileTeamMembers`'s guard matches on slug too.

The refusal is back as `unaccounted-crew-rows`, but stated precisely, because
"any leftover row" would break the legitimate crewless path (a real crewless
company has Commander stamped `…/commander@legacy`):
- **infrastructure** → accounted;
- **a `…@legacy` origin naming a role the roster does NOT carry** (a retired
  Dispatcher) → accounted; the backfill stamped that slug from the name, so the
  row provably is not a renamed roster member and cannot be duplicated;
- **a NULL-origin row with a non-roster name** → ambiguous (it may be a roster
  member renamed *before* the backfill could stamp it) → **refuse**. Known false
  positive: a company with a retired `Scribe` row and no crew at all is refused
  rather than provisioned. Rare, named in the log, and a short human decision
  beats a silent second crew.

**F3 — skills now go through the real `installSkill`.** The hand-rolled insert
dropped the bundle, hardcoded `trustLevel`/`fileInventory`, and — because it
stamped `sourceRef` to the current version — made `installSkill`'s idempotency
guard answer `alreadyInstalled` for that key **forever**, so the bundle would
never be materialized for that company. Both halves ablation-proved (`PROBE
alreadyInstalled = true`). All 17 skills the live crew team requires carry a
bundle. Skills are installed **outside** the transaction, deliberately:
`installSkill` git-clones each bundle, and holding a transaction plus an
advisory lock across 17 clones is not acceptable. That is safe in a way the
agent writes are not — additive, idempotent, version-scoped new-file writes,
never a delete of founder data — so a later transaction failure simply leaves
rows the next attempt re-uses.

> **Follow-up filed: `installTeam` has the identical defect.** — ✅ CLOSED by
> T2.3c (2026-07-24). `team-installer.ts` phase 3 did its own hand-rolled
> `company_skills` insert with `trustLevel: "markdown_only"` and
> `fileInventory: []`, so every freshly-bootstrapped company got the same
> bundle-less, poisoned rows and a *repaired* company ended up with strictly
> better skill rows than a newly created one.

**Also:** bounded concurrency for skill installs (F4 — sequential would have
blown the deadline and then not retried for a full cooldown); the advisory-lock
comment now states its true scope, naming the two gaps it does not cover (F5);
`team-reconcile.test.ts`'s positional mock replaced with keyed dispatch, which
had been silently answering the new query with the wrong fixture so the guard
never executed (F6); the team row keeps the published version with the
`TeamManifestSchema` `^\d+\.\d+\.\d+$` constraint recorded (F7);
`action: "none"` no longer counts as repaired or charges budget (F8); the route
docblock corrected and `force` given a 60s floor (F9); `resolver.ts` gives an
adopted row its own copy instead of a generic version-mismatch (F10).

### Step 5 — the trigger: BOTH, boot-time reconcile primary

**Chosen:** a boot/interval reconcile pass (`runCrewRepairPass`, called from
`runCrewUpdateCheck` in `server/src/index.ts`) **plus** an authenticated
founder-only route (`POST /api/companies/:cid/marketplace/crew/repair`).

**Argument.** The companies that need repair are by construction the ones whose
founder has no idea anything is wrong — the crew looks present and simply never
receives an update. A button only helps someone who already knows to press it,
so route-only would leave the majority permanently frozen. The reconcile is
affordable because it rides the pass that already exists: it reuses the catalog
`runCrewUpdateCheck` just loaded (zero extra catalog fetches), costs one indexed
diagnosis and nothing else for a healthy company, and is self-terminating (a
repaired company is permanently healthy, so the backlog only shrinks).

Guards, all required before this was acceptable:
- **No catalog → no pass.** `runCrewUpdateCheck` already returns early on an
  empty cache, so a genuinely offline instance does zero repair work and retries
  nothing. That is the "must not re-run every boot with no network" requirement.
- **`CREW_REPAIR_MAX_PER_PASS = 5`** — a many-company instance cannot turn a boot
  into a CDN stampede; the remainder are taken by later passes.
- **`CREW_REPAIR_COOLDOWN_MS = 6h`**, process-local and honestly documented as
  such. It guards tight re-entry (route in a loop, interval landing next to a
  boot), not a crash-looping process; the per-pass cap bounds that, and a failed
  repair writes nothing (adoption fetches before it writes, per agent).
- **Fail closed.** If no crew row maps onto the roster, repair installs nothing
  and logs why. A visible unrepaired company beats two parallel crews.

The route is kept because it is attributable, immediate, and returns the
diagnosis — so "is this company frozen out of crew updates?" is answerable
without DB access.

**Added 2026-07-24 during T2.3 review. This is not optional polish — without it
T2.3's core property is one network call wide.**

**Why:** `provisionCompanyCrew` has exactly **one** production caller — company
create (`companies.ts:190`) — and `crew-updater.ts:151` skips `@legacy` and
null-origin rows forever. So **any** degrade at the single instant of company
creation (CDN blip, cold cache + no snapshot, catalog timeout, aggregate
install deadline, process restart mid-install) permanently excludes that
company from every future crew update, with no recovery short of manual DB
surgery. The entire point of Phase 2 is that companies are born updateable;
today that property depends on one network call at one moment, with no retry.

This also makes the T2.3 degrade path *safe to choose*: bounded deadlines and
fail-open behaviour are only acceptable if the resulting state is recoverable.

- [x] **Step 1: Failing test** — a company whose crew is `@legacy`/unmanaged can
  be re-provisioned into a marketplace-managed crew, and afterwards
  `crew-updater` no longer skips it. **Discriminator:** assert the *origins
  change* (`@legacy`/null → `agent:aoa-curated/…`) and that a subsequent update
  check now considers the company — not merely that a route returned 200.
- [x] **Step 2: Failing test — repair must be safe to re-run** on an
  already-marketplace-managed company (no duplicate agents, no second team, no
  clobbering of founder customizations). Re-running repair is the single most
  likely operator action.
- [x] **Step 3: Run → FAIL.**
- [x] **Step 4: Implement.** Reuse `provisionCompanyCrew`. **Note the review
  finding this depends on:** `crew-bootstrap.ts:134-140` currently treats *any*
  non-`pending` operation as "someone else owns this install", including
  `failure` — so a previously-failed bootstrap would make repair a no-op and
  leave the company crewless. Narrow that guard to `pending | running | success`
  **before** wiring repair, or the repair path is dead on arrival for exactly
  the companies that need it most.
- [x] **Step 4b: Cover the two residual states T2.3 deliberately left visible.**
  Both are known, both are the *right* trade (a visible gap beats an
  unrepairable clobber), and both are only acceptable because this task exists:
  1. **`unknown` witness → crewless.** `inspectCrewTeamInstall` fails closed on
     a DB error, so a blip at exactly that moment yields a company with only
     Commander + Steward and an ERROR log as the sole signal. **Detection case:
     "has infrastructure agents but neither a crew team nor legacy crew rows."**
  2. **Unrepaired operation row.** The averted-clobber path repairs the lying
     `failure` row to `success`, but that write uses the same connection that
     just failed. If the DB is what's broken, the repair fails too and the row
     stays claimable (`operationRepaired: false`, logged ERROR). Repair will
     then find a legitimately claimable `failure` row — correct, just noisier.
     Do not "fix" this by retrying inside T2.3; retry belongs here.
- [x] **Step 5: Decide and record the trigger.** Options: an authenticated
  founder/admin route, a boot-time reconcile for degraded companies, or both.
  Boot-time reconcile is the one that fixes companies whose founder will never
  know to click anything — prefer it, but it must be rate-limited and must not
  re-run on every boot for a company that legitimately has no network.
- [x] **Step 6: Run → PASS. Verify + commit.**
```bash
git commit -m "feat(marketplace): make crew provisioning repairable after a degraded bootstrap"
```

---

## T2.3c — Install team skills through the real installer (found via T2.3b) — ✅ SHIPPED 2026-07-24

> **Execution notes.**
>
> 1. **Seam chosen: a new phase 3, outside the transaction — the same seam
>    T2.3b settled on**, for the same reasons plus one this path adds:
>    `uninstallTeam` already leaves `company_skills` in place ("they may be
>    shared with other agents"), and the orchestrator discards `cascadeResults`
>    entirely on a failed team install (`orchestrator.ts:359` keeps them only for
>    `PackageInstallError`), so **nothing** depended on skill rows rolling back
>    with the team. The phases renumbered: 1 pre-flight, 2 plugins, **3 skills**,
>    4 team-body txn.
> 2. **An already-present key is SKIPPED, not upgraded.** `installSkill` THROWS
>    on a version mismatch ("use the update flow"), so routing blindly through it
>    would make a founder's team install fail because one required skill is pinned
>    at an older version — a new failure mode the `onConflictDoNothing` it
>    replaces did not have. A pre-filter on `key` (exactly `installMissingRosterSkills`'s
>    shape) preserves the old semantics and keeps the throw out of the team path.
> 3. **The phase-1e skill-body pre-fetch was DELETED, not kept.**
>    `installSkill` loads inline content / fetches `resourceUrl` / materializes
>    the bundle itself, so keeping 1e meant a second, discarded round-trip per
>    skill — 17 of them on the crew bootstrap, every one of which is thrown away
>    because a bundle carries its own SKILL.md.
> 4. **One thing the plan did not name: this puts N `git clone`s on the
>    synchronous company-create POST**, and `CREW_INSTALL_DEADLINE_MS` was sized
>    against "27 CDN fetches" — a claim T2.3c would have silently falsified. The
>    caller's `signal` is now threaded `installTeam → installSkill →
>    materializeSkillBundle → execFile`, so the deadline actually kills a stalled
>    clone, and is re-checked before each skill install. Both docblocks were
>    rewritten to state what it does and does not bound.
> 5. **Correction to a T2.3b docblock:** it claimed `installSkill` "owns its own
>    per-item fetch and git-clone timeouts". The fetch half was true; the clone
>    half was not — `execFile` had no timeout and no signal. Stated honestly now.
>
> **Review round 2 (CHANGES REQUESTED → addressed).** The reviewer was right on
> both blockers, and the measurement they demanded overturned my own estimate.
>
> 6. **`git clone --no-checkout` is NOT shallow** — it skips the working tree but
>    downloads the whole object database. My "lands in a few seconds" was
>    derived from that false premise. **Measured**, 17 real bundles at
>    concurrency 6 against live GitHub, two runs each:
>
>    | fetch strategy | no cache | cache |
>    |---|---|---|
>    | `clone --no-checkout` | 67.5s / 69.3s | 18.2s / 23.9s |
>    | depth-1 fetch of the pinned sha | 16.1s / 12.9s | **5.6s / 5.2s** |
>
>    At 68s the shipped commit blew `CREW_INSTALL_DEADLINE_MS` (30s) by >2×, so
>    **every live company create would have degraded to legacy**. Both fixes
>    taken: a per-install `BundleCheckoutCache` (17 fetches → 4, the roster draws
>    on only 4 repos) and the optional depth-1 fetch, which the numbers made
>    non-optional. Net 12×.
> 7. **The per-item abort comment was false and its test passed for the wrong
>    reason** — a pre-aborted signal is caught at phase 1c, whose message also
>    matches a loose `/deadline/i`, so both phase-3 checks could be deleted with
>    the test still green. Replaced with two tests that abort *after* pre-flight
>    and assert the phase-3 messages exactly; ablation-verified (both fail with
>    the checks removed).
> 8. **C5 — orphaned bundle-less rows: ACCEPTED as "heals on next version
>    bump".** Agreed with the reviewer. No path repairs them (every installer
>    matches on key and skips), but T2.3 is not on `main`, so the cohort is local
>    dev instances only; `skill-auto-updater` re-materializes on the next version
>    bump of each skill for `customized = false` rows. A backfill for a
>    local-only cohort is not worth its own failure modes.
>
> **⚠️ NEW BLOCKER found while measuring — filed, NOT fixed here.**
> Against the **live** catalog the crew install fails in pre-flight for every
> company: all 9 published crew agents declare `aoa.triggers[].enabled`, and
> `agent-runtime.ts:87-92` types `triggers[]` as `.strict()` with only
> `kind` + `config`, so `parseMarketplaceAgentTemplate` rejects them
> (`unrecognized_keys: ['enabled']`) and company create degrades to the legacy
> `@legacy` roster. **T2.3's core property does not hold in production today.**
> No test caught it because every fixture catalog in the repo hand-writes
> triggers without `enabled`. Not fixed in T2.3c because it is a real semantic
> decision, not a rubber stamp: `normalizeMarketplaceAgentTemplate` (`:306`)
> does not read `enabled`, so merely relaxing the schema would install a
> trigger the catalog marked disabled as **enabled**. Needs its own task — and
> a fixture that mirrors a real published `agent.json`.

**Why:** `team-installer.ts:243-269` (phase 3 of `installTeam`) hand-rolls the
`company_skills` insert instead of calling `installSkill`. It hardcodes
`trustLevel: "markdown_only"`, `fileInventory: []`, no `catalogSkillBundle` /
`catalogBundleInstallPath` metadata, and takes markdown from the fetched body
rather than the bundle's. **All 17 skills the default crew requires carry
`skill.bundle` in the live catalog**, so every company created by T2.3 gets 17
bundle-less rows — and because `sourceRef` is stamped to the current version,
`installSkill`'s idempotency guard (`skill-installer.ts:67-70`) later returns
`alreadyInstalled: true`, so **the bundle is never materialized. Permanently.**

T2.3b fixed this for the *repair* path. Left alone, a **repaired** company would
have strictly better skill rows than a **newly created** one — and the phase's
own goal is "each agent arrives with its declared skills". A bundle-less skill
is not the declared skill.

**Scope note:** this changes every founder-initiated team install, not just the
bootstrap. That is a *fix* for those callers too — they are getting the same
poisoned rows today.

**Files:** `server/src/services/marketplace-install/team-installer.ts`, its tests.

- [x] **Step 1: Failing test** — after `installTeam`, a bundle-carrying skill has
  real bundle metadata and a non-empty `fileInventory`, and a subsequent
  `installSkill` for the same key does **not** report `alreadyInstalled` against
  a bundle that was never materialized. **Discriminator:** assert *field parity*
  against a row the real `installSkill` wrote — the check a re-implementation
  cannot pass. (T2.3b used exactly this; reuse the approach.)
- [x] **Step 2: Run → FAIL. Step 3: Route the insert through `installSkill`.**
  Mind the transaction: `installSkill` git-clones bundles, and T2.3b concluded
  17 clones inside a transaction holding an advisory lock is unacceptable —
  match whatever seam T2.3b settled on, and say which you chose.
- [x] **Step 4: Run → PASS. Step 5: Verify + commit.**
```bash
git commit -m "fix(marketplace): install team skills through the real installer (bundles + trust level)"
```

---

## T2.3d — Accept and honour `triggers[].enabled` (T2.3 DOES NOT WORK IN PRODUCTION)

> **🔴 This is a live blocker on the phase's own deliverable. Do it before T2.5/T2.4 —
> the exit criteria cannot pass until it lands.**

**Why:** every published crew agent declares `aoa.triggers[].enabled`, but
`marketplace-install/agent-runtime.ts:87-92` types triggers as `.strict()` with
only `kind` + `config`. So pre-flight validation fails:

```
crew provisioning DEGRADED to the legacy seeders (install failed:
  code: "unrecognized_keys", keys: ["enabled"], path: ["aoa","triggers",0])
```

**Every live company create fails and lands on the `@legacy` roster** — the exact
state this phase exists to eliminate. Independently verified 2026-07-24 by
fetching all 11 published `aoa-curated` agent bodies from
`raw.githubusercontent.com`: **9/9 agents that declare triggers declare
`enabled`** (adjutant, chronicler, engineer ×2, librarian, memory-keeper,
navigator, planner, reviewer, scout). The two with zero triggers are unaffected.

**Why no test caught it:** every fixture catalog in the repo hand-writes triggers
without `enabled`, and the catalog *index* (the bundled snapshot) carries no
trigger data at all — triggers live in the separately-fetched `agent.json`. The
fixtures were not wrong about the schema; they were wrong about the **catalog**.
This is a fixture-fidelity failure, and it is the third defect this phase caused
by a fixture diverging from production.

**Do NOT just relax the schema.** `normalizeMarketplaceAgentTemplate:306` maps
only `kind`/`config`, and `agent-create.ts:105` hardcodes `enabled: true` — so a
bare schema relaxation would install a trigger the catalog marked **disabled**
as **enabled**. The DB already supports the value: `aoa_agent_triggers.enabled`
is `notNull().default(true)`.

**Files:** `server/src/services/marketplace-install/agent-runtime.ts` (`:87`
schema, `:306` normalizer), `agent-create.ts` (`:105` insert),
`crew-updater.ts` (`:111` trigger re-insert), fixtures.

- [x] **Step 1: Failing test against a PRODUCTION-SHAPED fixture.** Copy a real
  published `agent.json` body (triggers carrying `enabled`) rather than
  hand-writing one. It must fail today with `unrecognized_keys: ["enabled"]`.
- [x] **Step 2: Failing test — `enabled: false` is HONOURED.** The discriminator:
  a catalog trigger marked disabled must produce `aoa_agent_triggers.enabled =
  false`, not `true`. A test that only asserts "install succeeds" would pass a
  bare schema relaxation and miss the semantic bug entirely.
- [x] **Step 3: Run → FAIL.**
- [x] **Step 4: Implement** — accept `enabled` (default `true` when absent,
  preserving today's behaviour), thread it through the normalizer, and honour it
  at BOTH insert sites (`agent-create.ts` and `crew-updater.ts`'s re-insert;
  adoption/update must not silently re-enable a disabled trigger).
- [x] **Step 5: Audit the rest of the contract the same way.** `enabled` was
  found by accident while measuring. Diff a real published `agent.json` against
  the schema field-by-field and report **every** other divergence — do not stop
  at the first. Check `team.json` too.
- [x] **Step 6: Run → PASS. Verify + commit.**
```bash
git commit -m "fix(marketplace): accept and honour triggers[].enabled from the catalog"
```

### Step 5 audit result (2026-07-24) — field-by-field, all 11 published agents + `team.json`

Method: fetched every published `aoa-curated` body at the catalog's own
`commitSha` (`ad575a0a…`, live CDN `generatedAt` 2026-07-24T04:06:31Z) and ran
the REAL `parseMarketplaceAgentTemplate` + `normalizeMarketplaceAgentTemplate`
over each, then enumerated every leaf key path in the bodies and traced each to
its consumer.

**Hard rejections (schema refuses the body):** exactly one — `aoa.triggers[].enabled`,
on 9/11 agents (2 declare no triggers). Fixed here. After the fix all 11 parse.

**Open findings — NOT fixed here, they need a product decision. F1 is a live blocker
on the phase's exit criterion, on a par with `enabled`:**

- **F1 — a marketplace-installed crew is INERT (`status: "paused"`).** The 9 crew
  bodies declare no `aoa.install` block, so `normalizeStatus(undefined, false)`
  (`agent-runtime.ts:193-197`) returns `"paused"` and `agent-create.ts` writes it.
  The legacy seeder writes `"idle"` (`seed-crew-agent.ts:101`). Every crew
  dispatch path excludes paused: `dispatcher.ts:594`
  (`notInArray(agents.status, ["paused","terminated"])`), `triggers.ts:74`, and
  every sweep (`sweep-adjutant.ts:69`, `sweep-chronicler.ts:61`,
  `sweep-memory-keeper.ts:61`, `sweep-steward.ts:71`). Verified empirically: all
  9 normalize to `status=paused`. Fix is either upstream (`install.defaultStatus`
  in the catalog — note `agent.v1` only permits `active|paused|terminated`, so it
  cannot express the seeder's `idle`) or server-side (crew-aware default).
- **F2 — the crew installs on the wrong adapter.** The 9 bodies declare
  `aoa.adapterType: "process"` and no `adapterConfig`, so every crew agent lands
  `adapterType="process"`, `adapterConfig={}`. The legacy seeder resolves the
  company's configured CLI via `resolveCrewAdapterForCompany`
  (`seed-crew-agent.ts:93`), and no marketplace path ever calls it —
  `resolveCrewAdapterForCompany`/`shouldRewriteCrewAdapter` are referenced only
  from the `ensure-*` seeders, which T2.2's gate suppresses for a
  marketplace-managed company.
- **F3 — `install.defaultRole: "engineering"` is not a valid AoA role.**
  `AGENT_ROLES = ["cxo","lead","general"]` (`packages/shared/src/constants.ts:68`),
  so the two published non-crew agents warn-and-fall-back to `general`. Soft
  (warn-and-continue), but the catalog author believes otherwise.
- **F4 — parsed-then-never-read agent fields:**
  `aoa.adapterCompatibility.requiresInstructionsBundle` and
  `.requiresSkillInjection` (declared by both non-crew agents) have no reader
  anywhere in `server/` or `packages/`.
- **F5 — `team.json` has NO runtime validation at all.** It is an unchecked
  `JSON.parse(...) as TeamTemplateBody` (`team-installer.ts:172-174`), so no field
  can be rejected — the empty-roster guard at `:400` is the only structural check.
  Within it: `manifest.installOrder` and `manifest.adapterCompatibility`
  (`supported`, `membersInheritWhenSingleChoice`) are stored verbatim into
  `teams.manifest` and never read (install order comes from the `agents[]` array;
  lead = first entry); `agents[].overrides` is declared in the TS interface and
  never read. No live divergence today — the published `installOrder` happens to
  match the published `agents[]` order — but the coupling is unenforced.

---

## T2.3e — The installed crew must actually RUN (status + adapter)

> **🔴 Second live blocker on the phase deliverable. Found by T2.3d's Step 5 audit.
> Even with T2.3d landed, a company that successfully installs the marketplace
> crew gets a crew that never fires and is wired to the wrong runtime.**

**F1 — the marketplace crew installs INERT.** The 9 published crew bodies declare
no `aoa.install`, so `normalizeStatus(undefined, false)` returns **`"paused"`**.
The legacy seeder writes **`"idle"`** (`seed-crew-agent.ts:103`). Every crew
execution path excludes paused — `dispatcher.ts:594`
(`notInArray(agents.status, ["paused","terminated"])`), `triggers.ts:74`, and all
four sweeps. So the install succeeds, the UI shows a crew, and **nothing ever
runs**. This is worse than degrading to legacy, because it looks correct.

**F2 — wrong adapter.** All 9 declare `aoa.adapterType: "process"` with no
`adapterConfig`. The legacy seeder resolves the company's actual CLI via
`resolveCrewAdapterForCompany` (`seed-crew-agent.ts:93`). **No marketplace path
calls it**, and T2.2's gate suppresses the `ensure-*` seeders once a company is
marketplace-managed — so nothing ever corrects it.

### Decision: fix server-side, not in the catalog (locked 2026-07-24)

The implementer correctly flagged this as a product call. Resolving it:

1. **The catalog physically cannot express the right value.** `agent.v1`'s
   `install.defaultStatus` enum is `active | paused | terminated` — there is no
   `idle`. Catalog-declared parity would require widening the schema in **both**
   repos before this blocker could be fixed at all.
2. **F2 is unknowable to the catalog by construction.** Which CLI a crew agent
   should use is *per-company runtime state* (`resolveCrewAdapterForCompany`).
   No published artifact can carry it.
3. **Precedent is already set in this plan.** T2.5's "Why" states that whether an
   agent is essential to AoA is *"an AoA fact, not catalog metadata"*. How a crew
   agent must be configured in order to run is the same kind of fact.
4. It avoids gating a live blocker behind T2.4's external-repo publish + sign-off.

So: **for `kind === "aoa"` installs, the server applies crew defaults** — status
and adapter resolved the same way the legacy seeder resolves them — overriding
catalog values that cannot express the truth. Catalog `install` hints may still
be honoured for non-crew (`kind: "org"`) agents.

**Files:** `server/src/services/marketplace-install/agent-runtime.ts`
(`normalizeStatus`, adapter normalization), `agent-create.ts`,
`team-installer.ts` (crew install path), `crew-repair.ts` (adoption must not
re-break a working crew).

- [ ] **Step 1: Failing test — a marketplace-installed crew agent is dispatchable.**
  **Discriminator:** assert the agent is actually *selected* by the real
  dispatcher/trigger query (`dispatcher.ts:594` / `triggers.ts:74`), not merely
  that `status !== "paused"`. A status-string assertion would pass a fix that
  still fails the real predicate.
- [ ] **Step 2: Failing test — the installed crew agent carries the company's
  resolved crew adapter**, matching what `resolveCrewAdapterForCompany` produces
  for that company, not `"process"`.
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** the crew-aware server-side defaults. Apply on the
  **install** path AND check the **adoption** path (`crew-repair.ts`) — adoption
  is pointer-only today, so a legacy row keeps its working `idle`/CLI values;
  make sure this change does not alter that, and that a repaired company and a
  freshly-created one converge on the same runnable state.
- [ ] **Step 5: Run → PASS.** Then re-run the T2.3d end-to-end bootstrap test and
  confirm the crew is both marketplace-managed **and** dispatchable — that
  conjunction is the phase's real exit criterion.
- [ ] **Step 6: Verify + commit.**
```bash
git commit -m "fix(marketplace): install crew agents in a runnable state (status + resolved adapter)"
```

### Deferred from the same audit (F3-F5, not blockers)

- **F3** `install.defaultRole: "engineering"` is not in `AGENT_ROLES`
  (`cxo|lead|general`) — warn-and-fall-back to `general`. Affects the two
  non-crew published agents only.
- **F4** `adapterCompatibility.requiresInstructionsBundle` / `.requiresSkillInjection`
  are parsed and have **no reader** anywhere in `server/` or `packages/`.
- **F5** `team.json` has **no runtime validation at all** — unchecked
  `JSON.parse(...) as TeamTemplateBody` (`team-installer.ts:172-174`). Within it,
  `manifest.installOrder` and `manifest.adapterCompatibility` are stored into
  `teams.manifest` and never read (order comes from `agents[]`, lead = first),
  and `agents[].overrides` is declared and never read. No live divergence today
  because the published `installOrder` happens to match `agents[]` — an
  unenforced coupling. **Note this interacts with T2.3b's F4 finding** (a
  `team.json` shipping `"agents": []` would commit a witness with zero agents).

---

## T2.5 — Protected origins (D23) — ✅ SHIPPED 2026-07-24

> Landed `970de03e9`. Decision #113. **The plan aimed the guard at the wrong
> door:** `DELETE /agents/:id` already hard-refuses every `kind='aoa'` row, so
> the per-agent refusal this section specified would have protected nothing new.
> The only unguarded path was `uninstallTeam`, which deletes members with raw SQL
> inside its own transaction where a per-agent guard is invisible. Keyed on
> identity (origin slug OR name), not origin alone — origin-only would have
> silently failed to protect Steward, the very agent named here.

**Do this BEFORE T2.4** so Steward is protected the moment it becomes marketplace-managed.

**Why:** whether an agent is essential to AoA is an **AoA fact, not catalog metadata** — so the protection lives server-side, needs no schema bump, and is enforced where it matters.

**Files:** `server/src/services/marketplace-install/team-uninstaller.ts`, the agent-uninstall path, a new shared const.

> **⚠️ Blocker found during T2.2 review (2026-07-24) — read before Step 1.**
> This task is specified as a protected-origin set **keyed on `templateOrigin`**,
> but **Steward has no `templateOrigin` and never will get one.**
> `backfill-template-origin.ts:39-49` `CREW_NAMES` lists Commander, Adjutant,
> Scout, Engineer, Navigator, Planner, Dispatcher, Memory Keeper, Librarian —
> **Steward and Chronicler are absent**, so their rows keep `templateOrigin =
> NULL` permanently. Verified directly: no seeder writes `templateOrigin`; the
> backfill is its only writer.
>
> That NULL is *load-bearing elsewhere* — it is precisely why running
> `ensureInfrastructureAgents` before the marketplace gate can't flip the gate
> to "managed" (the predicate requires `templateOrigin IS NOT NULL`). So do
> **not** casually add Steward to `CREW_NAMES`: stamping it `…@legacy` is
> harmless to the gate, but stamping it anything non-`@legacy` would make every
> company self-report as marketplace-managed and suppress the entire crew.
>
> Decide deliberately in Step 1 between: (a) key the protected set on the
> agent's **name/role** rather than origin (origin-independent, works today,
> survives T2.4 publishing Steward), or (b) add Steward + Chronicler to
> `CREW_NAMES` with an explicit `@legacy` suffix and key on origin. **(a) is
> the recommendation** — protection is an AoA fact about the agent, and this
> task's own "Why" says exactly that.

- [x] **Step 1: Failing tests** — uninstalling a **protected** origin (Commander, Steward) returns a clear refusal; uninstalling **any other** marketplace agent still succeeds (the discriminator — proves the guard isn't blanket). Include a case for a **protected agent whose `templateOrigin` is NULL** (Steward today) — a set keyed only on origin would silently fail to protect it.
- [x] **Step 2: Run → FAIL.** **Step 3: Implement** a server-side protected-origin set + refusal. **Step 4: Run → PASS.** **Step 5: Commit.**
```bash
git commit -m "feat(marketplace): refuse uninstall of protected AoA agent origins (D23)"
```

### Execution result (2026-07-24) — recommendation (a) taken, and the real hole was elsewhere

**Keyed on identity, not origin,** as the blocker note recommended:
`server/src/services/protected-agents.ts` recovers a canonical **role slug** from
*either* signal a row can carry — the `templateOrigin` (`…/commander@legacy`,
`agent:aoa-curated/aoa-steward`) **or** the `name` — and either alone is enough.
Origin covers a renamed row; name covers the NULL-origin row the backfill never
reaches. Ablated both ways: an origin-only predicate (the original spec) fails 9
of 28 tests including every Steward case; a blanket predicate fails 16.

**The gap the per-agent design would have missed entirely.**
`DELETE /agents/:id` already refuses **every** `kind='aoa'` row before the founder
gate (`agents.ts` FX-del), so Commander and Steward were never deletable there.
`uninstallTeam` deletes member agents with raw SQL and never touches that route —
it was the only unguarded path to destroying a protected agent, and it is now
where the refusal lives (`ProtectedAgentUninstallError`, raised **before** the
transaction opens; route answers 409, not the catch-all 500).

**Team uninstall DETACHES rather than refusing** (revised after review; the
first implementation refused the whole uninstall). A refusal was a dead end: the
crew team is company-wide (`crew-bootstrap.ts` passes no `targetDepartmentId`),
and `loadTeamForRosterEdit` refuses BOTH `addMember` and `removeMember` when
`parentProjectId` is null — so after T2.4 the founder could neither detach
Steward nor uninstall the team, leaving *deleting the company* as the only exit.
A department-parented team has `removeMember` as a way out; the company-wide crew
team has none. Retention is reported (`retainedAgentIds` + `retainedAgents` with
a reason each), which is the opposite of silently omitting requested members.
The per-agent `DELETE /agents/:id` still refuses with 409 — deleting one agent
has an obvious alternative (pause it), so there is no dead end there.

**Three consumers, three responses:** uninstall detaches, agent-delete refuses,
and `crew-updater.applyCrewAgentUpdate` **preserves triggers**. That last one is
functional destruction, not row destruction: the updater wipes every
`aoa_agent_triggers` row and re-inserts only the template's. Unreachable today
(Steward's origin is NULL) but reachable the instant T2.4 publishes it — and a
Steward without its `sweep`/`role:steward` trigger is permanently dead
(`sweep-steward.ts` selects on kind+enabled; `seedCrewAgent` only seeds triggers
for a NEWLY inserted row).

`crew-repair.ts`'s `INFRASTRUCTURE_*` membership is **kept local, not shared** —
the two sets are safe in opposite directions (growing the protected set adds
protection; growing crew-repair's set REMOVES `unaccounted-crew-rows` refusals
and lets repair mint a duplicate crew). `protected-agents-parity.test.ts` asserts
they are equal *and* are separate objects, so a third protected role trips a test
instead of silently changing repair. The slug *parsing* is split for the same
directional reason; the two byte-identical roster-side copies
(`crew-repair.legacySlugsForRosterEntry`, `team-reconcile.legacySlugsFor`) were
collapsed into `crewLegacySlugCandidates` since those two are on the same side.

**Not tamper-proof, and the docblock says so:** a founder who renames a
NULL-origin Steward *first* erases its last signal. That closes for Steward the
moment T2.4 publishes it. This is a guardrail against destructive operations,
not an authorization boundary. `POST /agents/:id/terminate` still gates on
`kind='aoa'` alone (terminate is reversible); a comment there names the day that
stops being enough.

---

## T2.4 — Author + publish the missing catalog content (P13b, D18, D20) — ✅ PUBLISHED + LIVE-VERIFIED 2026-07-25

> **Steward is LIVE in the catalog.** Published via a direct merge to
> `MeteoriteLabs/aoa-marketplace` `main` (the GitHub PR-create endpoint was
> down with HTTP 500 on both GraphQL and REST at publish time; `main` is
> unprotected, so a `--no-ff` merge `afb2c70` achieved the same end state, then
> the manifest fix `e806323`). The `Aggregate Catalog` workflow republished
> `catalog.json` to the CDN automatically. **Verified against the live catalog
> (`generatedAt 2026-07-24T19:52:15Z`, via the GitHub raw-media API to bypass
> Pages/raw caching):** `agent:aoa-curated/aoa-steward` v1.0.0 published, and
> `team:aoa-curated/default-crew` now lists **10** agent members with Steward
> last. `pnpm fetch-catalog` confirmed the AoA snapshot picks it up end-to-end.
>
> **Two-file catch (would have shipped a half-publish):** the team lives in
> **two** files. `content/teams/default-crew/team.json` is the *installer*
> roster (`agents[]` + `installOrder`); `content/teams/default-crew/manifest.json`
> is what the *catalog aggregator* reads to build the published team `requires`
> (`adapter.ts:193` hardcodes `manifest.json` for every type). The plan's Step 3
> named only `team.json`, so editing it alone published the Steward *agent* but
> left the *team* at 9 members. Both files must carry Steward. Caught by
> live-verifying the published team, not by trusting the merge.
>
> **Skills for Chronicler/Memory Keeper/Navigator: declared NONE (D17).**
> Examining the real agents: none carries `use_skill` in its allowlist — all
> three are closed mechanical tool-sets (Chronicler's instruction literally says
> "NEVER call any tool outside those three"). A declared skill would be inert
> without a published capability change to their allowlists. "No honest fit →
> declare none." Steward is the same shape (tight 2-tool agent) → `requires: []`.
>
> **AoA-side remainder (filed as tasks, NOT yet done):**
> - Steward **reconcile migration** — **pre-ship requirement**; the window is
>   now open because the catalog is live. Without it, a marketplace-managed
>   company with a legacy null-origin Steward gets a duplicate on next reconcile.
> - Uninstall UI must surface `retainedAgentIds` (latent until such a UI exists).
> - Step 6 **dependency-audit test** (guard, currently green).
> - Step 5 snapshot = gitignored build artifact, auto-refreshed by `prebuild`.


⚠️ **This task touches TWO EXTERNAL REPOS and publishes publicly. STOP and confirm with the product owner before opening either PR.** (Write access confirmed; PRs pre-authorised in principle — still confirm at the moment of publishing.)

**Repos:** `MeteoriteLabs/aoa-marketplace` (source: `content/agents/`, `content/teams/default-crew/`) and `MeteoriteLabs/aoa-marketplace-cdn` (published `catalog.json`).

> **⚠️ Cross-repo blast radius, found during T2.3 (2026-07-24).** After T2.3,
> **an edit in the catalog repo can silently regress provisioning in this one.**
> Two specific couplings to check in Step 6's dependency audit — not optional:
> 1. **Adding a plugin dependency to `default-crew` breaks company creation's
>    marketplace path.** The bootstrap plugin installer throws by design; the
>    team has no plugin deps today, so it is unreachable — the moment one is
>    added, the whole install fails and every new company silently degrades to
>    the legacy `@legacy` roster. Fail-closed and logged, but the *symptom*
>    appears in AoA while the *cause* is a merge in the other repo.
> 2. **Publishing Steward changes what a team uninstall returns.** T2.5 now
>    **detaches** protected agents rather than refusing (Decision #113 point 5,
>    revised) — `DELETE /marketplace/teams/:teamId` deletes the unprotected
>    members and the team row and returns Steward in `retainedAgentIds`. No 409.
>    Confirm any UI built against that route surfaces `retainedAgentIds`, or a
>    founder sees "uninstalled" and an agent that is still there.
> **✅ VERIFIED 2026-07-25 (post-publish, read-only): the duplicate risk in
> points 2–3 below is ALREADY MITIGATED — do NOT treat it as an open pre-ship
> blocker.**
> - `team-reconcile.ts:122-154` (landed in T2.3b) refuses to install a roster
>   member whose name / legacy-slug is already held by an unmanaged `kind='aoa'`
>   row, so a legacy Steward is **not** duplicated on reconcile.
> - `crew-repair.ts:457` matches a legacy Steward by name to the now-published
>   roster entry and **adopts it in place** (stamps origin + version).
> - Residual, narrow, NOT urgent: `ensureInfrastructureAgents` still force-seeds
>   Steward and `seed-crew-agent.ts:260-274` re-materializes the *legacy*
>   instruction bundle each run, overwriting the adopted marketplace instructions
>   (authored near-identical). Fix = the signposted `ensureSteward`
>   infrastructure→crew move (T2.2 `⚠️ TEMPORARY PLACEMENT`). Small, but on the
>   most-reviewed crew machinery and it changes managed-company seeding — do it
>   WITH review. Tracked as task #32.
> - The earlier "`INFRASTRUCTURE_AGENT_NAMES` must drop Steward" note was
>   over-cautious: `crew-repair.ts:758-798` documents that set as "safe stale"
>   post-T2.4 (consulted only AFTER roster matching), and Steward stays in
>   `PROTECTED_AGENT_ROLES` (still essential).
>
> 3. **Publishing Steward must be paired with reconciling the pre-existing
>    legacy Steward row**, or companies created between T2.3 and T2.4 end up
>    with **two** Steward agents (both carrying the `sweep` trigger → duplicated
>    hub curation). `team-reconcile.ts:96-107` builds `installedOrigins` from a
>    join on `teamMembers`, so a legacy Steward fails the lookup twice over —
>    it is neither a team member nor origin-stamped, making the duplicate
>    install unavoidable rather than merely likely. Chronicler has the identical
>    NULL-origin gap. See the T2.5 blocker note for why that NULL must not
>    simply be stamped non-`@legacy`.

- [ ] **Step 1: Author the Steward agent package** in `aoa-marketplace/content/agents/aoa-steward/` — `agent.json` + `AGENTS.md` + `manifest.json`, modelled on `content/agents/aoa-scout/`. Source the instruction text from `ensure-steward.ts:4` and `server/src/onboarding-assets/steward/`. Preserve the **sweep trigger** (`{kind:"sweep", config:{role:"steward"}}`) and the two-tool allowlist (`hub.readCurationContext`, `hub.updateCurationSummary`).
- [ ] **Step 2: Declare skills** for **Chronicler, Memory Keeper, Navigator** (currently zero) and Steward. Per D17 these are purpose-built per agent — draw from the 498 published skills where a genuine fit exists; **do not pad**. If a role has no honest skill fit, declare none and say so.
- [ ] **Step 3: Add Steward** to `content/teams/default-crew/team.json` `agents[]` and `manifest.installOrder`.
- [ ] **Step 4: Regenerate + publish.** Rebuild `catalog.json`, PR to `aoa-marketplace`, then publish to `aoa-marketplace-cdn`. **Confirm with the owner before each PR.**
- [ ] **Step 5: Refresh the bundled snapshot** in AoA via `pnpm fetch-catalog` so offline bootstrap matches.
- [x] **Step 6: Dependency audit as a test** — every agent's/team's declared `requires` edge resolves to a matching-type, active catalog item. SHIPPED as `server/src/__tests__/marketplace-dependency-audit.test.ts` (plain `.test.ts` → runs in the required `verify` gate + on Windows) against a committed, generated projection `__fixtures__/published-catalog/catalog-index.json`. Non-vacuity floor + negative controls guard against a "test that lies". **Refresh the fixture whenever the catalog is bumped: `pnpm fetch-catalog:audit-fixture`.** Green today (12 agents / 27 team edges / 70 total, 0 orphans).
- [ ] **Step 7: Commit** (AoA side).
```bash
git commit -m "feat(marketplace): publish Steward + declare skills for Chronicler/Memory Keeper/Navigator"
```

---

## T2.6 — Agent-instruction customization tracking (D22)

**This REVERSES a shipped design.** `crew-updater.ts:24-31` currently states *"instruction files are app code, not user config"* and full-replaces on update. D22 (product-owner decision) says agent instruction edits are treated like skills: `customized` + notify/diff/merge. **Record the reversal in `docs/architecture/decisions.md`.**

- [x] **Step 1: Failing tests** — an agent whose instructions a founder edited is **not** silently overwritten by a catalog bump; an **untouched** agent still auto-updates (the discriminator).
- [x] **Step 2: Run → FAIL.** **Step 3: Implement** — set `customized` when a founder edits a marketplace-managed agent's instructions via the editor; `crew-updater` routes customized agents to notify instead of full-replace. **Step 4: Run → PASS.**
- [x] **Step 5: Record the reversal** in `decisions.md`, superseding the `crew-updater.ts:24-31` rationale. **Step 6: Commit.**

**SHIPPED.** `agents.instructions_customized` is **three-state** (migration
`0182`): `false` = provably untouched, `true` = edited through the instructions
API, **`null` = unknown → treated as customized (fail closed)**. There is no
backfill: `agent_config_revisions` only writes a row when `changedKeys.length >
0`, and an instruction file write on an already-managed bundle leaves
`adapterConfig` byte-identical — so the edits that matter have no revision row,
and a content hash has no pre-existing baseline either. **Consequence:** every
crew agent installed before `0182` routes to notify on its next catalog bump,
including untouched ones, and `POST /updates/:id/apply` still answers 501 for
`itemType: "agent"` until T2.7. The D22 gate runs BEFORE
`materializeManagedBundle`'s `fs.rm`; a transactional
`instructions_customized = false` predicate is defence in depth for the
concurrent case. Adopted (T2.3b) rows carry `null`, so pointer-only adoption is
unchanged — D22 makes content adoption safe to build, T2.7 must build it.
```bash
git commit -m "feat(marketplace): treat agent instruction edits as customizations, not app code (D22)"
```

---

## T2.7 — Build the agent diff/merge path (P10, P11) — ✅ SHIPPED 2026-07-24

**Why:** today `/apply` returns 501 "use merge", `/merge` returns 404 "not a skill" — a closed loop. The Review button leads nowhere. D22 makes this load-bearing.

- [x] **Step 1: Failing tests** — an agent update with a customized local copy produces a **section-level diff**, accepts keep-mine/accept-upstream **per section**, and lands a `conflict` badge.
- [x] **Step 2: Run → FAIL.**
- [x] **Step 3: Extend** `/updates/:id/diff` and `/updates/:id/merge` to `itemType:"agent"` with section-level diffing over instruction files.
- [x] **Step 4: WRITE the `conflict` status.** It is currently **read in three places** (`marketplace-company.ts:154`, `UpdateCard.tsx:37`, `MarketplaceUpdatesPanel.tsx:40`) and **written nowhere** — dead enum, dead badge. Make divergence surface *before* the founder opens Review.
- [x] **Step 5: Run → PASS.** **Step 6: Commit.**
```bash
git commit -m "feat(marketplace): agent diff/merge with section-level review + live conflict status"
```

### Execution notes (2026-07-24) — the three delegated design calls, and one thing the plan did not name

**Files:** `server/src/services/marketplace-agent-merge.ts` (pure algebra),
`server/src/services/marketplace-install/agent-update-merge.ts` (I/O + write),
`server/src/routes/marketplace-company.ts` (three route branches),
`server/src/services/marketplace-install/crew-updater.ts` (conflict status),
`ui/src/components/marketplace/{MergeDiffPane,SnapshotUpdateModal,types}.*`.

**1. A section is `<file>::<## heading>`.** The skill differ's unit, namespaced by
file. Rejected: file granularity (an all-or-nothing choice on a 400-line
AGENTS.md) and hunk granularity (no stable identity across a rewrite, so a
founder cannot tell which of their edits a decision covers). The file prefix is
load-bearing — two bundle files may both declare `## Tone`, and without it one
decision would silently govern both. Whole-file adds/removes are *forced* to
`added`/`removed` rather than run through `computeSectionDiff("", …)`, which
would have labelled a brand-new file's preamble `changed`.

`promptTemplate` and `bootstrapPromptTemplate` are **virtual files**
(`promptTemplate.legacy.md`, `bootstrapPromptTemplate.legacy.md`) — the first of
those names is not invented here, `agent-instructions.ts` already surfaces
`promptTemplate` under exactly that path as a `virtual: true` bundle entry.
Upstream never carries them, so they appear as `removed` sections defaulting to
"mine". Excluding them was the other option and it is wrong in both directions:
drop them silently and a merge becomes the D22 harm; keep them unconditionally
and no merge could ever honestly report pure catalog content.

**2. "Accept upstream" sets the flag from the BYTES, never from the clicks.**
After a merge, `instructions_customized` is `false` iff the resulting bundle is
byte-identical to upstream (same file set, same bytes, same entry file), else
`true` — never back to `null`, because the divergence is now known rather than
unknown. This is the same statement `applyCrewAgentUpdate` already makes when it
re-asserts `false` after a full replacement.

The byte test is not cosmetic. `applyMergeDecisions` **reassembles** a document
(`sections.join("\n\n").trim() + "\n"`), so an all-"theirs" merge does not
reproduce upstream's bytes. Two verbatim shortcuts were added for exactly this:
a file whose every section resolves upstream is copied from `upstream` verbatim,
and a file whose every decision is "mine" is copied from `mine` verbatim. Without
the first, `pureUpstream` could never be true and the T2.6 backlog would be
permanent; without the second, "keep mine" would silently rewrite the founder's
blank lines — and would append a newline to the founder's `promptTemplate` on
every merge.

**Two defects the tests caught during the build, both in this area:**
- Rejoining a file from its diff sections is **not** lossless. `splitSections`
  always emits a `__preamble__` section, and for a heading-first document that
  section holds ZERO lines while its content string is `""` —
  indistinguishable from one blank line. Reconstruction therefore prepended a
  newline to every heading-first file, i.e. corrupted precisely the bytes the
  keep-mine guarantee is about. Both sides are now passed in as whole-file maps.
- `pureUpstream` was first computed as "every section decided theirs", which
  answered **false** for an agent whose bundle already equalled upstream (the
  common backlog shape, where the defaults are all "mine"). It is now a byte
  comparison of the result.

**3. The merged result is written file-by-file, never through
`materializeManagedBundle`.** `writeMergedAgentBundle` is the single named
function that touches disk; it uses the same `agentInstructionsService`
surface the founder's own editor uses (`writeFile` / `deleteFile` /
`updateBundle`) and **never** does a recursive `fs.rm` of the bundle root. When
every decision is "accept upstream" the end state is identical to what a
replace-everything materialize would have produced, reached without the hazard.
Deletions skip the entry file (`deleteFile` refuses it anyway); a skipped
deletion is reported and forces `pureUpstream` to false rather than being
papered over.

**Seam left for T2.8.** T2.8's subject is the *skill* side — `/merge` rewrites
`company_skills.markdown` and never re-materializes the checked-out bundle on
disk. Nothing in T2.7 writes skill bundles, and the agent write is isolated in
`writeMergedAgentBundle`, so T2.8 can add `materializeSkillBundle` to the skill
branch without reopening the agent path. **Do not "unify" the two by routing
the agent merge through `materializeManagedBundle`** — that reintroduces the
`fs.rm`.

**Also landed, because the plan's scope implied them:**
- **`/apply` now handles `itemType: "agent"`.** It was answering 501 for *every*
  agent update, including provably untouched ones with nothing to review.
  It delegates to `applyCrewAgentUpdate` (which owns the D22 gate) and answers
  409 `AGENT_INSTRUCTIONS_CUSTOMIZED` for `true`/`null` rows — the exact shape
  the skill path already used. 501 now means TEAM updates only.
- **Merge also moves `skillKeys`, `runtimeConfig.aoa.toolAllowlist`,
  `templateVersion` and triggers**, mirroring `applyCrewAgentUpdate`. It has to:
  stamping the new `templateVersion` without them would leave a row silently
  claiming content it does not have, and `checkCrewUpdates` would never look at
  it again. **D23 composes unchanged** — a protected AoA agent keeps its
  triggers through a reviewed merge, and there is a test for it.
- **Agent resolution fails closed on ambiguity.** `agents.template_origin` is not
  unique per company while `marketplace_pending_updates` is unique on
  (company, item), so two agents sharing an origin is a 409
  `AMBIGUOUS_AGENT_ORIGIN`, not a coin flip.
- **UI: an `Accept all upstream` / `Keep all mine` bulk control.** Not polish —
  it is the only affordance that drains a `null`-provenance agent, whose
  per-section default of "mine" would otherwise re-declare it customized on
  every review, forever.

**Is the T2.6 `null` backlog drainable end-to-end? Yes.** `checkCrewUpdates`
records those agents as `conflict` → the founder opens Review → the diff shows
either nothing (bundle already matches) or catalog-vs-catalog changes →
`Accept all upstream` → merge writes upstream verbatim and stamps
`instructions_customized = false` → the agent re-enters auto-update permanently.
Both halves are tested (`marketplace-agent-update-merge.test.ts`).

**Conflict-status semantics.** `conflict` = the local copy is (or may be)
divergent, so this cannot be taken wholesale; `pending` = held back only by
policy or the update window, one click away. Reconciliation is bidirectional but
only ever moves rows already in `pending`/`conflict` — an `applied` or
`dismissed` row is never resurrected here (that decision stays with
`upsertPendingUpdate`, which makes it only for a genuinely newer release).
`applyCrewAgentUpdate`'s "mark applied" predicate was widened to accept
`conflict` so a stale red badge cannot survive the apply that resolved it.

**Ablations run.** Removing the keep-mine branch (always take upstream) fails 11
tests, including the on-disk byte-identity assertion and the route-level one.
Hard-coding `nextStatus = "pending"` fails 3 conflict-status tests. A permanent
ABLATION test also pins the pre-T2.7 reality: landing the same founder edit
through `applyCrewAgentUpdate` leaves `AGENTS.md` byte-equal to upstream with
the founder's lines gone.

**Known gaps, stated rather than hidden.**
- The merge writes files BEFORE its transaction. A transaction failure leaves the
  merged bundle on disk with the row still on the old `templateVersion` — the
  pending update survives and the next diff shows the merged content as "mine".
  Recoverable; the reverse order is not (it would silently claim content that is
  not there).
- Two founders merging the same update concurrently: the pending row's
  `pending|conflict → applied` claim serialises the DB write, and the loser gets
  409. It cannot un-write the files the loser already put on disk.
- An upstream entry-file **rename** is handled (via `updateBundle`) only when the
  upstream entry file survives the merge; otherwise the old entry file is kept
  and `pureUpstream` is forced false.

### Review round 2 (2026-07-24) — four required findings, all taken

The reviewer's byte-fidelity sweep (21 document shapes, all 441 mine×upstream
pairs round-tripping exactly under both wholesale paths, plus a 4,000-iteration
random-decision sweep with no unsound `pureUpstream: true`) confirmed the
`__preamble__` fix and the flag's soundness direction. Four defects around it did
not hold.

**F1 — a declined upstream-only file was still created, containing `"\n"`.**
When a file exists only upstream and every section resolves to "mine",
`allTheirs` is false and the `allMine` shortcut requires a local side, so control
fell to `applyMergeDecisions`, which drops every section, joins nothing, and
returns `"".trim() + "\n"`. **Directly reachable from the `Keep all mine` bulk
control this task added.** The founder declined a file they never had and it
landed on disk, then read as their own content in every later diff. Now given its
own branch: skipped entirely, in neither `files` nor `deletedFiles` (there is
nothing on disk to delete), so `survivingUpstreamParity` still fails it and
`pureUpstream` still comes out false — same verdict, no artifact. A second test
pins the discriminator: a *partially* declined upstream file is still created.

**F2 — a trim-equal bundle could never reach `customized = false`, and the modal
said the opposite.** `identical` was derived from section *states*, and
`computeSectionDiff` classifies `unchanged` on `.trim()` — while the merge's
wholesale-upstream relaxation requires BYTE equality (deliberately). So a
trailing-whitespace-only divergence reported `identical: true`, rendered *"No
local changes found"*, and then merged to `instructions_customized = true`. Worse,
with every section `unchanged` the pane rendered no per-section buttons **and**
the bulk bar was gated on `decidable.length > 0`, so there was no control in the
UI capable of resolving it to upstream at all. A permanent freeze-out reported as
success. Both halves fixed: `identical` is now `bundlesAreByteIdentical` (file
set + contents + entry file), and the bulk bar renders on `sections.length > 0`.
Ablated: reverting either half fails its tests.

**F3 — the new agent `/apply` branch was unreachable from the UI.** `UpdateCard`
rendered "Update" only when `isPlugin`, so *"an agent with no local divergence
lands with one click"* was true server-side only. Wired rather than
de-claimed: `onApply` is now offered for any `pending` row (a `conflict` row goes
straight to Review, because its `/apply` answers 409 by design), the panel's
apply handler is generalised from `applyPluginUpdate` to `applyUpdate`, and a 409
falls through to the review modal so a status that went stale between render and
click is not a dead end. This also un-strands the **skill** `/apply`, which was
equally unreachable.

**F4 — the reconcile's stated escape hatch did not exist.** The shipped comment
scoped the reconcile to `pending`/`conflict` "because that re-opening decision
belongs to `upsertPendingUpdate`". It does not: `upsertPendingUpdate` has no
agent caller (`checkCompany` still carries `TODO: Add agent + team template
checks`), and with the unique index `onConflictDoNothing` can never re-open a
row. So dismiss was permanent **per agent** rather than per version, and an agent
that ever took an update never announced another one — the row sat `applied` with
`latestVersion` frozen, invisible to the panel, the reconcile and the insert
alike. Comment corrected AND the widening taken: `applied`/`dismissed` re-open
when `compareVersions(catalogItem.version, row.latestVersion) > 0`, mirroring
`upsertPendingUpdate`'s rule exactly. A re-opened row counts as news and fires
the notification; a same-version dismissal still holds (the discriminator).

**Lower findings.** F5: files whose merged content already equals disk are no
longer rewritten — `writeFile` round-trips through a UTF-8 decode/encode, which
churns mtime and would mangle a non-UTF-8 file in the bundle root. F6: a `TODO`
at the `applyMergeDecisions` call site naming the two inherited skill-primitive
defects (bare-`\n\n` joins damage CRLF; `splitSections` is fence-unaware, so a
`## ` inside a fenced example is independently decidable and carries the closing
fence) — they do not reach the wholesale paths, and fixing them means changing
the shipped skill merge. F7: the reconcile refreshes `currentVersion` too, so a
row whose agent advanced by another path cannot render a stale "1 → 3".

**F7's second half changed shape.** The reviewer asked for a one-line guard so a
real on-disk `promptTemplate.legacy.md` is not overwritten by the `adapterConfig`
value. Investigating it found the file is *unreadable through the service at
all*: `agentInstructionsService.readFile` short-circuits on that exact path and
returns `adapterConfig.promptTemplate` instead of the file's bytes (pre-existing,
and the same short-circuit is what makes the pseudo-file work for the editor).
Disk therefore cannot simply "win". The merge instead refuses to act on such a
path in either direction — excluded from the diff, never written, never deleted,
and the `adapterConfig` value for that key excluded too — reports it as
`shadowedPaths`, logs a warning naming the rename that would bring it under
review, and **forces `pureUpstream` false** so unaccounted local content can
never be mistaken for pure catalog content.

**End-to-end byte fidelity through the real filesystem.** The reviewer's sweep
ran at the pure-function layer. BOM, CRLF, and no-trailing-newline+tabs are now
also pushed through `writeMergedAgentBundle` against the real
`agentInstructionsService`, in both directions (kept verbatim as "mine", written
verbatim as upstream).

---

## T2.8 — Bundle re-materialization on merge (P12) — ✅ SHIPPED 2026-07-24

**Why:** merge rewrites markdown but never calls the materializer (`marketplace-company.ts` has zero materializer calls; only `skill-installer` and `skill-auto-updater` do), leaving bundled skill files stale on disk.

- [x] **Step 1: Failing test** — after a merge, bundled files on disk match the upstream commit.
- [x] **Step 2: Run → FAIL.** **Step 3: Call the materializer from the merge path.** **Step 4: Run → PASS.** **Step 5: Commit.**
```bash
git commit -m "fix(marketplace): re-materialize bundled skill files on reviewed merge"
```

### Execution notes (2026-07-24) — the premise held, plus the three delegated design calls

**Defect confirmed exactly as briefed.** `routes/marketplace-company.ts` had zero
materializer calls; the skill branch of `/merge` set
`{ markdown, sourceRef, customized, updatedAt }` and stopped. The consumer that
makes it bite is `listRuntimeSkillEntries` (`company-skills.ts:2232-2236`): it
reads `metadata.catalogBundleInstallPath` and hands those files to the agent, so
a merged skill shipped a new SKILL.md next to the OLD `scripts/`.

**Files:** `server/src/services/marketplace-install/skill-update-merge.ts` (new;
the I/O half, mirroring T2.7's `agent-update-merge.ts` split),
`server/src/routes/marketplace-company.ts` (the skill branch delegates),
`server/src/__tests__/marketplace-skill-update-merge.test.ts` (new),
`docs/api/marketplace-and-plugins.md`.

**1. Ordering: clone BEFORE the transaction**, matching `applySkillUpdate`.
Clone fails → nothing committed, the pending row stays `pending`, retryable. The
transaction fails after the clone → an unreferenced directory at the new
version; the row still points at the old files, which still match its old
markdown, and a retry re-materializes over itself (`overwrite: true`). Dead
disk, not corruption. The reverse order is the bug being fixed, now with
`sourceRef` stamped over it: disk-first fails loudly, DB-first fails silently.
T2.3c's "outside the transaction" precedent survives the merge case, for the
reason in (2).

**2. Stale files: the pointer moves, the old directory stays.**
`managedCatalogSkillDir` is **version-scoped**, so a merge writes a directory
that did not exist and deletes nothing; a file the upstream commit removed is
simply never copied, and `fileInventory` + `catalogBundleInstallPath` are
repointed in the same transaction. There is therefore no orphan in the *active*
bundle — the correctness claim. The previous version's directory is left alone,
consistently with `installSkill` / `applySkillUpdate`, and deliberately: an
`fs.rm` of a path derived from a *stale* row is Decision #115's hazard class,
and when `catalogItem.version` equals the installed version the "old" directory
IS the one just written. Reclaiming old versions is disk hygiene for a sweeper.

**3. Founder edits cannot be overwritten, structurally.** For
`sourceType = "catalog"` there is no founder write path to the bundle directory
at all: `companySkillsService.updateFile` writes to disk only for `local_path`
(`company-skills.ts:1586`), and `readFile` returns `null` for every
non-`SKILL.md` path on a catalog skill. The founder's edits live entirely in
`company_skills.markdown`, which the merge preserves — the code writes `merged`,
never `materialized.markdown`. Copying `applySkillUpdate`'s
`markdown: payload.markdown` line in here would have been the skill-side D22
harm; a dedicated test asserts a "keep mine" section survives while the bundle
still advances. This is also why the skill side may use a materializer at all
and the **agent side still must not** (Decision #115): the agent's bundle root
IS founder-editable. The two paths stay separate.

**Also recorded:**
- The bundle directory is keyed by `catalogItem.version`, not the pending row's
  `latestVersion` — the bytes come from `catalogItem.skill.bundle` and the
  catalog cache can lead the pending row. `sourceRef` still stamps
  `latestVersion` (unchanged); the pointer is self-describing, so a drift
  under-reports the version and the next checker pass converges it.
- `AbortSignal.timeout(60_000)` on the checkout. Not a perf budget — without it
  a stalled `git` pins an interactive founder request for git's own network
  timeout. No `BundleCheckoutCache`: one merge is one bundle is one repo, so it
  would hold one entry and save nothing.
- The route no longer echoes the absolute bundle path; it answers
  `{ ok, bundleMaterialized, bundleFileCount? }`. `SnapshotUpdateModal` ignores
  the body entirely, so the path was pure server-layout disclosure.
- **Ablation-verified.** With only the materializer call disabled, 5 of 8 tests
  fail on bytes: the removed `scripts/legacy.js` is still present,
  `references/guide.md` still reads `v1 guide` while the markdown advanced, and
  the route answers `bundleMaterialized: false`. The tests read the bundle
  through whatever `metadata.catalogBundleInstallPath` the row holds *after* the
  merge — modelling `listRuntimeSkillEntries` — so an unpatched pointer fails as
  "the old files are still live", not as a TypeError. The materializer is not
  mocked: a real two-commit local git repo is cloned through the real
  `materializeSkillBundle`, with only the remote redirected via the
  test-env-guarded `unsafeTestRepoUrl`.

### Review round 2 (CHANGES REQUESTED → addressed) — the fix created a CRITICAL

The reviewer was right on every item. One of them was a defect **this task
introduced**, and it inverted the decision-1 claim above.

**C1 (CRITICAL) — `/merge` had no status guard, and re-materialization made a
replay destructive.** `/apply` checks `status` (`marketplace-company.ts:272`);
`/merge` checked only `itemType`. Harmless while a merge rewrote a markdown
column — a replay wrote the same bytes. Not harmless once it wrote FILES: after
a successful merge the row's `catalogBundleInstallPath` **is** the destination
the merge recomputes, and `materializeSkillBundle` ran `prepareDestination`
(`rm -rf` under `overwrite`) **before** `prepareCheckout` — so a replay deleted
the live tree, then failed its fetch, and the bundle was gone. Silent, because
`walkLocalFiles` swallows a missing directory and `readAncillarySkillFiles`
returns `[]`. Reachable because `SnapshotUpdateModal`'s `onError` toasts and
re-enables the button **without closing**, so a commit whose response was lost
becomes a second click. Fixed with the `/apply` guard, which covers the agent
branch too.

This is where **"dead disk, not corruption" was wrong**: it holds only while the
destination differs from the row's live pointer. Decision 2 waved the
equal-version case through as "the directory is the one just written" — true
within one successful call, false across calls.

**C2 (Important) — the same root cause as a concurrency window**, and the reason
the guard alone was not enough: relying on it is exactly the "safe because the
caller always checks" reasoning standing rule 3 forbids. `materializeSkillBundle`
now builds the replacement in a **staging sibling and renames it into place**
(`stageDirectoryFor` / `swapIntoPlace`), so no caller can delete a live tree it
then fails to replace, and a concurrent reader never sees a half-copied `cp`.
Ordering is `destination→outgoing`, `staging→destination`, best-effort remove;
a failure at step 2 renames `outgoing` back. This improves `installSkill` and
`applySkillUpdate` too.

**C3 (Important) — the markdown-only branch left a stale bundle pointer.** When
an item stops carrying a bundle the merge advanced the markdown and left the row
naming the old tree forever. Now cleared, with `fileInventory` reset and
`trustLevel` back to `markdown_only` (`resolveBundleColumns`). **Correction to
the review's evidence:** the shipped snapshot has **498 skills, 0 of them
bundle-less** — the 16 bundle-less items are the 11 agents, 4 plugins and 1 team,
which never reach this path. So the gap is latent, not live; fixed anyway
because the function's contract is "the row describes what is on disk".
`skill-auto-updater.ts`'s `resolveSkillUpdatePayload` has the identical gap on
the auto-apply path and is **not** fixed here — filed as T2.8c(a).

**C4 — taken.** `sourceRef` now stamps `catalogItem.version`; both the merged
markdown and the bundle come from `catalogItem`, so it is the only stamp the
row's contents justify.

**C5 — docblock softened.** The `updateFile` gate is on the row's `sourceType`,
not on the path, and the bundle directory is not jailed: `POST /skills/import`
with `source` set to it yields a `local_path` row that `PATCH /skills/:id/files`
will then write into, and `PATCH /agents/:id/instructions-bundle` with
`mode:"external"` accepts any absolute `rootPath`. Stated honestly now; jailing
that root is filed as T2.8c(b).

**Ablations, each fix separately:**
- C1 guard removed → both replay tests fail `expected 200 to be 409` (the live
  tree survived, because C2 was in place — defence in depth confirmed).
- C2 reverted to `rm`-first → `leaves an existing destination intact when the
  fetch fails` dies with `ENOENT ... SKILL.md`. That is the reviewer's PROBE B,
  reproduced at unit level: the failed fetch deleted the live bundle.
- C3 reverted → the effective pointer still resolves to v1's tree.
- C4 reverted → `expected '2.0.0' to be '2.1.0'`.

---

## T2.7b — Fence-aware and line-ending-safe section splitting (found in T2.7 review)

**Why:** two defects live in `marketplace-merge.ts`, shared with the **already
shipped** skill merge, and T2.7 has just made them reachable on a path that
matters more:

1. **`splitSections` is fence-unaware.** A `## ` line inside a ``` fenced block
   becomes an independently-decidable section and carries the closing fence with
   it — so accepting one side and keeping the other leaves the fence
   **unbalanced**, corrupting the document. Measured in review:
   `"## Real
```md
## NotAHeading
…```
tail
"` splits into three sections.
2. **`applyMergeDecisions` joins with a bare `"

"`**, so a mixed merge of a
   CRLF document emits bare LF and trims a trailing `
` — mangled line endings
   on a Windows-first codebase.

Neither reaches the wholesale keep-all-mine / accept-all-upstream paths (those
take verbatim shortcuts, proven byte-exact over 441 document pairs + a
4,000-iteration random sweep), so this is the **mixed-decision** path only. But
that is exactly the path section-level review exists for, and **AGENTS.md
bundles routinely carry fenced examples** — far more than skill markdown did.

**Deliberately deferred out of T2.7** because the fix changes shipped skill-merge
behaviour and the fence case needs its own fixture set. Marked with a TODO at
`marketplace-agent-merge.ts:303-309` and in Decision #115's "Known gaps".

**Files:** `server/src/services/marketplace-merge.ts` (`splitSections`,
`applyMergeDecisions`), plus skill-merge tests that may encode current behaviour.

- [ ] **Step 1: Failing tests.** A fenced `## ` stays inside its parent section
  (**discriminator:** the fence must still balance after accepting one side and
  keeping the other); a CRLF document survives a *mixed* merge with CRLF intact;
  and a mixed merge of an LF document is unchanged from today (regression).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** fence-aware splitting and line-ending preservation.
  Detect the document's dominant ending and re-join with it rather than
  hardcoding `"

"`.
- [ ] **Step 4: Check the skill side.** These primitives are shared — confirm no
  shipped skill-merge test encoded the broken behaviour, and if one did, fix the
  test with a note rather than preserving the bug.
- [ ] **Step 5: Run → PASS. Verify + commit.**
```bash
git commit -m "fix(marketplace): fence-aware section splitting and line-ending-safe merge"
```

---

## T2.8b — Derive the skill `customized` flag from bytes, like the agent side

**Why:** after a reviewed **skill** merge, `customized` is set to `true`
**unconditionally**. So a founder who clicks *Accept all upstream* — landing a
row byte-identical to the catalog — is **permanently opted out of auto-update
for that skill**, with the review UI reporting success.

**Correction (T2.8 review):** my first framing of this called it the *same*
failure as the agent side and a "permanent freeze-out". That is too strong, and
the difference is the whole argument. On the agent side, `customized`
**blocked updates outright** under D22 — hence a backlog that had to be drained.
On the skill side `customized` is consulted in exactly **one** place
(`skill-auto-updater.ts:128`), and `marketplace-update-checker.ts` never reads
it at all — so pending updates keep being raised and `/merge` stays available
forever. The row forfeits the **one-click auto-apply path**, not the update
pipeline. A permanent papercut, not a freeze-out. Still worth closing (`true` is
a false statement about the bytes), but it is not urgent and it is **not a
one-liner** — see Step 4.

The shape of the fix is the same one the agent side already built. T2.7's review
found it there (a bundle that matched upstream could never reach
`customized = false`, and the modal said "no local changes found"), and
Decision #115 fixed it by deriving the flag from the **bytes**: `false` iff the
result is byte-identical to upstream, else `true`, never back to `null`. The
skill side still hard-codes `true`, so the two review paths now disagree about
what accepting upstream means.

So "conservative" is a defensible read here in a way it was not for agents —
the cost is a lost affordance, not a lost pipeline. Closing it is still right,
because `customized = true` on a byte-identical row is simply untrue and the
next reader will reason from it.

**Files:** the skill branch of `POST /updates/:id/merge`
(`server/src/routes/marketplace-company.ts`), mirroring
`agent-update-merge.ts`'s byte comparison.

- [ ] **Step 1: Failing test** — an all-"accept upstream" skill merge lands
  `customized = false` and the skill re-enters auto-update.
- [ ] **Step 2: Failing test — the discriminator.** A *mixed* merge (any section
  kept from the founder) still lands `customized = true`. Without this, simply
  hard-coding `false` would pass Step 1.
- [ ] **Step 3: Run → FAIL. Step 4: Implement** the byte comparison. Reuse the
  agent side's shape rather than writing a second one — and note the agent
  version compares the **file set**, contents, *and* entry file, because
  reassembly does not reproduce upstream bytes (hence its verbatim shortcuts).
  Check whether the skill path has the same reassembly hazard.
- [ ] **Step 5: Run → PASS. Verify + commit.**
```bash
git commit -m "fix(marketplace): derive skill customization from merge result bytes, not unconditionally"
```

---

## T2.8c — The two follow-ups T2.8's review round 2 deferred

Both are referenced as "filed" by docblocks in
`server/src/services/marketplace-install/skill-update-merge.ts`. Neither is
reachable today; both are stated invariants that the code does not yet hold.

**(a) `applySkillUpdate` has T2.8's C3 gap.** `resolveSkillUpdatePayload`
(`skill-auto-updater.ts:159-167`) returns `metadataPatch: undefined` when the
catalog item has no bundle, so an auto-applied update to an item that has
**stopped** carrying a bundle leaves `catalogBundleInstallPath`, `fileInventory`
and `trustLevel` naming the old version's tree — agents keep receiving scripts
upstream no longer publishes. T2.8 fixed the merge path
(`resolveBundleColumns`); this is the same shape on the auto-apply path. Not
fixed inside T2.8 because it is a behaviour change to a path T2.8 did not
otherwise touch. Latent: **0 of the 498 published skills** in the shipped
snapshot lack a bundle (the 16 bundle-less catalog items are the 11 agents, 4
plugins and 1 team, which never reach this code).

**(b) The managed skill-bundle root is not jailed.** T2.8's safety argument is
that a founder editing a catalog skill edits `company_skills.markdown`, because
`companySkillsService.updateFile` writes to disk only for
`sourceType === "local_path"` (`company-skills.ts:1591`). That gate is on the
**row's `sourceType`**, not on the **path**, and two founder-reachable chains
get a differently-typed row to name `.aoa/marketplace-skills/…`:

- `POST /companies/:cid/skills/import` takes an arbitrary `source` path and
  produces a `local_path` row whose `sourceLocator` is it — after which
  `PATCH /skills/:id/files` passes the `editable` check and writes inside.
- `PATCH /agents/:id/instructions-bundle` with `mode: "external"` accepts any
  absolute `rootPath`, then both writes and `fs.rm`s inside it.

Neither happens during a normal merge, and T2.8's staging swap means a materialize
no longer deletes a tree it cannot replace — but "nothing can write there" would
be false, so the docblock says so instead. The fix is to reject a
`sourceLocator` / `rootPath` that resolves inside the managed marketplace-skills
root, in both routes, with the containment check shared rather than duplicated.

---

## T2.9 — Guard the non-catalog install path (P13) — ✅ SHIPPED 2026-07-24

**Why:** the catalog path guards `customized` with an optimistic lock (`skill-auto-updater.ts:100-133`); the github/url install path has **no such check** and blind-overwrites a founder's customized skill.

- [x] **Step 1: Failing test** — reinstalling over a **customized** skill notifies instead of overwriting; an **uncustomized** skill still updates (discriminator).
- [x] **Step 2: Run → FAIL.** **Step 3: Apply the same `customized` check + optimistic lock** to the github/url install/reinstall path. **Step 4: Run → PASS.** **Step 5: Commit.**
```bash
git commit -m "fix(marketplace): stop the github/url install path overwriting customized skills"
```

### Entry points enumerated before choosing where the guard goes

Every write that can replace an installed row's `markdown`:

| # | Entry point | Service | Guarded now? |
|---|---|---|---|
| 1 | `POST /skills/:id/install-update` | `installUpdate` | **YES** (T2.9) — pre-read + `customized = false` predicate; throws 409 `SKILL_CUSTOMIZED` |
| 2 | `POST /skills/import` | `importFromSource` → `upsertImportedSkills` | **YES** (T2.9) — `preserve_founder_edits`; refusals in `refusedCustomized` + `warnings` |
| 3 | `POST /skills/scan-projects` | `scanProjectWorkspaces` (own inline UPDATE) | **YES** (review round 2) — pre-read + predicate; refusals land in `conflicts[]` |
| 4 | `POST /skills/import-package` | `importPackageFiles` | no, deliberately — see T2.9c |
| 5 | `POST /skills` | `createLocalSkill` | no, deliberately — see T2.9b |
| 6 | company bundle import | `company-portability.ts` | no, deliberately — see T2.9d |

> **Follow-on consequence recorded 2026-07-24 (T2.9 round 2).** Clearing
> `customized` under `caller_is_authoritative` means a bundle import declaring
> `sourceType: "catalog"` now leaves a row **eligible for catalog auto-apply**
> that was previously frozen out. That is the right call on the merits — the
> row's bytes are the importer's, not a founder's, so the flag was false — but
> it lands on the same surface T2.9's review identified as **attacker-
> controlled**: the manifest's `sourceType` is validated only as
> `z.string().min(1)` (`packages/shared/src/validators/company-portability.ts:81`)
> and is written straight through by `upsertImportedSkills`. So a crafted
> bundle can now both *name* a row as catalog-managed and *clear* its
> customization guard in one import. Evaluate that pairing explicitly when this
> task is picked up — validating `sourceType` against the known enum is the
> obvious first move.
| 7 | catalog install | `installSkill` | n/a — refuses any version change outright |
| 8 | catalog auto-apply | `applySkillUpdate` | pre-existing (the reference implementation) |

The guard sits on the **shared upsert primitive** (`upsertImportedSkills`), which 2/4/5/6
all funnel through, and its `CustomizedSkillWritePolicy` argument is **required with no
default** — a future install path cannot compile without stating which side wins. Row 3
keeps its own inline UPDATE (it matches on `sourceLocator`, not the canonical key) and
carries the same pre-read + predicate.

**`caller_is_authoritative` clears `customized`.** A path that legitimately replaces the
markdown with its own bytes has just erased whatever founder edit the flag described, so
leaving it set turns a stale `true` into a permanent refusal by every other path — the row
would be told it has local edits it no longer has, with delete-and-re-import the only exit.
Found in review round 2; this is what makes the two policies mean what they claim.

### Correction to the brief's premise — and the reviewer's correction to mine

`customized` is only ever written by `companySkillsService.updateFile`
(`company-skills.ts:1623`, `:1632`), which first requires `deriveSkillSourceInfo().editable`
— true only for `local_path` and `catalog` (`:2377`). I concluded from this that a
`github` / `url` row can never carry the flag.

**Review round 2 refuted the reachability half of that.** `sourceType` is *mutable after the
flag is set*, and the upsert's update branch writes `sourceType: imp.sourceType`. So: edit a
`local_path` skill (`customized = true`) → company bundle import with `replace` declaring the
same key and `sourceType: "github"` (validated only as `z.string().min(1)`) → the row is now
`github` **and** `customized`. My *severity* conclusion survives — the founder's bytes are
already gone by then, so the flag is stale rather than protective — but that staleness is
exactly the F1 bug, so it is not academic.

The live lossy chain is still narrower than "github reinstall eats founder edits":

- **`local_path` rows** *can* be customized, and `installUpdate` accepts them. Normally the
  founder's edit is on the same disk the reinstall re-reads, so nothing is lost — **except**
  `updateFile` swallows filesystem-write failures (`:1605-1608`), leaving the edit DB-only.
  A reinstall then silently reverted it. That is real, and now refused.
- For `github` / `url` this is a **fail-closed class fix**, not a fix for a live loss: the
  only thing preventing data loss was a caller-side editability check in a *different*
  function. Per standing rule 3 that is exactly the shape that must not be relied on.

`marketplace_pending_updates` is **not** an expressible notification channel here: its
`catalogItemId` / `itemType` / `currentVersion` / `latestVersion` are all `notNull`, it is
uniquely indexed on `(companyId, catalogItemId)`, and every consumer resolves that id
against the live catalog (`marketplace-company.ts:367-372`, `:403-407`). A synthetic row for
a non-catalog skill would surface an Updates entry that 422s on every action. "Notifies"
therefore resolved to a **founder hub item** via the existing `marketplaceNotifications`
family (`skillUpdateRefusedCustomized`, semantic type `marketplace_op`), fired from the
route next to the activity log it already writes, plus the synchronous 409 / `refusedCustomized`
in the response.

---

## T2.9b — `createLocalSkill` overwrites a colliding customized key

`POST /companies/:cid/skills` derives the key `company/<cid>/<slug>` and passes
`caller_is_authoritative`, so creating a skill whose slug collides with an existing
**customized** skill silently replaces it instead of 409-ing on the collision. Pre-existing
behaviour, unchanged by T2.9. The fix is a collision refusal at create time (the founder
should be told the name is taken), not a policy flip — a create genuinely IS authoritative
for the row it creates.

**Files:** `server/src/services/company-skills.ts` `createLocalSkill`.

---

## T2.9c — `importPackageFiles` has no founder-edit check

A package re-upload rewrites the skill directory and the row with no `customized` check at
all, so it silently destroys founder edits (both on disk and in the row) for a `local_path`
skill.

**Corrected in review round 2 — do NOT budget a materializer rewrite for this.** My first
write-up argued the check was blocked by ordering: `importPackageFiles` `fs.rm`s and
rewrites the directory (`company-skills.ts:1769-1778`) *before* the upsert, so a refusal at
the upsert would leave the founder's markdown in the row and the caller's files on disk — a
torn state worse than the overwrite. That is true **only for a refusal placed at the
upsert**. `doWork` already reads the whole company at step 1 and already holds the per-slug
lock, so the check belongs there, **before `fs.rm` ever runs**: no torn state, no
reordering, no stage-then-rename. The one thing that used to block it — `listFull` not
carrying `customized` — is gone, because T2.9 added `listFullRows` for exactly this.

So this is deferred because it is a **product decision**, not a technical one: who owns a
package-imported skill after the founder has edited it in the UI? `importPackageFiles` is
documented as "the caller is the authoritative source", and flipping it means an agent's
package upload now *fails* for a reason the agent must handle. That call belongs with the
product owner, and it is three lines once made.

**Files:** `server/src/services/company-skills.ts` `importPackageFiles` (step 1 of `doWork`).

---

## T2.9d — company bundle import has no founder-edit surface, and pairs results by index

`company-portability.ts` pairs `upsertImportedSkills` results to inputs **positionally**,
so `preserve_founder_edits` (which returns a short array on refusal) would mis-pair every
row after the first skip. It therefore passes `caller_is_authoritative` and a bundle import
into a company with customized skills overwrites them. The import plan already has a
`collisionStrategy` (`skip` / `replace` / `rename`) and a conflict surface — the right fix
is to make `customized` a planned collision reason there, not to flip the policy.

The positional pairing is itself a latent (pre-existing, rare) bug: `caller_is_authoritative`
*also* returns a short array when a row is concurrently deleted between the read and the
UPDATE, at which point every subsequent `id` in `resultSkills` is wrong. Pair by key.

**Files:** `server/src/services/company-portability.ts` (~`:2610-2623`), the import planner.

---

## ~~T2.9e — project scan re-syncs over customized rows~~ — ✅ CLOSED in review round 2

Folded into T2.9 rather than deferred. `scanProjectWorkspaces` now pre-reads `customized`
and carries the `customized = false` predicate on its inline UPDATE; refusals land in the
existing `conflicts[]` array (no type change needed) so one edited skill does not abort the
sweep for every other project. This was the cheapest and most-exposed of the four
follow-ups — a bulk re-sync silently reverting every matching row at once — and deferring
it was the wrong ordering.

---

## T2.10 — D18 crew/Commander autonomy dial-split

*(Folded into Phase 2 by product-owner decision 2026-07-24. Independent of the marketplace arc — do it last.)*

**Why:** `internal_agent_config.autonomyLevel` is a **single shared dial** read by Commander, crew task runs, org heartbeat, **and** Adjutant/thread scope-compilation (Decision #109 addendum). D18 wanted it Commander-only with a separate crew column "because one dial must not secretly drive two systems." Phase 1 raised its default to Assist, which moved all four at once.

- [x] **Step 1: Enumerate every reader** — done. The full list, with each one's assigned dial, is recorded in **Decision #109 addendum §10**. Ten resolution sites; eight are agent-execution (all → crew dial), two are dial-agnostic maintenance (`reconcile-autonomy-scale.ts`, `company-portability.ts`, both → *both* dials, independently). Two corrections to the list above: `runner.ts`'s completion guard and `set-task-status-tool.ts` are **not** readers — they consume a resolved `effectiveAutonomy` off the run payload / tool context and inherit whichever dial the resolution site chose, so they needed no change. Two readers the list missed: `threads.ts` (`advancePhase` auto-approve) and `routes/discussions.ts` (the authz gate that mirrors it), plus `thread-participation-runner.ts`.
- [x] **Step 2: Add a separate crew autonomy column** — `internal_agent_config.crew_autonomy_level`, migration `0183_clean_lady_ursula` (Drizzle-generated DDL + a backfill statement). Existing-row mapping: `UPDATE ... SET crew_autonomy_level = autonomy_level`, NOT the column default — a bare `ADD COLUMN DEFAULT 1` would have moved every company that had deliberately set Manual or Drive.
- [x] **Step 3: Repoint each reader** at the correct dial for its system.
- [x] **Step 4: Tests** — `d18-autonomy-dial-split.test.ts` (L3 schema + a **closed allowlist** so a new reader on the wrong dial fails CI) and `d18-autonomy-dial-split.integration.test.ts` (real Postgres; both directional cases through the real gate). Ablation-verified.
- [x] **Step 5: Update Decision #109 addendum + D18** references. **Step 6: Commit.**

**Adjutant/scope-compilation is NOT its own dial** — it already has one. `discussions.autonomy_level` is the per-thread override and stays untouched; the company-level fallback for those flows is the crew dial. Grouping it with crew (as this plan assumed) is correct.

**The UI was a dead stub.** The only company-autonomy control was a hard-coded `<Select value="0" disabled>` reading "Level 0 — Full Approval / Higher levels available in V3" — it never read or wrote `autonomyLevel`, so no founder could set the dial that was driving all four systems at Assist. Replaced with two labelled controls: Commander's stays read-only (its gating is the runtime-approval policy, not this integer — a writable control would imply an effect it does not have) and a **real, writable "Agent autonomy (crew + org agents)"** select that persists `crewAutonomyLevel`.
```bash
git commit -m "refactor(autonomy): split the crew and Commander autonomy dials (D18)"
```

---

## Test-coverage matrix

| Task | L1 unit | L2 service+mock | L3 schema | L4 integration | L5 e2e |
|---|---|---|---|---|---|
| T2.1 | installTeam precondition | — | `parentProjectId` nullable | cascade-safety on department delete | — |
| T2.2 | — | gate splits crew vs infra | — | — | — |
| T2.3 | — | fallback-to-legacy on failure | — | **real DB: marketplace roster + offline snapshot** | company-create smoke |
| T2.4 | — | — | — | dependency-resolution audit | — |
| T2.5 | protected set | uninstall refusal | — | — | — |
| T2.6 | — | customized→notify, untouched→auto | — | — | — |
| T2.7 | section differ | diff/merge routes | — | — | conflict badge |
| T2.8 | — | materializer called on merge | — | files on disk match upstream | — |
| T2.9 | — | customized→notify (+ on-disk bytes untouched) | — | — | — |
| T2.10 | dial resolution | each reader's dial | new column | — | — |

---

## Exit criteria

Creating a company installs the crew **from the marketplace** (offline fallback proven by stubbing the network); each agent carries its declared skills; an upstream agent or skill change flows down through **detect → notify → diff → merge without discarding founder edits**; protected agents cannot be uninstalled; and crew/Commander autonomy are independently dialable.

**Live verification (mirroring Phase 1's T10):** boot an isolated instance, create a fresh company, and confirm the crew arrives marketplace-managed (non-`@legacy` origins, real `templateVersion`, populated `skillKeys`) — then simulate an upstream bump and watch it flow to a founder-visible notification rather than a silent overwrite.
