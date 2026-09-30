# Commander Cockpit Person-Centered IA Implementation Plan

**Status:** Implementation in progress; Waves 0-1 complete

**Branch:** `codex/commander-cockpit`

**Product scope:** [Commander Cockpit Person-Centered IA Scope](./2026-07-12-commander-cockpit-personal-ia-scope.md)

**Test strategy:** [Commander Cockpit Real Lifecycle Test Plan](./2026-07-12-commander-cockpit-real-lifecycle-test-plan.md)

**Supersedes:** The section taxonomy, task-placement, Triage, Watch, TaskSlideOver-only, and inline-question portions of the 2026-07-08 and 2026-07-10 Commander Cockpit plans. Existing implemented behavior remains the baseline unless this plan explicitly changes it.

## Outcome

Commander becomes a person-centered operating surface with four stable sections:

1. **My Work:** `To do`, `Managing`, and `Following`.
2. **Conversations:** relevant Discussions and communication activity.
3. **Company Overview:** role-scoped company or department operating signals.
4. **Context:** personal notes, pinned shortcuts, and optional active-conversation memory audit.

`Triage` is removed as a section. `Question`, `Approval`, `Review`, `Overdue`, `Blocked`, `At risk`, `Running`, and `Unread` become attention signals on items that retain one stable home. `All`, `Needs me`, and `At risk` are filters across those homes.

Task Workspace and Discussion are Commander focus panes. Structured Ask Human questions render inline in Commander, Workspace, and Discussion message streams. Supporting approval, artifact, run, and evidence details use the shared Commander Viewer.

## Confirmed Product Decisions

1. Following is explicit and opt-in.
2. To do includes both personal tasks and personal decisions, separated visually inside the card.
3. Attention filters preserve sections and do not create a consolidated duplicate queue.
4. Managing contains work for which the current user is operationally accountable through direct responsibility or reporting hierarchy.
5. Automatic role-derived visibility belongs in Company Overview, not Following.
6. Pins remain Context shortcuts and do not imply Following.
7. Inbox remains a full feature; Cockpit shows source-linked actions without replacing Inbox.
8. Task and Discussion open as focus panes; supporting detail opens in the shared Viewer.
9. The same durable question is answerable from every authorized inline surface and updates all mirrors.

## What Already Exists

- Company-scoped Cockpit API, counts endpoint, and bounded task-bucket endpoint.
- Server-backed `mine`, `managed`, and `awaiting_review` task buckets with responsibility labels and cursor pagination.
- Canonical reporting-hierarchy and role-scope helpers.
- Cockpit cards for Inbox, review, approvals, work, today, notes, Discussions, running, pins, goals, budget, completions, findings, activity, and memory.
- Per-user card show or hide preferences keyed by stable ids.
- Typed Commander reference chips, drag/drop, and deduplication.
- Discussion focus pane foundations and host-owned nested Viewer dispatch.
- Task details, Workspace timeline/composer, TaskSlideOver, and Commander Viewer bodies.
- `work_questions` schema and shared contracts, including optimistic versioning, idempotent answers, recipients, source Discussion, Workspace, run, and continuation state.
- User entity pins for task, artifact, and goal shortcuts.
- Real Harbor organization and live-provider E2E fixtures on this branch.

## Architecture

```text
Canonical domain sources
  Tasks + responsibility hierarchy
  Work questions
  Approvals + Inbox/Hub
  Discussions
  Runs + goals + budget + activity
  Pins + follows + notes + memory retrievals
                  |
                  v
        Cockpit presentation service
  - authorization before counts or rows
  - relationship classification
  - source-action linking
  - entity deduplication
  - attention derivation and ranking
  - bounded section composition
                  |
                  v
      GET /companies/:id/cockpit
      ?attention=all|needs_me|at_risk
                  |
                  v
       CommanderCockpitPanel
  My Work | Conversations | Company Overview | Context
                  |
                  v
        Commander pane coordinator
  Commander chat | Focus pane | Shared Viewer | Cockpit rail
```

The client does not merge duplicate entities from unrelated API slices. The server owns classification and deduplication because it has the authoritative relationship, permission, and source-link context.

### Two-phase composition

1. **Candidate phase:** source adapters return authorized candidate identities, relationship/ranking columns, workflow identity, related entity ids, and exact source counts. They do not apply today's per-card hot-set limits before action linking.
2. **Composition phase:** batch-resolve links, establish presentation homes, deduplicate by workflow and primary entity rules, derive attention, apply the selected filter, globally rank, and only then take each bounded section/group hot set.
3. **Enrichment phase:** batch-fetch display fields and open targets for selected identities by entity kind.

Exact filter counts use a canonical SQL union/CTE that normalizes every authorized workflow key and primary-entity link, deduplicates the complete key set, and groups it by section, relationship, and attention membership. Counts never depend on bounded candidate windows. Hot-row selection may use indexed top-K source candidates sized to the requested global limit, but never an arbitrary legacy card limit; composition still deduplicates before the final row limit.

## Presentation Contract

Introduce a versioned Cockpit presentation contract while retaining compatibility aliases during migration.

```ts
type CockpitAttentionFilter = "all" | "needs_me" | "at_risk";
type CockpitSectionId = "my_work" | "conversations" | "company_overview" | "context";
type CockpitRelationship = "to_do" | "managing" | "following" | null;
type CockpitGroupId = "to_do_tasks" | "to_do_decisions" | "managing" | "following";

interface CockpitPresentationItem {
  key: string;
  primaryRef: { kind: string; id: string };
  title: string;
  subtitle: string | null;
  relationship: CockpitRelationship;
  groupId: CockpitGroupId | null;
  attention: CockpitAttentionSignal[];
  actions: CockpitLinkedAction[];
  primaryActionId: string | null;
  openTarget: CommanderOpenTarget;
  updatedAt: string;
}

interface CockpitLinkedAction {
  id: string;
  kind: "question" | "approval" | "review" | "inbox_request";
  workflowRef: { kind: string; id: string };
  relatedRefs: Array<{ kind: string; id: string }>;
  label: string;
  attention: CockpitAttentionSignal;
  openTarget: CommanderOpenTarget;
}

interface CockpitSection {
  id: CockpitSectionId;
  groups: CockpitGroup[];
}

interface CockpitPresentation {
  version: 3;
  activeFilter: CockpitAttentionFilter;
  filterCounts: { all: number; needsMe: number; atRisk: number };
  sections: CockpitSection[];
  meta: CockpitMeta;
}
```

`openTarget` is server-authored, typed data rather than a UI guess:

```ts
type CommanderOpenTarget =
  | { surface: "workspace"; issueId: string; anchor?: CommanderAnchor }
  | { surface: "discussion"; discussionId: string; anchor?: CommanderAnchor }
  | { surface: "viewer"; tab: CommanderViewerTabDescriptor }
  | { surface: "workspace_and_viewer"; issueId: string; tab: CommanderViewerTabDescriptor }
  | { surface: "note"; noteId: string }
  | { surface: "route"; href: string; reason: string };
```

This keeps entity placement independent from pane behavior and prevents card components from recreating routing logic.

## Relationship Classification

### Precedence

For a task visible to the current user:

1. **To do** when the current user is the human assignee, or when a concrete question, review, approval, or Inbox request is the user's only relationship to otherwise unrelated work.
2. **Managing** when the current user is `responsibleUserId` but another human or agent is executing, when work is assigned inside the current user's reporting subtree, or when the current user is otherwise accountable but has no immediate personal action.
3. **Following** when an explicit follow exists and neither To do nor Managing applies.
4. Otherwise the task is absent from My Work.

Attention never changes an established relationship home. A Managing or Following task that asks the current user a question remains in its existing group and gains a `Question - Needs you` action. When an otherwise unrelated task routes a concrete action to the user, To do is its temporary primary home only because no stronger stable relationship exists; after resolution it disappears unless another relationship applies.

### Task and decision separation

The To do card contains two unframed subgroups:

- **Tasks:** work the human must personally perform.
- **Decisions:** open questions, approvals, reviews, and standalone Inbox requests requiring the human.

A linked decision decorates its primary task row. A standalone decision receives its own primary key. Within To do, a row appears in exactly one subgroup: an unresolved personal decision places otherwise unrelated work under Decisions; otherwise a personally assigned task appears under Tasks. Multiple linked actions on one task are ordered by severity and represented by one row with an action count. Row click opens the primary entity; every action marker carries its own `openTarget` so Question can anchor inline while Approval opens Workspace plus Viewer. After resolution, the base relationship remains unchanged.

### Deduplication keys

- Linked task action: primary key `task:<issueId>`.
- Discussion without a task source: `discussion:<discussionId>`.
- Standalone approval: `approval:<approvalId>`.
- Standalone Inbox request: `hub:<hubItemId>`.
- Standalone question is not expected because `work_questions.issueId` is required; it keys to its task.
- Context shortcuts use their own shortcut key but declare `shortcutOf` so they never count as a second workflow item.

The source Discussion may show ordinary unread or activity state, but the Cockpit does not repeat a task-linked question as a second actionable Discussion row. The question still renders inline when the Discussion opens.

Workflow identity remains distinct from presentation home. A single-task approval may decorate that task row. An approval governing multiple tasks, such as `crew_dispatch`, remains one standalone `approval:<id>` Decisions row with all related task refs and opens its canonical approval detail; it is never copied onto every task or attached to an arbitrary first task.

## Attention Model

Derive signals on the server in this priority order:

1. Required human action: question, approval, review, reply request.
2. Failure or risk: blocked, overdue, SLA breach, at-risk objective, failed continuation.
3. Execution information: waiting on human, running, queued.
4. Change information: unread, updated, completed.

`Needs me` includes unresolved actions assigned to or claimable by the current authorized human. `At risk` includes blocked, overdue, failed, breached, and at-risk signals. `All` includes every bounded relevant row and ranks required action first.

The API applies the filter before its bounded hot-set limit. Filter counts are computed from authorized, deduplicated keys rather than raw source rows.

`All` is the safe default on each new Commander session. Filter state is session-local and is not allowed to silently persist a hidden subset across days. The segmented control exposes selected state to assistive technology and announces updated bounded counts.

## Following

### Data model

Add `user_entity_follows` using the existing pin schema conventions:

- `id` UUID primary key.
- `userId` text FK to `auth_users`, cascade delete.
- `companyId` UUID FK to companies, cascade delete.
- `entityType` validated as `task | project | goal` for V1.
- `entityId` UUID.
- `followedAt`, `createdAt`, `updatedAt` timestamptz.
- Unique `(userId, companyId, entityType, entityId)`.

The database adds a check constraint for the V1 entity-type set. The service still performs company and permission validation because the polymorphic `entityId` cannot have one foreign key.

For `entityType=project`, V1 accepts only `projects.type='project'`. Department rows are represented through Managing scope and Company Overview and are not directly followable in this wave.

Following is intentionally separate from pinning. Follow controls passive My Work visibility; Pin controls Context shortcuts. Ordinary updates may improve recency ranking in All but never enter Needs me. Only a real risk signal places followed work in At risk.

### API and authorization

- `GET /companies/:companyId/follows`
- `POST /companies/:companyId/follows`
- `DELETE /companies/:companyId/follows/:entityType/:entityId`

All routes require a board user and company access. Creation validates that the entity exists in the company and is readable by the actor. Follow and unfollow mutations write activity-log entries. Deleted or newly unauthorized entities are omitted from reads and Cockpit counts.

### UI

Expose `Follow` or `Unfollow` from task, project, and goal action menus and Cockpit row overflow. Do not add a second text-heavy button when an eye icon with tooltip fits the existing design system. Pin and Follow remain separate commands with distinct tooltips.

## Work Questions And Inline Threads

### Durable question service

Complete the existing `work_questions` foundation with:

- Company-scoped read, list, answer, reassign, and authorized takeover service methods.
- Optimistic version checks and idempotency-key replay.
- First successful authorized answer wins; stale concurrent answers return `409` with the resolved question.
- Automatic continuation dispatch after an accepted late answer.
- Activity logging for create, answer, reassign, takeover, continuation dispatch, and continuation failure.
- Realtime invalidation events for question and linked task updates.

Define explicit live-event payloads for question created/answered/reassigned/cancelled, continuation changed, follow changed, task relationship changed, Hub mirror reconciled, and Cockpit presentation invalidated. Each event carries company id and canonical entity ids; clients invalidate question, task, Hub, and Cockpit query keys from the same event without embedding sensitive answer text.

Add an optional `sourceCommanderConversationId` FK so a question from Commander-launched background work can return to the exact Commander session without reverse-inference through a run record. Creation still requires a real task and asking org agent, preserving Decision #109. Change agent deletion from destructive cascade semantics to nullable `set null` after creation and store an asking-name snapshot so deleting an agent cannot erase an unresolved human action. Change task deletion to nullable `set null` after creation and store task identifier/title snapshots for retained audit display.

Background Commander work must create or link a real task and dispatch it to an org agent before that agent can create a durable blocking question. Questions asked synchronously inside an active Commander reply remain ordinary conversation interaction. V1 does not introduce taskless or Commander-authored durable questions.

Answer acceptance and continuation dispatch are separated durably. Add a `work_question_continuation_requests` outbox keyed uniquely by `(questionId, answerVersion)` with target run kind, status, attempts, next attempt, and downstream idempotency key. The answer transaction records the answer and inserts the pending outbox row atomically. In V1, a worker dispatches organization-agent task questions through heartbeat with the same downstream idempotency key and records `dispatched` or `failed`. `internal_agent` remains a reserved discriminator until a runtime-native crew/Commander continuation path is designed; it must not be silently routed through heartbeat. Heartbeat wakeups add a `work_question_continuation` reason to their database uniqueness contract. A periodic recovery pass retries abandoned pending rows, so crash-before-dispatch produces a retry and crash-after-dispatch cannot create a second continuation.

Cut all new Ask Human producers over to `work_questions`, including the org-agent `ask_founder` bridge and blocked Commander background work. Existing open `agent_runtime_decisions(kind=work_question)` remain on their legacy lifecycle and are dual-read only until terminal, per Decision #109; they are not bulk migrated. Inbox/Hub projects each new durable question as one synchronized mirror and reconciles it on answer or cancellation.

### API

- `GET /companies/:companyId/work-questions?status=&issueId=&workspaceId=&discussionId=&commanderConversationId=`
- `GET /companies/:companyId/work-questions/:questionId`
- `POST /companies/:companyId/work-questions/:questionId/answer`
- `POST /companies/:companyId/work-questions/:questionId/reassign`
- `POST /companies/:companyId/work-questions/:questionId/take-over`

Implement a dedicated question capability service from existing company access, source-task visibility, responsibility scope, recipient, reviewer, founder, and instance-admin rules; the repository does not currently expose one task permission helper with the required operation granularity. Listing never leaks counts for unauthorized tasks.

### Question capability matrix

| Operation | Authorized actors |
|---|---|
| Create | Authenticated org agent in an active run for a nonterminal company-scoped task it currently owns through assignment and valid checkout/run context; internal Commander orchestration cannot forge this actor. |
| Read | Users who can read the company-scoped source task plus the current recipient; instance-admin bypass follows existing auth rules. |
| Answer | Current recipient, or a user who has first completed an authorized takeover. |
| Reassign | Current recipient; founder; team lead when both source task and new recipient are inside lead scope. |
| Take over | Founder/instance-admin; explicit task responsible human or reviewer; scoped team lead for work inside lead scope. |
| Retry continuation | Founder/instance-admin, source-task responsible human, or reviewer with source-task access. |
| Cancel | Internal producer while work is active, or founder/instance-admin through an audited administrative action. |

There is no generic company-admin role. Every create/read/mutation validates that issue, agent, Workspace, Discussion, Discussion entry, Commander conversation, recipient, and actor resolve to the same company before returning counts or data.

Task deletion locks open linked questions in the same transaction. Each is cancelled, its Hub mirror is closed, and no continuation is created; the task is then deleted and the retained question keeps snapshots with `issueId=null`. Answer and delete race on the locked question row, so exactly one legal transition wins.

### Shared inline component

Build one `WorkQuestionCard` with surface adapters for:

1. Commander conversation timeline.
2. Task Work timeline inside task detail.
3. Execution Workspace timeline.
4. Discussion group-chat timeline.

The card appears chronologically in the message stream above the composer. It supports options, free text, answer-and-resume, answered state, continuation state, reassignment where authorized, and a source-task action. It is not rendered as a Viewer-only card.

| Surface | Placement rule |
|---|---|
| Commander thread | `sourceCommanderConversationId` matches the active Commander conversation. |
| Task Work timeline | `issueId` matches the open task detail, independent of Workspace existence. |
| Workspace thread | `executionWorkspaceId` matches, with task-level fallback when the question predates Workspace creation. |
| Discussion thread | `sourceDiscussionId` matches the open Discussion. |
| Inbox | Canonical `work_question` detail mirror linked by question id. |
| Cockpit | One linked action on the primary task row. |

Timeline surfaces do not persist three copies of the question as ordinary chat messages. Each timeline read model merges authorized question events with messages using stable `(createdAt, kindOrder, id)` ordering. A source may persist a lightweight question reference marker only when required for durable pagination; it contains the question id and never owns a second answer lifecycle.

Plain chat text does not silently resolve a structured question. A direct structured answer or explicit confirmation is required. This avoids accidental completion from unrelated discussion prose.

All three surfaces query the same question id and invalidate the same query keys. Answering from one surface updates the others without duplicate continuation dispatch.

## Cockpit Sections

### My Work

- My Work renders at most eight 40-48px divider-separated rows total, attention-ranked across groups while guaranteeing one row for each non-empty group.
- To do uses distinct Tasks and Decisions subgroups encoded by `groupId`.
- Managing shows current assignee and accountability reason.
- Following is explicit and passive.
- Empty groups are omitted; the card has one calm empty state.
- `View all Tasks` opens Tasks with equivalent server-backed relationship and attention filters.
- `View all Decisions` opens Inbox with equivalent action filters because standalone approvals and requests are not Tasks.
- `View all Following` expands a paginated source-neutral list inside the Cockpit; task, project, and goal rows retain their own canonical open targets.

### Conversations

- Active or unread Discussions relevant to the actor.
- No duplicate task-linked question rows.
- Opens the Discussion focus pane and preserves draft/scroll state.

### Company Overview

- Founder: bounded company-wide material signals.
- Team lead: authorized department/project signals.
- Team member: section absent by default.
- Cards: Current operations, Objectives and budget, Material updates.
- Company Overview contains aggregates, non-task operating entities, systemic risks, and material events. It does not render individual task rows already housed in My Work.
- Running and completed work are aggregate summaries or signals, not alternate workflow homes. Drill-down opens a filtered canonical source list.
- A source that lacks canonical team-lead scoping is omitted for leads until that source feature provides one. The Cockpit must not invent department membership or broaden company data merely to fill this section.

### Context

- Personal notes default on.
- Pinned context default on.
- Active-conversation memory audit optional.
- Shortcut rows declare their source home and never inflate work counts.

## Pane Coordination

Extend the existing Commander pane reducer into one state machine:

```text
CommanderPaneState
  chat: expanded | rail | hidden
  focus: none | workspace(issueId) | discussion(discussionId)
  viewer: closed | tabbed(tabs, activeId)
  cockpit: expanded | rail | hidden
  restoreSnapshot
  originFocusKey
```

The reducer owns structural visibility and transition order only. Drafts, scroll positions, selected inner tabs, anchors, and nested origin chains live in keyed view-state registries using `(companyId, surfaceKind, entityId)`; they are referenced by reducer keys rather than copied into one growing snapshot. Viewer tab state remains in its typed Viewer store. A nested open pushes a stable origin record so close and Back can restore more than one level reliably.

Rules:

1. Never show more than two expanded work surfaces.
2. Task, task review, or question opens Workspace focus with the relevant anchor.
3. Discussion opens Discussion focus.
4. Approval opens source Workspace plus Viewer when linked; standalone approval opens Viewer.
5. Artifact, run evidence, and supporting references open Viewer.
6. Closing Viewer restores focus to the originating inline card or Cockpit marker.
7. Closing Focus restores the exact prior Commander chat, Cockpit, Viewer, draft, and scroll snapshot.
8. Escape closes only the topmost transient surface.

At narrow widths, Focus replaces Commander chat and Viewer overlays Focus. Cockpit becomes an explicit drawer/rail. Drafts remain keyed by company and entity id and survive pane replacement.

### Breakpoint contract

| Width | Base surfaces | Viewer | Cockpit |
|---|---|---|---|
| `>=1600px` | Commander chat + Focus | Replaces chat, which becomes a rail | Expanded or user-collapsed rail |
| `1100-1599px` | Commander chat + Focus | Overlay over the secondary region | Rail with explicit drawer |
| `721-1099px` | Commander chat or Focus | Overlay | Persistent drawer button |
| `<=720px` | One full-screen surface | Full-screen sheet above current surface | Persistent button + full-screen drawer |

Cockpit is a support surface, not a third work pane. Viewer plus Focus are the two expanded work surfaces at wide widths; opening Viewer collapses Commander chat to its rail.

### Transition contract

| Current state | Event | Result | Close/Back result |
|---|---|---|---|
| Default Commander | Open task/question/review | Workspace Focus; anchor matching action | Restore exact default snapshot and row focus |
| Default Commander | Open Discussion | Discussion Focus | Restore exact default snapshot and row focus |
| Any Focus | Open another task/Discussion | Replace Focus; retain keyed draft and scroll for previous entity | Restore prior Commander snapshot, not the replaced Focus |
| Workspace Focus | Open linked approval | Keep Workspace; open approval Viewer | Close Viewer back to originating action |
| Discussion Focus in Commander | Open nested detail | Dispatch to Commander Viewer | Close Viewer back to Discussion control |
| Standalone Discussions page | Open nested detail | Dispatch to Discussions-owned Viewer | Close native Viewer back to Discussion control |
| Any Viewer | Open another Viewer target | Add/select a typed Viewer tab subject to tab cap | Close selected tab; restore preceding tab or source |
| Focus with unsent draft | Replace or close | Preserve keyed draft; confirm only when preservation is impossible | Cancel returns to draft |
| Any transient state | Escape | Close only topmost Viewer, drawer, sheet, or Focus | Focus returns to stable origin key |
| Commander route | Browser Back | Follow the same topmost close order before leaving Commander | No draft or scroll loss |
| Any item | Full-page escape | Navigate to canonical source and retain recoverable Commander state | Browser Back restores Commander snapshot where supported |

Discussion bodies never choose a Viewer by inspecting the URL. The Commander host supplies Commander Viewer dispatch; the standalone Discussions host supplies its native Viewer dispatch.

## Interaction And Accessibility Contract

- Row click opens the primary entity and never attaches it to chat.
- Each linked action marker opens its own declared `openTarget`.
- A dedicated grip handle performs drag-to-chat with `grab` and `grabbing` cursors; the whole row does not translate on hover.
- Row overflow exposes `Attach to chat` as the keyboard and touch equivalent of drag.
- Scenario/focus tabs use tablist, tab, `aria-selected`, and roving focus semantics.
- Question options use radiogroup/radio semantics or native radio controls.
- Attention filters expose pressed/selected state and announce updated counts.
- Cockpit drawer controls synchronize `aria-expanded`; the mobile drawer traps focus and returns it to its trigger.
- Answer and continuation changes announce through a restrained live region.
- Touch targets are at least 44px; visible marker text is at least 11px.
- Focus restoration, Escape order, reduced motion, and keyboard-only operation are Wave 0 contracts, not late polish.

Render at most one primary attention marker and one secondary marker; additional signals collapse into `+N`. Human action uses warning tokens, overdue/failure uses error, running/unread uses info, and completion uses success. Brand red remains reserved for selection, focus, identity, and primary actions.

## Preferences Migration

Keep existing stable card preferences readable for one migration window.

| Old card id | New preference target |
|---|---|
| `myTasks` | `my_work` |
| `review`, `approvals`, `inbox`, `today` | `my_work` visibility; individual sources remain configurable in advanced settings |
| `running`, `goalsAtRisk`, `budgetPulse`, `doneToday`, `proactiveFindings`, `teammatesActivity` | `company_overview` with source toggles |
| `discussions` | `conversations` |
| `stickyNotes`, `pinned`, `memory` | `context` with source toggles |

Use a versioned preference object rather than deleting old localStorage keys. Migration is idempotent and preserves explicit off choices. Section order and relationship rules are not user-editable in V1; users may show/hide permitted summaries and reorder cards only within a section.

My Work and the top attention counts are structural and cannot be disabled. User preferences may hide optional calm source summaries, but they never suppress an unresolved question, approval, review, or other `Needs me` action. A hidden or collapsed section retains an accessible attention count, and selecting an attention filter temporarily reveals matching authorized rows without changing the saved preference.

## Failure And Rescue Registry

| Failure | User-visible rescue | Engineering behavior |
|---|---|---|
| One Cockpit source query fails | Inline `Some sections are unavailable` notice; healthy sections remain usable. | Preserve per-slice status and do not cache partial data as complete. |
| Followed entity is deleted or unauthorized | Row disappears; no broken shortcut. | Filter after company and permission checks; cleanup may be asynchronous. |
| Linked action cannot resolve its source task | Show standalone action with clear source-unavailable text. | Never discard an actionable question or approval solely due to enrichment failure. |
| Concurrent question answers | Winning answer shown with responder; loser gets resolved-state feedback. | Optimistic version transaction and `409` response. |
| Continuation dispatch fails | Answer stays recorded; show `Resume failed` with retry action to authorized users. | Answer plus initial outbox insertion are atomic; downstream dispatch and retry-state transitions occur separately. |
| Pane body fails | Keep surrounding Commander state and offer Retry/Open full page. | Error boundary per focus/viewer body. |
| Preference migration fails | Use safe defaults without overwriting old preferences. | Versioned parser, try/catch, no destructive cleanup. |
| Attention count and rows drift | Refresh affected query and show latest server result. | Server count and rows share classifier/deduper. |

## Performance And Security

- Every query is company-scoped and permission-filtered before count, grouping, or response.
- Use bounded hot sets and server pagination; never load the company hierarchy into the browser for ranking.
- Load responsibility scope once per Cockpit request and share it across composers.
- Query independent Cockpit sections concurrently with settled partial-failure handling.
- Batch source-link resolution by entity kind and id; do not enrich each row with per-item queries.
- Add composite indexes for follow reads and open work-question recipient/source reads only when query plans require them; avoid duplicate indexes already covered by unique constraints.
- Cache keys include company, user, attention filter, and contract version.
- Hidden panes stop polling and expensive queries but retain draft and scroll state.
- Do not allow relationship relevance to grant source-feature mutation permission.

## Implementation Waves

### Progress - 2026-07-12

- Wave 0 baseline captured from the real Harbor instance and documented in [Commander Cockpit Wave 0 Baseline](../qa/2026-07-12-commander-wave-0-baseline.md).
- Presentation v3, stable relationship, attention, preference migration, breakpoint, accessibility, density, and pane coordination contracts are implemented as pure tested modules.
- The behavior mock passes its documented acceptance gate at 390, 768, 1280, and 1600px.
- A fail-fast cross-platform gate runner, execution manifest, and verifier foundation are implemented and tested against injected child and cleanup failures.
- Wave 1 adds company-scoped follows, retained question source snapshots, Commander conversation provenance, a durable continuation outbox, and downstream idempotency keys through generated migration `0171_real_revanche.sql`.
- The question capability matrix covers create, read, answer, reassign, take over, retry, cancel, and cross-company source rejection before mutations are exposed.
- Migration 0171 was applied successfully to a fresh isolated PostgreSQL database and regeneration reports no schema drift.
- The combined Wave 0-1 targeted gate passes 62 tests; the full repository passes typecheck, 11,915 tests, and production build.
- Wave 2 durable question services and runtime integration are next. No v3 production UI capability is enabled yet.

### Wave 0 - Contract tests and compatibility scaffolding

- Capture the real Harbor founder, lead, member, task, question, approval, Discussion, and run lifecycle baseline before changing classification.
- Write the scenario matrix that maps each real domain state to expected home, signal, focus surface, and Viewer behavior.
- Add presentation-contract types, validators, fixture builders, and classifier tests.
- Freeze current Cockpit response compatibility tests.
- Add preference v3 parser/migration tests.
- Add pane state-machine transition tests before UI changes.
- Add accessibility semantics, keyboard maps, focus restoration, density budgets, and breakpoint contracts before component implementation.

### Wave 1 - Schema and authorization foundations

- Add follows schema/export, entity-type check, and generated migration.
- Add question Commander-conversation source, agent-retention, and continuation-outbox migrations and constraints.
- Add downstream continuation idempotency support for heartbeat and internal-agent targets.
- Add shared follow, presentation, question-source, and continuation contracts.
- Implement and exhaustively test the question capability matrix and cross-company source validation before exposing mutations.

### Wave 2 - Durable question vertical slice

- Implement question service, routes, authz, answer transaction, reassignment/takeover, continuation dispatch, realtime events, and query keys.
- Introduce provider-neutral `ask_human` runtime hooks and adapters; keep `ask_founder` as a compatibility alias while prompts/tools migrate.
- Cut all new org-agent Ask Human producers over to `work_questions`; Commander-launched work reaches this path through a real delegated task and agent. Dual-read legacy runtime work questions until terminal.
- Project and reconcile synchronized Inbox/Hub mirrors.
- Add shared inline `WorkQuestionCard` and lifecycle tests.
- Prove one real org-agent create -> Inbox/Cockpit mirror -> answer -> exactly-once continuation run before proceeding.

### Wave 3 - Following and presentation compositor

- Implement company-scoped follow service/routes/activity logging, API client, source-surface controls, and authorization tests.
- Refactor current source fetches behind typed source adapters.
- Implement relationship classifier, action linker, attention derivation, deduper, ranking, counts, and role-scoped section composer.
- Add attention filter to Cockpit and bucket endpoints.
- Keep compatibility aliases until the new UI is verified.
- Re-run the real Harbor scenario after the compositor is complete and compare relationship homes, counts, and filters with the Wave 0 matrix.

### Wave 4 - Person-centered Cockpit UI

- Replace registry taxonomy with My Work, Conversations, Company Overview, and Context.
- Add To do Tasks/Decisions, Managing, and Following groups.
- Add attention filter control and shared signal grammar.
- Migrate preferences without resetting user choices.
- Preserve chip, drag/drop, Ask, pin, and full-page escape actions.

### Wave 5 - Focus panes and inline mirrors

- Generalize the pane reducer for Workspace and Discussion focus.
- Host the reusable Task Workspace center body in Commander.
- Preserve reusable Discussion focus and host-owned nested Viewer dispatch.
- Insert question cards in Commander, Task Work, Workspace, and Discussion timelines; keep Inbox as the canonical detail mirror.
- Anchor Cockpit question/review markers to their inline card.
- Re-run the real Harbor scenario across Commander, Workspace, Discussion, Inbox, and Cockpit before enabling the v3 capability.

### Wave 6 - Accessibility, responsive behavior, and observability

- Verify the Wave 0 semantic contracts in the integrated UI and fix regressions.
- Verify keyboard/touch alternatives, target sizes, focus restoration, live announcements, and reduced motion.
- Run mobile/tablet/desktop/wide pane choreography tests.
- Structured telemetry/activity for follow, filter, open-target, question answer, and continuation failures without logging sensitive answer content.

### Wave 7 - Real lifecycle E2E

- Recreate the Wave 0 scenario in a fresh company with founder, lead, member, department, agents, goals, projects, Discussion, tasks, follows, pins, notes, approval, and real agent run.
- Drive a real question from an agent, answer it in each supported surface across separate runs, and verify automatic continuation.
- Verify review, approval, blocked, overdue, running, at-risk, unread, completed, and partial-failure behavior.
- Produce browser screenshots and a lifecycle report mapping source domain state to Cockpit home, attention marker, focus surface, and Viewer behavior.
- Enable the v3 UI capability only after Waves 2 through 5 pass together; do not expose a half-migrated Cockpit with old question sources or mixed pane rules.

## Test Plan

The linked Real Lifecycle Test Plan is the executable test contract for this implementation. It defines deterministic CI coverage, authenticated founder/lead/member browser coverage, live Claude/Codex task campaigns, prohibited fake-lifecycle shortcuts, evidence requirements, and per-wave gates. The summary below is not a substitute for that matrix.

### Unit

- Relationship precedence and transitions.
- Attention derivation and filter membership.
- Source-link deduplication and standalone-action fallback.
- Role scoping and permission redaction.
- Follow validation and entity resolution.
- Question answer concurrency, idempotency, recipient rules, and continuation states.
- Pane reducer restoration and Escape order.
- Preference migration.

### Integration

- Cockpit response with linked task, question, approval, review, Inbox item, run, and Discussion.
- Same entity appears once with multiple ordered actions.
- Counts equal authorized deduplicated rows.
- Founder, lead, and member fixtures produce different Company Overview sections.
- Follow does not grant read or mutation permission.
- Answering from one surface updates Commander, Inbox, Task Work, Workspace, and Discussion mirrors and dispatches one continuation.
- Partial source failures preserve healthy sections.
- Migration upgrade from the current schema preserves legacy runtime questions and existing preferences.
- Cross-company issue, agent, Workspace, Discussion, entry, conversation, recipient, follow, and action-link ids are rejected without leaking existence.
- Question creation rejects inactive runs, terminal tasks, unassigned agents, invalid checkout ownership, and mismatched agent/run/task companies.
- Answer versus reassign, takeover, cancel, and terminal-task races produce one legal terminal question state.
- Answer versus task deletion cancels or answers once, retains audit snapshots, and never dispatches continuation for a deleted task.
- Crash before continuation enqueue, crash after downstream dispatch, and concurrent retry workers produce one continuation identity.
- Multi-task approvals remain one workflow action with all related task refs.
- High-cardinality candidate sets preserve exact counts and globally correct top rows.
- Timeline merge ordering is deterministic across equal timestamps and reconnects.

### UI component

- To do Tasks and Decisions subgroups.
- Managing and Following reason copy.
- Attention filters preserve section headings.
- Signal color, text, tooltips, keyboard operation, and reduced motion.
- Cockpit row opens the declared target and never both navigates and attaches a chip.
- Inline question open, answered, conflict, continuation pending/failed states.

### E2E browser

1. Founder All, Needs me, and At risk views.
2. Team lead scoped Managing and Company Overview.
3. Member without Company Overview.
4. Follow/unfollow task, project, and goal.
5. Pin versus Follow independence.
6. Question opens Workspace anchored inline and answers successfully.
7. Same question updates Commander, Workspace, Discussion, and Inbox mirrors.
8. Discussion focus plus nested artifact Viewer.
9. Approval opens Workspace plus Viewer and resolves without duplicate row.
10. Request Changes returns an agent task to `in_progress` and its Managing home; approval moves it to `done` and removes it from active My Work.
11. Responsive pane choreography at mobile, tablet, desktop, and wide desktop.
12. Refresh, reconnect, partial API failure, stale answer race, and continuation failure recovery.
13. Legacy runtime-decision and durable work-question coexistence until the legacy item becomes terminal.
14. Cross-company attack fixtures for every question and follow route.
15. Answer/reassign/cancel, task-terminal/continuation, and retry-worker concurrency races.
16. Multi-task approval placement and open behavior.
17. High-cardinality global ranking and deterministic timeline ordering.

### Required repository checks

```sh
pnpm db:generate
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Rollout And Compatibility

1. Ship schema and server contract behind a Cockpit presentation-version capability.
2. Dual-read old preferences and emit v3 preferences.
3. Switch the Commander UI to the v3 presentation contract.
4. Run real Harbor lifecycle E2E and compare old versus new counts.
5. Remove compatibility aliases only in a later cleanup after no active client depends on them.

Rollback keeps new additive tables and columns but switches the UI back to the compatibility response. Do not down-migrate user follows or answered questions during an application rollback.

## Mockup Acceptance Gate

Before production UI implementation begins, the behavior mockup must demonstrate:

1. Separate To do Tasks and Decisions rows.
2. Managing action markers that do not move the task home.
3. Follow/unfollow independent from pin/unpin.
4. Dedicated drag grip plus Attach to chat alternative.
5. Group-specific View all behavior.
6. Loading, empty, partial-error, answered, and continuation-failed states.
7. Focus replacement, Viewer close order, draft retention, and focus restoration.
8. Persistent Cockpit access on mobile.
9. Screenshots at `390px`, `768px`, `1280px`, and `1600px`, with no overlap or clipped text.

## Non-Goals

- Replacing canonical source features.
- A free-form dashboard builder.
- Consensus or multi-party approval workflows.
- Inferring structured answers from ordinary chat prose.
- Manual drag between To do, Managing, and Following.
- Following arbitrary artifacts, agents, notes, or Discussion messages in V1.
- Removing full-page escape hatches.

## Definition Of Done

1. Every Cockpit item has one explainable primary home.
2. Attention filters never create duplicate workflow rows.
3. Founder, lead, and member scoping is correct before counts and rows leave the server.
4. Follow and Pin are independent and understandable.
5. Questions render inline and synchronize across all authorized surfaces.
6. Workspace, Discussion, and Viewer coordination follows one tested state machine.
7. Preference migration preserves existing choices.
8. Unit, integration, component, E2E, typecheck, tests, and build pass.
9. Real-agent lifecycle evidence and screenshots match the documented behavior.

## Review Results

### Product and information architecture

**Initial findings:** 3 P1 and 4 P2.

**Resolved:** Stable homes no longer change with attention; every linked action has its own destination; required actions cannot be hidden; Following is passive and source-neutral; Company Overview is aggregate-only; inline placement has an explicit surface matrix; real lifecycle capture begins in Wave 0.

**Remaining P0/P1:** None.

### Design and interaction

**Initial findings:** 5 P1 and 4 P2.

**Resolved:** Breakpoint and transition tables, explicit Tasks/Decisions fields, action-level open behavior, Wave 0 accessibility contracts, dedicated drag affordance, eight-row density budget, attention token budget, and mockup acceptance gate.

| Dimension | Final score |
|---|---:|
| Information hierarchy | 9/10 |
| Attention model | 9/10 |
| Tasks/Decisions separation | 9/10 |
| Card density | 8/10 |
| Focus/Viewer coordination | 9/10 |
| Accessibility | 9/10 |
| Responsive choreography | 9/10 |
| Acceptance contract | 9/10 |
| **Overall** | **8.9/10** |

**Re-review verdict:** CLEAR.

### Engineering architecture

**Initial findings:** 2 P0, 4 P1, and 2 P2. First re-review found 5 remaining P1 issues.

**Resolved:** Provider-neutral creation path, legacy coexistence, atomic answer/outbox insertion, downstream idempotency, capability matrix including Create, multi-task approval identity, exact-count CTE, task-backed Commander semantics, keyed pane view state, task-deletion races, and expanded negative tests.

**Final re-review:** No unresolved P0/P1 issues across all five final gates.

**Re-review verdict:** CLEAR.

### Test strategy

The dedicated [Real Lifecycle Test Plan](./2026-07-12-commander-cockpit-real-lifecycle-test-plan.md) now covers static contracts, unit tests, database integration, API contracts, components, deterministic Playwright, authenticated founder/lead/member sessions, and genuine Claude/Codex campaigns. Live qualification proves provider causality, five synchronized question surfaces, supervised permissions, review and approval loops, crash recovery, and inspectable evidence without seeded lifecycle end states.

Independent product-QA and engineering-test reviews found no unresolved P0/P1 gaps after amendment.

**Re-review verdict:** CLEAR.

### Review decisions

- Accepted: Managing work stays Managing when it needs the user's attention.
- Accepted: Required actions cannot be hidden by Cockpit customization.
- Accepted: Following is passive awareness; ordinary updates never enter Needs me.
- Accepted: Background Commander questions require a real delegated task and asking org agent.
- Rejected: A design-review suggestion to temporarily move Managing work into To do, because it contradicted the confirmed stable-home product model and the product review.

## Approval Gate

No product, design, engineering, or test-strategy P0/P1 decisions remain unresolved. The plan is ready for user approval. Production implementation must not start until that approval; the temporary mockup must also pass its documented acceptance gate before the Cockpit UI wave begins.
