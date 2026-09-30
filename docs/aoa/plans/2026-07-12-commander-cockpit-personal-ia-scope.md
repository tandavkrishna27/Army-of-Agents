# Commander Cockpit Person-Centered IA Scope

**Status:** Product direction confirmed; engineering plan under review

**Branch:** `codex/commander-cockpit`

**Scope:** Cockpit information architecture, attention grammar, card placement, and coordination with the approved focus-pane model

**Implementation:** This document does not authorize production implementation yet.

## Product Correction

The Cockpit must be organized around the current person's relationship to work. The existing taxonomy mixes unrelated axes at one level:

- `Triage` is a temporary attention state.
- `My Work` is an ownership and accountability relationship.
- `Conversations` is a communication surface.
- `Watch` combines execution state, company health, completed work, and activity.
- `Memory & Context` combines user-curated shortcuts with model retrieval auditing.

This makes a task appear to move conceptually between sections even when the person's relationship to it has not changed. It also makes `Watch` difficult to explain consistently to a founder, team lead, or member.

## Recommended Model

The Cockpit uses two separate axes:

1. **Stable home:** where an item belongs based on the person's relationship to it.
2. **Attention signal:** why that item matters now.

An item has one primary home. It may have multiple attention signals. Attention changes must not create a second workflow copy of the same entity.

## Confirmed Product Decisions

Confirmed on 2026-07-12:

1. `Following` is explicit and opt-in. Hierarchy-derived accountability belongs in Managing; automatic role visibility belongs in Company Overview.
2. `To do` includes personal tasks and personal decisions. The card separates task rows from question, approval, review, and standalone Inbox action rows.
3. `Needs me` and `At risk` filter rows across their existing sections. Filtering never creates a consolidated duplicate list or changes an item's primary home.
4. Attention is a cross-cutting property, not a permanent Triage section.
5. Pins are Context shortcuts and do not imply Following.

## Proposed Cockpit Structure

### 1. My Work

`My Work` is accountable work, not merely tasks assigned directly to the current human.

| Group | Meaning | Examples |
|---|---|---|
| **To do** | The current human directly owns the work, or a concrete action is their only relationship to otherwise unrelated work. | Human-assigned task, standalone review request, approval, standalone Inbox request. |
| **Managing** | Work is delegated to a human or agent for whom the current human is operationally accountable. | Agent task with the user as responsible human, direct-report task, delegated task waiting for the user's decision. |
| **Following** | The user explicitly wants visibility but is neither the direct actor nor accountable manager. | Followed task, subscribed project, followed objective. |

Base-relationship precedence is direct To do ownership, then Managing accountability, then explicit Following. Attention actions are evaluated after that classification. A task appears once in My Work even if several predicates match.

Attention does not override an established relationship. A Managing task that asks the current user a question stays in Managing and gains a `Question - Needs you` marker. A decision appears in To do only when To do is already the task's home or the decision is the user's only relationship to the underlying work.

The labels are provisional. `Managing` is recommended over `Managed` because it describes the user's current relationship. `Following` is recommended over `Overviewing` because it is familiar and opt-in. Automatic role-derived visibility belongs in Company Overview; it must not silently flood My Work.

### 2. Conversations

Contains communication streams relevant to the current person:

- Active Discussions.
- Direct mentions or replies when supported by the source system.
- Commander conversations only when a cross-session affordance is needed; the current session remains in the left rail.

Questions originating in a Discussion are rendered inline in that Discussion and carry an attention signal. They do not become duplicate standalone Discussion and question rows.

### 3. Company Overview

Replaces the ambiguous `Watch` section. This section is role-scoped and may be omitted entirely for users without operating overview responsibility.

- Objectives and goals at risk.
- Budget pulse.
- Current operations, including running and blocked workflows.
- Recent completions and material teammate activity.
- Commander proactive findings concerning company or department health.

For a founder, scope may be company-wide. For a team lead, it is limited to their authorized responsibility scope. For a member, this section should normally be absent. Explicitly followed objectives or projects live under `My Work > Following` instead.

### 4. Context

Contains user-curated and conversation-supporting material:

- Personal notes.
- Pinned shortcuts and references.
- Memory used in the active Commander conversation.
- Recent artifacts only when pinned or actively referenced.

`Memory` remains an audit/context surface, not a daily work queue. A pinned task keeps its primary home in My Work; its Context entry is a shortcut and must be visually identified as such.

## Attention Is Not a Section

The Cockpit exposes a compact attention filter and a shared badge grammar. It does not render a permanent `Triage` section.

Recommended top filters:

- **All**
- **Needs me**
- **At risk**

Additional filters such as `Updates` or `Running` should live in overflow only after real usage shows demand. The default view ranks attention-worthy items first without hiding calm work.

| Signal family | Example labels | Treatment |
|---|---|---|
| Human action | `Question`, `Approval`, `Review`, `Reply requested` | Strong marker; included in `Needs me`. |
| Time/problem | `Overdue`, `Blocked`, `SLA breached`, `At risk` | Strong marker; included in `At risk`. |
| Execution | `Running`, `Queued`, `Waiting on human` | Informational marker unless human action is required. |
| Change | `Unread`, `Updated`, `Completed` | Quiet marker; should not compete with required actions. |

`Waiting on human` is both an execution state and a human-action signal. The row should display the actionable reason, such as `Question`, rather than forcing the user to interpret a runtime state.

## Existing Card Migration

| Existing card | Proposed home or treatment |
|---|---|
| Inbox | Dissolve into source-linked attention rows. Standalone requests live in `My Work > To do`. Inbox remains a full feature and escape hatch. |
| Awaiting Review | Task stays in `To do` or `Managing` according to relationship and receives a `Review` marker. |
| Approvals | Linked approval decorates its source work; standalone approval lives in `To do`. |
| Active Work | Becomes the `To do`, `Managing`, and `Following` relationship groups. |
| Today | Becomes ranking and `Due today` or `Overdue` signals rather than a duplicate card. |
| Sticky Notes | Moves to `Context > Personal notes`. |
| Discussions | Remains in `Conversations`. |
| Running Now | Becomes an execution signal on work plus a role-scoped summary in `Company Overview > Current operations`. |
| Goals at Risk | Moves to Company Overview, or Following for an explicitly followed objective. |
| Budget Pulse | Moves to Company Overview. |
| Done Today | Becomes a quiet recent-completion summary in Company Overview, not a primary workflow location. |
| Proactive Findings | Decorates the relevant source entity; company-level findings live in Company Overview. |
| Teammates' Activity | Becomes a bounded Company Overview update stream, permission scoped. |
| Pinned | Moves to Context as shortcuts; pinning does not change the entity's primary home. |
| Memory | Moves to Context and remains optional. |

## Card And Row Grammar

Each work row should answer five questions without opening it:

1. What is it?
2. What is my relationship to it?
3. Why does it matter now?
4. Who or what is currently doing the work?
5. What happens if I open it?

```text
[entity icon] HAR-2  Boutique agency interview plan
Managing - Maya Product Analyst             [Question]
Updated 6m ago
```

Attention color communicates urgency; it must not communicate ownership. Relationship is expressed in text, not color alone.

## Role Behavior

| Role | My Work | Company Overview |
|---|---|---|
| Founder | Personal actions, all work they directly manage, explicit follows. | Company-wide but bounded to material signals. |
| Team lead | Personal actions, delegated/reporting-subtree work, explicit follows. | Authorized departments and projects only. |
| Team member | Personal actions, any work they genuinely manage, explicit follows. | Hidden by default. |

Hierarchy determines relevance, never permission. Canonical source-feature authorization remains authoritative before any count, row, or action is returned.

## Focus Pane Coordination

The previously agreed surface mapping remains unchanged:

- Task, review, question, or managed-work row opens the Task Workspace focus pane; the relevant question or review is anchored inline.
- Discussion opens the Discussion focus pane.
- Approval may open the source Task Workspace plus the approval in the shared Viewer.
- Artifact and supporting evidence open in the shared Viewer.
- Personal note opens the compact note editor.

The Cockpit classification determines **where an item is discovered**. Entity type and intent determine **which focus or Viewer surface opens**.

## Default Experience

1. Attention filters: `All`, `Needs me`, `At risk`.
2. My Work: non-empty `To do`, `Managing`, and `Following` groups.
3. Conversations: active or unread Discussions.
4. Company Overview: only for users with relevant operating scope.
5. Context: Personal notes and Pinned context; Memory remains optional.

Cards remain show or hide configurable. Configuration controls which summaries are shown, not the ownership or attention classification rules.

## Current Implementation Delta

The current branch provides useful foundations but does not yet implement this model:

- The Cockpit work service already calculates server-backed `mine`, `managed`, and `awaiting_review` task buckets.
- `mine` includes direct human assignment and explicit `responsibleUserId`; `managed` uses the reporting subtree and excludes Mine.
- Awaiting Review is currently a separate workflow bucket and card rather than an attention signal on its relationship home.
- `Following` has no canonical server-side subscription or task bucket yet. Existing pins are shortcuts and are not sufficient to infer a durable follow relationship.
- Durable `work_questions` exist as a domain contract, but the Cockpit service does not yet aggregate them into relationship rows and attention markers.
- The UI registry hard-codes `Triage`, `My Work`, `Conversations`, `Watch`, and `Memory & Context`; user show or hide preferences are keyed by stable card ids.
- Existing Inbox, approval, review, running, today, and pinned cards each query or render separate slices, so deduplication must happen in a new server-composed presentation model rather than by hiding duplicate React rows after fetch.

The migration therefore needs contract work across shared types, Cockpit services, routes, UI card models, preference compatibility, and end-to-end fixtures. It does not require changing the canonical source features.

## Non-Goals

- Replacing Inbox, Tasks, Discussions, Approvals, Goals, Budget, or Memory.
- A free-form dashboard builder.
- Allowing users to manually move entities between relationship groups.
- Duplicating the same task as separate workflow rows because it is due, running, in review, or pinned.
- Implementing the production taxonomy before product confirmation and engineering review.

## Confirmed Naming And Placement

1. Relationship labels are `To do`, `Managing`, and `Following` for the implementation plan. Copy may receive final usability polish without changing semantics.
2. `Company Overview` replaces `Watch` and is hidden when the user has no operating scope.
3. The compact top filters are `All`, `Needs me`, and `At risk`; there is no Triage section.
4. Inbox, Review, Approval, Today, and Running become attention or source lenses rather than permanent top-level cards.
5. Pinned entities may appear as Context shortcuts while retaining one primary workflow home.
6. Following remains distinct from pinning and automatic hierarchy scope.

## Validation Artifact

The temporary interactive mockup is served locally at `http://127.0.0.1:3203/`. It is intentionally outside tracked production source and should be used to validate naming, hierarchy, density, and pane choreography before implementation.
