# Commander and Auth Unified Integration Plan

**Status:** Reviewed plan; implementation not started
**Date:** 2026-07-14
**Source branches:** `feat/onboarding-auth-redesign`, `codex/commander-cockpit`
**Target branch:** `codex/commander-auth-integration`

## Objective

Deliver one coherent, reviewable PR containing the Google Auth/onboarding redesign and the complete Commander Cockpit work discussed since July 7, including the person-centered Cockpit, focus panes, durable Ask Human questions, continuation behavior, settings, and real lifecycle qualification.

The existing auth PR and Commander worktree remain preserved until the integration branch is verified.

## Current State

- `feat/onboarding-auth-redesign` is the source for the auth/onboarding work and is currently PR #287.
- `codex/commander-cockpit` contains the committed Commander work from July 7-12.
- The Commander worktree also contains 141 modified tracked files and 65 untracked files for the newer Commander wave.
- The current app at port `3210` runs the auth/onboarding worktree, not the complete Commander worktree.
- The Commander branch has no PR yet.

## Scope

### Included

- Google Auth, local development identity, first-user bootstrap, invitations, and onboarding state machine.
- Commander Cockpit sections, relationship classification, attention filters, deduplication, notes, pins, follows, and preferences.
- Typed reference chips and drag-to-chat attachment behavior.
- Commander, Discussion, Task Workspace, and Viewer pane coordination.
- Durable `work_questions`, authorized answers, reassignment, takeover, SLA, realtime mirrors, and continuation outbox.
- Provider-neutral Ask Human behavior for eligible task-bound organization and `aoa` Crew agents.
- Runtime capability handling: ask-and-park by default; live relay only when explicitly supported.
- Authenticated multi-user E2E, deterministic E2E, and real Claude/Codex lifecycle qualification.

### Excluded from this release

- Calendar-aware business-hour SLAs.
- Un-tasked durable questions from ordinary Commander or Discussion chat.
- Silent resolution of structured questions through ordinary comments.
- Unrestricted permission grants, shell access, network access, secrets, or out-of-Workspace writes.
- Claiming formal release readiness before all required scenarios and evidence pass.

## Integration Sequence

### 1. Preserve and checkpoint

1. Do not reset, clean, stash destructively, or overwrite the dirty Commander worktree.
2. Inventory tracked and untracked files and classify them as code, tests, generated migration, evidence, or disposable artifact.
3. Create a checkpoint commit or equivalent preserved patch for the current Commander wave after reviewing its file list.
4. Redact credentials, sessions, private answers, raw provider logs, and local-only evidence before staging.

### 2. Create the integration worktree

1. Create a clean worktree from `origin/main` on `codex/commander-auth-integration`.
2. Merge the auth branch first so the onboarding and auth contracts are the base.
3. Merge the committed Commander branch with explicit conflict resolution.
4. Apply the checkpointed uncommitted Commander wave.
5. Keep logical commits inside the single PR: auth, committed Commander, work-question/runtime, UI/panes, and qualification tests.

### 3. Reconcile schema and contracts

1. Treat `packages/db/src/schema` and the generated migration journal as the source of truth.
2. Resolve the duplicate migration `0169` histories from auth and Commander.
3. Regenerate migrations with `pnpm db:generate`; never manually rename or hand-edit SQL migrations.
4. Verify fresh database migration, upgrade migration, rollback safety assumptions, and no schema drift.
5. Synchronize DB, shared types/validators, server routes/services, UI API clients, generated tools, and docs.

### 4. Reconcile runtime behavior

1. Preserve company scoping, single-assignee rules, activity logging, approval gates, and budget hard stops.
2. Complete provenance from Commander -> task -> run -> Workspace -> question -> answer -> continuation.
3. Make question creation idempotent at the trusted provider tool boundary.
4. Persist the complete continuation envelope, including task criteria, question, answer, source Discussion, Commander conversation, Workspace, run, and remaining work.
5. Fence continuation leases with claim tokens and expiry so stale workers become no-ops.
6. Separate active provider execution time from human-question and permission wait time.
7. Enforce reporting hierarchy for visibility and project/department scope for mutation authority.

### 5. Reconcile Commander UX

1. Keep Commander as the stable shell; opening an item must not navigate away.
2. Use `My Work`, `Conversations`, `Company Overview`, and `Context` as stable sections.
3. Use `All`, `Needs me`, and `At risk` as attention filters, not duplicate sections.
4. Open tasks and reviews in the central Task Workspace focus pane.
5. Open Discussions in the central Discussion focus pane with native nested Viewer behavior.
6. Open Inbox-only actions, approvals, artifacts, and evidence in the Viewer.
7. Preserve typed action anchors, drafts, scroll position, focus restoration, resize state, Escape order, and responsive behavior.
8. Render one canonical question across Commander, Inbox, Task Work, Workspace, and source Discussion when applicable.

### 6. Verification gates

Run, in order:

1. `pnpm db:generate` and schema drift verification.
2. `pnpm -r typecheck`.
3. Unit, shared, DB integration, API contract, and UI component tests.
4. Deterministic Playwright E2E with isolated database and fake provider controls.
5. Authenticated founder, lead, and member Playwright E2E.
6. Full production build.
7. Fresh-company real lifecycle campaign with real Claude and Codex adapters.
8. Formal `R01-R14` and `Q1-Q5` execution with PASS, FAIL, BLOCKED, or NOT RUN evidence.
9. Manual browser acceptance on the integrated branch at a new port, not `3210`.
10. The lifecycle runner must write evidence paths, invoke the evidence verifier, and fail when an expected artifact is missing or belongs to another scenario.
11. Authenticated and live gates must be explicit merge inputs; a Windows skip sentinel cannot satisfy the release gate.
12. Live provider campaigns must use supervised permissions and sandbox settings, never provider bypass flags.

No task, question, review, approval, or completion state may be inserted directly to manufacture live lifecycle evidence.

### 7. PR and handoff

1. Push `codex/commander-auth-integration`.
2. Open one unified PR with a truthful title and body describing both auth and Commander.
3. Keep PR #287 open while the unified PR is being validated.
4. Close PR #287 as superseded only after the unified PR exists and contains its auth changes.
5. Leave the integrated app running for browser review and record the exact branch, port, database home, test manifest, and qualification verdict.

## Test Evidence Required

- Fresh and upgrade database migrations with no drift.
- Company and cross-company authorization tests.
- Question create, answer, reassign, takeover, cancel, retry, and terminal-task fencing.
- Duplicate producer and duplicate continuation race tests.
- Runtime capability and ask-and-park tests for Claude, Codex, and unsupported adapters.
- Chronological question placement in Commander, Task Work, Workspace, Discussion, and Inbox.
- Exact focus-pane opening for task, review, discussion, approval, artifact, and evidence references.
- Responsive, keyboard, accessibility, drag alternative, focus restoration, and partial-failure tests.
- Authenticated multi-user visibility and mutation boundaries.
- Real lifecycle provenance from task through provider tool call and continuation.
- Redacted manifests and screenshots with no credentials or private answers.

## Engineering Review

### Findings

1. **P1: migration lineage conflict.** Auth and Commander contain different migration `0169` histories. The integration must regenerate the combined lineage before any release claim.
2. **P1: dirty scope boundary.** The Commander worktree contains a large uncommitted wave. It must be checkpointed and reviewed before staging.
3. **P1: qualification contradiction.** Branch qualification says user acceptance is ready while the enterprise plan still lists runtime blockers and the formal R01-R14/Q1-Q5 matrix as pending. Release status must remain pending until the matrix passes.
4. **P1: incomplete previous verification.** Prior full tests covered the auth/onboarding branch, not the complete uncommitted Commander wave. The integrated branch needs a fresh full run.
5. **P1: shared runtime conflict risk.** Auth and Commander both change startup, migrations, task/question services, internal-agent runtime, thread UI, and settings. Automatic conflict acceptance is unsafe.
6. **P2: PR reviewability.** One PR is acceptable only if it retains logical commits and a clear validation matrix. A single squashed mixed commit is not acceptable.
7. **P2: evidence hygiene.** Generated screenshots, state files, logs, and live-provider artifacts require review for credentials, private content, and machine-specific paths before commit.

## Sub-Agent Review

Two independent read-only explorers reviewed the actual branch state and this plan.

### Integration and migration review

- Reconfirmed the duplicate `0169` migration collision and recommended rebuilding one canonical lineage from `origin/main` migration `0168`.
- Reconfirmed that the Commander wave is uncheckpointed and must be preserved before integration.
- Identified shared schema exports, app registration, and generated metadata as explicit post-merge contract checks.
- Added `pnpm gen:tools:check` and `pnpm gen:tools:md:check` to the generated-contract verification gate.
- Required evidence review for committed screenshots, state files, and live reports.

### Test and release review

- **P1:** `tests/e2e/scripts/run-commander-lifecycle.ts` writes provenance links without the evidence paths required by the verifier and does not invoke the verifier.
- **P1:** `tests/e2e/scripts/run-commander-gate.ts` and the default Windows Playwright configuration can pass while omitting authenticated, live-provider, and auth-release coverage.
- **P1:** The live campaign setup enables provider permission or sandbox bypasses, which violates the supervised qualification contract.
- **P1:** The authenticated Commander test uses one company and direct database setup, so it does not prove two-company isolation or complete multi-user UI behavior. Google OAuth remains manual or unit coverage only.
- **P2:** The formal scenario manifest does not independently prove that each `R` and `Q` scenario produced its own evidence artifact.

These findings are now hard gates in the implementation sequence. The plan is not release-ready until they are fixed and re-reviewed.

### Review Verdict

**Direction approved, implementation not yet started.** The unified PR is the right shape for the requested single release, but integration and PR closure remain blocked until the migration conflict, dirty-worktree checkpoint, runtime P1s, evidence wiring, supervised provider settings, and formal lifecycle qualification are treated as hard gates.

## Decision Record

- One unified integration PR: approved.
- New integration branch instead of extending PR #287: approved.
- Preserve PR #287 until the replacement PR is validated: approved.
- Tasks and reviews use Task Workspace focus: approved.
- Discussions use central Discussion focus with native nested Viewer: approved.
- Ask Human is durable only for task-bound eligible agent work: approved.
- Ask-and-park is the default for non-pauseable providers: approved.
- Automatic continuation after an accepted answer: approved.
- Company default question SLA with project override: approved.
- Formal R01-R14 and Q1-Q5 are release gates, not optional documentation: approved.

## Plan Status

This plan is reviewed and ready to guide implementation. No source branches were modified while creating or reviewing this document.
