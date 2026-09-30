# Commander Cockpit Enterprise Completion Plan

**Status:** Implemented and branch-qualified for user acceptance; formal Wave F release matrix remains pending

**Branch:** `codex/commander-cockpit`

**Scope:** Complete and qualify the person-centered Commander Cockpit, durable Ask Human lifecycle, task and Discussion focus panes, and real-provider workflows already approved in Decision #109 and the 2026-07-12 Commander plans.

**Supersedes:** The remaining-work and progress sections of the 2026-07-12 Commander Cockpit implementation plan. The approved product behavior, scope document, and real lifecycle test plan remain authoritative unless this plan explicitly tightens them.

## Outcome

Commander becomes a reliable personal command surface for real company work:

- `My Work`, `Conversations`, `Company Overview`, and `Context` are the four stable sections.
- `All`, `Needs me`, and `At risk` are attention filters, not duplicate sections.
- Tasks, questions, reviews, discussions, approvals, artifacts, runs, goals, agents, and notes open on the correct focus or Viewer surface.
- A blocking question from an eligible task-bound organization or `aoa` Crew execution appears as one canonical Ask Human object in Commander, Inbox, Task Work, Workspace, and its source Discussion.
- One authorized answer updates every mirror and causes either one live relay or one durable continuation, never both and never neither.
- Human waiting does not consume provider execution time for adapters that cannot suspend and resume.
- Reporting hierarchy controls personal work visibility; project or department scope controls mutation authority.
- Real Claude and Codex campaigns prove the lifecycle without fabricating final task, question, review, or approval states.

## Locked Product Decisions

1. Tasks and Decisions use canonical filtered pages for `View all`; Following expands as a paginated source-neutral Cockpit list.
2. Reporting hierarchy contributes to `Managing`; it does not itself grant cross-project mutation authority.
3. Commander synchronous questions remain ordinary Commander conversation interactions.
4. Commander background work must create or link a real task and delegate it to an eligible task-executing organization or `aoa` Crew agent before a durable question can exist.
5. Eligible task-bound organization and `aoa` Crew runs use durable Ask Human. Non-pauseable runtimes ask and park; a future live broker may relay only through an explicit capability contract.
6. Answering a parked question automatically starts exactly one continuation.
7. A breached question SLA marks work `At risk` and notifies the escalation route, but does not silently change the recipient. Authorized users may explicitly remind, take over, or reassign.
8. Plain chat prose never silently resolves a structured question. A structured answer or explicit confirmation is required.
9. Company completion policy defaults to `review_required`; governed task-level and scope-level overrides remain as specified by Decision #109.
10. Any eligible task-bound execution, including organization agents and task-executing `aoa` Crew agents, may create a durable Ask Human question. Un-tasked Commander and Discussion interactions remain conversational.
11. The V1 default human-question SLA is 24 elapsed hours, with company and project overrides. Calendar-aware working hours are deferred.
12. Runtime permissions may offer `Allow equivalent actions for this run` only for the exact Workspace and action class. The grant is audited, expires with the run, and never includes unrestricted shell, network, secrets, or out-of-tree writes.

## Runtime And Surface Contract

| Situation | Runtime behavior | User surfaces |
|---|---|---|
| Commander asks during an active reply | Continue the same conversation turn; no durable work question. | Commander thread |
| Commander launches background work | Create or link a task, preserve Commander provenance, and delegate to an eligible task-bound organization or `aoa` Crew agent. | Commander, Task Workspace |
| Eligible task-bound organization or `aoa` Crew agent asks a blocking question | Persist one canonical question. Relay only when the adapter advertises a pauseable live session; otherwise park immediately. | Commander, Inbox, Task Work, Workspace, source Discussion |
| Human answers while a live relay is valid | Relay once into that active provider session and terminalize the continuation requirement. | Every mirror updates |
| Human answers after parking | Atomically accept the answer and enqueue one idempotent continuation. | Every mirror updates; continuation state is visible |
| Discussion has ordinary conversational uncertainty | Ask in the Discussion without creating a durable task question. | Discussion thread |
| Discussion-originated task becomes blocked | The assigned eligible task-bound organization or `aoa` Crew agent creates a question linked back to the source Discussion. | Discussion plus all task question mirrors |

No current adapter is assumed pauseable by name. Claude CLI, Codex CLI, and generic process execution use ask-and-park until an adapter capability contract proves pause, resume, cancellation, deadline extension, and session correlation.

## Current Truth And Release Blockers

The branch contains partial Wave 2 implementation. It is not release-ready for the following reasons.

### P1 - Continuation context is incomplete

The wakeup payload contains question and answer data, while the provider-facing persisted `contextSnapshot` does not. A continuation can wake without the human answer or source context.

**Required correction:** Persist an immutable continuation envelope containing task id and criteria, question id and text, answer and responder, answer version, Workspace, source Discussion, source Commander conversation, prior run and provider session, and remaining-work instructions. Provider execution must consume that envelope directly.

### P1 - Commander provenance is not propagated end to end

The question schema can store a Commander conversation, but Commander run, task creation, delegation, heartbeat, and question creation do not preserve one canonical source chain.

**Required correction:** Capture source provenance from trusted tool and run context, persist explicit primary creation-source fields, stamp the delegated task, and derive question provenance from the canonical task/run chain rather than model-supplied arguments or reverse inference.

### P1 - Question creation is not idempotent

An adapter or MCP retry can create two canonical questions before answer idempotency or continuation uniqueness applies.

**Required correction:** Introduce a producer invocation key stable across transport retries, scoped to company and originating run. Atomically insert-or-load by that key. Store a payload fingerprint and return `409` when the same key is reused with different semantic input.

### P1 - Continuation claim ownership has an expired-lease race

A stale worker can mutate a request reclaimed by a newer worker because terminal transitions do not verify claim ownership.

**Required correction:** Add immutable claim tokens and lease expiry. Every success, cancellation, retry, and failure update must match request id, claimed status, and claim token. Stale workers are strict no-ops. Heartbeat enqueue becomes atomic insert-or-load.

### P1 - Question authorization confuses reporting and project scope

Recipient scope currently treats company-membership parentage as project membership.

**Required correction:** Resolve actor project or department authority through canonical role and scope records. Both source task and target recipient must be in a scoped lead's authority. Reporting parentage may affect `Managing` visibility only.

### P1 - Adapter waiting consumes provider budget

The current universal five-minute database-polling wait consumes the provider's wall-clock run timeout.

**Required correction:** Add an explicit runtime capability contract. Non-pauseable adapters persist and park immediately. Pauseable brokers use an event-driven cancellable waiter with a separately accounted human-wait budget. Task and run liveness expose `waiting_on_human` without treating process exit as task completion.

### P1 - Release qualification has failed

The existing Harbor real-provider campaign failed continuation context, scoped task access, question synchronization, review transition, and Codex startup.

**Required correction:** All deterministic gates and the fresh real-provider campaign in this plan must pass before enabling the v3 Cockpit capability.

### P2 - Timeline questions are appended rather than merged

Commander, Workspace, and Discussion currently render question cards after their message maps. Task Work lacks the complete mirror.

**Required correction:** Use a shared authorized timeline event model and stable `(createdAt, kindOrder, id)` merge on every inline surface.

### P2 - Focus anchors lose action identity

Review and question opens select a broad task tab but do not focus the exact action.

**Required correction:** Carry typed `{ kind, id }` anchors through presentation items, pane coordination, Task Workspace, and DOM focus restoration.

### P1 before broad rollout - Work-question reads amplify linearly

List authorization and per-row detail polling produce database and HTTP amplification.

**Required correction:** Authorize and paginate through a bounded joined query, return capability bits with list rows, deliver source-level real-time invalidation, and use one disconnected fallback poll only for visible open work.

## Enterprise Architecture

### Coordinated lifecycle models

`work_questions` is the sole source of truth for new durable questions, but question state, response delivery, and worker execution are orthogonal lifecycles.

```text
Question status: open -> answered | cancelled

Delivery mode snapshot: ask_and_park | live_relay

Response delivery: not_needed -> pending -> dispatched -> succeeded | failed

Outbox request: pending -> claimed -> dispatched | failed | cancelled
```

The answer transaction creates exactly one relay intent or one continuation request according to the immutable delivery-mode snapshot. A database invariant prevents both paths. Heartbeat terminal callbacks update response-delivery success or failure; `dispatched` never means completed. Mirrors never own an independent answer or terminal state.

The canonical lock order is `issues FOR UPDATE -> work_questions ordered by id -> continuation_requests ordered by id -> wakeups`. Answer, cancellation, takeover, reassignment, task transition, and deletion use that order. A terminal-task fence cancels queued or claimed work, signals dispatched or running continuations, and rejects later tool mutations against terminal or reassigned tasks.

### Runtime capability contract

Add a provider-neutral runtime capability object, versioned with the adapter execution contract:

```ts
type HumanQuestionRuntimeCapabilities =
  | { mode: "ask_and_park"; preservesProducerInvocationId: true }
  | {
      mode: "live_relay";
      preservesProducerInvocationId: true;
      pauseDeadline: true;
      resumeSession: true;
      cancelWait: true;
    };
```

The server chooses behavior from capabilities, never from adapter type strings. This optional contract extends the existing runtime-decision broker and defaults external plugins to ask-and-park. Unsupported, absent, or internally inconsistent capability claims fail closed and emit operational telemetry.

### Durable identity and provenance

Each question records:

- Company, task, asking agent, responsible recipient, and current recipient.
- Originating runtime kind and run id.
- Producer identity `companyId + originatingRunId + producerInvocationId` and semantic payload fingerprint. `producerInvocationId` is created at the trusted provider tool-call boundary and reused across every transport retry or reconnect. MCP request ids remain transport metadata. No identity is accepted from model arguments.
- Workspace, source Discussion and entry, source Commander conversation, and primary task creation source.
- Question, options, blocking state, answer, responder, timestamps, and version.
- Continuation status, idempotency identity, attempts, and visible failure reason.
- Snapshot labels retained when linked tasks or agents are deleted.

All foreign sources are validated in the same company. Trusted execution context supplies provenance; model input cannot grant or rewrite it.

### Exactly-once boundaries

- Question creation: unique producer invocation identity, atomic create-or-load.
- Answer: optimistic version plus first-authorized-answer transaction.
- Continuation request: unique `(questionId, answerVersion)`.
- Claim: fenced claim token and renewable lease.
- Heartbeat wakeup: unique downstream idempotency key with atomic insert-or-load.
- Mirror updates: canonical source event identity.
- Activity log: one event per accepted domain transition.

Exactly-once means one durable domain result under retries; transport and workers remain at-least-once.

### Authorization

- Company scope is mandatory for every source and target.
- Task read permission is evaluated before pagination and before counts are returned.
- The current recipient may answer or reassign.
- Founder and instance administrator retain audited takeover authority.
- Responsible human and reviewer may take over when they can read the task.
- A scoped lead may take over or reassign only when both task and new recipient fall inside canonical lead scope.
- Reporting hierarchy affects `Managing` relationship classification, not mutation permission.
- Cross-company ids return non-enumerating errors and never leak counts or snapshots.

### SLA and escalation

V1 stores a company question-response SLA with an optional project override. The default is 24 elapsed hours. Department-specific overrides and calendars are deferred. Every question snapshots `slaDuration`, `slaSource`, `dueAt`, and its escalation recipient. Breach notification and reminders use stable idempotency identities and a cooldown. Escalation routes to an eligible scoped lead, then founder when no lead exists.

Settings exposes the resolved company default under task execution as `Human question response time`, with the 24-hour default, explanatory text, and project override controls. Question cards show `Waiting since`, `Due in`, or `Overdue by` using the viewer's locale and timezone. Settings never imply business-hour behavior in V1.

At SLA breach:

1. Keep the original recipient.
2. Add `sla_breached` attention and `At risk` classification.
3. Notify the recipient and next authorized escalation route.
4. Show `Remind`, `Take over`, and `Reassign` only where authorized.
5. Audit every reminder, takeover, and reassignment.
6. Do not enqueue a continuation until an answer is accepted.

Reassignment candidates must be active company members who can read the source task. Takeover and reassignment change only the question recipient, never task assignee, responsible human, or reviewer. They require expected versioning and append-only audit history.

### Realtime and query model

The server emits company-scoped events containing canonical ids but no sensitive answer text. Clients invalidate question, task, Hub, timeline, and Cockpit presentation queries from the same event.

Question list responses include display snapshots, continuation state, attention state, and capability bits. Inline cards do not create one detail request per row. Hidden panes stop fallback polling. Disconnected fallback polling is bounded to visible open questions.

### Timeline composition

Commander, Task Work, Workspace, and Discussion consume a shared timeline event union:

```ts
type TimelineEvent =
  | { kind: "message"; id: string; createdAt: string; payload: Message }
  | { kind: "work_question"; id: string; createdAt: string; payload: WorkQuestionSummary };
```

The merge is deterministic by `(createdAt, kindOrder, id)`. Equal timestamps remain stable. Mirrors share the canonical question id and never persist duplicate ordinary chat messages as question state.

Live insertion preserves the user's scroll anchor while reading history. Auto-scroll occurs only near the bottom; otherwise a `New question` jump action appears. Composer draft and focus remain intact, and resolved cards update in place without shifting the timeline unexpectedly.

### Cockpit presentation and panes

The server compositor emits one primary home per entity using the approved precedence:

1. `To do`
2. `Managing`
3. `Following`

Attention enriches that stable row. It does not move or duplicate it.

Task, review, and question rows open Task Workspace focus with a typed exact anchor. Discussion rows open Discussion focus and reuse the Commander Viewer for nested artifacts, tasks, approvals, and evidence. Inbox-only actions and artifacts use the Viewer. Pane close and resize restore the exact prior layout, scroll, draft, and row focus.

Exact anchor means preserving `{kind,id}`, selecting the owning tab, awaiting the target, scrolling and focusing it, announcing it, and applying a reduced-motion-safe highlight. Resolved, deleted, and unauthorized targets use explicit fallbacks and restore focus to the originating Cockpit row.

Commander owns pane boundaries and resize seams. Embedded Task and Discussion content is borderless and shadowless; child panes own entity headers and content only. Closing a pane immediately releases its width to its neighbor.

Structural My Work and attention counts cannot be hidden. Counts are computed before preferences. A collapsed rail badge means unresolved `Needs me`, while `At risk` receives a distinct text or icon treatment. Any partial, failed, or unknown source suppresses calm `All clear` language and shows the affected source, unreliable count, last successful refresh, and retry action.

### Question UX state matrix

Wave C defines user-facing language and actions for assigned-to-me, assigned-to-another, approaching SLA, breached, submitting, stale conflict, answered, continuation queued, running, succeeded, failed, reassigned, taken over, cancelled, and source-terminal states. Each state specifies recipient, source, deadline or age, primary and secondary actions, draft retention, and live-region announcement. Raw backend enums are never displayed.

### Responsive and accessibility contract

One exported Commander breakpoint selector drives both reducer and rendering. At `<=720px`, persistent triggers open Cockpit, Focus, and Viewer as full-screen surfaces. Boundary tests cover `639/640`, `720/721`, `1023/1024`, `1099/1100`, `1535/1536`, and `1599/1600` until legacy breakpoint variants are removed.

Dragging uses a dedicated grip; row click only opens. `Attach to chat` remains keyboard and touch reachable without hover. Critical touch targets are at least 44 by 44 pixels and marker text is at least 11px. Resize separators expose accessible names, values, arrow-key resizing, and visible focus.

## API And Data Changes

All schema changes use Drizzle schema files and `pnpm db:generate`.

1. Extend question creation contracts with producer invocation identity and payload fingerprint.
2. Add or normalize explicit trusted provenance fields for Commander-created delegated tasks and runs.
3. Extend continuation context with the complete immutable envelope.
4. Add continuation claim token, lease expiry, and ownership-aware transitions.
5. Add runtime human-question capabilities to adapter execution metadata.
6. Add question SLA defaults and resolved snapshots at company and scope levels.
7. Replace per-row list authorization with a bounded server query and capability projection.
8. Add source-neutral follow routes and Cockpit v3 presentation endpoints if not already implemented.
9. Emit question, continuation, follow, task-relationship, Hub-reconciliation, and Cockpit-invalidation live events.
10. Preserve legacy open `agent_runtime_decisions(kind=work_question)` through terminal dual-read; do not migrate them into new canonical questions.

Migration rollout uses expand -> compatible server -> worker enablement -> backfill -> feature enablement. Regenerate `0171` only if it has never reached a shared environment; otherwise preserve it and generate `0172`. Rehearse lock timeouts and upgrades with existing legacy rows. List API changes use a versioned additive envelope or a new versioned endpoint so existing `WorkQuestion[]` clients remain compatible.

Realtime publishes one versioned `work_question.changed` event after commit with company id, canonical ids, version, and transition but no answer text. V1 documents single-instance delivery plus bounded fallback polling; horizontal deployment requires shared pub/sub before claiming cross-instance realtime.

## Implementation Waves

### Wave A0 - Real runtime preflight

- Run Claude and Codex in a fresh isolated company before additional Cockpit or SLA work.
- Prove each provider sees exactly its checked-out task through MCP, reads criteria and source context, writes a real Workspace output, and performs a legal task transition.
- Add shared run accounting for `activeExecutionMs`, `humanQuestionWaitMs`, `runtimePermissionWaitMs`, and `totalWallClockMs`; both question and permission waits stop the active execution deadline.
- Harden Codex Windows startup with a short managed home, cached or junction-based plugin materialization, no recursive curated-plugin checkout per run, path-length tests, and a live startup preflight.
- Test live-relay behavior only through a capability-controlled deterministic adapter until a real provider supports it.
- Add the bounded per-run equivalent-action permission grant and prove its Workspace, action-class, expiry, and audit boundaries.

**Exit gate:** Claude and Codex each start successfully, see exactly their checked-out task, write a real Workspace output, and perform a legal transition. A real supervised permission wait increases `runtimePermissionWaitMs` and wall-clock time without increasing `activeExecutionMs` or exhausting the provider deadline. Failure blocks later waves.

### Wave A - Runtime correctness and security

- Add producer idempotency identity and retried-create conflict behavior.
- Persist and consume the complete continuation envelope.
- Repair Commander-to-task-to-heartbeat provenance propagation.
- Implement capability-driven ask-and-park; remove universal provider-budget waiting.
- Fence continuation claims and make heartbeat enqueue atomic insert-or-load.
- Replace membership-parent scope inference with canonical project or department authorization.
- Permit eligible task-bound `org` and `aoa` Crew producers; reject un-tasked Crew, Commander, and Discussion interactions.
- Normalize lock order for answer, cancellation, and task deletion.
- Persist the immutable continuation envelope on the request row and consume it directly from heartbeat/provider prompts.
- Add terminal callbacks and terminal-task fencing.
- Add unit, database integration, concurrency, and cross-company tests before UI changes.

**Exit gate:** Deterministic and real-provider task runs can ask, park, answer, continue with answer-specific context, and reach the configured task transition exactly once under retry and restart. This answer-specific proof runs immediately after Wave A and before SLA or UI work.

### Wave B - SLA, realtime, and scalable reads

- Add resolved question SLA policy and breach scheduler.
- Add company and project Settings controls for the 24-hour elapsed SLA and display the resolved source.
- Implement notification-only escalation with explicit takeover and reassignment.
- Add activity and operational telemetry without answer content.
- Replace N+1 authorization and per-row detail polling with batched query responses.
- Add real-time invalidation and disconnected visible-source fallback polling.
- Add query-count, pagination, hidden-pane, and scheduler recovery tests.

**Exit gate:** Query count is constant across 1, 10, 100, and 200 rows; SLA breach updates every authorized surface without changing recipient.

### Wave C - Inline timelines and exact focus

- Build the shared timeline event merger.
- Render the canonical card chronologically in Commander, Task Work, Workspace, and Discussion.
- Preserve Task Work behavior when no execution Workspace exists.
- Carry typed anchors through presentation, pane coordinator, and Task Workspace.
- Focus and scroll the exact question or review action after data load.
- Reconcile first-click behavior, drafts, scroll restoration, and nested Viewer use.

**Exit gate:** The same question is visible and answerable on all five authorized surfaces, and every Cockpit action opens the exact intended control on the first click.

### Wave D - Person-centered Cockpit compositor and UI cutover

- Complete user follows and relationship classification.
- Implement server-side deduplication, ranking, attention, count, and partial-source metadata.
- Replace the legacy five-section registry with the four approved sections.
- Implement `All`, `Needs me`, and `At risk` filters without duplicate lists.
- Keep Tasks and Decisions `View all` routes canonical; expand Following in Cockpit.
- Preserve sticky notes, pins, optional cards, and migrated preferences.
- Gate the entire v3 cutover atomically; never mix old and new classification sources.

**Exit gate:** Founder, lead, and member see role-correct To do, Managing, Following, Conversations, Overview, and Context rows with no duplicate entity identity.

### Wave E - Accessibility, responsive behavior, and observability

- Verify keyboard-only drag, open, answer, takeover, reassign, close, and pane resize workflows.
- Implement focus restoration and Escape order across Commander, focus pane, Viewer, and Cockpit.
- Enforce the approved four-pane responsive transitions and minimum widths.
- Ensure cards expose recipient, wait reason, source, age, and action without visual overflow.
- Add reduced-motion behavior, screen-reader status announcements, and contrast verification.
- Add dashboards for question age, SLA breach, continuation latency, retry count, failures, and provider capability fallback.
- Add alert thresholds, admin diagnostics, and a runbook for stuck leases, failed continuations, scheduler lag, duplicate producer conflicts, stale unanswered questions, and manual retry, cancel, and reconciliation.

**Exit gate:** Desktop, tablet, and mobile Playwright screenshots and accessibility tests pass with no overlap, clipped controls, lost focus, or hidden unresolved action.

### Wave F - Deterministic and real-provider qualification

- Run all deterministic unit, integration, concurrency, component, and authenticated Playwright gates.
- Create a fresh company with founder, lead, member, department, project, Discussion, real Claude agent, and real Codex agent.
- Run R01-R14 and Q1-Q5 from the real lifecycle plan without direct database lifecycle mutation.
- Prove task checkout, MCP task visibility, question causality, answer-specific continuation output, review, request changes, approval, completion, and Commander synthesis.
- Crash and restart the server around accepted answers and claimed continuations.
- Capture redacted manifests, screenshots, logs, provider versions, ids, artifacts, query counts, and timeline evidence.
- Leave one isolated review URL running for user acceptance.

**Exit gate:** Every mandatory deterministic and live id is `PASS`; `BLOCKED`, `NOT RUN`, missing evidence, or unexpected skip fails qualification.

## Test Matrix

### Unit

- Relationship precedence, attention ranking, deduplication, and stable homes.
- Adapter capability resolution and fail-closed fallback.
- Eligible task-bound `org` and `aoa` Crew Ask Human producers; rejection of un-tasked Crew, Commander, and Discussion callers.
- Producer idempotency identity and payload fingerprint conflicts.
- Continuation envelope construction and sensitive-field redaction.
- Claim token ownership, lease expiry, retry backoff, and stale-worker no-op.
- Scope resolution separating reporting hierarchy from project authority.
- SLA resolution, breach classification, and notification route selection.
- Timeline ordering, equal timestamps, typed anchors, and preference migration.

### Database integration

- Fresh migration and upgrade from the pre-feature schema.
- Concurrent duplicate question creation produces one canonical row.
- Two answers, answer versus reassign, answer versus takeover, answer versus cancel, and answer versus task deletion produce one legal state.
- Barrier-controlled continuation lease expiry proves stale success and stale failure cannot mutate the new owner.
- Crash after heartbeat insertion but before outbox completion converges on one run.
- Cross-company and out-of-scope recipients are rejected without leaking existence.
- SLA scheduler is idempotent across overlapping ticks and restart.
- Query count remains constant with pagination and authorization applied before `LIMIT`.
- Relay-versus-continuation exclusivity and heartbeat terminal propagation.
- Terminal task versus running continuation fencing.
- Slow-batch lease expiry, overlapping scheduler ticks, and stale claim ownership.
- MCP replay across bridge reconnect and external adapter compatibility.
- Migration rehearsal with existing legacy question, wakeup, and preference rows.
- Permission waiting increases `runtimePermissionWaitMs` and total wall-clock time without increasing `activeExecutionMs`.

### Service and API

- Every source id is company-consistent.
- Create, list, detail, answer, reassign, takeover, retry, cancel, and follow operations enforce operation-specific capabilities.
- List rows contain enough state and capability information to render without per-row detail calls.
- Live events contain canonical ids and no answer text.
- Legacy runtime questions remain dual-readable until terminal.
- Error responses use consistent `400/401/403/404/409/422/500` semantics.

### UI component

- WorkQuestionCard options, free text, validation, conflict, answered, pending, failed, overdue, takeover, and reassignment states.
- Chronological placement in Commander, Task Work, Workspace, and Discussion.
- Inbox uses the same question id and authoritative detail.
- Review and question rows open exact anchored controls.
- Four-section Cockpit filters, counts, density, loading, partial failure, empty state, and preferences.
- No `Everything looks good` state while active, blocked, failed, overdue, or unanswered work exists.

### Authenticated browser E2E

- Founder, scoped lead, and member receive distinct relationship and capability views.
- Answer from each supported surface updates every other open surface.
- Scoped lead cannot mutate a task or recipient outside scope.
- SLA breach appears for recipient and manager without auto-reassignment.
- Explicit takeover changes recipient everywhere and one answer resumes the agent.
- Focus pane and Viewer coordinate across task, Discussion, approval, artifact, and run references.
- Four-pane close, resize, draft, scroll, and focus restoration pass across breakpoints.

### Real-provider campaigns

- Claude and Codex each pass a task-context preflight before campaign work.
- A real agent tool call creates the question; no seed or SQL creates lifecycle end state.
- Real Claude and Codex prove ask-and-park. A capability-controlled fake adapter proves active live relay until a genuinely pauseable provider exists.
- Continuation receives the exact human answer and produces answer-specific artifact evidence.
- Provider timeout excludes human waiting.
- A real supervised permission wait proves the permission-wait counter advances while active execution time and deadline budget remain paused.
- Task-bound Crew Ask Human is proven on the deterministic adapter path and on a real provider whenever the selected Crew runtime supports that provider.
- Provider cancellation, unavailable provider, and exhausted credits are reported honestly.
- Review-required and agent-can-complete tasks follow their effective policy.
- Commander explanation cites actual task, question, answer, run, output, review, and Discussion sources.

### Repository gates

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm test:commander-lifecycle
```

`pnpm test:commander-lifecycle` provisions isolated PostgreSQL, applies and verifies migrations, executes the required lifecycle manifest, and writes machine-readable evidence. The dedicated `commander-lifecycle` CI job must fail on missing PostgreSQL configuration, missing expected ids, skips, zero-test suites, migration drift, absent evidence, or a non-passing mandatory campaign. A green normal test command with lifecycle suites skipped is not qualification.

## Rollout And Recovery

- Keep the v3 Cockpit behind one capability gate until Waves A-D pass together.
- Use separate server-controlled kill switches for new question producers, continuation workers, the SLA scheduler, and Cockpit v3 reads/UI.
- Roll out in that order only after dependencies are healthy; worker shutdown drains owned claims or lets leases expire safely.
- Schema and event changes are additive and backward-readable during rollout.
- Legacy runtime work questions remain isolated from the new continuation path.
- A rollback disables the v3 compositor but does not delete follows, answers, provenance, or continuation audit rows.
- Scheduler and outbox health are observable before enabling the UI capability.
- Partial source failures produce explicit partial metadata and never a false calm empty state.

## Definition Of Done

1. Every P1 blocker in this plan has a regression test that fails before and passes after its implementation.
2. No new durable question can be duplicated by retry or lose its task, answer, source, or provider-session context.
3. Authorization uses company and canonical task scope; reporting hierarchy never grants mutation rights.
4. Human waiting is outside non-pauseable provider execution budgets.
5. One answer updates Commander, Inbox, Task Work, Workspace, and Discussion and causes exactly one relay or continuation.
6. Question SLA breach is visible and actionable without silent ownership transfer.
7. The four-section Cockpit has stable homes, correct attention, exact focus targets, and no duplicate rows.
8. Work-question reads remain bounded and hidden panes do not poll.
9. Full typecheck, tests, build, deterministic browser gates, and mandatory real-provider campaigns pass.
10. The isolated review application remains available with its evidence manifest for user acceptance.

## Confirmed Review Decisions

1. Task-bound organization and `aoa` Crew execution share the durable Ask Human lifecycle; un-tasked conversation does not.
2. V1 uses a visible, configurable 24 elapsed-hour SLA with project overrides; calendar-aware working hours are deferred.
3. V1 includes audited, run-bounded equivalent-action permission grants restricted to the exact Workspace and action class.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/plan-ceo-review` | Scope and product completeness | 2 | CLEAR | All prior P0/P1 findings and confirmed decisions are executable |
| Design Review | `/plan-design-review` | Enterprise UX and interaction | 1 | CLEAR FOR PLAN | 6 P1 and 2 P2 incorporated into Waves C-E |
| Eng Review | `/plan-eng-review` | Architecture, data, concurrency, and tests | 2 | CLEAR | No remaining P0/P1 contract gaps; Wave A0 is the safe first slice |

- **CROSS-MODEL:** All reviews agree the four-section IA and core Ask Human direction are sound; all reject implementation before runtime identity, state, migration, and preflight contracts are corrected.
- **UNRESOLVED:** 0 product decisions.
- **VERDICT:** CEO + DESIGN PLAN + ENG CLEARED. Implementation and branch qualification are complete. The authenticated A01-A07 campaign, focused contracts, real-provider REA lifecycle, full typecheck, full test suite, and production build pass. Formal release sign-off still requires an executable run of the named `R01-R14` and `Q1-Q5` Wave F matrix.

## Execution Status

- Waves A0-E are implemented and covered by focused regression tests.
- Real Claude/Codex lifecycle work was exercised in the REA company, including Ask Human continuation and bounded runtime permission flows.
- Authenticated browser scenarios A01-A07 pass against fresh private deployments with isolated databases.
- Repository typecheck, full tests, production build, and real-Postgres work-question integration pass.
- The detailed evidence, residual risks, and independent review findings are recorded in `docs/aoa/qa/2026-07-13-commander-enterprise-qualification.md`.
- Wave F remains incomplete only for the named `R01-R14` and `Q1-Q5` release matrix because this branch does not yet contain an executable runner for that matrix.
