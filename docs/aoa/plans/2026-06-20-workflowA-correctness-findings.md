# Workflow A — Correctness Review Findings (feat/v1-combined)

**Date:** 2026-06-20 · **Method:** 13 subsystem reviewers + 2 adversarial skeptics per finding (default-to-refuted) · **Agents:** 85

**Totals:** 31 confirmed (1 blocker, 12 high, 18 medium), 2 contested.

> Confirmed = neither skeptic could refute it; each finding was traced in code by 2 independent verifiers. Sanity-check before fixing.

---

## BLOCKER

### B1. Cleanup-retry sweeper rm -rf's the project workspace / repo on disk — missing the containment guard that the main cleanup path enforces

- **Severity:** blocker · **Confidence:** high · **Subsystem:** workspaces (execution workspace runtime, TTL/cleanup sweepers, git ops, authz)
- **Location:** `server/src/services/workspace-cleanup-retry-sweeper.ts:40-52`
- **Category:** data-integrity / data-loss

**What:** retryCleanupFailedWorkspaces() iterates every execution_workspaces row in status 'cleanup_failed' (closedAt older than 60s) and unconditionally runs `await rm(ws.providerRef ?? ws.cwd, { recursive: true, force: true })`. There is NO check that the target path is the shared project workspace / primary repo. By contrast, the canonical cleanup path cleanupExecutionWorkspaceArtifacts() (workspace-runtime.ts ~1228-1238) explicitly REFUSES to delete a local_fs path when it `containsProjectWorkspace` (path equals, or is an ancestor of, the project workspace cwd). The retry sweeper bypasses that guard entirely, so a workspace whose cwd/providerRef IS (or contains) the project workspace can have its directory blown away.

**Why it's a bug:** A 'cleanup_failed' status is the exact outcome produced when cleanupExecutionWorkspaceArtifacts() deliberately does NOT remove a directory. cleaned is computed (workspace-runtime.ts:1260) as `!workspacePath || !(await directoryExists(workspacePath))`. For a shared_workspace whose providerType is local_fs with createdByRuntime=false, none of the removal branches run, so the directory still exists -> cleaned=false. For a shared git_worktree workspace that points at the project's primary checkout, `git worktree remove --force` fails (git refuses to remove the main working tree), the error is swallowed into warnings, the directory remains -> cleaned=false. In the archive route (routes/execution-workspaces.ts:209-211) `if (!cleanupResult.cleaned) cleanupPatch.status = 'cleanup_failed'`. The retry sweeper (scheduled every 60s in index.ts:637) then rm -rf's providerRef ?? cwd — i.e. the shared project workspace directory / git repo — causing permanent loss of the user's local repo and any uncommitted work.

**Repro:** 1. Project with a shared/project_primary execution workspace whose cwd is the project workspace checkout (providerType local_fs createdByRuntime=false, OR a git_worktree session pointing at the primary worktree). 2. Archive it via PATCH /execution-workspaces/:id {status:'archived'} (allowed: shared workspaces only warn, never block; isDestructiveCloseAllowed=true). 3. cleanupExecutionWorkspaceArtifacts removes nothing -> cleaned=false -> row set to status 'cleanup_failed'. 4. Within ~60s scheduleCleanupRetrySweeper fires retryCleanupFailedWorkspaces, which rm -rf's the project workspace cwd, destroying the shared repo on disk.

**Fix:** In retryCleanupFailedWorkspaces, before rm(target): (a) skip/never rm shared_workspace or git_worktree rows whose path resolves to the project workspace/primary checkout (re-apply the same containsProjectWorkspace ancestor/equality check used in cleanupExecutionWorkspaceArtifacts, looking up projectWorkspaces.cwd / project primary), and prefer `git worktree remove` over rm for git_worktree provider types; and (b) fix the upstream root cause so a workspace that intentionally was not removed is not marked 'cleanup_failed' — compute `cleaned` as true when the cleanup path made a deliberate no-op/refusal (e.g. only flag cleanup_failed when an actual removal was attempted and failed).

---

## HIGH

### H1. MCP attach-artifact-version: cross-tenant artifact write for founder-scope actors (no companyId check)

- **Severity:** high · **Confidence:** high · **Subsystem:** auth-rbac
- **Location:** `server/src/mcp/tools/write-tools.ts:334-389 (esp. 349-353)`
- **Category:** cross-tenant-isolation

**What:** handleAttachArtifactVersion fetches the target artifact with ctx.services.artifactsSvc.getById(parsed.artifactId), which queries artifactVersions/artifacts purely by id with NO company filter (services/artifacts.ts getById -> fetchWithVersions, eq(artifacts.id,...)). Authorization is then delegated to filterArtifactsForScope(ctx.db, ctx.scope, [artifact]). For a founder scope, filterArtifactsForScope is a no-op (scope.ts:177 `if (scope.kind === 'founder') return rows;`), so the foreign artifact passes the visibility gate. The subsequent permission check canAccessEntity(..., 'artifact', 'update', { departmentId: linkedProjectId }) also returns true for a real founder (permissions.ts:227 `if (await isFounder(companyId, userId)) return true;`, evaluated against ctx.companyId = the attacker's own company). artifactsSvc.addVersion(artifactId, ...) then writes a new immutable artifact version onto the company-B artifact, also unscoped by company. Net: a founder of company A (via board session OR a founder-created MCP key replaying that founder userId) can append an immutable version to ANY artifact in ANY other company by supplying its artifactId.

**Why it's a bug:** Every other MCP write/read handler in this subsystem (create-task line 206, update-task line 262, suggest-memory's linked task line 96, update-task-status line 154, add-task-comment line 311, and ALL approval tools via `approval.companyId !== ctx.companyId`) explicitly verifies `entity.companyId !== ctx.companyId` before acting. attach-artifact-version is the lone write handler that relies solely on filterArtifactsForScope, which intentionally short-circuits for founder scope and never re-checks companyId. Because artifact getById and addVersion are both company-agnostic, the only thing that would have stopped a cross-company write is a companyId equality check, and it is missing. This is the same vulnerability class the team already closed in costs.ts (PATCH /agents/:id/budgets) and search.ts resolveScope per docs/aoa/plans/2026-06-17-authz-cross-tenant-budget-search-plan.md, but this handler was not covered. Artifact versions are immutable (Decisions #43/#45), so the write is also non-reversible pollution of another tenant's deliverable history.

**Repro:** As a founder of company A, obtain the artifactId of an artifact owned by company B. Call MCP tools/call name='attach-artifact-version' with { artifactId: '<company-B-artifact-id>', sourceDetail: 'x', content: 'injected' } against POST /companies/<company-A-id>/mcp using a board session or a founder MCP key. ensureProtocolAccess passes (URL company A is the founder's own). filterArtifactsForScope returns the row (founder no-op), isFounder(companyA, founderUserId) is true so canAccessEntity returns true, and addVersion writes versionNumber=N+1 onto company B's artifact.

**Fix:** After fetching `artifact`, add an explicit tenant check before any scope/permission logic: `if (!artifact || artifact.companyId !== ctx.companyId) return notFoundResult('Artifact not found');` (mirroring create-task/update-task). Keep the existing filterArtifactsForScope + canAccessEntity checks for intra-company department scoping.

### H2. MCP resources/read goals & artifacts: cross-tenant read by id (tasks branch checks companyId, goals/artifacts do not)

- **Severity:** high · **Confidence:** high · **Subsystem:** auth-rbac
- **Location:** `server/src/mcp/server.ts:481-531 (goals 487-493, artifacts 523-529)`
- **Category:** cross-tenant-isolation

**What:** In the resources/read handler, the single-item TASK branch correctly guards cross-tenant access: `const row = await issuesSvc.getById(resource.id); if (!row || row.companyId !== companyId || !canAccessProjectScopedEntity(...)) return 404` (line 472-475). The single-item GOAL branch (487-493) does `row = await goalsSvc.getById(resource.id)` then `filterGoalsForScope(db, scope, [row])` with NO `row.companyId === companyId` check; goalsSvc.getById fetches by `eq(goals.id, id)` only (services/goals.ts:204-213, no company filter). The single-item ARTIFACT branch (523-529) is identical: `artifactsSvc.getById(resource.id)` (company-agnostic) then `filterArtifactsForScope`. For a founder scope both filter functions are no-ops (scope.ts:134 and :177), so a foreign-company goal/artifact is returned in full. The MEMORY branch is safe because memorySvc.getById(companyId, id) is company-scoped (services/memory.ts:190-195).

**Why it's a bug:** The same file demonstrates the correct pattern one branch above (tasks: explicit `row.companyId !== companyId`). Goals and artifacts diverge from that pattern and rely on filter functions that are documented no-ops for founder scope. resolveUserScope returns `{ kind: 'founder' }` whenever the caller has a founder role OR has zero user_roles rows (scope.ts:17) — the latter means an MCP-key user with no roles, and agents (whose userId is the synthesized agentId, never present in user_roles) also resolve to founder scope. So this leaks to board founders, founder/no-role MCP keys, and agent actors alike. ensureProtocolAccess only validates the URL company, not the resource's owning company, so the arbitrary resource.id is never re-checked.

**Repro:** As any founder-scope MCP caller for company A (board session, founder MCP key, or agent run JWT), POST /companies/<company-A-id>/mcp with { method: 'resources/read', params: { uri: 'aoa://goals/<company-B-goal-id>' } } (or 'aoa://artifacts/<company-B-artifact-id>'). The foreign goal/artifact (with its full version content) is returned instead of a 404.

**Fix:** In both the goals and artifacts single-item branches, add a companyId equality check before/after the filter, mirroring the tasks branch: for goals `if (!row || row.companyId !== companyId) return 404;` then run filterGoalsForScope; for artifacts `if (!row || row.companyId !== companyId) return 404;` then filterArtifactsForScope. Alternatively give goalsSvc/artifactsSvc.getById a companyId parameter like memorySvc.getById.

### H3. Agent can self-approve identity/domain memory via memory.retain personal-scope path, poisoning company-wide context (violates Critical Rule #6)

- **Severity:** high · **Confidence:** high · **Subsystem:** mcp
- **Location:** `server/src/mcp/tools/write-tools.ts:440-496`
- **Category:** auth / broken-invariant

**What:** handleMemoryRetain's personal-scope path auto-approves the created memory item whenever (scopeToSelf === true && actor.source === 'agent' && agentId !== null). The branch does NOT constrain `layer`: `parsed.layer` is z.enum(MEMORY_ITEM_LAYERS), so an agent can pass layer='identity' (or 'domain'). The item is created with source='agent' (status pending) and then immediately flipped to 'approved' via memorySvc.approve(), with agentId set to the caller. The handler's own docstring (lines 414-416) claims 'agents cannot write to identity / domain memory directly' and that auto-approve is gated on the layer, but that guard is never implemented — only scopeToSelf + actor==agent are checked.

**Why it's a bug:** Critical Rule #6 states agents may only suggest memory (status pending) and only the founder may approve identity + domain layers. This path lets a worker agent self-approve an identity-layer item. Crucially, the 'personal bucket' isolation that the comment relies on does NOT hold for identity layer: server/src/services/internal-agent/context-assembly.ts:184-193 builds the 'Company Identity Memory' section by selecting ALL memory_items WHERE companyId=X AND layer='identity' AND status='approved' — with NO agentId filter. So an agent-personal identity item is injected into the company-wide identity context that every agent (and Commander) treats as ground truth. memorySvc.approve() (services/memory.ts:258-264) performs a bare status update with no layer/role gate. This is a memory-poisoning / privilege-escalation vector: a single misbehaving or compromised agent can rewrite company vision/values/identity for the whole org.

**Repro:** As an agent actor (run JWT), POST /companies/:cid/mcp tools/call name='memory.retain' arguments={title, content (malicious 'company value'), category, layer:'identity', sourceContext:'x', scopeToSelf:true}. Response returns status:'approved'. The item then appears in every agent's assembled 'Company Identity Memory' section.

**Fix:** In handleMemoryRetain, before taking the auto-approve branch, reject when parsed.layer is 'identity' or 'domain' (return forbiddenResult), i.e. only allow personal-scope auto-approve for 'working' (and optionally 'active_context'). Equivalently: compute isPersonalScope = scopeToSelf && isAgentActor && agentId && (layer === 'working' || layer === 'active_context'); otherwise fall through to the pending path. Also confirm context-assembly should exclude agentId-scoped personal items from company-wide identity/domain sections.

### H4. attach-artifact-version writes to artifacts of ANY company — missing companyId ownership check (cross-tenant write)

- **Severity:** high · **Confidence:** high · **Subsystem:** mcp
- **Location:** `server/src/mcp/tools/write-tools.ts:334-389`
- **Category:** cross-tenant isolation

**What:** handleAttachArtifactVersion fetches the artifact with artifactsSvc.getById(parsed.artifactId), which queries by id ALONE (services/artifacts.ts:33-35 → fetchWithVersions(db, id); no companyId predicate). It then calls filterArtifactsForScope(db, scope, [artifact]); for a founder scope that function returns the row unchanged (scope.ts:177). The permission gate permissionsSvc.canAccessEntity(...) short-circuits to true for founders (permissions.ts:227). It then calls artifactsSvc.addVersion(parsed.artifactId, ...), which also has no companyId predicate (artifacts.ts:105-148). At no point is artifact.companyId compared to ctx.companyId.

**Why it's a bug:** The route ensureProtocolAccess only authorizes the caller against the URL company (company A). Within company A's MCP endpoint, the artifactId argument is never validated to belong to company A. Any caller resolving to founder scope (an MCP Bearer key owned by a founder, the local_trusted local-board actor, OR any agent actor — agents resolve to founder scope, see resolveUserScope scope.ts:17 returning founder when roles.length===0) can pass a company B artifactId and append an immutable version to company B's artifact. The sibling write tools (update-task, update-task-status, add-task-comment, create-task, suggest-memory) all correctly check `entity.companyId !== ctx.companyId`; this one does not, making it an outlier and a genuine tenant-isolation break.

**Repro:** Hold an MCP key (or run as agent) for company A. POST /companies/{companyA}/mcp tools/call name='attach-artifact-version' arguments={artifactId:'<company-B-artifact-uuid>', sourceDetail:'x', content:'injected'}. A new artifact version is created on company B's artifact (and becomes currentVersionId).

**Fix:** After fetching the artifact, return notFoundResult('Artifact not found') when artifact.companyId !== ctx.companyId (do this before/independent of the founder-bypassing filterArtifactsForScope). Better: add a companyId param to artifactsSvc.getById/addVersion or have these tools verify ownership explicitly, matching the task tools' `companyId !== ctx.companyId` pattern.

### H5. resources/read for goals and artifacts returns cross-company rows by id (missing companyId check)

- **Severity:** high · **Confidence:** high · **Subsystem:** mcp
- **Location:** `server/src/mcp/server.ts:481-531`
- **Category:** cross-tenant isolation

**What:** In the JSON-RPC resources/read handler, the single-id goals path calls goalsSvc.getById(resource.id) then filterGoalsForScope(db, scope, [row]); the single-id artifacts path calls artifactsSvc.getById(resource.id) then filterArtifactsForScope(db, scope, [row]). Both getById helpers query by id only (goals.ts:204-213, artifacts.ts:33-35 — no companyId predicate), and both filter functions return the row unchanged for founder scope (scope.ts:134, 177). There is no `row.companyId === companyId` guard, unlike the tasks path immediately above (server.ts:472-477) which explicitly checks `row.companyId !== companyId`, and unlike the memory path (server.ts:507) which uses memorySvc.getById(companyId, id).

**Why it's a bug:** A founder-scoped MCP caller (or agent actor, which resolves to founder scope) authorized for company A can read a goal or artifact belonging to company B simply by supplying B's UUID in the resource URI (e.g. aoa://goals/<companyB-goal-id> or aoa://artifacts/<companyB-artifact-id>). The list (no-id) variants are safe because goalsSvc.list / artifactsSvc.list are companyId-scoped, but the by-id variants are not. This is an inconsistency with the tasks and memory branches in the same handler, confirming the goals/artifacts branches simply forgot the company guard.

**Repro:** POST /companies/{companyA}/mcp method='resources/read' params={uri:'aoa://artifacts/<companyB-artifact-uuid>'} as a founder-scoped or agent actor → returns company B's artifact + versions. Same for aoa://goals/<companyB-goal-uuid>.

**Fix:** In both the goals and artifacts single-id branches, after fetching the row add `if (!row || row.companyId !== companyId) { return 404 }` before/in addition to the scope filter — mirroring the tasks branch at server.ts:473.

### H6. Periodic orphan reaper falsely fails queued runs that are correctly waiting behind the concurrency clamp

- **Severity:** high · **Confidence:** high · **Subsystem:** heartbeat-concurrency
- **Location:** `server/src/services/heartbeat.ts:1867-1911 (reapOrphanedRuns); triggered by index.ts:659-663 with staleThresholdMs=5*60*1000`
- **Category:** race-condition / data-integrity

**What:** reapOrphanedRuns() selects every run in status ['queued','running'] (line 1872-1875), skips only those present in the in-memory runningProcesses map (line 1880), and after the staleness threshold marks the rest 'failed' with errorCode 'process_lost' (line 1888). A run in status='queued' that is legitimately waiting behind the per-agent concurrency clamp has NO child process, so it is never in runningProcesses. The periodic reaper (server/src/index.ts:659, staleThresholdMs = 5 min, scheduler tick = 30s) therefore reaps such a queued run as 'process lost' even though nothing was lost — it was correctly waiting for an execution slot.

**Why it's a bug:** The clamp default is HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1 (line 134, confirmed by heartbeat-concurrency-clamp.test.ts). startNextQueuedRunForAgent (line 2100-2114) claims only `availableSlots = max - running` queued runs and intentionally LEAVES the remainder in status='queued'. For an agent with a long-running task and a second wakeup for a DIFFERENT issue, the second wakeup goes through the issue-scoped enqueueWakeup branch, finds no activeExecutionRun for issue B, and inserts a real heartbeat run with status='queued' (line 4704-4717) plus sets issues.executionRunId on issue B (line 4727-4735). That queued run's updatedAt is its creation time and is never bumped while it waits (nothing touches a waiting queued run's updatedAt absent a new coalescing wakeup). Coding-agent runs routinely exceed 5 minutes, so the queued follow-up crosses the 5-minute threshold and is reaped. On reap: setRunStatus->'failed/process_lost' (1888), setWakeupStatus->'failed' (1893) so the queued work is lost, and releaseIssueExecutionAndPromote (1905) clears issue B's executionRunId. Net effect: a perfectly valid queued task is silently failed and its issue lock dropped, so the agent never executes it until some unrelated future wakeup re-triggers it.

**Repro:** 1) Set an agent's heartbeat.maxConcurrentRuns to 1 (the default). 2) Wake the agent on issue A; its run goes running and the adapter takes >5 min (normal for a coding task). 3) Within that window, wake the same agent on a different issue B -> a heartbeat run is created in status='queued' (waiting for the single slot) and issues.executionRunId(B) is set. 4) After 5 minutes the periodic reaper tick (every 30s) sees run B queued, not in runningProcesses, updatedAt older than 5 min -> marks it failed/process_lost, fails its wakeup, and releases issue B's execution lock. 5) Issue B is now left with no queued run and no execution; the work is silently dropped.

**Fix:** The reaper must only treat status='running' runs as orphan candidates (a queued run has no process to lose). Either restrict the select to ['running'], or in the periodic (threshold>0) path skip status='queued' rows: add `if (staleThresholdMs > 0 && run.status === 'queued') continue;`. Startup reap (threshold===0) can still fail queued runs because the process map is genuinely empty after a restart.

### H7. linkEntry moves an entry between threads without reassigning seq — breaks the per-thread seq unique index and the orchestration/freshness cursor

- **Severity:** high · **Confidence:** high · **Subsystem:** discussions-threads
- **Location:** `server/src/services/discussions.ts:1725-1755`
- **Category:** data-integrity / broken-invariant

**What:** linkEntry() moves a discussion_entries row to a different discussion via `UPDATE discussion_entries SET discussionId = targetDiscussionId` but does NOT reassign the entry's `seq`, and does NOT bump the target discussion's `entrySeq` counter (it only increments the denormalized `entryCount`). The moved entry retains the `seq` value assigned by the SOURCE discussion's entrySeq counter, which is meaningless in the target discussion's independent seq space.

**Why it's a bug:** `seq` is the per-thread monotonic counter the entire PR-B orchestration relies on. There is a partial UNIQUE index on `(discussionId, seq) WHERE seq <> 0` (packages/db/src/schema/discussions.ts:230-234). Two failure modes: (1) If the target already has an entry whose seq equals the moved entry's seq (common — e.g. moving an entry with seq=3 into any thread with >=3 entries), the UPDATE violates the partial unique index and throws Postgres 23505, unhandled in linkEntry and the route (server/src/routes/discussions.ts:1009-1014) → 500. (2) If seqs don't collide, the move silently corrupts ordering: runController (thread-orchestration.ts:516-540) point-reads the cursor entry's seq and selects `seq > cursorSeq` ordered by seq — a moved entry with a low seq is skipped forever, and the freshness snapshot's entrySeq/latestHumanSeq (thread-agent-action-freshness.ts) and the scope-proposal stale check `proposalCursorSeq vs entrySeq` (thread-deliverables.ts) read corrupted values. The target's entrySeq counter is also never advanced, so the next addEntry on the target can re-issue a seq the moved entry already occupies → another duplicate-seq collision.

**Repro:** Founder calls POST /companies/:cid/discussions/link moving an entry whose source-thread seq collides with an existing target-thread entry seq (e.g. move the 2nd entry of thread A into thread B which already has >=2 entries) → unique violation → 500. With non-colliding seqs, the moved entry is dropped from controller processing and skews freshness/stale comparisons.

**Fix:** Inside the linkEntry transaction, atomically bump the TARGET discussion's entrySeq (`UPDATE discussions SET entrySeq = entrySeq + 1 ... RETURNING entrySeq`) and reassign the moved entry's seq to that new value in the same transaction (mirroring addEntry's seq-assignment), instead of leaving the stale source seq. The target entryCount bump can fold into the same UPDATE.

### H8. create_artifact_version tool has NO company-scope check — cross-tenant write + immutability/versioning corruption

- **Severity:** high · **Confidence:** high · **Subsystem:** artifacts-outputs
- **Location:** `server/src/services/internal-agent/tools/artifact-create-version.ts:37-93`
- **Category:** auth / cross-tenant isolation

**What:** The `create_artifact_version` crew-agent tool accepts an arbitrary `artifactId` from the model's tool params and, inside a transaction, allocates `max(version_number)+1`, inserts a new `artifact_versions` row, and repoints `artifacts.current_version_id` to it. It never verifies the target artifact belongs to `ctx.companyId`. `ctx.db` is the full unscoped Db and `authorizeToolInvocation` only gates by role/capability/allowlist — it does no per-entity company check. The tool body never references `ctx.companyId` at all.

**Why it's a bug:** Every other write path in this subsystem enforces tenant isolation explicitly: the sibling `attach_task_artifact` tool has a long security comment and does `row.companyId !== ctx.companyId → NOT_FOUND` before any write; the output-detection confirm route checks `existingArtifact.companyId !== run.companyId` (403); MCP document/version tools reach the artifact only via a company-scoped `task.artifactId` after `assertTaskAccess`; MCP version-push routes check `existing.companyId`. `create_artifact_version` is the lone outlier. Because the artifact's `current_version_id` is the artifact-as-input source (Decision #71), injecting a version into another tenant's artifact both violates tenant isolation AND poisons that tenant's downstream task context. It also violates the immutability/versioning invariant by mutating another company's version chain. The tool is registered (tool-registry.ts:124) and granted to Engineer and Planner crew agents (ensure-engineer.ts:42, ensure-command-staff.ts:106), which are LLM-driven over untrusted task/discussion/upstream-artifact content (prompt-injection surface).

**Repro:** Drive an Engineer/Planner crew agent in company A (e.g. via injected instructions in a task description or upstream artifact) to call create_artifact_version({ artifactId: <UUID of company B's artifact>, content: '...' }). The FK on artifact_id only requires the artifact to exist (any company), so the version inserts, version_number increments, and company B's artifacts.current_version_id is repointed to the attacker's content. No company-mismatch error is raised.

**Fix:** Inside the transaction, before allocating the version, load the artifact (SELECT company_id FROM artifacts WHERE id = artifactId) and return { success:false, error:'NOT_FOUND', summary:'Artifact not found' } when the row is missing OR row.companyId !== ctx.companyId — mirroring attach-task-artifact-tool.ts and the output-detection confirm route. Add a c2-artifact-create-version test asserting a cross-company artifactId is rejected with nothing written.

### H9. Cancelled dependency permanently deadlocks its dependents (no auto-unblock, checkout forever rejected)

- **Severity:** high · **Confidence:** high · **Subsystem:** tasks-deps-planning
- **Location:** `server/src/services/dependencies.ts:213, 295, 323-345 (and server/src/services/issues.ts:485)`
- **Category:** data-integrity / broken-invariant

**What:** The dependency model is asymmetric about the 'cancelled' terminal status. addDependency() auto-blocks a dependent only when the dependency is NOT in TERMINAL_STATUSES = ['done','cancelled'] (line 18, 84) — so it treats a cancelled dependency as 'satisfied' for the purpose of NOT blocking. But every unblock/satisfaction path treats ONLY 'done' as satisfied: resolveDependenciesTx uses `allDone = remaining.every(r => r.status === 'done')` (line 213), maybeUnblockTx uses `remaining.every(r => r.status === 'done')` (line 295), and issueService.hasUnmetDependencies returns `upstream.some(r => r.status !== 'done')` (issues.ts:485). handleCancelledDependency() (line 323) only writes a 'dependency.cancelled_warning' activity log entry — it never unblocks dependents or re-evaluates them.

**Why it's a bug:** A task D that is 'blocked' because of dependency C will never be released once C is cancelled. handleCancelledDependency does nothing but log. resolveDependencies only ever runs on a transition to 'done', and a cancelled task never becomes 'done'. If D has any cancelled dependency, allDone/every(status==='done') is permanently false, so completing the remaining (done) dependencies still leaves D blocked. hasUnmetDependencies also treats cancelled != done as 'unmet', so the heartbeat checkout path rejects D with 'Task has unmet dependencies' (issues.ts:1487) forever. The only escape is a human manually deleting the dependency row. This is a broken invariant: a dependency that can never complete pins the dependent in a non-terminal, non-executable state indefinitely.

**Repro:** 1) Create tasks C and D. 2) addDependency(D depends on C) -> D becomes 'blocked'. 3) Set C status to 'cancelled' via svc.update -> handleCancelledDependency only logs a warning. 4) D stays 'blocked'; resolveDependencies never fires for D; hasUnmetDependencies(D) returns true so agent checkout of D is rejected. Variant: D depends on C (cancelled) and E (done) -> completing E never unblocks D because allDone requires every dep === 'done'.

**Fix:** Treat 'cancelled' as a satisfied/terminal dependency in the release paths, consistent with the auto-block logic. Either (a) change the satisfaction predicate everywhere to `TERMINAL_STATUSES.includes(r.status)` (i.e. done OR cancelled) in resolveDependenciesTx (line 213), maybeUnblockTx (line 295), and hasUnmetDependencies (issues.ts:485); or (b) make handleCancelledDependency re-evaluate each blocked dependent and unblock it when all remaining deps are terminal (done|cancelled), mirroring maybeUnblockTx. Option (a) is the consistent fix and also unblocks the mixed done+cancelled case.

### H10. Workspaces are marked 'cleanup_failed' when no directory removal was even attempted (shared workspaces)

- **Severity:** high · **Confidence:** high · **Subsystem:** workspaces (execution workspace runtime, TTL/cleanup sweepers, git ops, authz)
- **Location:** `server/src/services/workspace-runtime.ts:1260-1268`
- **Category:** logic / broken-invariant

**What:** cleanupExecutionWorkspaceArtifacts returns `cleaned = !workspacePath || !(await directoryExists(workspacePath))`. This conflates 'the directory is gone' with 'cleanup succeeded'. For workspaces where removal is intentionally a no-op — shared_workspace/local_fs with createdByRuntime=false, or the explicit containsProjectWorkspace refusal branch (line 1237) — the directory still exists, so cleaned=false even though cleanup behaved exactly as designed. The route (routes/execution-workspaces.ts:209-211) then stamps status='cleanup_failed'.

**Why it's a bug:** cleanup_failed is meant to signal a transient teardown failure (e.g. Windows file-handle lock) that should be retried. Returning cleaned=false for deliberate no-ops mislabels healthy archives as failures, pollutes the status field, surfaces a wrong cleanupReason, and (combined with the retry sweeper) drives the destructive rm in finding #1. Even without the rm, it is a broken state-machine invariant: an archive that did everything right ends up 'cleanup_failed' forever.

**Repro:** Archive any shared_workspace whose providerType is local_fs with createdByRuntime=false: cleanup removes nothing, directoryExists stays true, cleaned=false, row -> 'cleanup_failed'.

**Fix:** Track whether a removal was actually attempted (e.g. return cleaned=true for the refusal branch and for provider/createdByRuntime combinations where no removal is expected). Only report cleaned=false when an attempted git worktree remove / rm left the directory behind.

### H11. Unhandled EPIPE on child stdin can crash the entire server process

- **Severity:** high · **Confidence:** high · **Subsystem:** adapters-wire
- **Location:** `packages/adapter-utils/src/server-utils.ts:318-321`
- **Category:** error-handling / availability

**What:** In runChildProcess, after spawning the child the parent writes the prompt to the child's stdin via `child.stdin.write(opts.stdin); child.stdin.end();` with NO `error` listener ever attached to `child.stdin`. If the child closes/exits its stdin before the parent finishes writing, the stdin stream emits an 'error' event (EPIPE / ERR_STREAM_DESTROYED).

**Why it's a bug:** A Node.js writable stream that emits 'error' with no registered listener throws the error as an uncaught exception. There is no `uncaughtException` handler in the main server process (the only one found is inside the separate MCP-bridge subprocess in server/src/services/internal-agent/mcp-bridge.ts), so the exception propagates and terminates the whole AoA server, killing all in-flight runs — a single bad run becomes a server-wide DoS. The claude and codex adapters both pass the full rendered prompt (task markdown + instructions, easily tens of KB to MB) as `stdin`, which exceeds the OS pipe buffer (~64KB), so write() does not flush synchronously and the EPIPE race window is wide whenever the child exits fast (e.g. missing/misconfigured CLI command — especially with shell:true on Windows — or a CLI that rejects auth and exits immediately).

**Repro:** Configure a claude_local or codex_local (or process) agent whose `command` exits immediately (e.g. a wrapper that does `exit 1` without reading stdin) and trigger a heartbeat with a large prompt/task. The child closes stdin before the parent finishes writing; the stdin 'error' (EPIPE) has no listener and crashes the server.

**Fix:** Attach an error handler before writing: `if (opts.stdin != null && child.stdin) { child.stdin.on('error', (err) => onLogError(err, runId, 'child stdin write error')); child.stdin.write(opts.stdin); child.stdin.end(); }`. EPIPE/ERR_STREAM_DESTROYED here is benign (the close handler still resolves with the captured exit code) and must be swallowed, not thrown.

### H12. provider_quota_windows unique index includes nullable `model`, so the adapter-refresh upsert never dedups and leaks duplicate rows unbounded

- **Severity:** high · **Confidence:** high · **Subsystem:** db-schema
- **Location:** `packages/db/src/schema/provider_quota_windows.ts:44-48 (uniqueIndex companyWindowUniqueIdx); paired writer: server/src/services/quota-windows.ts:62-87 + 107-118`
- **Category:** data-integrity / unique-constraint NULL semantics

**What:** The unique index `provider_quota_windows_company_window_unique_idx` is a plain btree on `(company_id, provider, model, window_kind)`, and `model` is nullable. The primary writer `quotaWindowsService.refreshWithAdapter()` ALWAYS passes `model: null` (quota-windows.ts:110) and upserts via `onConflictDoUpdate({ target: [companyId, provider, model, windowKind] })`. PostgreSQL treats NULL as distinct in a standard unique index, so `ON CONFLICT` with `model = NULL` can never match an existing row whose `model` is also NULL. Every adapter refresh therefore INSERTs a brand-new row instead of updating the prior snapshot.

**Why it's a bug:** This is the classic 'NULL is distinct in unique indexes' trap. The migration (0057_puzzling_jubilee.sql:70) creates the index with plain `USING btree (...)` — no `NULLS NOT DISTINCT`. Because the adapter path hard-codes model=null, the conflict target's NULL component guarantees no conflict is ever detected, so the DO UPDATE branch is dead for the dominant write path and rows accumulate. Corroboration that the team knows NULL model is a real, non-exceptional case: the company-portability import path (company-portability.ts:2854-2856) deliberately does a manual `qw.model === null ? isNull(model) : eq(model, qw.model)` SELECT-then-update/insert rather than relying on the unique index — i.e. it works around exactly this defect, while the live refresh path does not.

**Repro:** Call quotaWindowsService.refresh(companyId, 'claude_local') (or load the /costs UI, which triggers a refresh) twice against a real PostgreSQL. The adapter returns windows with model unset → two rows are written per window instead of one being updated. Repeated polling grows the table without bound; `list()` returns N stale duplicates and `getWindow()` returns an arbitrary one via `.limit(1)`. The existing unit tests miss this because they mock @armyofagents/db with Proxy stubs whose `onConflictDoUpdate` is a no-op and cannot reproduce Postgres NULL-distinct behavior.

**Fix:** Either (a) add `NULLS NOT DISTINCT` to the unique index (Postgres 15+) so NULL model rows collide as intended and ON CONFLICT works, or (b) store a non-null sentinel (e.g. empty string '') for model-less windows in both the schema default and all writers, or (c) make the refresh upsert path mirror the portability path's explicit isNull() SELECT-then-write. Option (a) is the smallest schema-level fix.

---

## MEDIUM

### M1. MCP update-task allows reassigning a task to a project owned by another company (dangling cross-company projectId)

- **Severity:** medium · **Confidence:** medium · **Subsystem:** auth-rbac
- **Location:** `server/src/mcp/tools/write-tools.ts:240-295 (esp. 267-269)`
- **Category:** data-integrity

**What:** handleUpdateTask validates the EXISTING task's company (existing.companyId !== ctx.companyId, line 262) but when the caller supplies a new `projectId`, it only calls `assertScopedProjectAccess(ctx.scope, parsed.projectId, 'Project')` (line 268). Unlike handleCreateTask, which fetches the project and rejects `project.companyId !== ctx.companyId` (line 204-208), update-task never verifies the new projectId belongs to ctx.companyId. assertScopedProjectAccess is a no-op for founder scope (scope.ts:74), so a founder can move one of their own tasks onto a projectId belonging to another company. issuesSvc.update writes the patch by id with no project-company validation.

**Why it's a bug:** This breaks the invariant that a task's projectId references a project in the same company. The asymmetry with create-task (which does validate) shows the check was simply omitted on the update path. Impact is bounded (the actor can only mutate their OWN company's task, and only to point at a foreign project id they happen to know), so it is data-integrity corruption / referential inconsistency rather than a direct data-exfiltration or privilege-escalation, hence medium not high. It can still produce confusing RBAC/scoping results downstream because project-scoped filters key on projectId.

**Repro:** As a founder of company A, call update-task with { taskId: '<company-A-task>', projectId: '<company-B-project-id>' }. The task is updated to reference company B's project; no 404/403 is returned.

**Fix:** Mirror create-task: when parsed.projectId is provided, fetch it and reject if `!project || project.companyId !== ctx.companyId` before assertScopedProjectAccess. Apply the same to the goalId field if goals can be cross-company linked.

### M2. memory.retain does not verify linked taskId/goalId/projectId/departmentId belong to the company

- **Severity:** medium · **Confidence:** medium · **Subsystem:** mcp
- **Location:** `server/src/mcp/tools/write-tools.ts:474-490`
- **Category:** data integrity / cross-tenant

**What:** handleMemoryRetain forwards parsed.taskId, goalId, projectId, departmentId directly into memorySvc.create() without verifying any of them belong to ctx.companyId. The sibling handleSuggestMemory DOES verify the linked task (loads it and checks linkedTask.companyId !== ctx.companyId, write-tools.ts:94-100) and applies assertScopedProjectAccess to the resolved department. In the personal-scope branch of memory.retain, even the scope assertions are skipped entirely (the `if (!isPersonalScope)` guard at line 447), so a (founder-scoped) agent can attach a foreign-company taskId/goalId reference to the new memory item.

**Why it's a bug:** This creates memory rows whose taskId/goalId/projectId point at entities in other companies (or outside the caller's scope). Beyond dangling/incorrect references, filterMemoryForScope keys visibility off these FK columns (scope.ts:144-170), so a mis-set foreign reference could in principle affect later RBAC filtering decisions. Lower severity than the artifact/goal reads because it does not by itself disclose foreign data, but it is a real integrity gap and an inconsistency with suggest-memory.

**Repro:** tools/call name='memory.retain' with taskId set to a UUID from another company and scopeToSelf:true (agent) — the item is created and auto-approved with the foreign taskId, no validation error.

**Fix:** Mirror suggest-memory: when taskId is provided, load it and 404/forbid on companyId mismatch / out-of-scope; run assertScopedProjectAccess on departmentId/projectId and assertScopedGoalAccess on goalId in BOTH paths (including personal-scope), or at minimum validate FK company ownership unconditionally.

### M3. update-task can move a task to a cross-company / out-of-company project (founder scope, no companyId check on new projectId)

- **Severity:** medium · **Confidence:** medium · **Subsystem:** mcp
- **Location:** `server/src/mcp/tools/write-tools.ts:267-284`
- **Category:** data integrity / cross-tenant

**What:** handleUpdateTask validates the existing task's companyId (line 261-265), but when parsed.projectId is supplied it only calls assertScopedProjectAccess(ctx.scope, parsed.projectId, 'Project') — which returns immediately for founder scope and never loads the project to confirm project.companyId === ctx.companyId. The new projectId is then written via issuesSvc.update. Contrast handleCreateTask (lines 204-210), which explicitly loads the project and rejects when project.companyId !== ctx.companyId before scope-checking.

**Why it's a bug:** A founder-scoped (or agent) caller can patch an in-company task's projectId to a UUID belonging to another company, corrupting project-membership and downstream RBAC scope resolution (which keys off issue.projectId). It is gated to callers who can already edit the task, so impact is integrity rather than disclosure, but it is an inconsistency with create-task's stricter check.

**Repro:** tools/call name='update-task' arguments={taskId:'<in-company-task>', projectId:'<other-company-project-uuid>'} as founder/agent → task.projectId is updated to the foreign project.

**Fix:** In handleUpdateTask, when parsed.projectId is provided, load the project and return notFoundResult/forbidden when !project || project.companyId !== ctx.companyId, before assertScopedProjectAccess — matching handleCreateTask.

### M4. flagStaleItems never flags never-accessed items (accessedAt IS NULL), contradicting its documented intent

- **Severity:** medium · **Confidence:** high · **Subsystem:** memory
- **Location:** `server/src/services/memory-lifecycle.ts:284-340 (key: line 295)`
- **Category:** logic-error / broken-invariant

**What:** flagStaleItems selects stale identity/domain items with a single WHERE predicate `lt(memoryItems.accessedAt, cutoff)` (line 295). memory_items.accessedAt is nullable with NO default (schema memory_items.ts:64), so a freshly approved item that has never been retrieved has accessedAt = NULL. In SQL, `NULL < cutoff` evaluates to NULL (not TRUE), so never-accessed items are silently excluded and can NEVER be flagged as stale, no matter how old they are.

**Why it's a bug:** The code's own evidence string at line 333 (`Last accessed: ${item.accessedAt?.toISOString() ?? "never"}`) and the day-count fallback at line 325 (`item.accessedAt?.getTime() ?? 0`) both anticipate accessedAt being null inside the suggestion-creation loop — i.e. the author intended NULL-accessedAt items to reach that code. More tellingly, the unit test memory-lifecycle.test.ts:403-412 ('items with null accessedAt and old createdAt are flagged stale') hardcodes the INTENDED WHERE clause as `(accessedAt IS NULL AND createdAt <= cutoff) OR (accessedAt <= cutoff)` — which the implementation does not contain. The test passes only because it evaluates that boolean expression inline rather than calling flagStaleItems, so it is blind to the divergence. flagStaleItems is non-destructive (creates suggestions, founder decides), so including old never-accessed items is safe and clearly intended; the destructive sibling archive_stale_memory tool deliberately excludes NULL accessedAt (memory-archive-stale.ts:68-71) — confirming the two paths are supposed to differ, and that flag should include NULLs.

**Repro:** Founder approves an identity/domain memory item. No agent ever retrieves it (accessedAt stays NULL). 120 days later the staleness sweep runs flagStaleItems(companyId). Expected: a 'hasn't been used' suggestion is created. Actual: 0 suggestions — the item is invisible to the staleness query forever.

**Fix:** Replace the single `lt(memoryItems.accessedAt, cutoff)` condition with the documented disjunction: `or(and(isNull(memoryItems.accessedAt), lt(memoryItems.createdAt, cutoff)), lt(memoryItems.accessedAt, cutoff))`. Import isNull/or. Also change the test to actually invoke flagStaleItems against a mock row with accessedAt=null so it exercises the real query.

### M5. Expired active_context memory is served to agents via heartbeat retrieval (no expiry/scope filter)

- **Severity:** medium · **Confidence:** high · **Subsystem:** memory
- **Location:** `server/src/services/heartbeat.ts:1033-1083 (fetchMemoryContext) + memory.ts:414-654 (searchMultiPath)`
- **Category:** data-integrity / stale-data

**What:** fetchMemoryContext calls memoryService.searchMultiPath and maps the results straight into the agent's memory context (heartbeat.ts:1076-1082) with no further filtering. searchMultiPath's only freshness/visibility predicate is `status = 'approved'` (buildConditions, memory.ts:421-432); it does NOT exclude items whose expiresAt has passed, and its own docstring (memory.ts:412) states 'Caller is responsible for downstream RBAC filtering (filterMemoryForScope)'. fetchMemoryContext performs no such downstream filtering (no isExpired, no scope split). Because expiry archival is asynchronous — archiveExpiredItems is only reachable via the /memory-lifecycle route / Memory-Keeper sweep, not synchronous on expiry — there is a real window in which an expired active_context item (still status='approved') is retrieved and injected into agent prompts.

**Why it's a bug:** This is asymmetric with the Commander recall path, which routes the SAME searchMultiPath output through splitCommanderMemoryItems → filterCommanderMemoryItems, which explicitly drops expired items via isExpired() (memory-policy.ts:36-40, 82-88). The heartbeat agent path has no equivalent guard, so the documented TTL semantics ('active_context ... Temporary. expiresAt field') are violated for agent runs until the next sweep. The same gap lets a pinnedToSkill expired-but-not-yet-archived item leak into the synthesized company-knowledge skill (memory-skill-sync.ts:78-95 filters only status='approved', not expiresAt).

**Repro:** Create an active_context memory item with expiresAt = now+1min, approved. Wait 2 minutes (sweep has not run). Trigger a heartbeat run for a task whose text matches the item. fetchMemoryContext → searchMultiPath returns it (status still 'approved', expiresAt ignored) → the expired guidance is placed in the agent's context.

**Fix:** Add an expiry guard to the agent retrieval path: either add `or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql\`now()\`))` to searchMultiPath.buildConditions (and searchSemantic), or filter the searchMultiPath results in fetchMemoryContext with the same isExpired() check the Commander path uses. The query-level fix also closes the pinned-skill leak if applied to buildPinnedMemorySkillEntries.

### M6. Version-number assignment races on the (memoryItemId, versionNumber) unique index → unhandled 500 and lost suggestion

- **Severity:** medium · **Confidence:** medium · **Subsystem:** memory
- **Location:** `server/src/services/memory.ts:849-867 (suggestUpdate), 964-1006 (saveDraft), 1550-1566 (changeLayer)`
- **Category:** race-condition

**What:** suggestUpdate and saveDraft compute the next version number with a separate `SELECT max(versionNumber) ... ORDER BY versionNumber DESC LIMIT 1` followed by an INSERT of `latest + 1`, with no row lock and (for suggestUpdate/saveDraft) no enclosing transaction. memory_item_versions has a uniqueIndex on (memory_item_id, version_number) (memory_item_versions.ts:26). Two concurrent writers for the same memory item — e.g. two different agents calling suggestUpdate (each passes the per-agent existing-pending check at lines 828-847 because they query by createdBy=agentId), or two users saving drafts — both read the same `latest`, both attempt versionNumber = latest+1, and the second INSERT violates the unique constraint, surfacing as an unhandled 500 to the caller and dropping that suggestion/draft. changeLayer wraps its read+insert in a transaction (lines 1541-1569) but at READ COMMITTED a SELECT does not lock a not-yet-existing row, so it is equally exposed (the transaction only makes the failure atomic, not race-free).

**Why it's a bug:** The unique index converts a benign 'two suggestions get the same number' into a hard write failure. There is no onConflict handling or retry anywhere in memory.ts (confirmed by grep — no ON CONFLICT / catch on these inserts). The per-agent dedup in suggestUpdate specifically allows multiple distinct agents to be mid-flight simultaneously, which is exactly the concurrent-agent scenario this codebase is built around (heartbeat runs multiple agents).

**Repro:** Two agents (agent-A, agent-B) each POST /memory/:id/suggest-update for the same approved item at nearly the same time. Both read latest versionNumber = 2. Both INSERT versionNumber = 3. One succeeds; the other throws a unique-constraint error that propagates as a 500, and that agent's suggestion is lost.

**Fix:** Make version-number allocation conflict-safe: either compute the number inside a transaction with `SELECT ... FOR UPDATE` on the parent memory_items row to serialize writers, or insert with an ON CONFLICT (memory_item_id, version_number) DO NOTHING + retry loop, or derive versionNumber via a single INSERT ... SELECT COALESCE(max(version_number),0)+1 statement. Apply uniformly to suggestUpdate, saveDraft, and changeLayer.

### M7. Scope-coupled thread action falsely suppressed as newer_scope_version by a sibling create_scope_draft committing earlier in the same thread-scoped batch

- **Severity:** medium · **Confidence:** medium · **Subsystem:** discussions-threads
- **Location:** `server/src/services/thread-agent-action-freshness.ts:191-197`
- **Category:** logic error / lost-work

**What:** compareFreshnessSnapshot() suppresses any scope-coupled action (add_scope_item, create_artifact_candidate) when the live latestScopeVersionId differs from the action's snapshot. But the PR-B commit is thread-scoped: commitThreadAgentActions (thread-agent-actions.ts:464-535) drains ready rows from multiple actions/runs in one batch ordered by createdAt ASC. When a `create_scope_draft` action commits earlier in the batch, it materializes a NEW draft scope version (thread-scope-versions.ts:758-799). A subsequent add_scope_item/create_artifact_candidate whose snapshot predates that draft then fails the `current.latestScopeVersionId !== snapshot.latestScopeVersionId` check and is terminally marked suppressed_stale.

**Why it's a bug:** The freshness snapshot is captured once at run start (runner.ts:267-268) and shared across every proposeThreadAction of that run, and captureFreshnessSnapshot's latest-scope query has no status filter so it includes drafts. If no draft exists at snapshot time (latest is accepted vN or null), create_scope_draft creates v(N+1) draft; the scope-coupled sibling's snapshot still references vN/null, so the compare returns newer_scope_version and the commit loop writes suppressed_stale (terminal, not retried). The intended idempotent behavior — add_scope_item's own commit calling createDraftFromThread and reusing the just-created draft — never runs because the freshness gate fires first, so a valid memory candidate / artifact link is silently lost. The thread-scoped cross-run drain makes co-occurrence more likely, not less.

**Repro:** In one controller turn (or two runs drained together), the crew proposes create_scope_draft AND add_scope_item/create_artifact_candidate on a thread with no pre-existing draft. create_scope_draft commits first (earlier createdAt) → new draft version → the scope-coupled action's per-action freshness check sees a newer scope version and suppresses it.

**Fix:** Make the scope-version freshness check tolerant of a draft the same batch is producing: treat snapshot null/accepted → a brand-new draft as non-conflicting for scope-coupled actions whose commit will reuse that draft, or commit create_scope_draft with its dependent scope items as one transactional unit keyed off the shared draft so the version bump isn't observed as 'newer'.

### M8. artifact addVersion parentVersionId is never validated to belong to the same artifact (or company)

- **Severity:** medium · **Confidence:** high · **Subsystem:** artifacts-outputs
- **Location:** `server/src/services/artifacts.ts:105-148`
- **Category:** data-integrity / branching invariant

**What:** `artifactService.addVersion` writes `parentVersionId: data.parentVersionId ?? null` with no check that the referenced version belongs to the same `artifactId`. The shared validators (createArtifactVersionSchema, mcpArtifactVersionSchema) only constrain it to `z.string().uuid()`, and the DB FK (`parent_version_id references artifact_versions.id`) permits ANY version row — including one from a different artifact or a different company. The internal-agent create_artifact_version tool passes parentVersionId through unchecked too.

**Why it's a bug:** The branching model (Decisions #43/#45: 'founder picks winner', no auto-merge) relies on parentVersionId forming a coherent in-artifact lineage so the founder can branch from a real ancestor. Allowing a parent pointer to a foreign artifact's version (or another tenant's version) produces a corrupt/cross-tenant version graph: the version tree viewer and any branch-from-parent logic will resolve to a version that does not belong to this artifact, and it leaks/links cross-company version IDs. This is a broken invariant even though the row content itself stays immutable.

**Repro:** POST /artifacts/:id/versions with parentVersionId set to a version UUID belonging to a different artifact (or company). The insert succeeds; the new version's parentVersionId now points outside its own artifact's lineage.

**Fix:** In addVersion, when parentVersionId is provided, SELECT artifact_id FROM artifact_versions WHERE id = parentVersionId inside the transaction and reject (throw) if it is missing or its artifact_id !== artifactId. This also transitively enforces same-company since artifactId is already company-scoped by the route.

### M9. Detected-output confirm/dismiss does a non-transactional read-modify-write of the detectedOutputs JSONB array (lost updates)

- **Severity:** medium · **Confidence:** medium · **Subsystem:** artifacts-outputs
- **Location:** `server/src/routes/output-detection.ts:117-253`
- **Category:** race condition

**What:** The confirm handler reads heartbeat_runs.detectedOutputs (a JSONB array), checks outputs[index].status === 'pending', creates an artifact/version + task_output, then writes back the ENTIRE array with `set({ detectedOutputs: updatedOutputs })`. There is no row lock (SELECT ... FOR UPDATE) and no transaction spanning the read and the write. The dismiss handler has the same pattern.

**Why it's a bug:** Two concurrent confirms (or a confirm + dismiss) on different indices of the same run both read the same stale array. Each writes back its own full copy with only its own index mutated — last-write-wins clobbers the other index's status flip back to 'pending'. Worst case: an output that was already confirmed (artifact/version + task_output created) reverts to 'pending' in the JSONB, so a subsequent confirm passes the `status !== 'pending'` guard again and creates a DUPLICATE artifact version / duplicate task_output (the task_outputs externalId `detected-output:${runId}:${index}` unique index would catch the duplicate task_output, but the duplicate artifact version is not deduped). The per-output `status` guard is read against a stale snapshot, so it does not prevent the double-confirm.

**Repro:** Issue two concurrent POST .../detected-outputs/0/confirm and .../detected-outputs/1/confirm for the same run. Interleave so both read before either writes; one status update is lost. Re-confirming the reverted index creates a second artifact version.

**Fix:** Wrap the read-modify-write in db.transaction and re-select the run row FOR UPDATE (or FOR NO KEY UPDATE) before mutating the JSONB, so concurrent confirms serialize. Alternatively store per-output confirmation state in a child table with a unique (runId,index) key instead of mutating a shared JSONB array.

### M10. Auto-block loses original status: backlog task auto-unblocks to 'todo' and can be auto-dispatched

- **Severity:** medium · **Confidence:** medium · **Subsystem:** tasks-deps-planning
- **Location:** `server/src/services/dependencies.ts:83-92 (block), 217-220 & 296-299 (unblock to 'todo')`
- **Category:** logic error / state restoration

**What:** addDependency() auto-blocks ANY non-terminal, non-blocked dependent — including a task in 'backlog' (line 83-87 only excludes terminal and already-blocked statuses). When the dependency later completes, resolveDependenciesTx (line 219) and maybeUnblockTx (line 298) always set the dependent to 'todo', regardless of what its status was before it was blocked. There is no stored pre-block status (no blockedFromStatus column exists). A backlog task therefore becomes 'todo' after an unrelated dependency completes, and if it has an assignee, resolveDependenciesTx pushes a wakeup (line 238-240) that dispatches the agent.

**Why it's a bug:** 'backlog' is the not-yet-scheduled state; promoting it to 'todo' (the ready/active queue) silently changes the founder's intent. Worse, the unblock path enqueues an assignee wakeup, so a backlog task the team had deliberately deferred can be auto-dispatched to an agent the moment some upstream dependency finishes. The block/unblock pair is not status-preserving: backlog -> blocked -> todo is a one-way promotion.

**Repro:** 1) Create task D in 'backlog' with an assigned agent. 2) Create task C ('todo'). 3) addDependency(D on C) -> D becomes 'blocked' (was 'backlog'). 4) Complete C (svc.update C -> 'done'). 5) resolveDependenciesTx sets D to 'todo' and pushes a wakeup -> agent is dispatched on a task that was deliberately in backlog.

**Fix:** Record the pre-block status when auto-blocking (e.g. a blockedFromStatus column or metadata field) and restore it on unblock; or, at minimum, only auto-block tasks in active states (todo/in_progress) and leave 'backlog' tasks in 'backlog' (don't block them, since they aren't scheduled). On unblock, restore to the captured prior status instead of unconditionally 'todo', and skip the wakeup when the restored status is 'backlog'.

### M11. Reopen-via-comment dispatches planning-mode tasks, bypassing the D8 planning-mode gate

- **Severity:** medium · **Confidence:** low · **Subsystem:** tasks-deps-planning
- **Location:** `server/src/routes/issues.ts:406 (and reopen at 281-289)`
- **Category:** logic error / invariant bypass (D8)

**What:** In enqueueIssueCommentWakeups the dispatch condition is `if (assigneeId && (reopened || (!selfComment && !isClosed && shouldDispatchIssueWakeup(currentIssue))))`. Because `reopened` is OR'd at the front, the `shouldDispatchIssueWakeup(currentIssue)` planning-mode gate is short-circuited whenever a comment reopens a closed task (applyIssueCommentControlEffects sets status to 'todo' via svc.update at line 282 and marks reopened=true). A task with workMode === 'planning' that is reopened via comment therefore enqueues an assignee wakeup even though shouldDispatchIssueWakeup would return false.

**Why it's a bug:** Per Paperclip Divergence D8, planning-mode tasks must NOT auto-dispatch until the founder switches them to Standard. Every other dispatch site in this subsystem gates on shouldDispatchIssueWakeup (create line 963, update line 1172/1369, dependency unblock dependencies.ts:24). The reopened branch is the one path that ignores the gate, so a planning task that was previously closed and is reopened by a board comment gets dispatched to its agent — contradicting the documented invariant.

**Repro:** 1) Create task D with workMode='planning', an assigned agent, status 'done'. 2) POST a comment with reopen=true. 3) applyIssueCommentControlEffects reopens D to 'todo' (reopened=true). 4) Line 406 fires the wakeup because `reopened` is true, skipping shouldDispatchIssueWakeup -> the planning task is dispatched.

**Fix:** Apply the planning gate to the reopen branch too, e.g. `if (assigneeId && shouldDispatchIssueWakeup(currentIssue) && (reopened || (!selfComment && !isClosed)))`, or explicitly AND the reopen sub-condition with shouldDispatchIssueWakeup(currentIssue). Confirm desired behavior with D8: a reopened planning task should remain human-curated and not auto-dispatch.

### M12. addDependency auto-block is not transactional: race can leave a dependent blocked after its dependency already completed

- **Severity:** medium · **Confidence:** medium · **Subsystem:** tasks-deps-planning
- **Location:** `server/src/services/dependencies.ts:49-92 (called standalone with conn=db from routes/dependencies.ts:39)`
- **Category:** race condition

**What:** When called from the HTTP route (routes/dependencies.ts:39) addDependency runs with no outerTx, so conn = db and each statement is its own implicit transaction. It reads the dependency status (line 49-60), then in a separate statement sets the dependent to 'blocked' (line 88-92) based on that stale read. There is no row lock and no transaction spanning the read and the block.

**Why it's a bug:** If the dependency task transitions to 'done' (firing its own resolveDependencies) in the window between the status read and the block write, addDependency will still see status != terminal and set the dependent to 'blocked'. The dependency's resolveDependencies pass already ran (and either didn't see this dependency row yet or saw the dependent as not-blocked), so it won't unblock the dependent. The dependent is now blocked with all dependencies done and no future event to release it — it only escapes via maybeUnblock on a manual dependency removal. Window is narrow but real in a multi-actor system (agent completing C while a board user / discussion-approval adds D->C).

**Repro:** Concurrently: thread A completes C (svc.update C -> 'done', runs resolveDependencies for C's existing dependents); thread B calls addDependency(D on C) and reads C as not-yet-done, then writes D='blocked'. End state: C done, D blocked, no remaining release path until manual dependency deletion.

**Fix:** Wrap the existence read, cycle check, insert, and auto-block in a single transaction and re-read the dependency status with row-level locking (SELECT ... FOR UPDATE on the dependency issue), or after inserting the edge re-check the dependency status inside the same tx and only block if still non-terminal. Alternatively, after addDependency commits, call maybeUnblockTx(dependent) so a just-completed dependency immediately releases the freshly-blocked dependent.

### M13. runWorkspaceCommand uses POSIX /bin/sh on all platforms, ignoring the Windows-aware shellInvocation used elsewhere

- **Severity:** medium · **Confidence:** medium · **Subsystem:** workspaces (execution workspace runtime, TTL/cleanup sweepers, git ops, authz)
- **Location:** `server/src/services/workspace-runtime.ts:540-546`
- **Category:** cross-platform / error-handling gap

**What:** runWorkspaceCommand resolves the shell as `process.env.SHELL?.trim() || '/bin/sh'` and spawns it with args ['-c', command]. recordWorkspaceCommandOperation's recorder path instead uses shellInvocation(), which correctly selects powershell.exe / cmd on win32. recordWorkspaceCommandOperation's no-recorder branch (line 623) delegates to runWorkspaceCommand, so when no recorder is supplied on Windows, provision/teardown commands attempt to exec '/bin/sh', which does not exist there, and the run fails with ENOENT.

**Why it's a bug:** Two code paths for the same operation use different shell resolution; the simpler one is POSIX-only and will spawn a non-existent binary on Windows (a supported platform per CLAUDE.md). The recorder is usually present, which limits exposure, but the no-recorder branch is a real, reachable inconsistency that breaks provisioning on Windows.

**Repro:** On Windows with SHELL unset, invoke a workspace provision/teardown via a path that passes recorder=null/undefined into recordWorkspaceCommandOperation -> runWorkspaceCommand -> spawn('/bin/sh', ...) -> ENOENT.

**Fix:** Make runWorkspaceCommand use shellInvocation(input.command) like recordWorkspaceCommandOperation's recorder path, so both branches honor the platform shell.

### M14. blockedTaskScan reports every in-progress task with ANY dependency row, ignoring dependency completion status

- **Severity:** medium · **Confidence:** high · **Subsystem:** commander (internal-agent)
- **Location:** `server/src/services/internal-agent/proactive.ts:122-150`
- **Category:** logic-error

**What:** blockedTaskScan's documented contract (lines 120-121) is: a task is 'blocked' if it appears as dependentIssueId in task_dependencies and the dependency task (dependencyIssueId) is not yet completed. The actual query inner-joins issues to task_dependencies on dependentIssueId and filters only issues.status = 'in_progress' and issues.companyId. It never joins to the dependency issue nor checks whether that dependency is still incomplete. So ANY in-progress task that has at least one dependency row is reported as 'blocked', even when every dependency it waits on is already completed. Additionally, because it is an inner join with no DISTINCT/group-by, an in-progress task with N dependency rows appears N times in blockedTasks, inflating both result.findings and the count in the notification ('Found X in-progress task(s) with unresolved dependencies'). Note: this function is exported but only test-invoked in this branch, so impact is dormant until a scheduler wires it in.

**Why it's a bug:** task_dependencies (packages/db/src/schema/task_dependencies.ts) has no status column, so completion can only be determined by joining to the dependency issue's status, which the query never does. The select() returns the joined issues+taskDependencies rows, so duplicates per task are returned verbatim. Both the false-positive (already-completed deps) and the duplicate-count behaviors directly contradict the function's stated purpose and the notification text.

**Repro:** Create an in-progress task T that depends on task D; complete D. Run blockedTaskScan for the company. T is still returned as 'blocked' and a 'Blocked Tasks Detected' notification fires. Add a second dependency row for T and T is counted twice in the findings.

**Fix:** Join to the dependency issue (second alias of issues on taskDependencies.dependencyIssueId) and filter on its non-terminal status, e.g. notInArray(depIssue.status, ['completed','cancelled']). De-duplicate dependent tasks (selectDistinct on issues.id or group-by) so the count reflects distinct blocked tasks, not dependency rows. The unit test mocks the DB to return pre-filtered rows, so it does not exercise this SQL and won't catch the bug.

### M15. Merge output silently reorders user-retained sections that upstream removed

- **Severity:** medium · **Confidence:** high · **Subsystem:** marketplace-plugins
- **Location:** `server/src/services/marketplace-merge.ts:93-124`
- **Category:** data-integrity

**What:** computeSectionDiff() processes sections in upstream (theirs) order, then appends every section that exists only in `mine` (state: 'removed') at the END of the diff array. applyMergeDecisions() then emits sections in diff order. So when a user keeps a section that upstream deleted (decision 'mine' on a 'removed' section — also the default for removed sections), that section is relocated to the bottom of the merged document instead of staying in its original position.

**Why it's a bug:** The diff array is built as [theirs-ordered sections..., then mine-only 'removed' sections...]. applyMergeDecisions joins parts in that order. A 'removed' section kept by the user is appended last, so a doc like mine=`## A / ## B / ## C` merged against theirs=`## A / ## C` (B removed upstream) yields output order A, C, B. The user's content is preserved but silently moved, corrupting document structure (e.g. a '## Deprecated' or '## Notes' block jumps below later sections). This is a skill/agent/team snapshot update merge that founders apply, so it directly mutates stored skill markdown.

**Repro:** computeSectionDiff('## A\na\n## B\nb\n## C\nc', '## A\na\n## C\nc'); applyMergeDecisions(diff, { B: 'mine' }) → produces A, C, B (B moved to end) instead of A, B, C.

**Fix:** Build the result in `mine` order for sections that exist in mine (insert 'removed' entries at their original index relative to surviving neighbors), or interleave 'removed' sections back into position by tracking each section's source index. Simplest: iterate mine's sections in order, classify each (unchanged/changed/removed) against theirs, then append theirs-only 'added' sections at the point they appear relative to anchors — preserving the user's original ordering for retained content.

### M16. Manual triggerJob() overlap check is a TOCTOU — concurrent triggers can double-dispatch the same job

- **Severity:** medium · **Confidence:** medium · **Subsystem:** marketplace-plugins
- **Location:** `server/src/services/plugin-job-scheduler.ts:439-496`
- **Category:** race-condition

**What:** triggerJob() guards against overlap by checking the in-memory `activeJobs` set and querying the DB for `running` runs, then creates a run and dispatches via `void dispatchManualRun(...)`. But `dispatchManualRun` only adds the jobId to `activeJobs` when its async body actually runs (it is fire-and-forget via `void`), and it marks the run `running` in the DB even later. Two near-simultaneous trigger requests for the same job can both pass the `activeJobs.has(jobId)` check (set still empty) and the DB `running`-runs check (no run is `running` yet, only `queued`), then both create runs and both dispatch a runJob RPC.

**Why it's a bug:** The guards read state that is only mutated *after* the guard passes, and the mutation happens in a separately-scheduled microtask (`void dispatchManualRun`). createRun inserts status 'queued', not 'running', so the DB check at lines 462-476 (which filters status === 'running') does not see the just-created queued run either. There is no atomic claim (no SELECT FOR UPDATE / conditional UPDATE) on the job row. Result: a job declared to have overlap prevention can run twice concurrently against the worker.

**Repro:** Fire two POST /plugins/:id/jobs/:jobId/trigger requests within the same tick. Both reach triggerJob; neither sees the other in activeJobs (populated later in dispatchManualRun) nor a 'running' DB run (createRun writes 'queued'); both call workerManager.call('runJob') for the same job.

**Fix:** Claim the job atomically before dispatch: either add jobId to `activeJobs` synchronously inside triggerJob (before the `void dispatchManualRun`) and remove it in dispatchManualRun's finally, or perform a conditional DB claim (e.g. INSERT-then-check, or an UPDATE ... WHERE no active run exists). Also include status 'queued' in the existing-runs guard query.

### M17. Codex session id lost when stdout exceeds 4MB capture cap, breaking session resume

- **Severity:** medium · **Confidence:** medium · **Subsystem:** adapters-wire
- **Location:** `packages/adapters/codex-local/src/server/parse.ts:192-195`
- **Category:** data-integrity / broken-invariant

**What:** appendWithCap (server-utils.ts:125-128) keeps only the TAIL of stdout (`combined.slice(combined.length - cap)`, MAX_CAPTURE_BYTES = 4MB), discarding the head. The codex JSONL session id is carried ONLY by the `thread.started` event, which is emitted at the very START of the stream (parse.ts:192-195 is the sole place sessionId is set). For a run that produces more than 4MB of stdout, the `thread.started` line is truncated away, so parseCodexJsonl returns sessionId:null.

**Why it's a bug:** In execute.ts:498 `resolvedSessionId = attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null`. For a fresh (non-resumed) codex run, all fallbacks are empty, so resolvedSessionId becomes null and sessionParams is null (execute.ts:499-507). The next heartbeat then cannot resume the codex thread and the agent silently loses conversation continuity, starting cold each wake. Claude is immune to the same cap because its session_id is repeated on EVERY stream-json line including the final `result` event (claude-local parse.ts:21/27/45), which survives tail-truncation; codex emits it only once at the head.

**Repro:** Run a codex_local agent on a task that produces >4MB of JSONL stdout in a single turn (verbose tool output). The captured proc.stdout drops the leading `thread.started` line; resolvedSessionId is null; the saved sessionParams is null; the follow-up heartbeat starts a brand-new thread instead of resuming.

**Fix:** Either special-case the session-establishing line so it is never evicted (capture and retain sessionId out-of-band as it streams in via onLog, rather than re-parsing the capped buffer), or raise/disable the cap for the session-id-bearing prefix. Simplest: parse sessionId incrementally in the onLog stdout callback and thread it through instead of relying on the post-hoc parse of the truncated buffer.

### M18. Concurrent createDraftFromThread loses the convergence catch: only `one_draft_uq` is handled, but `thread_version_uq` (created first) fires first and surfaces a 500

- **Severity:** medium · **Confidence:** medium · **Subsystem:** db-schema
- **Location:** `packages/db/src/schema/thread_scope_versions.ts:46-49 (thread_version_uq + one_draft_uq); handler: server/src/services/thread-scope-versions.ts:801-817`
- **Category:** error-handling gap / concurrency

**What:** createDraftFromThread computes `versionNumber = latest.versionNumber + 1` then inserts a draft. Two concurrent calls past the `latest?.status === 'draft'` check both insert a row with the same `(threadId, versionNumber, status='draft')`. That row violates BOTH unique indexes: `thread_scope_versions_thread_version_uq` (threadId, versionNumber) and `thread_scope_versions_one_draft_uq` (threadId WHERE status='draft'). The catch block (line 810) only recognizes `isUniqueViolation(err, 'thread_scope_versions_one_draft_uq')` and converts it to the existing-draft result; any other violation is re-thrown.

**Why it's a bug:** PostgreSQL evaluates unique constraints in index (OID) creation order. In migration 0142_sweet_rogue.sql the `thread_version_uq` index is created at line 119, BEFORE `one_draft_uq` at line 120, so on the racing insert the `thread_version_uq` violation is the one Postgres reports. The handler does not match that constraint name, so the loser re-throws instead of converging to `{ status: 'existing_draft' }`, turning a designed-for-concurrency path into a 500. The unique indexes still prevent the duplicate row (no corruption), but the documented graceful convergence is defeated precisely on the most likely error.

**Repro:** Fire two add_scope_item / create_artifact_candidate commits (each calls createDraftFromThread) for the same thread concurrently when no draft exists. Both reach the insert; the loser hits a unique violation reported as thread_scope_versions_thread_version_uq, which the catch doesn't handle → unhandled 23505 / 500 instead of returning the winner's draft.

**Fix:** Broaden the catch to also handle `thread_scope_versions_thread_version_uq` (and re-load the latest draft on either), or catch any 23505 on this table and re-select the existing draft. Alternatively move the convergence behind a single `onConflictDoNothing` on the one-draft index and re-select.

---

## CONTESTED — one skeptic refuted, needs a human call

1. **cancelRun / cancelActiveForAgent use unconditional setRunStatus, so a concurrently-finishing executeRun can overwrite the terminal 'cancelled' state** [medium] — `server/src/services/heartbeat.ts` — refutes=1 (heartbeat-concurrency)

2. **Provider quota upsert never updates rows when model is NULL — every adapter refresh inserts a duplicate row** [high] — `server/src/services/quota-windows.ts` — refutes=1 (finance-budget)
