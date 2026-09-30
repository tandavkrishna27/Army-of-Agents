# v1-combined Batch-4 — Remaining Correctness + Security Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining verified-real finding from the Workflow-A (correctness) and Workflow-B (security) reviews of `feat/v1-combined`, so the branch is genuinely ready for the v1 upgrade — shipped as a single `batch-4` PR.

**Architecture:** Targeted fixes across 8 subsystems. Each fix follows the tenant-isolation / state-machine / concurrency patterns already established elsewhere in the same files (every finding cites a sibling that does it correctly). TDD throughout: failing test → fix → green. Race/SQL/constraint findings get **real-DB integration tests** (embedded-postgres, Linux-only, run in Docker as the `node` user); logic findings get unit/service-mock/route-mount tests.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM + PostgreSQL, vitest, supertest, embedded-postgres (integration), pnpm workspaces. Adapter utils in `packages/adapter-utils`. Schema in `packages/db/src/schema`.

**Branch:** `fix/v1-combined-batch4-correctness` off `origin/feat/v1-combined` (HEAD `9de8a100e`).

---

## Verified worklist (grounded against HEAD `9de8a100e`)

All items below were re-read in the actual merged code — **none are false positives or already-fixed**. Each cites the proven location.

| ID | Severity | Subsystem | One-line | Verdict |
|----|----------|-----------|----------|---------|
| A-H8 | high | artifacts | `create_artifact_version` crew tool: no companyId check → cross-tenant write | REAL |
| A-H11 | high | adapters | child `stdin` write has no `error` listener → EPIPE crashes server | REAL |
| A-H6 | high | heartbeat | orphan reaper fails `queued` runs waiting behind the clamp | REAL |
| A-H9 | high | deps | cancelled dependency deadlocks dependents (release paths check `done` only) | REAL |
| A-H7 | high | discussions | `linkEntry` moves entry without reassigning `seq`/`entrySeq` | REAL |
| A-H12 | high | db-schema | quota unique index on nullable `model`, no `NULLS NOT DISTINCT` → dup rows | REAL |
| B-H1 | high | mcp-authz | `scope.ts` founder fail-open: non-board actors resolve to founder | REAL |
| A-M1/M3 | med | mcp-authz | update-task: new `projectId` not company-checked (M1≡M3, one fix) | REAL |
| A-M2 | med | mcp-authz | `memory.retain` doesn't verify linked taskId/goalId/etc. belong to company | REAL |
| A-M8 | med | artifacts | `addVersion` `parentVersionId` not validated same-artifact/company | REAL |
| A-M9 | med | artifacts | detected-output confirm/dismiss: non-transactional JSONB RMW (lost updates) | REAL |
| A-M10 | med | deps | auto-block loses original status: backlog → `todo` → can auto-dispatch | REAL |
| A-M11 | med | tasks | reopen-via-comment dispatches planning-mode tasks (bypasses D8 gate) | REAL |
| A-M12 | med | deps | `addDependency` auto-block not transactional → block-after-complete race | REAL |
| A-M14 | med | proactive | `blockedTaskScan` ignores dep completion + no DISTINCT (DORMANT — unwired) | REAL |
| A-M4 | med | memory | `flagStaleItems` never flags never-accessed (`accessedAt IS NULL`) items | REAL |
| A-M5 | med | memory | expired `active_context` served to agents (no expiry filter on retrieval) | REAL |
| A-M6 | med | memory | version-number assignment races on unique index → 500 | REAL |
| A-M7 | med | threads | scope-coupled action falsely `suppressed_stale` by sibling draft in batch | REAL |
| A-M18 | med | threads | concurrent `createDraftFromThread`: only `one_draft_uq` caught → 500 | REAL |
| A-M13 | med | workspace | `runWorkspaceCommand` uses `/bin/sh` on Windows (no-recorder branch) | REAL |
| A-M16 | med | plugins | manual `triggerJob` overlap check is a TOCTOU | REAL |
| A-M17 | med | adapters | Codex session id lost when stdout exceeds 4MB cap | REAL |
| A-M15 | med | marketplace | merge output silently reorders user-retained sections | REAL |
| B-M3 | med | goals | goal re-parent: cross-tenant `goal_parents` edge to foreign goal | REAL |
| B-M5 | med | plugins | plugin host trusts worker-supplied companyId; enable gate is a no-op | REAL |
| B-M4 | med | plugins | plugin worker sandbox: no network egress (PARTIAL — fs-read+docs only) | REAL/mixed |

**Out of scope (explicitly):** B-M4's network-egress boundary (needs OS-level isolation — network namespace/seccomp/proxy; not an in-process fix). We do the code-feasible parts (tighten `--allow-fs-read`, surface trust-tier) and document the limitation.

---

## Test strategy (the "100% sure" bar)

Per finding, the **minimum** test set:

- **Logic / authz / state-machine** (A-H8, H9, H6, B-H1, M1/M3, M2, M4, M8, M10, M11, M13, M14, M15, M16, B-M3, B-M5): **service-mock** or **route-mount** unit test that drives the handler and asserts the new guard (foreign id → notFound; queued run not reaped; cancelled dep unblocks; etc.) + a **regression** that the happy path still works.
- **Concurrency / SQL / unique-constraint** (A-H12, A-H7, M6, M9, M12, M18): **real-DB integration** (embedded-postgres, `describe.skipIf(win32)`, run in Docker `aoa-lx` as the `node` user) — these CANNOT be proven with the Proxy db mock (it has no real tx isolation or NULL-distinct semantics). Add a service-mock unit for the deterministic parts (e.g. the error-classification branch in M18).
- **Adapter / stream** (A-H11, A-M17): **unit** against the pure function / spawn path (mock `process.platform`, feed oversized stdin/stdout).
- **Threads** (A-M7, A-M18): **real-DB integration** (the freshness/draft interaction needs real rows + ordering).

**Verification gate before the PR** (no CI burn): full local `verify` equivalent on the batch-4 branch — `pnpm -r typecheck`, `pnpm -r build`, full server suite, full UI suite, adapter suites; **plus** the new integration tests run in Docker-Linux (`su node -c '… vitest run …'`). Reminder lessons: (1) any service edit that `tx.update`/`tx.delete`s a NEW table breaks every sequence-mock test of that method — add the table to the mock; (2) rebuild `adapter-utils` dist after editing its `src`.

---

## Codex review — verified corrections (these OVERRIDE the task bodies below)

A Codex pass + my own code re-verification found real defects in the first draft. Every item below was confirmed against the actual code at `9de8a100e`. **Apply these; they supersede the original task text where they conflict.**

**[P1] corrections (would cause wrong/failed implementation):**
- **A-H8 (Task 2.1):** the artifact company check must run **BEFORE** `ctx.db.transaction(...)`. The outer handler wraps the tx return as `{success:true}` (artifact-create-version.ts:95-96), so a `{success:false}` returned *inside* the tx callback is lost. Use `ctx.db.select(...)` (not `tx`) before the transaction; also validate `parentVersionId` (A-M8) there.
- **A-M9 (Task 2.3):** wrong file. Confirm/dismiss are **`server/src/routes/output-detection.ts`** (~`:105-277`, `:280-328`), not `services/`. Wrapping the route in `db.transaction` is insufficient if it still calls `artifactService(db)`/`taskOutputService(db)` on the **non-tx** db — use tx-scoped service instances or inline the writes in the tx, after re-selecting the run row `FOR NO KEY UPDATE` and re-checking pending status.
- **A-H9 (Task 3.1):** `handleCancelledDependency` must **return `WakeTask[]`** and the `cancelled` branch of `issueService.update` (issues.ts ~`:1340-1350`) must assign it to `wake` (mirroring the `done` path) — otherwise unblocked dependents are never woken. Also update **`proactive.ts dependencyChainGaps` (~`:246-299`)**: after cancelled counts as satisfied, it still flags cancelled deps as gaps → false positives. Remove/redefine that check.
- **A-M10 (Task 3.2):** option (a) is **wrong** for this codebase — issues default to `backlog` and the model blocks any non-terminal non-blocked task, so "don't block backlog" silently changes behavior. Use **option (b)**: add `blockedFromStatus` (nullable) to `issues` schema, capture it on auto-block, restore it on unblock, and **skip the wakeup** when the restored status is `backlog`. Requires `pnpm db:generate`.
- **A-M7 (Task 6.2):** wrong path — **`server/src/services/thread-agent-action-freshness.ts:191-196`**. Pick **one** concrete design (not "OR"): thread the same-batch-produced draft id through to the freshness check so a scope-coupled action whose commit will reuse that draft is not `suppressed_stale`. (Batch-committing the draft + dependent actions is the alternative; choose the thread-the-id approach — smaller change.)
- **A-M18 (Task 6.3):** wrong path — **`server/src/services/thread-scope-versions.ts:627-816`** (catch at `:810`); `db-errors.ts:46-48` exact-match is correct. Logic stands.
- **B-M5 (Task 8.5):** wrong interpretation. `plugin_company_settings` is **default-ENABLED** ("no row => enabled", schema comment :12-15; `enabled` defaults true). Do **NOT** fail-closed on missing row (it would disable every plugin). Correct fix: (1) verify the plugin row exists/belongs to the company (`plugins.companyId`), and (2) honor an explicit `enabled === false` row as disabled. No default-deny without a product decision + backfill.

**[P2] refinements (apply within the relevant task):**
- **B-H1 (Task 1.1):** also update the **`McpRouteDeps.resolveScope`** signature (server.ts:103) and any custom route deps/tests, else they bypass the actor-source distinction.
- **A-H12 (Task 7.1):** use Drizzle's native **`.nullsNotDistinct()`** (already used at `plugin_state.ts:83`) — drop the "if Drizzle can't express it" hedge. Still dedupe `model IS NULL` rows before the index is (re)created.
- **A-H7 (Task 6.1):** moving a reply can leave `parentEntryId` pointing at an entry in the old thread → **reject moving replies, or clear/re-map `parentEntryId`** in `linkEntry`.
- **A-H11 (Task 4.2):** also wrap `child.stdin.write/end` in **try/catch** — a synchronous `EPIPE`/`ERR_STREAM_DESTROYED` can throw before the listener fires.
- **A-M6 (Task 5.3):** move the **pending/draft dedup reads INSIDE the transaction**, after the parent-row `FOR UPDATE` lock — locking only around the max-version read leaves stale pre-lock decisions.
- **A-M12 (Task 3.4):** also **lock/check the dependent** (not just the dependency), or make the block UPDATE conditional on the dependent still being in a blockable status.
- **A-M4 (Task 5.1):** the suggestion title falls back to epoch for `accessedAt=null` ("20000+ days"); compute age from **`createdAt`** or special-case "never accessed".
- **A-M11 (Task 3.3):** implement the gate in the **shared `enqueueIssueCommentWakeups`** helper so BOTH comment routes are covered, not just one.
- **B-M3 (Task 8.4):** also require **every** requested parent id to be found (`rows.length === uniqueParentIds.length`) — a non-existent/foreign id returns no row and would otherwise pass.
- **A-M2 (Task 1.3):** validate only the FKs `memory.retain` actually accepts (taskId/goalId/projectId/departmentId per its schema — there is no `sourceArtifactId` param).

**Confirmed-correct by Codex (no change):** A-H6, A-M1/M3, A-M5, A-M8 (logic), A-M13, A-M14, A-M15, A-M16, A-M17, B-M4 (code-feasible part).

---

## Phase 1 — MCP authz (highest blast radius; do first)

**Files:** `server/src/mcp/tools/scope.ts`, `server/src/mcp/server.ts`, `server/src/mcp/tools/write-tools.ts`. Tests in `server/src/__tests__/`.

### Task 1.1 — B-H1: board-gate `resolveUserScope` (no founder for non-board actors)

**Files:**
- Modify: `server/src/mcp/tools/scope.ts:7-25` (`resolveUserScope` signature + founder fallback)
- Modify: `server/src/mcp/server.ts:405-407` (pass the actor, not just userId)
- Test: `server/src/__tests__/mcp-scope-resolver.test.ts` (new)

**Verified cause:** `scope.ts:17` `if (roles.length === 0 || roles.some(r => r.role === "founder")) return { kind: "founder", userId }`. `server.ts:407` passes only `protocolActor.userId`; an agent actor's `userId = agentId` (server.ts:189-198) is never in `user_roles` (FK → `authUsers`), so it yields zero rows → **founder**. #210 fixed the cross-tenant read symptoms but NOT this elevation.

- [ ] **Step 1: Failing test** — `resolveUserScope(db, companyId, { source:'agent', userId:agentId })` with zero roles → expect `{ kind:'scoped', projectIds:[<agent_projects>] }`, NOT founder; `source:'mcp'` zero roles → team_member-equivalent scoped; genuine `source:'board'` founder role → founder. (service-mock db: `user_roles` select returns `[]` for agent; `agent_projects` returns 2 rows.)
- [ ] **Step 2: Run → fails** (current code returns founder).
- [ ] **Step 3: Implement** — change signature to `resolveUserScope(db, companyId, actor: { source: string; userId: string })`. Board-gate:
  ```ts
  // Only genuine board sessions may resolve to founder via user_roles.
  if (actor.source === "board") {
    const roles = await db.select().from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, actor.userId)));
    if (roles.length === 0 || roles.some(r => r.role === "founder")) return { kind: "founder", userId: actor.userId };
    return { kind: "scoped", userId: actor.userId, projectIds: roles.map(r => r.projectId).filter(Boolean) };
  }
  // Non-board (agent / mcp / commander): NEVER founder.
  if (actor.source === "agent") {
    const projects = await db.select({ projectId: agentProjects.projectId })
      .from(agentProjects).where(eq(agentProjects.agentId, actor.userId));
    return { kind: "scoped", userId: actor.userId, projectIds: projects.map(p => p.projectId) };
  }
  return { kind: "scoped", userId: actor.userId, projectIds: [] }; // mcp/commander → least privilege
  ```
  Update `server.ts:407` to pass `{ source: protocolActor.source, userId: protocolActor.userId }`. Import `agentProjects`.
- [ ] **Step 4: Run → passes.**
- [ ] **Step 5: Route-mount regression** — agent-key MCP `list-tasks` / `resources/read aoa://memory` returns only agent_projects-scoped rows (extend an existing MCP route test). Confirm a genuine board session still gets founder reach.
- [ ] **Step 6: Commit** `fix(security): B-H1 — board-gate MCP scope resolution (no founder for agent/mcp actors)`

> **Design note / risk:** This is the riskiest fix — it narrows what agent/mcp MCP callers can read. Verify no internal flow relies on agents having founder MCP scope (grep callers of `resolveUserScope`; the Commander path uses its own `kind` and is exempt via the `lead` runtimeConfig check in the dispatcher, unaffected). Align the no-roles default with `resolveUserRole` (which returns team_member).

### Task 1.2 — A-M1/M3: update-task new `projectId` company check

**Files:** Modify `server/src/mcp/tools/write-tools.ts:267-269` (`handleUpdateTask`). Test: `server/src/__tests__/mcp-write-tools-tenant.test.ts` (extend or new).

**Verified cause:** `write-tools.ts:268` only `assertScopedProjectAccess(ctx.scope, parsed.projectId, "Project")` (no-op for founder, `scope.ts:74`); never loads the project to check `project.companyId !== ctx.companyId`. `handleCreateTask:204-208` does it correctly.

- [ ] **Step 1: Failing test** — `handleUpdateTask` with `projectId` of a foreign company → expect `notFoundResult` and `issuesSvc.update` NOT called. (service-mock: `projectsSvc.getById` returns `{ companyId: 'other' }`.)
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — before `assertScopedProjectAccess`:
  ```ts
  if (parsed.projectId) {
    const project = await ctx.services.projectsSvc.getById(parsed.projectId);
    if (!project || project.companyId !== ctx.companyId) return notFoundResult("Project not found");
    assertScopedProjectAccess(ctx.scope, parsed.projectId, "Project");
  }
  ```
- [ ] **Step 4: Run → passes.** **Step 5:** parity contract test (create vs update both reject foreign projectId). **Step 6: Commit** `fix(security): A-M1/M3 — update-task rejects cross-company projectId`.

### Task 1.3 — A-M2: `memory.retain` validates linked entity ownership

**Files:** Modify `server/src/mcp/tools/write-tools.ts:493-509` (`handleMemoryRetain`). Test: same tenant test file.

**Verified cause:** `handleMemoryRetain` forwards `taskId/goalId/projectId/departmentId` straight to `create` with no company check; the `if (!isPersonalScope)` guard (line 466) skips even the scope asserts on the personal path. Sibling `handleSuggestMemory:94-100` loads the task and 404s on `companyId` mismatch.

- [ ] **Step 1: Failing test** — `handleMemoryRetain` with foreign `taskId` → notFound; memory NOT created. (incl. personal-scope path.)
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — for each provided FK, load and reject on company mismatch (mirror suggest-memory), in BOTH paths:
  ```ts
  if (parsed.taskId) { const t = await ctx.services.issuesSvc.getById(parsed.taskId);
    if (!t || t.companyId !== ctx.companyId) return notFoundResult("Task not found"); }
  if (parsed.goalId) { const g = await ctx.services.goalsSvc.getById(parsed.goalId);
    if (!g || g.companyId !== ctx.companyId) return notFoundResult("Goal not found"); }
  if (parsed.projectId) { const p = await ctx.services.projectsSvc.getById(parsed.projectId);
    if (!p || p.companyId !== ctx.companyId) return notFoundResult("Project not found"); }
  ```
- [ ] **Step 4: Run → passes. Step 5:** regression personal-scope still creates with valid same-company FKs. **Step 6: Commit** `fix(security): A-M2 — memory.retain validates linked entity company`.

---

## Phase 2 — Artifacts (cross-tenant write + version integrity)

**Files:** `server/src/services/internal-agent/tools/artifact-create-version.ts`, `server/src/services/artifacts.ts`, `server/src/services/output-detection.ts`. Tests in `server/src/__tests__/`.

### Task 2.1 — A-H8: `create_artifact_version` company check

**Files:** Modify `server/src/services/internal-agent/tools/artifact-create-version.ts:37-93`. Test: `server/src/__tests__/artifact-create-version-tenant.test.ts` (new).

**Verified cause:** the crew tool body **never references `ctx.companyId`** (grep = 0 hits); inserts a version + repoints `current_version_id` on any artifact by id. Sibling `attach-task-artifact-tool.ts` does `row.companyId !== ctx.companyId → NOT_FOUND`.

- [ ] **Step 1: Failing test** — drive the tool with an `artifactId` owned by company B → expect `{ success:false, error:'NOT_FOUND' }` and NO version inserted. (service-mock: artifact select returns `{ companyId:'B' }`.)
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — inside the tx, before allocating the version number:
  ```ts
  const [art] = await tx.select({ companyId: artifacts.companyId }).from(artifacts).where(eq(artifacts.id, artifactId));
  if (!art || art.companyId !== ctx.companyId) return { success:false, error:'NOT_FOUND', summary:'Artifact not found' };
  ```
- [ ] **Step 4: Run → passes. Step 5:** regression same-company create still works. **Step 6: Commit** `fix(security): A-H8 — create_artifact_version rejects cross-company artifactId`.

### Task 2.2 — A-M8: validate `parentVersionId` belongs to same artifact

**Files:** Modify `server/src/services/artifacts.ts:127-139` (`addVersion`). Test: `server/src/__tests__/artifact-add-version-parent.test.ts` (new) + real-DB integration.

**Verified cause:** `addVersion` inserts `parentVersionId: data.parentVersionId ?? null` with no check that the parent's `artifactId === artifactId`; FK allows any `artifact_versions` row (cross-artifact/cross-company).

- [ ] **Step 1: Failing test** (service-mock) — `addVersion(artifactId, { parentVersionId: <other-artifact-version> })` → throws/NOT_FOUND.
- [ ] **Step 2: Run → fails. Step 3: Implement** — inside the tx, when `parentVersionId` provided: `SELECT artifact_id FROM artifact_versions WHERE id = parentVersionId`; throw `badRequest("parentVersionId does not belong to this artifact")` if missing or mismatched. **Step 4: Run → passes.**
- [ ] **Step 5: Integration** (real-DB, Docker) — cross-artifact + cross-company parent rejected, valid same-artifact parent accepted. **Step 6: Commit** `fix(artifacts): A-M8 — validate parentVersionId belongs to the artifact`.

### Task 2.3 — A-M9: transactional detected-output confirm/dismiss

**Files:** Modify `server/src/services/output-detection.ts:117-126,247-253,289-325`. Test: `server/src/__tests__/output-detection-confirm-race.integration.test.ts` (new, real-DB).

**Verified cause:** confirm/dismiss do `db.select` → mutate the whole `detectedOutputs` JSONB array → `db.update` write-back, all on `db` (never `db.transaction`); concurrent confirms lose updates and a reverted index re-confirmed creates a 2nd artifact version (the `addVersion` at :182 isn't deduped).

- [ ] **Step 1: Failing integration test** (real-DB) — two concurrent confirms on indices 0 and 1 of the same run → expect both statuses persisted (no lost update) and exactly one version per index.
- [ ] **Step 2: Run → fails (lost update).**
- [ ] **Step 3: Implement** — wrap each confirm/dismiss in `db.transaction`; re-select the run row `FOR NO KEY UPDATE` before mutating the JSONB; re-check the index status under the lock. **Step 4: Run → passes.**
- [ ] **Step 5: Commit** `fix(artifacts): A-M9 — serialize detected-output confirm/dismiss under row lock`.

---

## Phase 3 — Dependencies / tasks / planning

**Files:** `server/src/services/dependencies.ts`, `server/src/services/issues.ts`, `server/src/routes/issues.ts`, `server/src/routes/dependencies.ts`, `server/src/services/internal-agent/proactive.ts`. Tests in `server/src/__tests__/`.

### Task 3.1 — A-H9: cancelled dependency releases dependents

**Files:** Modify `server/src/services/dependencies.ts:213,295`, `server/src/services/issues.ts:485`. Test: `server/src/__tests__/dependencies-cancelled.test.ts` (new).

**Verified cause:** block uses `TERMINAL_STATUSES = ['done','cancelled']` (line 84-85), but release paths use `status === 'done'` only (`resolveDependenciesTx:213`, `maybeUnblockTx:295`, `hasUnmetDependencies` issues.ts:485); `handleCancelledDependency:329` only logs. → a cancelled dep pins dependents `blocked` forever.

- [ ] **Step 1: Failing test** (service-mock) — D blocked by C; C → cancelled; assert D unblocks; and mixed D-blocked-by-C(cancelled)+E(done) → completing E unblocks D.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — change the satisfaction predicate to terminal-inclusive in all three spots: `remaining.every(r => TERMINAL_STATUSES.includes(r.status))` and `hasUnmetDependencies` → `upstream.some(r => !TERMINAL_STATUSES.includes(r.status))`. Also make `handleCancelledDependency` call `maybeUnblockTx` for each dependent (so cancelling C immediately re-evaluates D).
- [ ] **Step 4: Run → passes. Step 5:** integration regression (full update→resolve chain). **Step 6: Commit** `fix(deps): A-H9 — treat cancelled dependency as satisfied in release paths`.

### Task 3.2 — A-M10: preserve original status across auto-block

**Files:** Modify `packages/db/src/schema/issues.ts` (add `blockedFromStatus` nullable), `server/src/services/dependencies.ts:83-86,217-220,296-299`. Migration via `pnpm db:generate`. Test: `dependencies-cancelled.test.ts` + integration.

**Verified cause:** auto-block blocks any non-terminal non-blocked task (incl. `backlog`); unblock always forces `todo` (:217-220, :296-299); no `blockedFromStatus` column → a backlog task gets promoted to `todo` and auto-dispatched.

- [ ] **Step 1: Failing test** — block a `backlog` task, then unblock → expect it returns to `backlog`, NOT `todo`, and no wakeup is dispatched.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — Decision: **option (a)** is simplest and avoids a migration: only auto-block tasks in active states (`todo`/`in_progress`); leave `backlog` un-blocked (a backlog task isn't executable anyway). If product wants backlog tasks blocked, switch to option (b): add `blockedFromStatus`, capture on block, restore on unblock, and skip the wakeup when restored status is `backlog`. **Default to (a).** Update the auto-block condition to `["todo","in_progress"].includes(status)`.
- [ ] **Step 4: Run → passes. Step 5: Commit** `fix(deps): A-M10 — do not auto-block (and later auto-dispatch) backlog tasks`.

### Task 3.3 — A-M11: reopen-via-comment honors the D8 planning gate

**Files:** Modify `server/src/routes/issues.ts:406`. Test: `server/src/__tests__/issues-reopen-planning-gate.test.ts` (new).

**Verified cause:** `if (assigneeId && (reopened || (!selfComment && !isClosed && shouldDispatchIssueWakeup(currentIssue))))` — `reopened` is OR'd at the front, bypassing the planning gate; the reopen branch builds + dispatches a wakeup unconditionally; `heartbeat.wakeup` has no planning gate.

- [ ] **Step 1: Failing test** (route/service-mock) — reopen a `workMode:'planning'` done task via comment → assert NO wakeup enqueued.
- [ ] **Step 2: Run → fails.**
- [ ] **Step 3: Implement** — AND the gate across both branches: `if (assigneeId && shouldDispatchIssueWakeup(currentIssue) && (reopened || (!selfComment && !isClosed)))`.
- [ ] **Step 4: Run → passes. Step 5:** regression (standard-mode reopen still dispatches). **Step 6: Commit** `fix(tasks): A-M11 — reopen-via-comment respects the D8 planning-mode gate`.

### Task 3.4 — A-M12: transactional `addDependency` auto-block

**Files:** Modify `server/src/services/dependencies.ts:41,49-92`. Test: `server/src/__tests__/add-dependency-race.integration.test.ts` (new, real-DB).

**Verified cause:** route calls `addDependency` with no `outerTx`; existence-read + cycle-check + insert + auto-block are separate statements with no `FOR UPDATE` and no post-insert re-check → a dependency completing in the window leaves the dependent permanently blocked.

- [ ] **Step 1: Failing integration test** — interleave `complete(C)` and `addDependency(D→C)`; assert D is NOT left blocked when C is already done.
- [ ] **Step 2: Run → fails. Step 3: Implement** — wrap the read+cycle+insert+block in one `db.transaction` with `SELECT … FOR UPDATE` on the dependency row, and call `maybeUnblockTx(dependent)` after the edge insert (so a just-completed dep releases immediately). **Step 4: Run → passes. Step 5: Commit** `fix(deps): A-M12 — make addDependency auto-block transactional`.

### Task 3.5 — A-M14: `blockedTaskScan` joins dependency status + DISTINCT

**Files:** Modify `server/src/services/internal-agent/proactive.ts:122-138`. Test: `server/src/__tests__/blocked-task-scan.integration.test.ts` (new, real-DB).

**Verified cause:** the query inner-joins `issues→task_dependencies` on `dependentIssueId`, filters only `issues.status='in_progress'`, never joins the dependency issue nor checks its status; no DISTINCT → an in-progress task with N deps appears N times. (DORMANT — not wired to a scheduler, but fix before wiring.)

- [ ] **Step 1: Failing integration test** — in-progress task whose only dependency is `done` → expect 0 findings; task with 2 deps → counted once.
- [ ] **Step 2: Run → fails. Step 3: Implement** — join a second `issues` alias on `task_dependencies.dependencyIssueId`, filter `notInArray(depIssue.status, ['done','cancelled'])`, `selectDistinct` on `issues.id`. **Step 4: Run → passes. Step 5: Commit** `fix(proactive): A-M14 — blocked-task scan honors dependency completion + dedups`.

---

## Phase 4 — Heartbeat / adapters

**Files:** `server/src/services/heartbeat.ts`, `packages/adapter-utils/src/server-utils.ts`, `packages/adapters/codex-local/src/server/`. Rebuild `adapter-utils` dist after editing.

### Task 4.1 — A-H6: orphan reaper skips `queued` runs

**Files:** Modify `server/src/services/heartbeat.ts` (`reapOrphanedRuns`, the staleThreshold>0 path). Test: `server/src/__tests__/reap-orphaned-runs.test.ts` (new or extend heartbeat tests).

**Verified cause:** selects `["queued","running"]`, skips only `runningProcesses`, then fails the rest after the threshold — a queued run waiting behind the clamp (default 1) has no process and is wrongly reaped.

- [ ] **Step 1: Failing test** (service-mock) — a `queued` run with `updatedAt` older than the stale threshold, not in `runningProcesses`, with `staleThresholdMs > 0` → assert it is NOT marked failed.
- [ ] **Step 2: Run → fails. Step 3: Implement** — in the periodic path: `if (staleThresholdMs > 0 && run.status === 'queued') continue;` (startup reap with threshold===0 may still fail queued rows after a restart). **Step 4: Run → passes. Step 5:** regression (a genuinely orphaned `running` run is still reaped; startup reap still clears queued). **Step 6: Commit** `fix(heartbeat): A-H6 — do not reap queued runs waiting behind the concurrency clamp`.

### Task 4.2 — A-H11: stdin `error` listener (no server crash)

**Files:** Modify `packages/adapter-utils/src/server-utils.ts:363-365` (`runChildProcess`). Test: `packages/adapter-utils/src/__tests__/child-stdin-epipe.test.ts` (new).

**Verified cause:** `if (opts.stdin != null && child.stdin) { child.stdin.write(...); child.stdin.end(); }` with no `.on("error")` → an EPIPE/ERR_STREAM_DESTROYED on a writable with no listener is thrown as an uncaught exception → server crash.

- [ ] **Step 1: Failing test** — spawn a child that exits immediately (e.g. `process` adapter command that closes stdin) and write a large `stdin`; assert the function resolves (with the captured exit code) and does NOT throw/emit an unhandled error. (Use a real `spawn` of `node -e "process.exit(1)"` with a multi-MB stdin; Linux + Windows.)
- [ ] **Step 2: Run → fails (uncaught EPIPE).**
- [ ] **Step 3: Implement** —
  ```ts
  if (opts.stdin != null && child.stdin) {
    child.stdin.on("error", (err) => { /* benign EPIPE/ERR_STREAM_DESTROYED — child exited early */ });
    child.stdin.write(opts.stdin);
    child.stdin.end();
  }
  ```
- [ ] **Step 4: Run → passes. Step 5:** rebuild dist (`pnpm --filter @armyofagents/adapter-utils build`). **Step 6: Commit** `fix(adapters): A-H11 — swallow benign child-stdin EPIPE (was a server-wide crash)`.

### Task 4.3 — A-M17: preserve Codex session id past the 4MB cap

**Files:** Modify `packages/adapters/codex-local/src/server/execute.ts` (parse session id incrementally in the `onLog` stdout callback). Test: `packages/adapters/codex-local/src/server/session-id-cap.test.ts` (new).

**Verified cause:** `appendWithCap` keeps the TAIL of stdout (drops head); Codex sets `sessionId` only at the head `thread.started` event; parse runs on the truncated buffer → session id lost for >4MB runs → resume breaks.

- [ ] **Step 1: Failing test** — feed a `thread.started` line then >4MB of trailing JSONL through the capture/parse path → assert `resolvedSessionParams` non-null.
- [ ] **Step 2: Run → fails. Step 3: Implement** — extract `thread.started`/`thread_id` incrementally in the `onLog` callback (out-of-band, before capping) and thread it into the result, instead of re-parsing `proc.stdout`. **Step 4: Run → passes. Step 5: Commit** `fix(codex): A-M17 — capture session id out-of-band so it survives stdout truncation`.

---

## Phase 5 — Memory lifecycle

**Files:** `server/src/services/memory.ts`, `server/src/services/memory-lifecycle.ts`, `server/src/services/heartbeat.ts` (or `memory-skill-sync.ts`).

### Task 5.1 — A-M4: flag never-accessed stale items

**Files:** Modify `server/src/services/memory-lifecycle.ts:1,295` (import `isNull`/`or`; widen predicate). Test: `server/src/__tests__/memory-lifecycle.test.ts` (rewrite the stale test to actually call `flagStaleItems`).

**Verified cause:** predicate is `lt(accessedAt, cutoff)` only; `accessedAt` nullable → `NULL < cutoff` = NULL = never flagged. Existing test asserts a comment, never invokes the function.

- [ ] **Step 1: Failing test** (service-mock, sequence-db) — a row with `accessedAt=null` and old `createdAt` → expect 1 stale suggestion.
- [ ] **Step 2: Run → fails. Step 3: Implement** — `or(and(isNull(accessedAt), lt(createdAt, cutoff)), lt(accessedAt, cutoff))`; import `isNull, or`. **Step 4: Run → passes. Step 5: Commit** `fix(memory): A-M4 — flagStaleItems also flags never-accessed items`.

### Task 5.2 — A-M5: filter expired active_context from retrieval

**Files:** Modify `server/src/services/memory.ts:421-432` (`buildConditions` for `searchMultiPath`/`searchSemantic`) and `memory-skill-sync.ts:91-92` (pinned skills). Test: `server/src/__tests__/memory-retrieval-expiry.test.ts` (new).

**Verified cause:** `buildConditions` filters only company + status='approved' + scope; no `expiresAt` filter. `heartbeat.fetchMemoryContext` does no downstream filtering. Commander path (`memory-policy.ts:84`) correctly drops expired; retrieval doesn't.

- [ ] **Step 1: Failing test** (service-mock/integration) — approved `active_context` with past `expiresAt` → not returned by `searchMultiPath`/`fetchMemoryContext`.
- [ ] **Step 2: Run → fails. Step 3: Implement** — add `or(isNull(expiresAt), gt(expiresAt, sql\`now()\`))` to `buildConditions` (and the pinned-skill query). **Step 4: Run → passes. Step 5:** regression (non-expired active_context still served). **Step 6: Commit** `fix(memory): A-M5 — never serve expired active_context to agents`.

### Task 5.3 — A-M6: conflict-safe version-number allocation

**Files:** Modify `server/src/services/memory.ts:849-867,964-1006,1541-1569` (`suggestUpdate`, `saveDraft`, `changeLayer`). Test: `server/src/__tests__/memory-version-race.integration.test.ts` (new, real-DB).

**Verified cause:** read max version + insert `+1` with no row lock/tx; per-agent dedup keys on `createdBy` so two agents read the same `latest` → unique-index 23505 → unhandled 500.

- [ ] **Step 1: Failing integration test** — two concurrent `suggestUpdate` from different agentIds → both succeed, distinct version numbers, no 500.
- [ ] **Step 2: Run → fails. Step 3: Implement** — uniformly: `SELECT … FOR UPDATE` the parent `memory_items` row inside a transaction before allocating, OR `INSERT … ON CONFLICT (memory_item_id, version_number) DO NOTHING` + retry. Apply to all three call sites. **Step 4: Run → passes. Step 5: Commit** `fix(memory): A-M6 — serialize version-number allocation (was an unhandled 500)`.

---

## Phase 6 — Discussions / threads

**Files:** `server/src/services/discussions.ts`, `server/src/services/internal-agent/aoa-agents/thread-agent-action-freshness.ts` + `thread-agent-actions.ts`, `server/src/services/internal-agent/aoa-agents/thread-scope-versions.ts`, `server/src/db-errors.ts`.

### Task 6.1 — A-H7: `linkEntry` reassigns seq + bumps target entrySeq

**Files:** Modify `server/src/services/discussions.ts:1725-1752`. Test: `server/src/__tests__/link-entry-seq.integration.test.ts` (new, real-DB — the partial unique index `(discussionId, seq) WHERE seq<>0` needs real Postgres).

**Verified cause:** `UPDATE discussion_entries SET discussionId = target` without reassigning `seq`; target update bumps `entryCount` not `entrySeq`. → unique-index 23505 on collision, or silent ordering corruption + the controller skips the moved entry.

- [ ] **Step 1: Failing integration test** — move the 2nd entry of thread A into thread B which already has ≥2 entries → currently 500 (unique violation); after fix → succeeds, moved entry gets a fresh target seq, controller sees it.
- [ ] **Step 2: Run → fails. Step 3: Implement** — inside the tx, atomically `UPDATE discussions SET entrySeq = entrySeq + 1 … RETURNING entrySeq` for the target, then set the moved entry's `seq` to that value (fold the `entryCount + 1` into the same update). **Step 4: Run → passes. Step 5: Commit** `fix(threads): A-H7 — linkEntry reassigns seq into the target thread's seq space`.

### Task 6.2 — A-M7: tolerate same-batch sibling scope draft in freshness check

**Files:** Modify `server/src/services/internal-agent/aoa-agents/thread-agent-action-freshness.ts:135,191-196` (or commit scope-coupled actions as one unit). Test: real-DB integration.

**Verified cause:** scope-coupled actions (`create_scope_draft`/`add_scope_item`/`create_artifact_candidate`) keep the scope-version check; a sibling `create_scope_draft` committing earlier in the same `asc(createdAt)` batch changes `latestScopeVersionId` → the dependent action is `suppressed_stale` even though it would reuse that draft.

- [ ] **Step 1: Failing integration test** — two-action batch (create_scope_draft + add_scope_item) with no pre-existing draft → assert the sibling is NOT `suppressed_stale`.
- [ ] **Step 2: Run → fails. Step 3: Implement** — make the scope-version freshness check tolerant of a draft this batch is producing (treat snapshot null/accepted → brand-new draft as non-conflicting for scope-coupled actions whose commit reuses that draft), OR commit the draft + dependent scope items as one transactional unit keyed off the shared draft. **Step 4: Run → passes. Step 5: Commit** `fix(threads): A-M7 — do not suppress scope-coupled actions behind their own batch's draft`.

### Task 6.3 — A-M18: handle both unique constraints in `createDraftFromThread`

**Files:** Modify `server/src/services/internal-agent/aoa-agents/thread-scope-versions.ts:810`, `server/src/db-errors.ts:46-48`. Test: real-DB integration + service-mock unit on the error branch.

**Verified cause:** two racers past the early-return both insert `versionNumber=latest+1, status='draft'`, violating BOTH `thread_version_uq` and `one_draft_uq`; the catch only matches `one_draft_uq`, and Postgres reports `thread_version_uq` first (created first in the migration) → loser re-throws as 500.

- [ ] **Step 1: Failing unit** (service-mock) — an `err` carrying `constraint: 'thread_scope_versions_thread_version_uq'` → expect convergence to `{ status:'existing_draft' }`, not a throw. **Plus** integration: two concurrent `createDraftFromThread`, loser returns `existing_draft`.
- [ ] **Step 2: Run → fails. Step 3: Implement** — broaden the catch to also handle `thread_version_uq` (re-load latest draft on either), or catch any 23505 on this table and re-select. **Step 4: Run → passes. Step 5: Commit** `fix(threads): A-M18 — converge concurrent draft creation on either unique constraint`.

---

## Phase 7 — DB schema

### Task 7.1 — A-H12: quota unique index `NULLS NOT DISTINCT`

**Files:** Modify `packages/db/src/schema/provider_quota_windows.ts:42-48`; generate migration via `pnpm db:generate`. Test: `server/src/__tests__/quota-windows-dedup.integration.test.ts` (new, real-DB).

**Verified cause:** unique index on `(company_id, provider, model, window_kind)` with nullable `model`; refresh always passes `model=null`; Postgres treats NULL as distinct → `ON CONFLICT` never matches → a new row every refresh.

- [ ] **Step 1: Failing integration test** — call `quotaWindowsService.refresh(companyId,'claude_local')` twice → currently 2 rows per window; after fix → 1 (updated).
- [ ] **Step 2: Run → fails. Step 3: Implement** — Decision: **option (a)** `NULLS NOT DISTINCT` on the unique index (Drizzle: `.on(...).nullsNotDistinct?`; if unsupported, hand-author the migration SQL `CREATE UNIQUE INDEX … (…) NULLS NOT DISTINCT`). Run `pnpm db:generate`; verify the migration. (NEVER hand-write the migration file outside the Drizzle flow per Critical Rule #1 — generate it; only adjust if Drizzle can't express NULLS NOT DISTINCT, then add a follow-up raw index in a generated migration body.)
- [ ] **Step 4: Run → passes (in Docker-Linux against real PG). Step 5:** migration-journal integrity check. **Step 6: Commit** `fix(db): A-H12 — quota unique index NULLS NOT DISTINCT so model-less upserts dedup`.

> **Risk:** existing duplicate rows in deployed DBs must be de-duped before the unique index can apply. Include a data-cleanup step in the migration (delete all but the newest per `(company_id,provider,window_kind)` where `model IS NULL`) BEFORE creating the index, or the migration fails on dirty data.

---

## Phase 8 — Workspace / jobs / marketplace / plugins

### Task 8.1 — A-M13: Windows-aware shell in `runWorkspaceCommand`

**Files:** Modify `server/src/services/workspace-runtime.ts:540-546`. Test: `server/src/__tests__/workspace-run-command-shell.test.ts` (new).

**Verified cause:** the no-recorder branch resolves `process.env.SHELL || "/bin/sh"` + `["-c", …]`; the Windows-aware `shellInvocation()` (lines 109-123) exists and is used by the recorder branch (:636) but not here → ENOENT on Windows with SHELL unset.

- [ ] **Step 1: Failing unit** — mock `process.platform='win32'`, SHELL unset; call `runWorkspaceCommand`; assert `executeProcess` is invoked with `powershell.exe` + `-Command` (via `shellInvocation`), not `/bin/sh`.
- [ ] **Step 2: Run → fails. Step 3: Implement** — replace the inline resolution with `shellInvocation(input.command)` (note it uses `-lc`/`-Command`, not `-c`). **Step 4: Run → passes. Step 5: Commit** `fix(workspace): A-M13 — use the platform shell in runWorkspaceCommand`.

### Task 8.2 — A-M16: atomic manual `triggerJob`

**Files:** Modify `server/src/services/plugin-job-scheduler.ts:455-493`. Test: `server/src/__tests__/plugin-trigger-job-overlap.test.ts` (new).

**Verified cause:** TOCTOU — `activeJobs.has` + a DB guard filtering only `status='running'`; `createRun` inserts `status='queued'` so the guard can't see it; `activeJobs.add` happens later inside the async `dispatchManualRun`.

- [ ] **Step 1: Failing test** (service-mock) — two concurrent `triggerJob` in one tick → assert only one `workerManager.call("runJob")`.
- [ ] **Step 2: Run → fails. Step 3: Implement** — `activeJobs.add(jobId)` synchronously inside `triggerJob` before `void dispatchManualRun` (remove in its `finally`); and include `'queued'` in the existing-runs guard. (Note: true multi-instance atomicity needs a conditional DB claim — out of scope; single-process correctness here.) **Step 4: Run → passes. Step 5: Commit** `fix(plugins): A-M16 — close the manual triggerJob overlap TOCTOU`.

### Task 8.3 — A-M15: preserve section order in marketplace merge

**Files:** Modify `server/src/services/marketplace-merge.ts:74-123`. Test: `server/src/__tests__/marketplace-merge.test.ts` (extend).

**Verified cause:** diff is built in `theirSections` order, `removed` (kept) sections appended at the end → `mine=A,B,C` vs `theirs=A,C` outputs `A,C,B`.

- [ ] **Step 1: Failing unit** — `computeSectionDiff` + `applyMergeDecisions` over the A/B/C vs A/C fixture → assert output order `A,B,C`.
- [ ] **Step 2: Run → fails. Step 3: Implement** — build the retained result in `mine` order (insert retained/removed entries at their original index relative to surviving neighbors), interleaving theirs-only `added` sections at their anchor. **Step 4: Run → passes. Step 5: Commit** `fix(marketplace): A-M15 — preserve user section order when merging skill updates`.

### Task 8.4 — B-M3: goal re-parent rejects cross-tenant parents

**Files:** Modify `server/src/services/goals.ts:341-343` (`setGoalParents`). Test: `server/src/__tests__/goal-reparent-tenant.test.ts` (new) + route-mount.

**Verified cause:** route gates only the child's company; `setGoalParents` passes `parentIds` with no parent-company check; `isScopeWithinParent` returns true for a foreign company-wide goal (no project_goals); `goal_parents` has no companyId column.

- [ ] **Step 1: Failing test** — `setGoalParents(childId, [foreignGoalId])` → reject (400/404); no edge written.
- [ ] **Step 2: Run → fails. Step 3: Implement** — `SELECT id, companyId FROM goals WHERE id IN (parentIds)`; assert all `companyId === existing.companyId`; else throw. (Defense-in-depth follow-up: add companyId column to `goal_parents`.) **Step 4: Run → passes. Step 5:** regression (same-tenant multi-parent + company-wide same-tenant parent still allowed). **Step 6: Commit** `fix(goals): B-M3 — reject cross-tenant goal re-parent edges`.

### Task 8.5 — B-M5: enforce per-company plugin availability in host services

**Files:** Modify `server/src/services/plugin-host-services.ts:290-300`. Test: `server/src/__tests__/plugin-host-company-gate.test.ts` (new).

**Verified cause:** `ensurePluginAvailableForCompany` is an empty no-op; `inCompany` only checks the worker-supplied id; `companies.list()` returns all tenants → one plugin reaches every company regardless of the `enabled` toggle.

- [ ] **Step 1: Failing test** — `issues.list({companyId: B})` where the plugin is disabled for B → rejected; enabled company still works.
- [ ] **Step 2: Run → fails. Step 3: Implement** — implement `ensurePluginAvailableForCompany(companyId)` to fail-closed when no `plugin_company_settings` row enables the plugin for that company (product decision: default-deny vs explicit-allow — default to **fail-closed on `enabled=false`**). **Step 4: Run → passes. Step 5: Commit** `fix(plugins): B-M5 — enforce per-company enable gate in host services`.

### Task 8.6 — B-M4 (partial): tighten plugin fs-read + document egress limitation

**Files:** Modify `server/src/services/plugin-sandbox.ts:22-33`. Test: `server/src/__tests__/plugin-sandbox-argv.test.ts` (new) + a docs note.

**Verified cause:** untrusted tier gets `--allow-fs-read=*` and unrestricted network (Node `--permission` has no `--allow-net`). Network boundary is NOT in-process-fixable.

- [ ] **Step 1: Failing unit** — `buildSandboxExecArgv` emits `--allow-fs-read=<pkgDir>` + `<scratchDir>`, NOT `*`.
- [ ] **Step 2: Run → fails. Step 3: Implement** — scope `--allow-fs-read` to the plugin package dir + scratch dir. Add a doc note (`docs/architecture/decisions.md` or plugin security doc) that **no trust tier provides a network-egress boundary** (requires OS isolation) and ensure the install/approval UI surfaces the trust tier. **Step 4: Run → passes. Step 5: Commit** `fix(plugins): B-M4 (partial) — scope plugin fs-read + document the egress limitation`.

> **Explicitly deferred:** the actual network-egress enforcement (network-namespace/seccomp container or mandatory egress proxy) is infra work, tracked separately — NOT in batch-4.

---

## Final verification (before opening the PR) — no CI burn

- [ ] `pnpm -r typecheck` → 0 errors
- [ ] `pnpm -r build` → 0 errors
- [ ] Full server suite (Windows) → 0 fail (integration tests skip)
- [ ] Full UI suite → 0 fail
- [ ] Adapter suites (adapter-utils + grok/acpx/codex) → 0 fail
- [ ] **Docker-Linux integration run** (`aoa-lx`, as `node` user) for ALL new `*.integration.test.ts` (M6, M9, M12, M14, M18, H7, H12, A-M5 if integration) → 0 fail. These are the ones the Windows suite skips and the only way to prove the race/SQL/constraint fixes.
- [ ] Rebuild `adapter-utils` dist after its src edits (H11, M17).

## PR + Codex loop

- [ ] Open `batch-4` PR into `feat/v1-combined`; address any Codex P1/P2 before merge (same loop as batch-3); reply in-thread.
- [ ] Merge after green local verify + Codex cleared.

## After batch-4 (separate efforts, not this PR)

- Workflow C (tests/CI + design/DX review) → Workflow D (synthesis → go/no-go).
- B-M4 network-egress OS isolation (infra).
- Restore GitHub Actions (org billing) — needed to protect `main` and get CI signal (note: `main` is currently UNPROTECTED, so it does not block the `combined→main` v1 merge).

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Self-review | writing-plans self-check | coverage / placeholders / type consistency | 1 | CLEAR | 27/27 findings mapped; no placeholders |
| Codex Review | `/codex review` | independent 2nd opinion | 1 | issues_found (GATE: FAIL) | 7 [P1] + 8 [P2]; all verified valid against code; corrections applied above |

- **CODEX:** GATE FAIL on first draft. All 7 P1 (A-H8 return-shape bug, A-M9/A-M18/A-M7 wrong paths, A-M10 wrong default, B-M5 wrong default-deny, A-H9 missing wakeup) + 8 P2 verified against `9de8a100e` and folded into the "Codex review — verified corrections" section, which overrides the affected task bodies.
- **CROSS-MODEL:** my own re-verification independently confirmed every Codex structural claim (paths, return-shape, schema default-enabled, native `.nullsNotDistinct()`).
- **UNRESOLVED:** 0 — all review findings are dispositioned (applied or confirmed-correct).
- **VERDICT:** plan CLEARED for execution **after** the corrections section. Recommend subagent-driven execution, Phase 1 first (B-H1 is the highest-risk fix — audit `resolveUserScope` callers before landing).
