# Commander Cockpit Real Lifecycle Test Plan

**Status:** Implementation in progress; Waves 0-1 deterministic foundation complete

**Parent plan:** [Commander Cockpit Person-Centered IA Implementation Plan](./2026-07-12-commander-cockpit-personal-ia-implementation-plan.md)

## Purpose

Prove the Commander Cockpit with two complementary forms of evidence:

1. Deterministic automated tests cover every branch, race, permission boundary, failure mode, and UI state on each pull request.
2. Fresh live-provider campaigns create genuine tasks and run authenticated Claude and Codex CLIs so questions, permissions, outputs, review, completion, and continuation are observed rather than fabricated.

Neither layer substitutes for the other. Fake adapters give repeatability and failure injection; real providers prove the actual runtime, MCP/tool bridge, Workspace, and user experience.

## Progress - 2026-07-12

- The fail-fast targeted gate and independently verified execution manifest cover the Wave 0 presentation/pane contracts and Wave 1 persistence/capability contracts.
- The targeted gate passes 62 tests with shared, UI, and DB package typechecks.
- Generated migration `0171_real_revanche.sql` applies to a fresh isolated PostgreSQL database, and a second schema generation reports no drift.
- Full repository verification passes 23-project typecheck, 11,915 tests, and production build.
- Real provider journeys R01-R14 and Q1-Q5 remain intentionally unclaimed until Wave 2 supplies the durable question service, `ask_human` runtime path, mirror reconciliation, and exactly-once continuation dispatch.

## Authoritative Qualification Environment

Linux CI with real PostgreSQL and Chromium is the authoritative merge gate. The default Windows embedded-PostgreSQL Playwright configuration can run only a skip sentinel on administrative runners, and several DB suites skip there; a zero exit on that path is advisory, not qualification.

Every qualification run emits `test-execution-manifest.json` with expected, passed, failed, skipped, blocked, and not-run ids for unit, DB integration, deterministic E2E, authenticated E2E, and live campaigns. The gate fails on an unexpected skip, missing expected id, zero-test suite, or blocked required deterministic test. Local Windows becomes authoritative only with the documented external `DATABASE_URL` or forced non-admin embedded PostgreSQL path.

## Non-Negotiable Test Rules

1. Lifecycle end states are never inserted directly into the database.
2. Company, human, agent, department, project, goal, Discussion, and initial task setup may use supported UI or public APIs.
3. Questions must be created by a running agent through the provider-neutral `ask_human` path.
4. Runtime permissions must come from a real supervised tool request.
5. Outputs must be written by the agent inside its real isolated Workspace.
6. Review must be reached through the task-domain transition, not a seeded status.
7. Continuation must be produced by answering a real parked question.
8. Direct SQL is read-only evidence or deterministic integration setup where no public fixture seam exists; it never manufactures a live campaign result.
9. Every scenario is marked `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`. A blocked provider is never reported as a product pass.
10. Provider credentials, session data, private answers, and raw sensitive logs are excluded from committed evidence.

## Test Layers

| Layer | Purpose | Runtime | Merge gate |
|---|---|---|---|
| Static/schema | Type synchronization, validators, generated migration shape | TypeScript/Drizzle | Every change |
| Unit | Pure classification, attention, deduplication, ranking, reducer, preference behavior | Vitest | Every change |
| DB integration | Transactions, authorization, exact counts, races, outbox, Hub reconciliation | Vitest + real PostgreSQL | Every change |
| API contract | Request validation, company boundaries, status codes, compatibility | Supertest/Vitest | Every change |
| UI component | Rendering, keyboard, focus, drag alternatives, error states | RTL/Vitest/jsdom | Every change |
| Deterministic browser E2E | Full UI flows with supported APIs and scripted fake CLIs | Playwright isolated instance | Every PR |
| Authenticated multi-user E2E | Founder/lead/member sessions and permission-scoped UI | New Playwright authenticated config | Before UI capability ships |
| Live-provider E2E | Genuine Claude and Codex task runs and causal evidence | Playwright live config + isolated instance | Release qualification and final handoff |
| Manual in-app acceptance | Visual quality, pane feel, resizing, drag, readable context | Visible in-app browser | Before user acceptance |

## Required Test Harness Work

### Deterministic harness

Extend the existing `tests/e2e/playwright.config.ts` isolated instance and fake Claude/Codex controls. Fake CLIs must call the same supported runtime hooks and APIs as real adapters; they may script timing and failure, but may not bypass the work-question service or write final lifecycle rows directly.

Add reusable helpers:

- `createCommanderTestOrganization`
- `createTaskRelationshipFixture`
- `scriptAskHumanRun`
- `scriptPermissionRun`
- `waitForQuestionMirror`
- `answerQuestionFromSurface`
- `assertCockpitPlacement`
- `assertSingleContinuation`
- `captureCommanderPaneState`

### Authenticated multi-user harness

The normal E2E config runs `local_trusted` and treats `local-board` as founder. It cannot prove founder/lead/member browser behavior.

Add a dedicated Playwright configuration that:

1. Starts an isolated instance with `AOA_DEPLOYMENT_MODE=authenticated` and a test-only strong `BETTER_AUTH_SECRET`.
2. Creates founder, lead, and member accounts through supported authentication routes.
3. Creates or accepts company membership and role assignments through supported APIs/UI.
4. Saves separate Playwright storage states for all three users.
5. Runs the same Cockpit page assertions in separate browser contexts.
6. Verifies unauthorized rows, counts, Viewer bodies, routes, and live events are absent rather than merely disabled.

The v3 Cockpit UI cannot ship based only on local-board role simulation.

Concrete harness files:

- `tests/e2e/playwright.authenticated.config.ts`
- `tests/e2e/auth/global-setup.ts`
- `tests/e2e/auth/global-teardown.ts`
- `tests/e2e/auth/founder.storage.json` (generated and gitignored)
- `tests/e2e/auth/lead.storage.json` (generated and gitignored)
- `tests/e2e/auth/member.storage.json` (generated and gitignored)
- `tests/e2e/commander-cockpit-authenticated.spec.ts`

Global setup starts the authenticated isolated instance, signs up or signs in the founder, creates the company, drives invite acceptance for lead/member, assigns roles/scopes, and saves storage states. Global teardown deletes the test company/users where supported and stops the instance. Tests include CSRF/trusted-origin rejection and cross-company live-event subscribe/reconnect attacks.

### Live-provider harness

Add `tests/e2e/scripts/commander-lifecycle-instance.ts`, a dedicated lifecycle controller that owns the isolated server and writes a redacted startup manifest. The lifecycle campaign uses `tests/e2e/playwright.commander-lifecycle.config.ts`; it must validate that manifest before setup and must not attach to an arbitrary live server. The launcher enforces:

- No fake crew, fake Claude, or fake Codex environment flags.
- Resolved CLI paths are outside all fake fixture directories and include executable versions.
- Dedicated app, HMR, and embedded PostgreSQL ports.
- Dedicated AOA home and Workspace root.
- `AOA_DEPLOYMENT_MODE=authenticated` with a campaign-specific strong `BETTER_AUTH_SECRET`.
- Provider readiness probes before task creation.
- Explicit Claude/Codex model and timeout environment settings.
- Supervised permission routing enabled.
- Claude `dangerouslySkipPermissions` and Codex `dangerouslyBypassApprovalsAndSandbox` are false.
- A visible review URL left running for the user after the campaign.

The harness records binary, adapter, model, run id, task id, Workspace id, question id, approval/decision id, Discussion id, and timestamps without recording credentials. Campaign setup signs in the founder, lead, and member against this exact instance, stores three campaign-scoped authenticated browser states, and records their user, session, and company ids in redacted form. Every live phase chooses one of those explicit browser contexts; the campaign never inherits board or `local_trusted` access.

The controller exposes `start`, `status`, `crash`, `restart`, and `stop` operations. `crash` force-terminates the owned server PID and proves that PID and listener are gone. `restart` preserves the same database, AOA home, Workspace root, campaign manifest, and ports; waits for API health plus continuation-worker readiness; and validates or refreshes the three authenticated browser sessions without recreating company or domain state. Evidence distinguishes graceful stop/start from forced crash/restart.

Do not reuse the existing real-crew helper's bypass policy for the supervised campaign. Lifecycle helpers must accept an explicit safe policy and assert the persisted agent configuration before the first task.

Before any campaign task, each provider must pass a live task-context preflight:

- See exactly its checked-out task.
- Read acceptance criteria and source context.
- Read and write a bounded document inside its Workspace.
- Fail to read a cross-company control task.
- Invoke `ask_human` successfully in a disposable preflight task.
- Submit review or completion under the configured task policy.

Failure blocks that provider track immediately and prevents an expensive campaign that cannot preserve task context.

### Live provenance chain

For every provider task, evidence must establish:

```text
task -> checkout -> run -> adapter process/session -> provider tool call
     -> domain event -> question/permission/output/review
```

Record executable path/version, adapter/model, provider session correlation, process exit state, tool-call event identity, Workspace-before/after hash, and actor/run ids on mutations. Any missing link is a failure; temporal proximity or a plausible file is not accepted as proof.

## Static And Contract Tests

### Shared contracts

- Every presentation union and `openTarget` variant parses valid fixtures and rejects incomplete variants.
- `groupId` agrees with `relationship` and To do subgroup invariants.
- Every linked action has workflow identity, related refs, attention, and its own open target.
- Follow validators accept V1 task/project/goal and reject department/artifact/agent/note kinds.
- Work-question Commander source requires a real task and asking agent at creation.
- Compatibility aliases remain parseable during the migration window.

### Schema and migrations

- Fresh database applies all generated migrations.
- Upgrade from the pre-feature schema preserves existing pins, Cockpit preferences, runtime decisions, tasks, and Hub items.
- `user_entity_follows` uniqueness and entity-type check work.
- Question agent/task retention semantics preserve snapshots after deletion.
- Continuation outbox uniqueness on `(questionId, answerVersion)` works.
- Heartbeat/internal-agent downstream idempotency constraints reject duplicate continuation dispatch.
- Company deletion cascades new follows, questions, mirrors, and outbox rows in dependency-safe order.

## Unit Test Matrix

### Relationship classification

| Case | Expected home |
|---|---|
| Human is task assignee | To do / Tasks |
| Human is responsible; agent executes | Managing |
| Direct-report human executes | Managing |
| Reporting-subtree agent executes | Managing |
| Explicit follow with no stronger relation | Following |
| Managing task asks current human | Managing + Question/Needs me |
| Following task asks current human | Following + Question/Needs me |
| Unrelated task routes review to current human | To do / Decisions |
| Relation predicates overlap | One row using base precedence |
| Task terminalizes | Removed from active My Work |

### Attention classification

- Question, approval, review, and reply request enter Needs me only for an authorized current action.
- Blocked, overdue, failed continuation, breached SLA, and at-risk objective enter At risk.
- Running, queued, unread, updated, and completed retain informational priority.
- Waiting on human displays the actionable reason instead of a raw runtime label.
- Following ordinary updates never enter Needs me.
- One primary marker, one secondary marker, then `+N` ordering is deterministic.

### Deduplication and ranking

- One task with question, review, approval, run, Inbox mirror, pin, and Discussion link has one My Work row.
- Every action marker keeps its own destination.
- Multi-task approval remains one standalone Decisions workflow.
- Context pin declares `shortcutOf` and does not increment work counts.
- Company Overview aggregates do not create task rows.
- Equal urgency/priority/timestamps use stable id tie-breaking.
- Exact counts use full deduplicated key space, independent of hot-row limits.

### Pane and state models

- Every transition in the parent plan table.
- Nested Viewer origin stack and Escape order.
- Workspace/Discussion replacement retains keyed drafts, tabs, scroll, and anchors.
- Browser Back follows topmost close order.
- Breakpoint transitions preserve state.
- Hidden panes suspend expensive queries and do not steal focus.

### Preferences

- V2-to-v3 migration is idempotent.
- Explicit old off choices map to optional summaries.
- Required My Work actions and attention counts cannot be disabled.
- Corrupt storage falls back without overwriting recoverable old data.

## Database Integration Matrix

### Adapter and runtime-hook contracts

- Claude and Codex adapters expose the provider-neutral `ask_human` schema.
- `ask_founder` remains a compatibility alias and produces the same durable service call.
- Active-session relay and ask-and-park paths preserve task/run/Workspace context.
- Provider cancellation while waiting produces one legal parked/cancelled state.
- Malformed, oversized, missing-option, and repeated tool payloads are rejected consistently.
- Continuation context includes task, criteria, source, question, answer, Workspace, and remaining steps.
- Runtime-hook authentication rejects missing, expired, replayed, wrong-run, wrong-agent, and cross-company tokens.
- Adapter contract tests prove no provider bridge can create a question for an unrelated or non-checked-out task.

### Authorization

- Create rejects unauthenticated agents, inactive runs, terminal tasks, unrelated assignments, invalid checkout ownership, and cross-company sources.
- Read does not leak counts or existence for unauthorized source tasks.
- Answer requires recipient or completed authorized takeover.
- Reassign and takeover honor founder, responsible/reviewer, and lead scope rules.
- Retry and cancel enforce their operation-specific capabilities.
- Follow does not grant source read or mutation permission.
- Every linked issue, agent, Workspace, Discussion, entry, Commander conversation, recipient, and actor is company-consistent.

### Question and continuation races

- Two answers: first authorized transaction wins; loser receives resolved state.
- Duplicate idempotency key replays the original result.
- Answer versus reassign/takeover/cancel produces one legal state.
- Answer versus task deletion either answers or cancels once, retains snapshots, and never continues deleted work.
- Answer plus outbox insertion is atomic.
- Crash before dispatch is recovered.
- Crash after downstream dispatch does not run twice.
- Concurrent retry workers claim one outbox row.
- Terminal task before continuation suppresses wakeup with an audited reason.

### Hub and presentation

- One question produces one Hub mirror and one Cockpit linked action.
- Answer/cancel closes every mirror transactionally or through idempotent reconciliation.
- Legacy runtime work questions and durable questions coexist until legacy terminalization.
- Partial source failure preserves healthy sections and marks response partial.
- High-cardinality company data returns globally correct top rows and exact counts.
- Query-count assertions prevent N+1 enrichment.

## UI Component Matrix

### Cockpit

- All, Needs me, and At risk selected/pressed states and counts.
- My Work Tasks, Decisions, Managing, and Following groups.
- Eight-row total density budget with one guaranteed row per non-empty group.
- Required actions remain discoverable when optional summaries are hidden.
- Company Overview absent for member and scoped for lead.
- Context distinguishes Pin from Follow.
- Loading, empty, partial error, forbidden target, and stale response states.
- Row click, action marker, drag grip, Attach to chat, overflow, pin, follow, and full-page escape remain separate controls.

### WorkQuestionCard

- Option, free-text, and combined answer modes.
- Open, submitting, answered, stale conflict, reassigned, cancelled, continuation pending, dispatched, and failed states.
- Plain chat message does not resolve the question.
- Radiogroup semantics, labels, live announcements, and focus restoration.
- Answer from one mounted mirror updates another through shared query invalidation.

### Focus, Viewer, and responsive UI

- Workspace and Discussion focus bodies.
- Commander-hosted Discussion uses Commander Viewer; standalone Discussion uses native Viewer.
- Viewer replacement/tab cap/close order.
- Mobile persistent Cockpit button and focus-trapped drawer.
- No overlap or clipped text at 390, 768, 1280, and 1600px.
- Keyboard-only and reduced-motion paths.

## Deterministic Playwright Scenarios

Create `tests/e2e/commander-cockpit-personal-ia.spec.ts` and focused companion specs where isolation improves diagnostics.

| ID | Scenario | Evidence |
|---|---|---|
| D01 | Founder sees correct To do/Managing/Following homes | DOM assertions + Cockpit API snapshot |
| D02 | Needs me and At risk filter rows without moving sections | DOM before/after + counts |
| D03 | Task with all linked sources dedupes to one row | Row count + action markers |
| D04 | Each action marker opens its exact Focus/Viewer target | URL unchanged + pane assertions |
| D05 | Follow and Pin are independent | API + UI + reload |
| D06 | Question renders in Commander, Inbox, Task Work, Workspace, and Discussion hosts | Same question id on all five mirrors |
| D07 | Answer from each mirror across five separate questions | Resolved mirrors + one continuation each |
| D08 | Review Request Changes and approval have different task outcomes | Status + placement transition |
| D09 | Multi-task approval remains one Decisions item | One workflow row + related task list |
| D10 | Legacy and durable work questions coexist | Both readable; separate lifecycle actions |
| D11 | Partial API failure preserves healthy sections | Error notice + usable unaffected rows |
| D12 | Pane replacement, drafts, scroll, Back, and Escape restore state | State assertions |
| D13 | Drag grip and Attach to chat create one typed chip | Chip identity + no navigation |
| D14 | Mobile/tablet/desktop/wide choreography | Screenshots + semantic assertions |
| D15 | Refresh/reconnect does not duplicate rows or continuations | Network interruption + final ids |

## Authenticated Multi-User Scenarios

| ID | Actor | Expected behavior |
|---|---|---|
| A01 | Founder | Company-wide Managing relevance and aggregate Company Overview, bounded and permission-safe. |
| A02 | Product lead | Own To do, reporting-subtree Managing, explicit Following, department/project Overview only. |
| A03 | Team member | Own To do and follows; Company Overview absent by default. |
| A04 | Lead outside scope | No counts, rows, action details, or live-event leakage from another department. |
| A05 | Sick/absent recipient takeover | Authorized founder/scoped lead takes over, answers, and every mirror updates. |
| A06 | Unauthorized member | Cannot answer, reassign, take over, retry, follow unreadable work, or infer source existence. |

Run each with independent storage state and at least one cross-company negative fixture.

## Real Live-Provider Campaign

The campaign uses a generated `campaignId` and independently rerunnable phased specs rather than one R01-R14 test body:

- `commander-cockpit-live-setup.live.spec.ts`
- `commander-cockpit-provider-preflight.live.spec.ts`
- `commander-cockpit-claude-questions.live.spec.ts`
- `commander-cockpit-codex-questions.live.spec.ts`
- `commander-cockpit-review-loop.live.spec.ts`
- `commander-cockpit-approval.live.spec.ts`
- `commander-cockpit-panes.live.spec.ts`
- `commander-cockpit-synthesis.live.spec.ts`

Specs share only the redacted campaign manifest and persisted domain ids. Each has its own timeout and causal assertions. `playwright.commander-lifecycle.config.ts` defines executable project dependencies:

1. `lifecycle-setup`
2. `provider-preflight`, dependent on setup
3. `claude-questions` and `codex-questions`, each dependent on preflight
4. `review-loop` and `business-approval`, dependent on both provider tracks
5. `pane-coordination`, dependent on review and approval
6. `lifecycle-synthesis`, dependent on every prior phase

Setup, provider, review, approval, pane, and synthesis phases can still be rerun independently, but every phase first validates its prerequisite checkpoint and exact persisted ids. A missing or failed checkpoint produces an explicit BLOCKED result; it never recreates or fabricates prerequisite state. Permit at most one retry for an identified infrastructure startup/transport failure; never retry a completed but behaviorally wrong provider response as flake recovery.

Every test title includes `@commander-lifecycle` so Bash and PowerShell can run the exact campaign without shell-dependent file globbing.

### Organization

Create one fresh authenticated organization, not Harbor reuse:

- Founder account.
- Product lead account.
- Team member account.
- Product and Engineering department.
- Customer Validation project.
- Customer-validation objective.
- Claude Product Analyst reporting through the product lead.
- Codex Launch Engineer reporting through the product lead.
- Company default `review_required` with explicit acceptance criteria on every task.

All three humans are mandatory members of this same causal company and use independent authenticated browser sessions. The member owns and completes a human task, the lead manages both provider tasks and performs a task review, and the founder answers an escalated question and handles the governed approval. Every role assertion uses the exact live task/run/question ids, not a parallel fixture company.

### Real work graph

| ID | Real work | Required causal result |
|---|---|---|
| R01 | Member-owned interview preparation task | The member is assignee, sees it in To do / Tasks, and completes it through the authenticated task UI. The product lead sees the same task id in Managing. The founder sees only the policy-appropriate Managing or aggregate overview representation, never personal To do. Capture all three authenticated browser states. |
| R02 | Claude customer-segment analysis task from a source Discussion | Appears in Managing with source Discussion and real Workspace. |
| R03 | Claude calls `ask_human` with meaningful options | Same durable question appears in Cockpit, Inbox, Workspace, and source Discussion. |
| R04 | Human answers from Workspace | One outbox row and one continuation; all mirrors resolve. |
| R05 | Separate Claude run asks from Commander-launched delegated task | Question mirrors in the originating Commander conversation and task Workspace. |
| R06 | Claude writes recommendation artifact under supervised permissions | Real permission request is distinct from question/review and the output exists on disk. |
| R07 | Claude submits review-required task | Task remains Managing with Review/Needs me and opens anchored Workspace review. |
| R08 | Human requests changes with feedback | Task returns to in_progress, one continuation runs, and feedback is visible inline. |
| R09 | Claude resubmits; human approves | Task becomes done and leaves active My Work. |
| R10 | Codex implements a bounded validation artifact | Real Codex Workspace/run/output/review lifecycle passes independently. |
| R11 | Agent-can-complete bounded task | Agent reaches done only with criteria and policy authority. |
| R12 | Real Discussion nested artifact/task links | Commander Discussion Focus and shared Viewer coordinate correctly. |
| R13 | User follows project/goal/task and pins artifact | Following and Context remain independent through real updates. |
| R14 | Commander explains current work | Answer accurately cites source Discussion, task, question answer, permission, run, output, and review state. |

### Five real question journeys

| ID | Agent and task | Source | Question and options | Human/surface | Required output consequence | Final state |
|---|---|---|---|---|---|---|
| Q1 | Claude - `Select founder interview ownership` | Commander-launched delegated task | Founder-led vs analyst-led interviews | Founder answers in Commander | Interview plan names the chosen owner and explains the selected trade-off | Artifact submitted to review |
| Q2 | Codex - `Choose validation landing-page format` | Task Workspace | Interactive prototype vs static evidence page | Product lead answers in Workspace | Implementation creates the selected format and cites the answer in its README | Artifact submitted to review |
| Q3 | Claude - `Set boutique-agency interview sample` | Source Discussion | Five deep interviews vs twelve short interviews | Product lead answers in Discussion | Research plan uses the selected sample and updates its evidence schedule | Artifact submitted to review |
| Q4 | Codex - `Choose launch instrumentation depth` | Task without Discussion/Commander source | Minimal event set vs full funnel | Founder answers in Inbox | Instrumentation artifact implements the selected event set | Policy-appropriate review/completion |
| Q5 | Claude - `Set interview incentive cap` | Task Work timeline in task detail | $100 cap vs $250 cap | Product lead answers in Task Work | Budget section and participant plan use the selected cap | Artifact submitted to review |

Each is a separate real provider run. First click must open the correct inline card/detail, Commander, Inbox, Task Work, Workspace, and Discussion mirrors must share one question id when their source links apply, the selected answer must synchronize everywhere, and exactly one useful continuation must follow. Task Work and Workspace hosts are asserted separately even when they share a component.

For every Q1-Q5 continuation, assert that the resumed provider receives task, Workspace, source context, question, answer, and remaining steps; the resulting artifact contains answer-specific evidence; and that same continuation requests review or completion. The harness performs no task transition on the provider's behalf and the run performs no parent-directory configuration or environment discovery.

### Business approval campaign

Use one fixed Assist-mode crew-dispatch workflow:

- Founder starts `Dispatch boutique interview recruitment` and `Dispatch incentive budget validation` from one named Discussion scope.
- The workflow, not a test insert, creates one multi-task approval.
- The card explains requester, reason, consequence, and both named tasks.
- Approval authorizes both dispatches without becoming two task rows.
- A separate rejection run proves rejection leaves both tasks parked.
- Separately, Request Changes on one task review requires feedback and resumes only that task; it is not represented as approval rejection.

### Failure campaign

Add named test-only server failpoints:

- `work_question.after_answer_commit`
- `work_question.after_outbox_claim`
- `work_question.after_downstream_accept`
- `work_question.before_dispatch_ack`
- `cockpit.fail_source:<sourceId>`

They are available only when `AOA_E2E_FAILPOINTS=1` and a per-instance test secret matches. Production startup rejects or ignores failpoint requests. Use Playwright route interception only for client transport failures; use the server source failpoint to prove settled partial-source behavior.

- Deny one real runtime permission and observe agent/task messaging.
- Configure a bounded execution timeout, leave one real question unanswered beyond it, and verify the task/UI remain `Waiting on human` rather than failed. Restart the server, answer through UI, and prove one context-preserving continuation completes useful answer-specific work.
- Interrupt after answer commit but before worker dispatch using the supported test failpoint; restart and verify one continuation.
- Temporarily break a Cockpit source endpoint and verify partial rendering.
- Stop one provider track when readiness/auth/credits fail and mark it BLOCKED with evidence.

The crash cases invoke the controller rather than killing an incidental process. After restart, the test must prove the pre-crash server PID is dead, the new worker is ready, the same domain ids and Workspace contents remain, all three users can authenticate, and exactly one continuation owns the unanswered or committed question.

## Live Campaign Pass Criteria

The feature is not accepted until:

1. At least one real Claude task and one real Codex task complete their required lifecycle.
2. Five real questions are answered from Commander, Inbox, Task Work, Workspace, and Discussion with one useful continuation each.
3. One real supervised permission, review-required loop, Request Changes loop, human approval, and agent-can-complete task pass.
4. Founder/lead/member role behavior passes through independent authenticated sessions in the same live causal company.
5. No lifecycle result was manufactured through direct database writes.
6. The user can inspect a still-running fresh organization with understandable titles and causal context.
7. All deterministic gates remain green after live findings are fixed.

### Per-item narrative acceptance

Every live Cockpit item must show an understandable title, requester, source, reason, current state, and next action. It must have the correct persona-specific home and attention marker; first click must open the intended anchored Focus/Viewer state; URL, Back, Escape, drafts, refresh, counts, and deduplication must remain correct before and after resolution. Commander center summary must agree with Cockpit attention and may not show an all-clear message while actionable rows exist.

### Commander explanation rubric

Generate an expected-facts manifest from persisted campaign ids. Commander must identify the source Discussion, task, agent, question, selected answer, permission decision, artifact, review result, and current status with navigable reference chips. It must omit unrelated and unauthorized facts. Generic prose without entity-grounded facts does not pass.

## Evidence Bundle

Write a dated folder under `docs/aoa/qa/commander-cockpit-real-lifecycle-YYYY-MM-DD/` containing:

- `STATE.json`: redacted company/entity/run/question ids and final states.
- `TIMELINE.md`: causal event timeline with timestamps.
- `RESULTS.md`: scenario verdicts and exact blocked reasons.
- `API-CONTRACTS.md`: redacted relevant request/response shapes.
- `test-execution-manifest.json`: expected/passed/failed/skipped/blocked/not-run ids and environment authority.
- `startup-manifest.json`: redacted server mode, ports, fake-seam assertions, CLI paths/versions, adapters, and models.
- `EXPECTED-FACTS.json`: causal facts used to score Commander synthesis.
- Desktop, tablet, and mobile screenshots.
- Playwright trace paths for deterministic failures.
- Provider readiness and duration summary.
- Query-count/performance summary.

Screenshots show actual readable entities, not random fixture labels. Raw credentials, private provider session content, and unrestricted execution logs are never committed.

## Performance And Reliability Gates

- `GET /cockpit` executes at most 20 SQL statements and query count remains constant as selected rows increase.
- Exact count query and hot-row query plans use intended indexes on a fixture with at least 5,000 tasks, 1,000 actions, and 1,000 follows.
- On the documented local release-build benchmark, Cockpit API p95 is at most 1,000ms and filter-response p95 is at most 750ms for that fixture.
- Initial useful Cockpit content renders within 2,000ms after Commander shell readiness at 1280px.
- One domain event produces at most two Cockpit refetches within a two-second coalescing window.
- The 5,000-task benchmark fixture is generated within 60 seconds on the documented test host.
- Reconnect and server restart preserve drafts, questions, mirrors, and continuation identity.
- Run each deterministic E2E spec three consecutive times locally with zero retries before declaring it stable.
- Capture explicit passing screenshots at 390, 768, 1280, and 1600px. Fail on console errors, uncaught exceptions, unexpected 5xx responses, blank canvas/pane regions, overlapping controls, or clipped text.
- Store `EXPLAIN (ANALYZE, BUFFERS)` evidence for exact-count and hot-row queries in the QA bundle.

## Commands And Gates

All test commands write machine-readable results under `.aoa-qa/commander/<campaignId>/results/`. Add `tests/reporters/commander-execution-reporter.ts` adapters for Vitest and Playwright, `tests/e2e/scripts/verify-commander-evidence.ts`, and a cross-platform `tests/e2e/scripts/run-commander-gate.ts`. The reporter normalizes expected id, actor, layer, result, duration, provenance links, and evidence paths into `test-execution-manifest.json`. The verifier fails on a missing expected id, zero-test suite, unexpected skip, blocked required deterministic scenario, absent live provenance link, missing screenshot/log/artifact, or invalid project-dependency checkpoint. In live qualification mode every mandatory live id must be PASS; BLOCKED, NOT RUN, missing, skipped, or zero-test results are nonzero failures. Provider readiness/auth/credit failures may be recorded as BLOCKED evidence, but they do not qualify the feature.

Both gate runners execute child commands sequentially, stop at the first failure, run required cleanup in `finally`, and return the first failing child or verifier exit code. Cleanup success can never replace a test failure. This contract is covered by unit tests that inject failures at every child-command position.

### Per-wave targeted gate

```bash
pnpm exec tsx tests/e2e/scripts/run-commander-gate.ts --gate=targeted
```

```powershell
pnpm exec tsx tests/e2e/scripts/run-commander-gate.ts --gate=targeted
```

The Windows command is authoritative only when embedded PostgreSQL actually runs under a non-administrative user; otherwise set an external `DATABASE_URL` and record it as redacted infrastructure metadata.

### Authenticated browser gate

```bash
pnpm exec tsx tests/e2e/scripts/run-commander-gate.ts --gate=authenticated
```

```powershell
pnpm exec tsx tests/e2e/scripts/run-commander-gate.ts --gate=authenticated
```

### Full merge gate

```sh
pnpm exec tsx tests/e2e/scripts/run-commander-gate.ts --gate=merge
```

### Live-provider gate

```bash
pnpm exec tsx tests/e2e/scripts/run-commander-lifecycle.ts \
  --campaign-id commander-review \
  --port 3224 \
  --db-port 54424 \
  --leave-running-on-success
```

```powershell
pnpm exec tsx tests/e2e/scripts/run-commander-lifecycle.ts --campaign-id commander-review --port 3224 --db-port 54424 --leave-running-on-success
```

`run-commander-lifecycle.ts` starts the controlled instance, sets the live-provider variables only for the child Playwright process, runs the dedicated lifecycle config and evidence verifier, and preserves the first nonzero Playwright or verifier exit code. On failure it finalizes evidence and stops the instance in `finally` unless an explicit diagnostic override is used. On success, `--leave-running-on-success` records and prints the authenticated review URL and leaves the exact evidence organization available for user inspection without changing the qualification result. CI omits that flag and cleans up on success.

After user inspection, cleanup is a separate command:

```sh
pnpm exec tsx tests/e2e/scripts/commander-lifecycle-instance.ts stop --campaign-id commander-review
```

The evidence bundle records the exact successful command, resolved binaries, startup manifest, and test execution manifest.

## Review Results

### Product QA review

The initial review found gaps in answer-to-output causality, shared-company personas, provenance, the five answer surfaces, task-context preflight, per-item narrative clarity, approval realism, timeout/restart behavior, and Commander synthesis assertions. All were incorporated. A focused re-review then found three command/classification/authentication issues; the live runner, R01 role placement, and exact-instance authentication contract now resolve them.

**Final verdict:** CLEAR. No unresolved P0/P1 product-QA gaps.

### Engineering test architecture review

The initial review found gaps in authoritative execution reporting, dedicated live-instance control, phase isolation, Task Work coverage, adapter/runtime contracts, authentication setup, failpoints, executable commands, and numeric evidence gates. A focused re-review found four remaining orchestration issues; explicit live project dependencies, controlled crash/restart, manifest reporters/verifiers, fail-fast gate runners, and inspectable-success behavior now resolve them.

**Final verdict:** CLEAR. No unresolved P0/P1 engineering-test gaps.

This verdict approves the plan, not the unimplemented feature. Qualification is earned only when the planned tests and live campaigns run and produce the required evidence.

## Exit Criteria

- All static, unit, integration, API, component, deterministic E2E, authenticated-role, and live-provider gates have recorded results.
- Full typecheck, test, build, and Playwright suites pass.
- Live-provider failures are fixed and rerun, not papered over with seeded replacements.
- The evidence organization remains available for user inspection.
- The parent plan's Definition of Done and mockup acceptance gate are satisfied.
