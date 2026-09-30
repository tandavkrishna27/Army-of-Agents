# Inbox Correctness Wave — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task's full fix design (root cause, exact code, edge cases) lives in `docs/aoa/qa/inbox-hub-2026-07-03/ROOT-CAUSE-INVESTIGATION.md` — read your task's section there FIRST; this plan sequences and scopes, the investigation doc carries the code.

**Goal:** Implement the founder-locked decisions from the 2026-07-04 root-cause investigation: waiting-lane mirror semantics, Approvals nav removal, zombie-run teardown, work_question safety, crew-dispatch autonomy exemption, hub polish fixes, and the dead-type build/prune package.

**Founder decisions (2026-07-04, all locked):**
1. **Approvals nav:** remove the nav item, KEEP all `/approvals` routes (8 deep-link producers), pair with the dismiss-visibility fix.
2. **Lane model = MIRROR:** resolve/archive on a still-pending decision item (approval_request, join_request, agent_runtime_decision) is server-rejected; items leave only when the source is decided. Dismiss/snooze stay allowed (personal), with a lane affordance to reveal hidden items.
3. **Dead types package:** build extraction_failed + routine_outcome(failure-only) now; prune human_input_needed + scope_proposal; defer reminder + proactive to 1.1 (fix the CLAUDE.md proactive overstatement now); keep legacy_other internal-only (hide from settings).
4. **Crew gate:** the company crew-autonomy dial gates agent-INITIATED work only; explicit founder authorization (crew_dispatch approve, manual assignment) always dispatches. `crewPaused` remains the kill-switch.

**Defaults taken (flagged, vetoable):** dead-run work_question answer → 409-and-cancel (honest error); budget_alert closes symmetric (<80%); fixed extraction auto-archives its failure item; "Needs you most" = waiting-lane-only fetch; routine SUCCESS never notifies; Manual-mode scope drafts stay thread-only for launch.

**Branch:** `feat/inbox-hub-tabbed` (same PR, next part). **Verification:** suites per task + one live pass at the end (Task 12).

---

## Sub-wave 1 — Decision-surface correctness

### Task 1 — Mirror model: per-type manual-lifecycle guard (R3 + H1)
**Investigation sections:** `R3-runtime-decision-hub-actions-not-server-blocked`, `H1-archive-hides-pending-approval`.
**Files:** `packages/shared/src/hub.ts` (legality map), `server/src/services/hub-items.ts` (recordLifecycleAction guard + delete the unreachable recordAndAct tail ~:1253-1346, export :1758), `server/src/__tests__/hub-items-action.integration.test.ts` (MIGRATE its 4 `svc.recordAndAct(...)` calls at :102/132/157/198 to `recordLifecycleAction` — same semantics; Linux-CI gate, breaks otherwise — P2-2), `ui/src/components/hub/HubViewer.tsx` (hide Resolve/Archive for the blocked types — runtime_decision already hides; extend to approval_request/join_request), tests: `hub-items-lifecycle.test.ts`, `hub-items-routes.test.ts`, `HubShell.test.tsx`.

**⚠️ P1-3 — the two source classes use DIFFERENT pending checks:**
- **approval_request / join_request** → block resolve/archive while the source is **pending** via the SOURCE_RECONCILERS snapshot helper (`terminal:false` = still pending; `terminal:true` or missing row = allow). Fail-open on missing source is safe (every reconciler returns `{terminal:true}` on a gone row).
- **agent_runtime_decision** → block ONLY while `decision.status ∈ {created, shown}` (a bespoke check, NOT the snapshot `terminal` flag). The snapshot marks `answered`/`relay_failed` as non-terminal, but those MUST stay manually clearable (they're the dead-run stall rows Task 5 sweeps) — using the generic terminal flag here would block them and collide with Task 5.

- [ ] Failing tests: (a) resolve/archive on an OPEN approval_request/join_request whose source is pending → 409 ("Decide it in the approval itself"); once settled (row still open pre-reconcile) → allowed. (b) resolve/archive on a `created`/`shown` agent_runtime_decision item → 409; on an **`answered`-status** runtime_decision item → **ALLOWED** (regression guard for the Task 5 collision). (c) dismiss/snooze/claim/release unaffected for all.
- [ ] Implement: `HUB_SOURCE_MIRRORED_TYPES` in shared hub.ts; guard in `recordLifecycleAction` after the open-status check with the two-class logic above. Remove the dead recordAndAct tail + its export AND migrate the integration test in the SAME commit.
- [ ] UI: hide Resolve/Archive for mirrored types while blocked (HubViewer `showLifecycleActions` extension). Commit.

### Task 2 — Dismissed-visibility affordance (the dismiss hole)
**Files:** `ui/src/components/hub/HubShell.tsx` + `HubList.tsx` + `ui/src/pages/InboxHub.tsx`; the query API **fully plumbs** `includeDismissed`/`includeSnoozed` service→route (routes/hub-items.ts:125-126 — P3-2 correction, they're not "half-supported"). Dismissal is per-actor (`hub_item_user_state` keyed by principalId) so the chip only ever reveals the CURRENT user's rows — no RBAC concern.
- [ ] Waiting lane header gains a subtle "N hidden" chip when the lane has dismissed/snoozed OPEN items for this user. **P3-2 — the count isn't a free one-liner:** the counts service returns flat `{open,unread}` through a snapshot cache typed `{open,unread}` (hub-counter-snapshots.ts:13); adding a per-lane `hiddenOpen` needs the cache contract widened + a `group by`. Budget that (or use a cheap second lane-scoped `includeDismissed` count query if simpler than touching the cache). Clicking toggles `includeDismissed+includeSnoozed`; hidden rows render a muted "dismissed" badge + Undismiss action (undismiss/unsnooze routes exist).
- [ ] Tests: chip appears only when hidden>0; toggle includes rows; undismiss restores. Commit.

### Task 3 — Remove Approvals from primary nav (founder decision 1)
**Investigation section:** Approvals track `removalPlan`.
**Files:** `ui/src/components/Sidebar.tsx` (remove the Approvals entry). **P3-3 — three e2e/unit assertions MUST be fixed (Linux gate, not shielded by Windows-skip):** `inbox-hub-w1b.spec.ts:47-48` and `inbox-hub-operator.spec.ts:38-39` assert "Open full" as `getByRole("link")→/approvals/:id` but the tabbed shell renders a `<Button>` (HubViewer.tsx:265-273) — already stale on this branch, fix regardless; `Sidebar.test.tsx:124-130` asserts the nav link → INVERT it. KEEP `inbox-hub-operator.spec.ts:56-82` ("approval canonical routes remain available") — it pins the ROUTES which survive nav-only removal.
- [ ] Remove nav item; fix the 3 assertions above (edits are deterministic — safe read-only); update CLAUDE.md sidebar-structure section (remove Approvals). Commit.

## Sub-wave 2 — Runtime lifecycle

### Task 4 — Zombie-run teardown (R1: 4 coordinated changes)
**Investigation section:** `R1-zombie-cli-survives-cancel`.
**Files:** `packages/adapter-utils/src/server-utils.ts` (win32 taskkill tree-kill in signalRunningProcess — `spawn('taskkill',['/PID',pid,'/T','/F'])`, swallow exit 128; POSIX group-kill unchanged; reuse `spawnTrackedChild.terminate()`'s escalation pattern where possible), `server/src/services/heartbeat.ts` (remove the **5** eager `runningProcesses.delete` sites — :5547/5585/5630/5667 **AND :2232 in the orphan-reaper** (P2-1); terminal-status latch in setRunStatus — conditional UPDATE `WHERE status NOT IN (terminal)` with metadata-only fallback patch, skip live-event + terminal hub emit on guard miss), `server/src/services/agent-runtime-decisions.ts` (createPrompt run-liveness guard → conflict on terminal run), `server/src/services/runtime-hook-registry.ts` (+`deregisterRuntimeHooksForRun` called from cancelRun).
**⚠️ P2-1 — the metadata-fallback is load-bearing at TWO terminal→terminal sites:** heartbeat.ts:4307 (completion) and :4513 (error/catch) both become `cancelled→cancelled` writes in the cancel-race; the fallback MUST still persist their `usageJson`/log-excerpts without touching status. Confirmed no site needs a terminal→*different*-terminal flip (no failed→timed_out reclassification), and `detectedOutputs` (:4435) is a raw non-setRunStatus update the latch never touches; `markRunWaiting`/`clearRunWaiting` (:4080) write `running` (running→running passes, cancelled→running correctly blocked).
- [ ] TDD: latch unit test (cancelled + running patch → status unchanged, no publish); **cancelled→cancelled metadata write still persists usageJson/excerpts** (P2-1 guard); createPrompt-on-terminal-run → 409, hook route maps to deny; win32 taskkill spawn mock test; existing cancel tests green.
- [ ] Sanity: run every heartbeat-named suite from repo root. Commit.

### Task 5 — work_question safety fixes (R2, safety only — the adapter caller stays deferred)
**Investigation section:** `R2-work-question-stall-and-no-caller`.
**Files:** `server/src/services/agent-runtime-decisions.ts` (answerPrompt liveness gate → dead run ⇒ decision cancelled + relayError "run ended before the answer could be delivered" + `closeProjectedHubItem` (in scope here, :650) + 409; **P3-4 — sweeper coverage = a NEW method `sweepStrandedAnswers`**, NOT a widening of `listDueForExpiry` which is hard-scoped to `['created','shown']` at :494/:968 — the new method selects `['answered','relay_failed']` joined to terminal runs, calls closeProjectedHubItem, and slots into the index.ts:1063-1081 interval next to expireDuePrompts), route error copy, tests in `agent-runtime-decisions.test.ts`.
- [ ] TDD: answer against terminal run → 409 + decision cancelled + hub item archived; sweeper closes a stranded answered-row with dead run; live-run answer path unchanged (relay <1s test untouched). Commit.

### Task 6 — Crew dispatch: authorization overrides the dial (founder decision 4)
**Investigation section:** `crew-dispatch-skipped-autonomy-double-gate`.
**⚠️ P1-2 — there is NO single chokepoint.** `enqueueIssueAssigneeWakeup` covers crew_dispatch-approve (crew-task-service.ts:95), assign-on-create (issues.ts:996), dependency-unblock (dependencies.ts:54, issues.ts:1381) — but the **PATCH `/issues/:id` reassign path builds its own wakeup and dispatches via `svc.enqueueAoaMentionWakeup` (routes/issues.ts:1226-1242, `source:"assignment"`), bypassing the chokepoint.** A `dispatchClass` stamp there would miss reassignment (the exact bug, one path over). **FIX: key the dispatcher exemption on the wakeup PAYLOAD, not a stamp** — exempt when `typeof payload.issueId === "string" && (source === "assignment" || source === "automation")`. Both the chokepoint and the PATCH path already populate `issueId` + those sources; mention/sweep wakeups use `thread_mention`/`sweep.*` sources and stay gated.
**Files:** `server/src/services/internal-agent/aoa-agents/dispatcher.ts` (the role-autonomy gate at ~:449; `skipped_autonomy` sole write at :489 — add the payload-keyed exemption BEFORE it), tests for the dispatcher gate. (No stamp edit needed in issue-assignee-wakeup.ts if keying on issueId+source.)
- [ ] TDD: at company autonomy Manual — (a) a crew_dispatch-approve wakeup (issueId + source assignment) reaches dispatch; (b) a **PATCH-reassign wakeup (issues.ts:1226-1242 path)** also reaches dispatch (P1-2 regression guard); (c) an agent-initiated mention wake (source thread_mention) still `skipped_autonomy`; (d) crewPaused/thread-pause/budget hard-stop still block everything. Commit + note for decisions.md (Task 11).

## Sub-wave 3 — Hub polish

### Task 7 — Producer/UI quick wins (H2 + H5)
- [ ] H2: hire-approval in-tx emit — `routes/agents.ts` after the approvalsSvc.create block (~:1153): `await emitHubItem(db, buildApprovalHubEmit(approval))` (+ import). Test: hire on a board-approval company emits immediately (mock emit spy).
- [ ] H5a: run producers gain `relatedEntityType:"agent", relatedEntityId: run.agentId` (both builders; parity test updated — key-safety verified: relatedEntity not in sourceUniqueKey). **Companion fix (required):** `hubRegistry.tsx` run-case resolveTabId must NOT use preferRelated (it would return the agent id as run id) — use rawSource(sourceId)=run.id for the runId and relatedEntityId for the agentId in `hubTabForItem`'s run branch.
- [ ] H5b: Needs-you-most — InboxHub fetches a small waiting-lane page (limit 5) when `activeLane===null` and passes it to HubShell/HubHome. Test: Home shows waiting items. Commit.

### Task 8 — budget_alert reconciler + summary heal (H3)
**Investigation section:** `H3-budget-alert-never-closes`.
- [ ] Shared `formatBudgetAlertSummary` used by producer + reconciler (byte-identical, storm-safe); `reconcileCompanyBudget` in SOURCE_RECONCILERS (terminal when utilization <80% or budget unset; heal summary in place otherwise); call it from the sidebar-badges scan + notifications-lane GET. TDD: closes when budget cleared; heals stale % in place; no ping-pong (xmin stable on identical re-emit). Commit.

### Task 9 — suggestion dedupe (H4)
**Investigation section:** `H4-suggestion-dedupe-miss`.
**⚠️ P1-1 — the unique index will CRASH on the live QA instance** (two identical open `No identity memory` suggestions already violate it: `ed6c6c41`/`32e9fd59`). drizzle-kit emits a bare `CREATE UNIQUE INDEX ... WHERE status='pending'` with no data step; Postgres aborts on the existing dup. The app-runtime self-heal runs AFTER migrations, too late. **FIX: hand-add a duplicate-collapse DML statement INTO the drizzle-generated migration, statement-breakpoint-separated, BEFORE the index statement** (allowed — Rule #1 bans raw SQL migration *files*, not editing a drizzle-generated one; precedent: partial-index migrations 0045/0068/0092). Collapse = keep the newest pending per `(company_id, dedupe_key)`, mark older ones dismissed. Drizzle partial-unique precedent: `agent_wakeup_requests.ts:54-56`.
**Files:** `packages/db/src/schema/suggestions.ts` (+ `dedupe_key` column + partial `uniqueIndex().where(sql\`status='pending'\`)`), `server/src/services/suggestions.ts` (stable patternId per detector finding + upsert-on-dedupe_key), the generated migration (hand-add the pre-index collapse DML), tests.
- [ ] Stable `patternId` per detector output (`memory_gap:identity`, `memory_gap:domain:<deptId>`, `workload_balance:<agentId>`, `goal_gap:<goalId>`, …); persist as `dedupe_key`; `pnpm db:generate`; hand-edit the migration to collapse-then-index; detect() honors the key; app-side self-heal for any pre-existing dupes on next detect. TDD: two detect runs → one pending row; the migration applies cleanly against a DB seeded with a dup pair (integration). Commit.

## Sub-wave 4 — Type registry package (founder decision 3)

### Task 10 — Build 2, prune 2, hide 1
- [ ] BUILD extraction_failed: `buildExtractionFailedHubEmit` + emits at extraction.ts failure sites (:431/:521 region) with classified-guidance summary; reconcile: successful reprocess auto-archives (targeted reconcile at the reprocess success path). TDD + template test.
- [ ] BUILD routine_outcome (failure-only): `buildRoutineFailedHubEmit` emitted where routine runs record failure (verify the routines run path the investigator cited; if routines genuinely never run in this build, downgrade to BLOCKED and report — do not fake it).
- [ ] PRUNE human_input_needed + scope_proposal in one commit. **⚠️ P2-3 — `scope_proposal` is HEAVILY overloaded (~97 files); only ~10 lines are the hub-type touchpoints. DO NOT TOUCH the scope-draft product flow** (`scope-proposal-writer.ts`, `thread-post-scope-proposal.ts`, `ScopeProposalCard.tsx`, `propose_crew_work`, `discussion_entries.inputType='scope_proposal'`, `constants.ts:810`). Prune ONLY: hub.ts:68/69/93/94/124 (the 3 exhaustive maps — the `Record<HubSemanticType,...>` compile guards will flag any miss), notification-registry.ts:113-118/137-142, hubRegistry.tsx:54/116-138. **P2-4 — also the dotted-event forms**: `constants.ts:1057/1061`, `api/threads-contract.ts:81/85` (+ its test :203/207), `types/notification.ts:15` — decide+document whether the thread event enum keeps the dotted type (event fires → maps to nothing) or is removed too. Update the 5 hub test files + strip the `[SEED]` rows on the QA instance.
- [ ] **P3-1 — read-side safety:** `decorateItem` (hub-items.ts:192-198) only null-guards; a leftover pruned-type string → `lane: undefined` in lane-LESS reads (the new H5 Home fetch, `q` search). Add an explicit unknown→drop (or →legacy_other) in `laneForSemanticType`/`decorateItem` so stray rows don't surface with undefined lane. (UI `hubTabForItem`/`resolveHubEntry` already null-guard — no crash, but clean this since the QA instance carries `[SEED]` rows of both pruned types.)
- [ ] HIDE legacy_other from the settings rules list (prefs UI filter only; sink stays functional for imports). Commit.

### Task 11 — Docs + decisions
- [ ] CLAUDE.md: remove Approvals from the sidebar list; fix the Commander proactive line ("proactive checks implemented; scheduler wiring tracked for 1.1"). decisions.md: append the four founder decisions (mirror lane model; approvals nav removal + routes kept; crew dial = initiative-only; dead-type package) as dated entries following the existing format. Commit.

### Task 12 — Regression + live verification
- [ ] Full suites: `npx vitest run` from repo root (workspace) + `pnpm --filter @armyofagents/ui typecheck` + server typecheck + adapter package suites.
- [ ] Rebuild UI, restart QA server (same env), live pass: mirror-block via API (409) + UI (buttons hidden); dismiss→chip→undismiss; nav shows no Approvals but /approvals/:id deep link still renders; cancel a claude run → process tree dead (`tasklist` check) + no zombie decisions; answer a dead-run decision → honest 409; crew_dispatch approve at Manual → run actually spawns; budget alert closes when budget cleared; extraction failure → inbox item → reprocess success archives it. Screenshots + append results to TEST-REPORT.md. Report the URL to the founder.

## Execution order — shared-file collisions (do NOT parallelize these)
The reviewer flagged files touched by multiple tasks; enforce this order so agents don't collide:
- **`server/src/services/hub-items.ts`** — Task 1 (guard + recordAndAct delete) → Task 8 (reconcileCompanyBudget + SOURCE_RECONCILERS + reconcile scope-switch :1556-1567) → Task 10 (decorateItem strip-unknown + the same reconcile switch for extraction_failed). **Order: 1 → 8 → 10.**
- **`packages/shared/src/hub.ts`** — Task 1 (add HUB_SOURCE_MIRRORED_TYPES) → Task 10 (remove 2 union members from the exhaustive maps). **Order: 1 → 10.**
- **`ui/src/components/hub/hubRegistry.tsx`** — Task 7 (run resolveTabId) → Task 10 (remove 2 Record entries). **Order: 7 → 10.**
- **`server/src/services/heartbeat.ts`** — Task 4 owns it entirely; keep atomic, no other task touches it.
- Tasks with NO shared-file conflict (can run parallel): Task 3 (Sidebar/e2e), Task 6 (dispatcher), Task 9 (suggestions/db), Task 2 (UI/InboxHub) — subject to the above.

## Review corrections folded (2026-07-04)
Claude staff-eng review returned CHANGES-REQUIRED; all 3 P1s + P2s + P3s folded above (Codex was rate-limited). P1-1 (migration crash), P1-2 (PATCH-reassign bypass), P1-3 (runtime_decision answered-row collision) are the load-bearing fixes.

## Scope guard
**In scope:** exactly the tasks above. **Not in scope:** work_question adapter caller (deferred feature — needs its own design), reminder/proactive schedulers (1.1), BUG-6 codex empty-turn (separate investigation), E3 hub tab panels (deferred by founder), Approvals page deletion (kept), autopilot escalation surfacing, slaAt display, toast scope. **Do not** alter emit()'s storm guard semantics anywhere.
