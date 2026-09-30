# Commander Real-Life Lifecycle E2E Plan

**Date:** 2026-07-11
**Branch:** `codex/commander-cockpit`
**Status:** Reviewed and ready for execution
**Related plan:** `2026-07-11-commander-ask-human-completion-policy-plan.md`

## Goal

Verify Commander and the surrounding task, Discussion, Inbox, approval, workspace, and review surfaces using a fresh company and realistic work lifecycles. The campaign must tell us what works now, what is confusing in the user experience, and which later-wave capabilities are genuinely missing.

This is not a visual seed-data demo. Identity and starting configuration may be seeded, but questions, reviews, task transitions, approvals, agent runs, and continuation behavior must be produced through real application services and UI flows.

## Current-Truth Boundary

Wave 2 currently provides:

- Company, project/department, Routine, workflow-template, and task completion-policy fields.
- Effective task-policy snapshots and provenance.
- `review_required` versus `agent_can_complete` enforcement.
- Structured acceptance criteria required for agent completion.
- Materialized reviewer routing on entry to `in_review`.
- Agent protection from self-authoring criteria or elevating completion policy.

The following master-plan behavior is **not shipped yet** and must be recorded as an expected gap, not fabricated with seeded rows:

- A provider-neutral `ask_human` tool and service using `work_questions`.
- Durable late answers and automatic continuation after a terminated run.
- One synchronized question object across Commander, Inbox, task Work timeline, workspace, and source Discussion.
- Required Request Changes feedback plus a guaranteed agent wakeup.
- Task-domain-driven Discussion milestones that fully replace process-exit wording.
- Final Commander triage-family deduplication for Questions, Awaiting Review, Approvals, Exceptions, and Inbox.

The existing `ask_founder` tool remains an org-agent-only runtime-decision flow. It can block briefly and be answered in Inbox while its run is alive, but a terminal run cancels the decision and cannot resume from a late answer. That behavior is a baseline probe, not the target Ask Human design.

## Test Strategy

### Track A: deterministic isolated lifecycle suite

Run through the repository's Playwright harness:

- Temporary `AOA_HOME` and embedded PostgreSQL.
- Dedicated application and database ports.
- `local_trusted` deployment.
- One browser worker and no reused server.
- Real Express routes, Drizzle persistence, event delivery, React UI, task dispatch, and workspaces.
- Deterministic fake Codex/Claude executables only at the LLM boundary.

This track is CI-repeatable and proves the application's lifecycle logic without spending tokens or depending on provider availability.

### Track B: authenticated multi-human authorization suite

The current E2E harness explicitly has no authenticated-mode coverage. A proper multi-human test therefore requires a small authenticated fixture harness with separate browser contexts and real session cookies for four users.

Track B must prove behavior that `local-board` cannot prove honestly:

- Recipient-specific review visibility.
- Team-lead versus founder fallback.
- Alternate reviewer takeover.
- Unauthorized answer/reviewer/policy changes.
- Cross-company isolation between two signed-in humans.

If authenticated fixture support cannot be built without changing production auth behavior, Track B is reported `BLOCKED` with the missing harness contract. It must not be marked passed by changing `userId` fields in direct database writes.

### Track C: optional live-provider dogfood

After deterministic Track A passes, repeat one direct task and one immediate `ask_founder` scenario with an installed authenticated provider. This checks prompt/tool behavior, not deterministic product correctness. Provider unavailability is `BLOCKED`, not a product failure.

## Realistic Company Fixture

Create a fresh company named `Northstar Launch Lab <run-id>`.

### Humans

| Person | Role | Responsibility |
|---|---|---|
| Maya Chen | Founder | Company policy, final escalation, approvals |
| Priya Rao | Product lead | Product department lead and normal reviewer |
| Ravi Shah | Product manager | Responsible human for launch work |
| Noor Khan | Operations lead | Alternate reviewer/takeover actor |

### Agents

| Agent | Kind | Runtime | Purpose |
|---|---|---|---|
| Atlas | Org agent | deterministic `codex_local` | Direct assigned work and immediate legacy question |
| Forge | Internal crew agent | fake crew runtime | Discussion-created work and autonomy checks |
| Relay | Org agent | deterministic failure script | Failure and blocked-state observation |

### Work scopes

| Scope | Completion setting |
|---|---|
| Company | `review_required` |
| Product department | inherit company |
| Launch project | `agent_can_complete` |
| Compliance project | `agent_can_complete`, then constrained by company hard guardrail |
| Weekly launch Routine | creator override varied per scenario |
| Release workflow template | creator override varied per scenario |

### Work narrative

Northstar is preparing a controlled beta launch. The work includes a launch brief, pricing decision, release checklist, compliance review, and support handoff. These are understandable business tasks whose acceptance criteria and reviewer choices can be judged from the UI.

## Evidence Contract

Create `docs/aoa/qa/commander-real-life-e2e-<run-id>/` containing:

- `RESULTS.md`: one result per scenario.
- `BUGS.md`: complete reproducible findings.
- `STATE.json`: fixture IDs and persisted lifecycle snapshots.
- `screenshots/`: desktop, tablet, and mobile evidence.
- `network/`: relevant request/response bodies with secrets removed.
- `logs/`: server and agent-run excerpts using IDs, not free-text answers.

Result format:

```text
<scenario> | PASS|FAIL|BLOCKED|EXPECTED_GAP | observed behavior | evidence
```

Every scenario asserts all three layers where applicable:

1. Browser-visible behavior.
2. API response and live synchronization.
3. Persisted task/policy/reviewer/run state.

## Scenario Matrix

### Phase 0: isolation and fixture integrity

#### RL-00 - Fresh isolated startup

- Confirm no AoA process is reused and selected app/database ports are free.
- Start the Playwright-owned server with a temporary `AOA_HOME`.
- Assert `/api/health`, an empty company list, no browser console errors, and no failed startup requests.
- Record process ID, ports, database directory, branch SHA, and migration head.

#### RL-01 - Company and people created through supported flows

- Create Northstar through the onboarding UI.
- Add Priya, Ravi, and Noor through Team APIs/UI, then assign hierarchy and scoped roles.
- Create Atlas, Forge, and Relay through supported agent APIs.
- Seed only deterministic runtime controls and starting policy configuration.
- Assert company scoping and visible Team hierarchy.

### Phase 1: policy resolution and provenance

#### RL-10 - Company default snapshot

- Create a direct Product task with no override.
- Expect `review_required`, source `company`, source ID = company ID.
- Change the company default afterward and prove the existing task snapshot does not change.

#### RL-11 - Project override snapshot

- Create a Launch-project task with acceptance criteria.
- Expect `agent_can_complete`, source `project`, source ID = Launch project.

#### RL-12 - Task override wins

- Create a Launch task overridden back to `review_required`.
- Expect source `task` and source ID = task ID.
- Verify an agent cannot set or loosen this override.

#### RL-13 - Hard guardrail wins

- Enable the company review guardrail.
- Create a Compliance task under an `agent_can_complete` project.
- Expect effective `review_required`, company provenance, while preserving the configured child override.
- Disable the guardrail only after persisted evidence is captured.

#### RL-14 - Creator provenance

- Trigger a Routine with an override and instantiate a workflow template with an override.
- Expect source `routine`/`workflow_template` and the creator entity ID.
- Repeat with creator override unset to prove project then company fallback.

#### RL-15 - Discussion crystallization provenance

- Create a real Discussion, produce/approve a task scope item, and crystallize it into work.
- Expect planning-mode task creation plus project/company completion-policy provenance.
- No direct issue insert or status seed may be used for the lifecycle assertion.

#### RL-16 - MCP task creation provenance and tenant scope

- Create one task through authenticated MCP `create-task` using a project-scoped caller.
- Expect the same central policy snapshot as an equivalent board-created task.
- Attempt a project/company mismatch and expect a scoped denial without leaking the foreign entity.

### Phase 2: review-required lifecycle

#### RL-20 - Agent cannot bypass review

- Assign Atlas a `review_required` task with acceptance criteria and dispatch it.
- Script Atlas to attempt `done`; expect a typed rejection directing it to `in_review`.
- Script/allow Atlas to submit `in_review`.
- Assert the task appears once in Commander Awaiting Review and not in My Work active rows.

#### RL-21 - Reviewer materialization order

Run four tasks and verify reviewer/source:

1. Explicit reviewer -> `explicit`.
2. No explicit reviewer, Ravi responsible -> `responsible`.
3. No explicit/responsible, Product scope -> Priya / `scope_lead`.
4. No eligible scope lead -> Maya / `founder`.

The unavailable fallback cannot be produced honestly through normal onboarding because every created company has a founder. Cover it with a server integration fixture containing no eligible active reviewer, and assert entry to `in_review` fails with `reviewer_unavailable` rather than creating ownerless review work. Do not claim this subcase as browser-driven.

#### RL-22 - Open review in Commander

- Click the Awaiting Review row.
- Expect the task slide-over, Work tab, acceptance criteria, output/workspace evidence, responsible human, reviewer, and policy explanation.
- The Commander URL and chat session remain stable.
- Back/Escape restores focus to the originating row.

#### RL-23 - Human approves review

- Approve from the task slide-over.
- Expect `done`, reviewer remains recorded, Awaiting Review removes the item live, Done Today gains it, and no duplicate Inbox/approval row remains.

#### RL-24 - Request Changes baseline and gap report

- Click Request Changes on another review task.
- Observe current behavior: status returns to `in_progress` without required feedback or guaranteed agent wakeup.
- Record `EXPECTED_GAP` unless later-wave behavior has shipped by execution time.
- Do not silently call this a pass because the button changes status.

### Phase 3: agent-can-complete lifecycle

#### RL-30 - Eligible autonomous completion

- Dispatch a Launch task with structured acceptance criteria at Drive autonomy.
- Agent completes it through the normal status tool.
- Expect `done`, no Awaiting Review row, Done Today update, and retained policy provenance.

#### RL-31 - Missing criteria fails closed

- Dispatch an `agent_can_complete` task with no criteria.
- Attempt `done`; expect `acceptance_criteria_required`.
- Then submit it to `in_review`; expect normal reviewer materialization.

#### RL-32 - Insufficient autonomy fails closed

- At Manual/Assist autonomy, attempt direct completion.
- Expect rejection; at Assist, allow `in_review` but not `done`.
- Confirm no false completion notification or Discussion message.

#### RL-33 - Agent cannot rewrite its test

- From an authenticated agent request, send `acceptanceCriteria` together with `done`.
- Expect 403 at the route and rejection at the service guard if invoked directly.
- Attempt policy elevation to `agent_can_complete`; expect 403.

### Phase 4: legacy question truth probe

#### RL-40 - Immediate `ask_founder` answer while run is alive

- Give Atlas a real task whose deterministic script calls `ask_founder` with options.
- Assert one runtime-decision question appears in Inbox.
- Answer before the bounded wait expires.
- Expect the same run to receive the answer and continue.
- Record whether Commander mirrors the item; absence is an observed gap, not seeded around.

#### RL-41 - Late answer after run termination

- Trigger a second question and let the run terminate/park.
- Verify the runtime decision is cancelled/closed and cannot start a continuation.
- Record `EXPECTED_GAP`: this demonstrates why durable `work_questions` Wave 3 is needed.

#### RL-42 - Cross-surface question synchronization probe

- Inspect Commander, Inbox, task Work, execution workspace, and source Discussion.
- Record exactly where the same question ID is visible and actionable today.
- Expected current result: Inbox/runtime viewer is actionable; the complete synchronized five-surface model is not shipped.

### Phase 5: Commander information architecture and pane behavior

#### RL-50 - Triage ordering and deduplication

- Place one task in review, one pending approval, one failed task, and one unread Inbox item.
- Assert current Commander sections, row counts, and ordering.
- Detect duplicate representations by stable entity/source ID, not title text.
- Compare observed behavior with target precedence: Question -> Review -> Approval -> Exception -> Inbox.

#### RL-51 - My Work ownership

- Verify direct assignments to Maya, work Ravi is responsible for, and managed-agent work are distinguishable.
- Review tasks must not remain mixed into active My Work.
- “View all managed tasks” must expand/use the Commander work surface rather than navigate to an invented standalone page.

#### RL-52 - Discussion pane

- Click a real Discussion cockpit item.
- Expect the dedicated Discussion thread pane with its own nested viewer capability, while Commander remains the host workspace.
- It must not open as a generic reference tab or navigate away from Commander.

#### RL-53 - Task slide-over

- Click tasks from Triage, My Work, managed work, and inside the Discussion pane.
- Every direct task opens the canonical task slide-over.
- Review and active tasks use the same task surface; their section classification changes, not their viewer type.

#### RL-54 - Drag-to-chat reference chips

- Hover a draggable row: pointer/hand affordance and stable highlight appear.
- Drag task, Discussion, Inbox, approval, artifact, goal, agent, and note references into chat.
- Expect one identity-preserving chip per entity, no duplicate insertion, removable/reorderable before send, and correct persistence after send/reload.

### Phase 6: failure, isolation, and recovery

#### RL-60 - Process success is not task completion

- Run Atlas successfully without a task-domain transition.
- Expect technical run success in logs/history but no user-facing “task completed,” no Done Today item, and no Discussion Completed milestone.

#### RL-61 - Run failure and blocked work

- Run Relay with a deterministic failure.
- Expect one exception/failure representation with task context and no completion language.
- Opening it leads to the task/work evidence surface.

#### RL-62 - Cross-company isolation

- Create a second fresh company.
- Attempt task reads, reviewer changes, policy changes, question answers, and status transitions using IDs from Northstar.
- Expect 403/404 according to hide-don't-leak conventions and no state mutation.

#### RL-63 - Reload and live-event recovery

- Reload Commander at each major lifecycle boundary.
- Persisted state must reconstruct correctly without relying on stale client cache.
- Drop/reconnect live events once; refetch must converge without duplicate rows.

### Phase 7: responsive and accessibility pass

Repeat RL-22, RL-40, RL-50, RL-52, RL-53, and RL-54 at:

- Desktop: 1440x900.
- Tablet: 1024x768.
- Mobile: 390x844.

Assert keyboard access, focus restoration, screen-reader names, no clipped controls, no overlapping panes, and usable 44px touch targets for primary actions.

## Automation Deliverables

Add after plan approval:

- `tests/e2e/helpers/seed-commander-lifecycle.ts`
- `tests/e2e/helpers/task-policy-assertions.ts`
- `tests/e2e/commander-task-policy-lifecycle.spec.ts`
- `tests/e2e/commander-review-routing.spec.ts`
- `tests/e2e/commander-legacy-question-truth.spec.ts`
- `tests/e2e/commander-pane-lifecycle.spec.ts`
- Authenticated multi-context helper/specs if Track B is feasible.

The deterministic fake provider must support scripted status-tool and `ask_founder` calls while all resulting rows and UI states remain real.

## Execution Order

1. Build the fixture helper and policy assertion helper.
2. Implement Phase 0-3 automated tests first; these are the Wave 2 acceptance gate.
3. Run Phase 4 truth probes without changing product behavior.
4. Run Phase 5 browser UX audit and capture screenshots.
5. Add authenticated Track B or record the exact harness blocker.
6. Run optional live-provider dogfood.
7. Produce the observed information-architecture report before fixing product gaps.
8. Triage findings into Wave 2 regressions, later-wave expected gaps, and UX/product decisions.

## Bug Protocol

For every failure:

- Continue the sweep unless the failure blocks all remaining scenarios.
- Capture screenshot, console errors, network response, relevant server/run log, and persisted row snapshot.
- Classify:
  - `BLOCKER`: core lifecycle cannot proceed.
  - `MAJOR`: incorrect state/routing with a workaround.
  - `MINOR`: copy, focus, layout, or non-blocking feedback problem.
  - `EXPECTED_GAP`: behavior belongs to an explicitly unshipped later wave.
- Never “fix while observing.” Complete the evidence sweep first, then produce a separate remediation plan.

## Verification Commands

```powershell
pnpm -r typecheck
pnpm exec playwright test --config=tests/e2e/playwright.config.ts `
  tests/e2e/commander-task-policy-lifecycle.spec.ts `
  tests/e2e/commander-review-routing.spec.ts `
  tests/e2e/commander-legacy-question-truth.spec.ts `
  tests/e2e/commander-pane-lifecycle.spec.ts
pnpm test:run
pnpm build
```

On a non-administrative Windows account with embedded PostgreSQL, set `AOA_E2E_FORCE_WINDOWS=1`. Otherwise use an explicit isolated `DATABASE_URL`. Never attach these tests to the developer's `:3100` instance or default AoA database.

## Exit Criteria

The campaign is complete when:

1. Every Wave 2 scenario has a PASS/FAIL result with browser and persisted-state evidence.
2. Every unshipped Ask Human/Request Changes/triage behavior is labeled `EXPECTED_GAP`, not passed with synthetic data.
3. Direct/board, MCP, Discussion, Routine, and workflow-template creation have provenance evidence.
4. Both completion policies and the hard guardrail are proven through real status attempts.
5. Reviewer routing is proven for explicit, responsible, scope-lead, founder, and unavailable cases.
6. Commander task and Discussion surfaces behave consistently without navigation surprises.
7. Track B either proves multi-human authorization or names the exact missing authenticated fixture capability.
8. The final report recommends Commander category/interaction changes from observed lifecycles.

## GSTACK REVIEW REPORT

### Scope Mode

**HOLD SCOPE with evidence expansion.** The campaign tests the agreed product model and does not implement later waves while observing it.

### CEO / Product Review

**Pass after revision.** The test company uses one coherent launch narrative instead of unrelated demo rows. The plan separates “what works now” from target-state Ask Human behavior, so product decisions will be based on real lifecycle evidence. It explicitly tests the confusing distinctions the user raised: Review versus My Work, question versus task, approval context, and Discussion pane versus task slide-over.

### Design / UX Review

**Pass after revision.** Every triage row has a destination, focus-restoration expectation, duplicate-identity rule, and responsive/accessibility pass. Review and active work use the same canonical task surface; classification changes do not invent another viewer. The plan verifies the dedicated Discussion pane and its nested viewer separately.

### Engineering Review

**Pass after revision.** The plan reuses the repository's isolated Playwright server, temporary PostgreSQL, deterministic fake providers, and single-worker model. It forbids lifecycle writes through SQL, requires persisted-state assertions, covers all task-creation chokepoints, and explicitly handles policy precedence, guardrail, tenant isolation, idempotency, and live-event recovery.

### QA / Operator Review

**Pass after revision.** Scenario IDs, evidence paths, result taxonomy, failure capture, cleanup, and execution order are defined. Expected product gaps cannot be mistaken for regressions. Live-provider dogfood is supplemental and cannot make deterministic acceptance flaky.

### Independent Codex Review

**Unavailable, locally audited instead.** The installed Codex CLI rejected its configured `gpt-5.6-sol` model and requested a newer CLI, so it produced no review findings. The plan was re-audited against the current Playwright configuration, `ask_founder` implementation, task policy services, reviewer service, Commander viewer tests, and existing Inbox/Discussion E2E plans. That audit added the MCP provenance case and moved the reviewer-unavailable case out of browser claims into a server integration fixture.

### Important Review Decisions

1. Run a deterministic real-application suite before live-provider dogfood.
2. Treat fake LLM output as acceptable only at the provider boundary; all application state must be real.
3. Do not claim multi-human authorization from `local_trusted`; use authenticated browser contexts or report a blocker.
4. Do not seed questions/reviews/status outcomes directly.
5. Complete the evidence sweep before remediation.
6. Produce the Commander information-architecture recommendation from observed row lifecycles and destinations.

### Remaining Approval Gate

No additional product decision is required to begin Track A. Track B may expose one engineering scope decision: whether to add reusable authenticated E2E session fixtures now or schedule them as shared test infrastructure. The evidence report must surface that decision before any production-auth change.
