# Commander Ask Human and Completion Policy Plan

**Status:** Reviewed and implementation-ready
**Branch:** `codex/commander-cockpit`
**Companion to:** `docs/aoa/plans/2026-07-10-commander-cockpit-completion-plan.md`

## Outcome

Commander must show real human attention, not infer it from run logs or task descriptions. An agent that needs a decision creates one durable Ask Human question. That question is actionable from every relevant work surface and resolves everywhere from one answer. A successful process exit never pretends that the task is complete.

Task completion is governed by one understandable company policy with scoped overrides:

1. **Review required:** the agent submits the task for review; an authorized human completes it.
2. **Agent can complete:** the agent may complete the task after satisfying its acceptance criteria.

This plan does not add a new Automation Templates product. AoA's concrete repeatable-work surfaces are Routines, workflow templates, and other task creators; they consume the same completion-policy resolver.

## Product Decisions

### Task status and attention

Task status remains:

- `backlog`
- `todo`
- `in_progress`
- `blocked`
- `in_review`
- `done`
- `cancelled`

`waiting_on_human` is an attention state, not a task status. A task can remain `in_progress` while an open blocking question makes it waiting on a human. The UI derives this state from canonical open questions rather than persisting a second task status that can drift.

V1 does not add a separate completion outcome or resolution taxonomy. A task ends as `done` or `cancelled`; the task timeline and final comment explain the result.

### Completion policy hierarchy

Every agent-owned task resolves exactly one effective policy:

```text
task override
  -> routine or workflow-template override
  -> task scope default (department or project)
  -> company default
```

The most specific configured value wins. AoA's `projects` table represents either a department or a project, and a task has one `projectId`; V1 therefore has one scoped-default layer selected by `projects.type`, not an invented department-to-project parent chain. A hard company guardrail may tighten the resolved result to `review_required`, but a child scope cannot loosen a hard guardrail.

- Company default is required and initially `review_required`.
- Department and project rows expose the same optional scoped default and inherit when unset.
- Routines and workflow templates choose `inherit`, `review_required`, or `agent_can_complete`.
- Task create/edit offers the same choices when an agent is assigned.
- New tasks store their configured override separately from the resolved policy snapshot and provenance.
- Later setting changes affect newly created tasks, not in-flight tasks.
- Human-owned tasks remain completable by authorized humans; the agent completion policy is not presented as a second human workflow.
- The existing autonomy dial remains a capability ceiling. Agent completion requires both `agent_can_complete` and sufficient autonomy. The most restrictive rule wins.
- If acceptance criteria are absent or cannot be evaluated safely, an agent uses `in_review` even when it could otherwise complete.

The task override may change only before execution starts. Once checked out or `in_progress`, the effective snapshot is locked except that a founder may make it stricter by changing it to `review_required`; that exception is audited. This keeps a running agent's authority stable.

Agent completion requires structured acceptance criteria on the task. V1 adds an ordered `acceptanceCriteria` string list to the task contract. Free-form description text is not silently treated as acceptance criteria.

### Reviewer semantics

`issues.reviewerUserId` already exists and becomes meaningful only for review-required work.

Reviewer resolution is:

1. Explicit task reviewer.
2. Responsible human.
3. Relevant project or department lead.
4. Founder.

Before review, `reviewerUserId` is an optional explicit override. On the transition to `in_review`, the service resolves and materializes the actual reviewer into `reviewerUserId` and records `reviewerSource` (`explicit`, `responsible`, `scope_lead`, or `founder`). This gives Commander and Inbox one stable recipient instead of a fallback that changes when hierarchy changes. An authorized team lead in scope or the founder can take over when that reviewer is unavailable. An instance administrator has only the authority granted by the existing canonical board/RBAC context; this plan does not invent a company-admin role. All assignment, takeover, and completion actions are activity logged.

### Structured Ask Human

`ask_founder` becomes a backward-compatible alias for the product concept **Ask Human**. New agent prompts and tool documentation use `ask_human`.

An Ask Human question is a durable, company-scoped server object linked to:

- Task.
- Asking agent.
- Originating work session or run when available.
- Primary recipient and current recipient.
- Execution workspace when available.
- Source Discussion when the task originated from a Discussion.
- Question text, optional choices, supporting context, blocking flag, answer, and audit history.

One canonical question may be mirrored in many surfaces. Mirrors never become independent inbox records with separate lifecycle state.

### Answer and continuation contract

- The first authorized answer wins under a database transaction.
- Repeated submissions with the same idempotency key return the accepted answer.
- A conflicting later answer returns the canonical answer and a clear already-answered result.
- If the adapter supports live answer relay and the agent session is still waiting, the answer is relayed into that session.
- If the original session has ended, answering automatically enqueues one continuation using the same task, workspace, question, accepted answer, and prior session context.
- A normal answer does not require a separate Resume button.
- A visible `Retry continuation` action appears only when continuation dispatch fails.
- An unavailable recipient can reassign; an authorized lead or admin can take over.
- General comments do not silently resolve a question. A direct reply to the question card may resolve it. When an unlinked comment looks like an answer, the UI may offer `Use as answer` with explicit confirmation.
- Reassigning the task's agent while a question is open cancels that question unless an authorized human explicitly transfers the question and continuation context to the new agent.

### Discussion milestones

Only a Discussion from which the task originated receives task milestones. Normal direct tasks do not invent a Discussion.

The source Discussion may receive:

- Blocking question asked.
- Question answered.
- Task blocked or execution failed.
- Ready for review when the effective policy requires review.
- Changes requested, including the required feedback.
- Task completed.

Technical process success, heartbeat completion, tool completion, or session exit is not a task milestone. Discussion `Completed` messages are produced only by a real transition of the task to `done`.

## Current-System Findings

The implementation must repair these existing inconsistencies rather than layer UI on top of them:

1. HTTP MCP exposes `ask_founder`, but the internal crew bridge does not provide an equivalent durable question tool.
2. `agent_runtime_decisions` is run-bound and rejects answers after the originating heartbeat run becomes terminal, so it cannot support late continuation.
3. Heartbeat success emits `run_complete`, and crew result relay can post `Completed` into a Discussion without checking the task's domain status.
4. Agent task-status rules differ between the HTTP MCP path, internal crew tool path, autonomy dial, and locked Decision #18.
5. `reviewerUserId` exists but is not consistently assigned, explained, or used as the single review-routing contract.
6. Request Changes currently changes `in_review` to `in_progress` without requiring feedback or reliably waking the assigned agent.
7. Commander can currently display inferred or seeded question-like content that is not a real actionable question.

## Domain Model

### Completion policy fields

Use explicit typed columns rather than storing the policy in unrelated JSON settings:

```text
companies.agent_completion_policy_default
  review_required | agent_can_complete

companies.agent_completion_review_guardrail
  boolean

projects.agent_completion_policy_default
  null | review_required | agent_can_complete
  (projects.type distinguishes department and project)

routines.agent_completion_policy_override
  null | review_required | agent_can_complete

workflow_templates.agent_completion_policy_override
  null | review_required | agent_can_complete

issues.agent_completion_policy
  review_required | agent_can_complete

issues.agent_completion_policy_override
  null | review_required | agent_can_complete

issues.agent_completion_policy_source
  company | department | project | routine | workflow_template | task | legacy_backfill

issues.agent_completion_policy_source_id
  nullable source identifier

issues.agent_completion_policy_resolved_at
  timestamp

issues.reviewer_source
  null | explicit | responsible | scope_lead | founder

issues.acceptance_criteria
  jsonb string[]
```

`issues.agent_completion_policy` is the resolved snapshot for that task. `issues.agent_completion_policy_override` preserves what the user configured. A permitted pre-execution override update recomputes snapshot and provenance as one audited mutation; changing a parent default does not rewrite existing tasks.

### Work questions

Create a canonical `work_questions` table rather than extending the run-bound runtime-decision table:

```text
work_questions
  id
  company_id
  issue_id
  asking_agent_id
  originating_run_kind
  originating_run_id
  execution_workspace_id
  source_discussion_id
  source_discussion_entry_id
  primary_recipient_user_id
  current_recipient_user_id
  title
  question
  context_json
  options_json
  blocking
  status: open | answered | cancelled
  answer_json
  answered_by_user_id
  answered_at
  continuation_status: not_needed | pending | dispatched | failed
  continuation_run_kind
  continuation_run_id
  continuation_error
  version
  created_at
  updated_at
```

V1 uses the existing activity log for reassignment, takeover, answer, relay, continuation, cancellation, and retry history. The `work_questions` row stores current state. Do not add a second event table until a product requirement needs a question-specific event stream that the activity log cannot serve.

Indexes must support:

- Company plus open status and recipient.
- Task plus status and creation time.
- Source Discussion plus creation time.
- Workspace plus creation time.
- Originating run lookup.
- One successful continuation dispatch per answered question and answer version.

Use optimistic `version` checks or row locking for answer, reassignment, takeover, and retry transitions.

### Runtime decisions remain separate

`agent_runtime_decisions` continues to represent ephemeral runtime permission/trust decisions. It is not the canonical store for new work questions. Existing open work-question rows cannot be safely upgraded because many lack a durable task/workspace link. They remain visible and answerable through the legacy viewer until answered, cancelled, or expired; they do not gain late-continuation semantics. New questions use `work_questions` after the cutover. The legacy `work_question` kind is retired only after no active rows remain.

## Service Architecture

### Policy resolver

Add one shared `agentCompletionPolicyService` used by every task creator and status guard.

Responsibilities:

- Resolve company, department, project, Routine/workflow-template, and task scopes.
- Enforce hard review guardrails.
- Return effective policy plus provenance.
- Snapshot the result on task creation.
- Validate override authorization.
- Explain the effective value for UI tooltips and audit events.

No route, MCP tool, Routine runner, or Discussion dispatcher may reproduce the precedence logic.

### Question service

Add one `workQuestionService` responsible for:

- Creation and recipient routing.
- Company and task access checks.
- Hub/Commander projection.
- Direct answer, reassignment, takeover, cancellation, and retry.
- Live answer relay.
- Late continuation dispatch.
- Source Discussion milestone projection.
- Idempotency and concurrency.
- Activity and question-event logging.

All surfaces call this service through shared API contracts. No surface updates Hub, task comments, and Discussion independently.

### Agent tool bridge

Define one provider-neutral `ask_human` tool contract and expose it through:

- HTTP MCP for org agents.
- Internal crew MCP bridge.
- CLI/provider adapters that receive AoA tools.
- Local trusted board/agent execution where allowed by Decision #14.

The contract returns either the immediate answer or a parked result containing the durable question ID. Tool availability is explicit in adapter capability tests. Missing bridge credentials fail with a clear setup error rather than silently omitting the tool.

Delivery is capability-driven behind that one product contract:

| Runtime capability | Ask behavior | Answer behavior |
|---|---|---|
| Live decision broker | Create durable question, wait for a bounded interval | Relay into the same session when still active; otherwise continue later |
| CLI/internal runtime without live injection | Create durable question and return a parked result immediately | Enqueue a continuation after the answer |

The UI never promises `same session` until the question detail reports that capability. Provider parity means every supported runtime can ask and later continue, not that every provider can suspend a process identically.

### Continuation dispatcher

The continuation job must:

1. Atomically claim an answered question whose original session is no longer active.
2. Load the task, workspace, prior run/session context, question, and accepted answer.
3. Start the appropriate org-agent or internal-crew continuation.
4. Record the new run and publish one lifecycle event.
5. Mark dispatch failure without reopening or losing the accepted answer.

Use the existing durable wakeup/dispatch queue with a unique idempotency key derived from `(questionId, answerVersion)`. The queue insert and question transition to `pending` occur in one transaction; the worker atomically claims the wakeup and records the resulting run. This closes the crash window between marking a question and enqueueing work.

Retries are idempotent. A continuation never starts after the task is already terminal, the question is cancelled, or the assignee has changed without an explicit transfer decision.

### Task transitions

Centralize agent terminal transitions in the same status guard:

- `review_required`: agent may move eligible work to `in_review`, never directly to `done`.
- `agent_can_complete`: agent may move eligible work to `done` only when autonomy and acceptance checks pass.
- Human with canonical task permission may complete or cancel.
- Request Changes requires non-empty feedback, changes `in_review` to `in_progress`, records the feedback, and automatically wakes the assigned agent.
- Approve changes `in_review` to `done` and records the reviewer.

Update `docs/architecture/decisions.md` with a new decision that explicitly refines/supersedes the agent-completion portion of Decision #18. Preserve unrelated atomic checkout and single-assignee invariants.

## API Contracts

Add company-scoped endpoints following existing route conventions:

```text
GET    /api/companies/:companyId/work-questions
GET    /api/companies/:companyId/work-questions/:questionId
POST   /api/companies/:companyId/work-questions/:questionId/answer
POST   /api/companies/:companyId/work-questions/:questionId/reassign
POST   /api/companies/:companyId/work-questions/:questionId/take-over
POST   /api/companies/:companyId/work-questions/:questionId/retry-continuation
POST   /api/companies/:companyId/work-questions/:questionId/cancel
```

Task, Discussion, workspace, and Commander queries may include compact question projections, but mutation remains through the canonical question endpoints.

Register `work_question` as its own Hub source/semantic type with a source reconciler. Hub resolve/archive must not close an unanswered question; users answer, reassign, take over, cancel when authorized, dismiss personally, or snooze personally. This preserves the source-of-truth lifecycle already required for approvals and runtime decisions.

Settings endpoints expose effective and inherited values separately:

```text
configuredValue
effectiveValue
effectiveSource
guardrailApplied
```

Every endpoint enforces company boundary, source-entity visibility, recipient/takeover permissions, and activity logging.

## User Experience

### Reusable question card

Build one `WorkQuestionCard` with density variants, not separate question implementations.

The card shows:

- Asking agent and task.
- The question and supporting context.
- Choice controls or free-text answer.
- Primary recipient and reassignment/takeover state.
- Blocking state and elapsed time.
- Source Discussion or workspace link when relevant.
- Answered state, responder, timestamp, and continuation state.
- Retry only when continuation dispatch failed.

Submitting shows one deterministic state sequence: `Answering` -> `Answered` -> `Continuing work` when a continuation is needed. All mirrored cards update from the same query/cache event.

### Surface mapping

| Surface | Behavior |
|---|---|
| Commander Triage | `Questions` family ranks blocking questions first. Click opens the task slide-over at Work with the question focused. Inline answer remains available for fast triage. |
| Inbox | Canonical question item in the existing viewer. Answering resolves the same question and removes it from active Inbox filters. |
| Task SlideOver | Work tab shows open questions inline in the work timeline and keeps review actions in the task header/action area. |
| Focused Workspace | Thread shows the actionable question inline at the conversational point where it was asked. Raw execution logs remain read-only records. |
| Source Discussion | The question is an actionable structured entry in the group chat. Direct reply can answer it; unrelated comments do not. |

Commander does not show a question as both an independent fake task and an Inbox duplicate. It shows one question attention item linked to its real task. Counts and badges use the same canonical ID.

### Commander categories

Triage keeps five explicit families:

1. Questions.
2. Awaiting Review.
3. Approvals.
4. Exceptions.
5. Inbox.

Questions are agent requests for human input. Awaiting Review contains tasks whose work is ready for a reviewer. Approvals are governed action requests. Exceptions are failed, blocked, breached, or continuation-failed work. Inbox contains other unread or assigned communications. A source object can have several mirrors across the application, but Commander chooses one primary family by the listed order to avoid duplicate triage rows. When a task has an open blocking question, Questions wins over an otherwise eligible Exception row; blocked/failure context appears on that question row. A continuation dispatch failure moves the question to Exceptions until Retry succeeds.

### Review-required flow

1. Agent finishes a meaningful work iteration.
2. Task moves to `in_review`.
3. Commander shows it under Triage > Awaiting Review, not My Work > Active Work.
4. Clicking opens `TaskSlideOver` at Work.
5. Reviewer chooses Approve or Request Changes.
6. Request Changes requires feedback and wakes the agent; the task returns to My Work/Running as appropriate.
7. Approve moves the task to `done`; the source Discussion receives one completion milestone if applicable.

### Agent-can-complete flow

1. Agent satisfies acceptance criteria under sufficient autonomy.
2. Task moves directly to `done`.
3. Commander removes it from active work and may show it in Watch > Done Today.
4. Source Discussion receives one task-completed milestone if applicable.
5. If the agent cannot establish completion safely, it submits to review instead.

### Settings UX

- Company Settings: default completion policy and optional hard review guardrail.
- Department and Project settings: inherit or override, with effective source shown.
- Routine and workflow template editor: inherit or choose a policy for generated tasks.
- Task create/edit: inherit or override when an agent is assigned; show the resolved policy in plain language.
- Task detail: show `Review required` or `Agent can complete`, reviewer when relevant, and where the policy came from.

Avoid exposing the word `inherit` without context. Use labels such as `Use company setting (Review required)`.

## Migration and Rollout

1. Add schema, generated Drizzle migration, shared types, validators, and exports.
2. Backfill company defaults to `review_required`.
3. Backfill existing tasks to `review_required` with `legacy_backfill` provenance for safety.
4. Leave existing project, department, Routine, and workflow-template overrides unset.
5. Add read paths and compatibility projection before enabling writes.
6. Introduce `ask_human` while retaining `ask_founder` as a logged compatibility alias.
7. Move all new questions to `work_questions`.
8. Keep technical run-completion events in run ledgers and observability, but stop projecting them as user-attention items or unconditional Discussion `Completed` messages.
9. Enable late continuation behind an internal company-scoped rollout flag until provider matrix tests pass; it is not a user-facing setting.
10. Remove the legacy runtime-decision work-question path only after active old rows are resolved or migrated.

No migration rewrites an in-flight task to agent-completable.

## Implementation Waves

### Wave 1: Contracts and persistence

- Completion-policy enums, schema, migration, shared contracts.
- Work-question schema, events, indexes, and service skeleton.
- Company-scoped permissions and activity logging.
- Decision record refining Decision #18.

### Wave 2: Policy enforcement

- Shared resolver and task-creation snapshotting.
- Centralized status guard across HTTP MCP, internal crew tools, routes, Routines, and Discussion-created tasks.
- Settings APIs and effective-value explanation.
- Safe backfill behavior.

### Wave 3: Ask Human runtime

- Provider-neutral tool contract and `ask_founder` alias.
- HTTP and internal bridge parity.
- Capability-aware live answer relay, ask-and-park behavior, late continuation, retry, and idempotency.
- Recipient routing, reassignment, takeover, and unavailable-human escalation.

### Wave 4: Task and Discussion lifecycle

- Request Changes feedback plus agent wakeup.
- Review and completion domain events.
- Source Discussion milestone projector.
- Remove process-exit completion messages and misleading user-facing run-complete triage.

### Wave 5: Unified UI

- Reusable question card and query hooks.
- Commander, Inbox, Task SlideOver Work, Workspace thread, and Discussion integration.
- Settings UI across company, project/department, Routine/template, and task.
- Cross-surface cache/live-event synchronization.
- Keyboard, touch, focus, and responsive behavior.

### Wave 6: Realistic end-to-end verification

- Fresh isolated database and company.
- Multiple humans: founder/admin, department lead, responsible member, alternate lead.
- Multiple agents: org agent and internal crew agent with real adapter capability.
- Real Discussion-originated and direct tasks.
- Immediate and late questions, review-required and agent-completable work, changes requested, takeover, failure, and retry.
- Commander information-architecture report based on observed lifecycles, not seeded labels.

## Verification Matrix

### Unit

- Policy precedence and hard guardrail.
- Snapshot provenance for direct, Discussion, Routine, template, and MCP task creation.
- Reviewer and question recipient routing.
- Answer authorization, optimistic concurrency, first-answer-wins, and idempotency.
- Live relay versus late continuation selection.
- Discussion milestone mapping from task domain transitions.
- Triage-family precedence and deduplication.

### Integration

- Drizzle migration and backfill on an existing company.
- Every task creator stores the same resolved policy.
- HTTP MCP and internal bridge expose equivalent `ask_human` behavior.
- A parked question can be answered after its originating run terminates and starts exactly one continuation.
- Request Changes records feedback, returns the task to `in_progress`, and wakes the assignee.
- Agent completion obeys policy, autonomy, acceptance criteria, and hard guardrail.
- Cross-company reads, answers, reassignment, takeover, and status changes are rejected.
- Hub, Commander, task, workspace, and Discussion projections share one question ID and lifecycle.

### Component and accessibility

- Question choice, free-text, answered, unavailable, continuation, failed, and retry states.
- Direct reply confirmation and unrelated-comment non-resolution.
- Task Work timeline and review actions.
- Commander primary-family deduplication.
- Keyboard-only answering, focus restoration, screen-reader names, 44px touch targets, and narrow layouts.

### Browser E2E

Run against a fresh isolated company with real persisted entities and real task execution:

1. Founder creates a company, department, project, humans, and agents.
2. Company defaults to review required; project overrides to agent can complete; a hard-guardrail scenario is also exercised.
3. A direct org-agent task on a live-broker-capable adapter asks a blocking question while the workspace is open; answer inline and verify the same live session continues.
4. A Discussion creates a crew task that asks a question; allow the run to park, answer later from Commander, and verify one continuation plus synchronized Inbox, task, workspace, and Discussion state.
5. Answer a different question from Inbox and verify Commander removes it without refresh.
6. Reassign and take over a question when the primary recipient is unavailable.
7. Submit review-required work, request changes with feedback, verify agent wakeup, then approve the next submission.
8. Complete an agent-can-complete task and verify it never appears in Awaiting Review.
9. Force continuation dispatch failure, verify Exception placement and Retry, then recover.
10. Verify process success without task completion produces no Discussion `Completed` message and no false triage completion.
11. Trigger a Routine and workflow template task and verify the creator override, single task-scope default, and company fallback provenance.
12. Exercise Commander pane behavior: question -> TaskSlideOver Work, Discussion -> dedicated pane, nested task -> slide-over, Back/Escape restoration.
13. Repeat critical flows at desktop, tablet, and mobile widths with console and network-error assertions.

Capture screenshots and persisted-row assertions at each major lifecycle boundary. The E2E seed creates identities and starting configuration only; questions, answers, status changes, milestones, and continuations must be produced through real application flows.

## Observability

Add structured metrics and logs for:

- Questions created, answered, reassigned, taken over, cancelled, and overdue.
- Median time to first answer.
- Live relay success and late continuation success/failure.
- Duplicate continuation prevention.
- Review-required versus agent-completed task counts.
- Request Changes loops.
- Rejected cross-company or unauthorized answers.
- Legacy `ask_founder` alias usage.
- Suppressed process-exit completion notifications during rollout.

Never log free-text question context or answers by default. Logs use IDs and state transitions; audit-visible content remains in company-scoped storage.

## Definition of Done

This work is done when:

1. Every supported agent runtime can create the same durable Ask Human question and reports whether live relay is available.
2. One answer from any authorized surface updates all surfaces and either resumes live work when supported or starts one late continuation.
3. Commander shows real Questions, Awaiting Review, Approvals, Exceptions, and Inbox without duplicate primary rows.
4. Agent completion behavior is explained, inherited, snapshotted, and enforced identically across all task creation and mutation paths.
5. Request Changes requires feedback and wakes the agent.
6. Discussion milestones follow task domain transitions; process exits never claim task completion.
7. The fresh-company multi-human, multi-agent E2E matrix passes with persisted-state assertions and screenshots.
8. `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass.
9. `CLAUDE.md`, API documentation, MCP documentation, settings documentation, and architecture decisions describe shipped behavior.

## GSTACK REVIEW REPORT

### Scope Mode

**SELECTIVE EXPANSION.** Preserve the agreed Commander experience while extending the work only where a durable cross-surface lifecycle requires it.

### Review Summary

| Review | Verdict | Applied changes |
|---|---|---|
| CEO/product | Pass after revision | Kept two completion modes, removed a separate V1 question-event store, clarified Triage precedence, and avoided a new Automation Templates product. |
| Design/UX | Pass after revision | Materialized one reviewer, made adapter capability visible, kept one reusable question card, and made failure/takeover states explicit. |
| Engineering | Pass after revision | Corrected the nonexistent department-to-project inheritance chain, separated override from effective snapshot, added structured acceptance criteria, defined durable dispatch idempotency, and preserved technical run events outside user triage. |
| DX/operator | Pass after revision | Defined effective-value explanations, compatibility behavior, rollout boundaries, real E2E fixtures, and provider capability tests. |
| Codex outside review | Revise, incorporated | Independent review identified the task-scope hierarchy mismatch and challenged reviewer persistence, role naming, provider neutrality, and migration precision. Its Windows read-only shell stalled after source inspection; all material findings were independently verified against repository source before incorporation. |

### Decisions Locked By Review

1. Policy precedence is task override -> creator override -> one department-or-project task scope -> company.
2. Configured override and effective task snapshot are separate fields; running-task authority is stable.
3. Review assignment is materialized on entry to `in_review`.
4. Ask Human is provider-neutral at the domain level and capability-aware at delivery time.
5. Activity log is sufficient for V1 question history; no duplicate question-event table.
6. Existing runtime-decision questions remain legacy until terminal; they are not unsafely migrated.
7. Technical run completion remains observable but cannot claim that a task is complete.

### Remaining Gate

No blocking product decision remains. Implementation should begin with Wave 1 and re-run engineering review after the generated migration and shared contracts exist, before runtime wiring begins.
