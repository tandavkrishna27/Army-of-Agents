# Commander Cockpit Completion Plan

**Status:** Reviewed and implementation-ready
**Branch:** `codex/commander-cockpit`
**Supersedes for remaining work:** the interaction, categorization, and viewer portions of the 2026-07-07 and 2026-07-08 Commander Cockpit plans

## Outcome

Commander is the daily operating surface for triage, accountable work, conversations, company watch signals, and working context. It does not replace Inbox, Tasks, Discussions, Approvals, Artifacts, Goals, Agents, or Memory. Cockpit cards explain why an item matters now; entity type determines how the item opens.

The completion wave must deliver three unambiguous contracts:

1. A task has one primary workflow location in the Cockpit, plus explicitly secondary lenses.
2. Every real task opened inside Commander uses `TaskSlideOver`, regardless of its source card.
3. A Discussion opens as a dedicated pane, while nested detail is rendered by the host surface rather than by a second embedded viewer.

## What Already Exists

- A company-scoped `/companies/:companyId/cockpit` API and Cockpit card registry.
- Triage, My Work, Conversations, Watch, and Memory & Context sections.
- Configurable show/hide card preferences and pinning.
- Typed Commander input references with `(kind, id)` identity and chip deduplication.
- `TaskSlideOver`, Commander viewer tabs, Hub detail, `ApprovalDetailCore`, artifact viewers, and sticky notes.
- A full Discussions experience with Thread, Scope, Branches, extracted items, pre-tasks, attachments, map, browser, and a Discussions-owned viewer.
- A unified human and agent reporting hierarchy using `parentType` and `parentId`.
- `issues.responsibleUserId`, including automatic nearest-human responsibility for agent-assigned tasks.
- An isolated seeded review company and Commander E2E coverage.

## Information Architecture

Top-level sections are operating modes:

1. **Triage:** Inbox, Awaiting Review, Approvals.
2. **My Work:** Active Work, Today, Sticky Notes.
3. **Conversations:** Discussions.
4. **Watch:** Running Now, Goals at Risk, Budget Pulse, Done Today, Proactive Findings, Teammates' Activity.
5. **Memory & Context:** Pinned, Memory.

Cards remain compact and individually configurable. No free-form dashboard builder is included.

### Primary workflow placement

Tasks have one primary Cockpit location:

| Task condition | Primary location |
|---|---|
| Non-terminal, not `in_review`, directly assigned to the current human | My Work > Mine |
| Non-terminal, not `in_review`, explicitly responsible to the current human | My Work > Mine |
| Non-terminal, not `in_review`, assigned within the current human's reporting subtree | My Work > Managed |
| `in_review` with `reviewerUserId` equal to the current user, or inside the same responsibility scope | Triage > Awaiting Review |
| `done` today and inside the same responsibility scope | Watch > Done Today |
| `cancelled`, archived, or hidden | Not shown in active workflow cards |

`in_review` tasks must not also appear in Active Work. Moving a task into review moves its primary Cockpit placement from My Work to Awaiting Review.

### Secondary lenses

The following cards are lenses, not primary workflow locations, and may intentionally repeat a task:

- **Today:** due or scheduled today.
- **Running Now:** has a live or queued execution.
- **Pinned:** explicitly pinned by the user.
- **Proactive Findings:** linked to a Commander finding.
- **Teammates' Activity:** linked to recent human activity.

The UI must distinguish this intentional repetition from accidental duplication. Lens cards use context-specific labels and do not imply a second workflow state.

### Responsibility scope

My Work represents accountable work, not only direct assignment.

The responsibility set is company-scoped and consists of:

1. Tasks where `assigneeUserId` is the current user.
2. Tasks where `responsibleUserId` is the current user.
3. Tasks assigned to active humans or agents in the current user's reporting subtree.

Awaiting Review additionally includes any `in_review` task where `reviewerUserId` is the current user. Explicit reviewer assignment wins the `Your review` reason even when the task is outside the user's normal responsibility subtree.

The reporting subtree follows canonical `parentType` and `parentId` links across users and agents. Legacy `agents.reportsTo` is a compatibility fallback only; new Cockpit logic must use one shared hierarchy resolver rather than reimplementing tree walking per card.

The result is partitioned into:

- **Mine:** direct assignment or explicit responsibility.
- **Managed:** reporting-subtree work not already classified as Mine.

An entity appears once inside Active Work. Mine wins over Managed when both predicates match.

### Relevance and permission boundaries

- Reporting hierarchy and lead departments determine Cockpit relevance and ranking.
- Existing permission services remain authoritative for task reads and mutations.
- Founder relevance may cover the full company hierarchy.
- Team-lead My Work relevance includes only Mine and reporting descendants. Department leadership does not pull unrelated departmental tasks into My Work.
- Lead-department scope may influence Inbox, approvals, watch signals, and canonical permission decisions where those source features already use it.
- Team-member relevance includes Mine and any reporting descendants represented by the canonical hierarchy.
- The Cockpit must not introduce stricter visibility than the source Tasks feature without a separate product and RBAC decision.
- The Cockpit must never use hierarchy relevance to grant a mutation or expose data that the canonical permission service denies.
- Permission checks occur before rows, totals, labels, or cached summaries are returned.

### Ranking and bounded rendering

The Cockpit is a summary surface, not an unbounded task list.

Active Work and Awaiting Review are ranked by:

1. Needs-current-user or explicit reviewer.
2. Blocked or SLA-breached.
3. Overdue, then due today.
4. Priority.
5. Most recently updated.

Each group renders a bounded hot set and a total count. A `View all` escape hatch opens the Tasks feature with an equivalent server-backed filter. The client must not fetch an entire company hierarchy and rank it in memory.

### Active Work presentation

- Mine starts expanded and renders at most five ranked rows plus its total count.
- Managed starts expanded and renders at most three ranked rows plus its total count and `View all`.
- Empty subgroups are omitted. If both are empty, Active Work shows one calm `No active work` state rather than two empty panels.
- A Mine row shows task identifier, title, status, priority when exceptional, and the execution assignee.
- A Managed row additionally shows the responsible reporting human or agent and the relationship reason.
- `View all Mine` and `View all Managed` open server-backed Tasks filters with the same scope and ordering as the Cockpit.
- Expanding, collapsing, loading, or refreshing either subgroup must not resize unrelated cards.

### Primary and lens badge grammar

| Context | Required reason label |
|---|---|
| Mine through direct assignment | `Assigned to you` |
| Mine through explicit responsibility | `You are responsible` |
| Managed human work | `Managed: <human>` |
| Managed agent work | `Managed: <agent>` |
| Awaiting Review with explicit reviewer | `Your review` |
| Awaiting Review through hierarchy | `Team review` |
| Today | `Due today` or `Overdue` |
| Running Now | `Running by <agent>` or `Queued for <agent>` |
| Pinned | `Pinned` |
| Proactive Findings | `Commander finding` |
| Teammates' Activity | `Recent activity` |

Primary rows use responsibility and workflow labels. Lens rows use the lens reason. A lens must not present itself as another owner or workflow state.

## Interaction Contract

Every referenceable Cockpit row follows one gesture contract:

| Gesture | Result |
|---|---|
| Click row/title | Open the entity inside Commander without changing the route when a safe host surface exists; otherwise use the explicit documented full-page fallback. |
| Click Ask | Add exactly one typed reference chip and seed the suggested prompt. |
| Drag into composer | Add the same typed reference chip as Ask, without duplicate identity. |
| Click external-link action | Open the entity's full feature page. |
| Click composer chip | Open the referenced entity inside Commander. |
| Remove chip | Remove only that reference before sending. |

Reference identity is `(kind, id)`. Row click never also attaches a chip. Ask and drag never navigate. Repeated Ask or drop retains one chip.

Draggable rows use a grab cursor, visible keyboard focus, a subtle hover highlight, and a small stable translation or elevation that does not resize the card.

## Entity Surface Mapping In Commander

| Entity | Commander surface | Full-page escape hatch |
|---|---|---|
| Inbox item | Commander viewer with Hub detail and lifecycle actions | Inbox route |
| Real task from any card, chip, or Discussion | `TaskSlideOver` | Tasks route |
| Discussion | Dedicated closable Discussion pane | Discussions route |
| Approval | Commander viewer using `ApprovalDetailCore` | Approval or Inbox route |
| Artifact or attachment | Commander viewer using the registered artifact body | Artifact route where available |
| Goal | Commander viewer after a safe detail body exists; route fallback until then | Goal route |
| Agent | Commander viewer after a safe detail body exists; route fallback until then | Agent route |
| Note | Compact personal note editor | No required full page |
| Discussion draft/pre-task | Commander viewer workbench body | Discussion route fallback only for unsupported states |
| Discussion memory candidate or saved memory | Commander viewer memory body | Memory route |
| Discussion scope version or source signal | Commander viewer discussion-context body | Discussion route |
| Browser, map, or link | Commander viewer registered body | External/open route where relevant |

## Discussion Host Contract

The reusable Discussion body contains:

- Discussion header and presence.
- Group-chat timeline and composer.
- Thread, Scope, and Branches tabs.
- Extraction, pre-task, task-creation, attachment, and scope workflows.

It does not contain:

- The Discussions feature's left rail when hosted in Commander.
- A hard-coded Discussions viewer.
- A hard-coded Commander viewer.
- Commander outer page chrome.

The body emits a discriminated `ThreadOpenRequest` union to its host. Payloads may not remain `unknown` at this boundary:

```text
ThreadOpenRequest
  | { kind: "task"; issueId; title; scopeItemId? }
  | { kind: "task_output"; issueId; title; scopeItemId? }
  | { kind: "scope_item"; item; scopeVersionId? }
  | { kind: "memory"; memoryId; title; scopeItemId? }
  | { kind: "artifact"; artifactId; versionId?; title }
  | { kind: "asset"; attachment; entryId? }
  | { kind: "browser"; url; title }
  | { kind: "map"; scope; threadId? }
```

The host dispatches those requests:

```text
Commander host
  real task                 -> TaskSlideOver
  all supported non-task    -> CommanderViewer
  unsupported target        -> explicit fallback with reason

Discussions host
  nested target             -> DiscussionsViewer
```

The same Discussion body must preserve behavior in both hosts. Viewer ownership is dependency-injected through typed callbacks or a host adapter; it must not branch on URL strings or duplicate permission logic.

Existing `ThreadViewerTab` factories should be converted to or built from `ThreadOpenRequest` so Discussions can retain its current tabs while Commander dispatches the same request elsewhere. Extraction must be incremental: first separate open-request creation from rendering, then move reusable workbench bodies. Do not fork `ThreadDetail` into Commander-specific and Discussions-specific copies.

### Commander pane choreography

Never show more than two fully expanded work panes.

1. Default: Commander chat plus Cockpit or Commander viewer.
2. Discussion opened: Commander chat plus Discussion pane; sessions and Cockpit collapse to rails as needed.
3. Nested detail opened: Discussion pane plus the appropriate host detail surface; Commander chat temporarily collapses.
4. Nested detail closed: restore Commander chat plus Discussion pane.
5. Discussion closed: restore the exact pre-open sessions, Cockpit, viewer tabs, selected tab, and collapse state.

At constrained desktop widths, Discussion becomes the primary pane and host detail replaces the secondary pane. On mobile, Discussion is full-screen and nested detail opens above it with an explicit Back action. Hidden panes must not continue expensive queries or steal keyboard focus.

### Pane transition state machine

| Current state | Event | Visible expanded surfaces | Topmost Escape or Back | Focus after transition | Query behavior |
|---|---|---|---|---|---|
| Commander default | Open Discussion | Commander chat + Discussion | Close Discussion | Discussion heading, then composer on reply intent | Discussion active; hidden sidebars idle |
| Discussion open | Open real task | Discussion + `TaskSlideOver` | Close task | Task heading | Task active; Discussion retained without losing draft |
| Discussion open | Open non-task detail | Discussion + Commander viewer | Close selected detail | Viewer heading | Active viewer body only; Commander chat idle |
| Nested detail open | Close nested detail | Commander chat + Discussion, subject to width tier | Close Discussion | Originating Discussion control | Discussion reactivates; closed body idles |
| Discussion open | Close Discussion | Exact pre-open Commander snapshot | Close next topmost surface | Originating Cockpit row or chip | Restored active surface resumes |
| Any state | Open another Discussion | Commander chat + replacement Discussion | Close replacement Discussion | New Discussion heading | Previous Discussion draft is retained in query/form state |
| Any state with unsaved Discussion draft | Close or replace Discussion | Confirmation only when draft cannot be retained safely | Cancel confirmation first | Draft composer | No destructive cleanup before confirmation |

Escape closes only the topmost transient surface. It never skips from nested detail past Discussion to the default Commander layout. Restoration includes sessions state, Cockpit state, viewer tabs, selected viewer tab, Discussion center tab, scroll position where practical, and unsent composer text.

Pane choreography is owned by one reducer rather than independent booleans. Its snapshot contains at minimum:

```text
CommanderPaneSnapshot
  sessionsCollapsed
  cockpitCollapsed
  commanderViewerState { tabs, activeId, expanded }
  commanderChatCollapsed
  discussion { id, centerTab, scrollKey }?
  originFocusKey?
```

Discussion drafts are controlled or persisted in a draft store keyed by `(companyId, discussionId)`. Replacing, resizing, hiding, or temporarily unmounting the Discussion body must not clear a draft. Successful send clears only that Discussion's draft. Exact browser DOM nodes are not stored in reducer state; focus restoration uses stable origin keys and refs.

### Responsive tiers

| Width tier | Discussion behavior | Nested detail behavior | Cockpit and Commander chat |
|---|---|---|---|
| Mobile `<640px` | Full-screen Discussion with Thread/Scope/Branches navigation | Full-screen detail above Discussion with Back | Hidden but state-preserved |
| Tablet `640-1023px` | Discussion is primary; Commander chat is collapsed | Detail replaces the secondary region or opens as sheet | Cockpit rail only |
| Desktop `1024-1535px` | Commander chat + Discussion while no detail is open | Discussion + detail; Commander chat collapses | Cockpit and sessions collapse to rails as needed |
| Wide `>=1536px` | Commander chat + Discussion | Discussion + detail; Commander chat always collapses | Cockpit rail; never more than two expanded work panes |

No tier may hide a draft without preserving it. Touch layouts expose row actions without hover. Temporary breakpoint overrides used in testing must be reset.

### Accessibility and input requirements

- Every row and action is reachable by keyboard without relying on hover.
- Touch and pointer targets are at least 44 by 44 CSS pixels. Dense secondary actions move into an accessible menu rather than using undersized controls.
- Drag has a keyboard and touch alternative: `Add to Commander` performs the same deduplicated reference action.
- Row focus, Ask, Pin, external-link, and drag affordances have distinct accessible names and do not share one click target.
- Resizable separators are keyboard operable, expose separator semantics and value, and respect minimum pane widths.
- Opening a pane, viewer, sheet, or slide-over moves focus to its heading or first meaningful control. Closing returns focus to the originating row, chip, or nested link.
- Loading, failure, completion, and restored-state changes use restrained live-region announcements.
- Motion honors `prefers-reduced-motion`; translation is removed while contrast and elevation still communicate hover or drag state.
- Escape and Back behavior follows the pane state table and is covered by keyboard-only E2E tests.

### Visual density and default cards

The 300px Cockpit remains a quiet enterprise surface: section bands are unframed, individual cards use compact rows, and nested cards, decorative gradients, large radii, and excessive shadows are prohibited.

Default-on cards remain: Inbox, Awaiting Review, Approvals, Active Work, Today, Sticky Notes, Discussions, Running Now, and Pinned.

Optional cards remain: Goals at Risk, Budget Pulse, Done Today, Proactive Findings, Teammates' Activity, and Memory. Existing user preferences survive card title changes through stable card ids and a preference migration when required.

## Surface State Matrix

| State | Cockpit behavior | Discussion/detail behavior |
|---|---|---|
| Initial loading | Show stable skeleton rows and suppress all-clear claims | Show bounded skeleton with correct pane title |
| Success with data | Render ranked rows, totals, labels, and actions | Render real domain body and actions |
| Success empty | Show context-specific empty state only after successful response | Show real domain empty state, not a missing-state error |
| Partial response | Render successful cards and an inline retry notice for unavailable slices | Preserve available context and identify the failed body |
| Error without data | Show `Cockpit unavailable` with Retry; never substitute `EMPTY_DATA` or `All clear` | Show problem, likely cause, Retry, Close, and safe full-page action |
| Stale cached data | Keep rows visible with subtle `Updating` state and disable destructive assumptions | Preserve body and mark refresh without discarding drafts |
| Forbidden | Do not render cached summary content; show access message | Show access message without leaked title or body |
| Deleted/stale reference | Keep reference identity and show unavailable state | Offer Close and safe full-page fallback only when meaningful |

`All clear` is valid only after a successful Cockpit response confirms that every enabled primary card is empty. It must never be derived from loading defaults or a failed request.

## Data And API Contract

The Cockpit response must expose enough information for rendering without client-side hierarchy reconstruction:

- Active Work groups for Mine and Managed.
- Total counts independent of the bounded visible rows.
- Primary placement reason and secondary badges.
- Responsible human and assignee identity needed for labels.
- Awaiting Review rows and counts from the same responsibility scope plus explicit reviewer assignments.
- Stable server-side ordering.
- Additive response metadata:
  - `generatedAt`
  - `partial`
  - per-slice `ok | error` status with a stable error code, never raw internal text

The service should compute one reusable responsibility scope and apply it to Active Work, Awaiting Review, Today, Done Today, and relevant Watch cards. Awaiting Review then unions explicit reviewer assignments. Shared scope avoids cards disagreeing about which work belongs to the user.

Authentication, company scope, and responsibility-scope resolution fail the request as a whole. Independent Cockpit slices run through settled results so one non-critical slice can fail without erasing successful cards. A partial response sets `meta.partial = true`; the UI renders successful slices and a retry notice for failed slices. Totals and `All clear` are valid only when every enabled primary slice succeeded.

`View all` uses a dedicated paginated endpoint rather than approximating Cockpit semantics through singular issue filters:

```text
GET /companies/:companyId/cockpit/tasks
  ?bucket=mine|managed|awaiting_review
  &cursor=<opaque>
  &limit=<bounded>
```

The summary endpoint and paginated endpoint share one work-query builder for responsibility predicates, permission filtering, primary placement, ranking, and stable cursor ordering. The response includes rows, total, and next cursor. It never accepts arbitrary user or company scope from the client.

The responsibility graph loader reads active company memberships and agents in bounded queries, constructs typed `user:<id>` and `agent:<id>` nodes, and traverses with a visited set and maximum depth. It must include agents below reporting humans and humans below reporting humans. Per-node database queries are prohibited.

No database schema change is assumed until the service-level hierarchy query is proven insufficient. Any API contract change must update shared types, server tests, UI tests, and seed data together.

The full Cockpit query is enabled only while the Cockpit is expanded or a rail card is opened. A lightweight company-scoped `/cockpit/counts` response supplies collapsed-rail counts and active indicators, uses the same responsibility scope, and is refreshed by targeted live invalidation. Targeted invalidation covers task create/update/delete, hierarchy changes, Hub changes, approvals, pins, notes, runs, and budget changes. A low-frequency background refresh may remain as rescue, but an eight-second hidden-pane full-data poll is not the correctness mechanism.

### API compatibility and rollout

The new shared contract is additive for one compatibility window:

- New fields: `activeWork`, `awaitingReview`, and `meta`.
- Existing `review` remains as a deprecated alias of the visible Awaiting Review rows.
- Existing `myTasks` remains as a deprecated alias of visible Mine rows and explicitly excludes `in_review` under the new primary-placement contract.
- The Commander UI switches atomically to the new fields in the same change.
- Server contract tests verify new fields and aliases during the window.
- Alias removal is a separately documented follow-up, not part of this implementation wave.

The responsibility graph, shared work-query builder, new response types, `/cockpit/tasks`, and `/cockpit/counts` endpoints land before Active Work or Awaiting Review UI changes depend on them.

## Engineering Architecture

```text
Board request
  -> company/auth guard
  -> canonical role and action permissions
  -> responsibility graph loader
       memberships + agents
       -> typed user/agent graph
       -> Mine/Managed/review relevance
  -> shared work-query builder
       -> Active Work summary
       -> Awaiting Review summary
       -> Today / Done Today
       -> paginated View All buckets
  -> independent Cockpit slices via settled results
  -> CockpitData + metadata
  -> visibility-gated query + targeted live invalidation

Discussion row or chip
  -> Commander pane reducer
  -> host-neutral Discussion body
  -> discriminated ThreadOpenRequest
       -> Commander host
            task      -> TaskSlideOver
            non-task  -> Commander viewer
            unsupported -> explicit fallback
       -> Discussions host
            request   -> Discussions viewer tabs
```

### Principal file ownership

| Boundary | Principal files |
|---|---|
| Responsibility graph and permission-aware work query | `server/src/services/org-hierarchy.ts`, `agents.ts`, new `responsibility-scope.ts`, `cockpit.ts` |
| Cockpit API and shared contract | `packages/shared/src/cockpit.ts`, `server/src/routes/cockpit.ts`, `ui/src/api/cockpit.ts` |
| Active Work and Awaiting Review presentation | `CommanderCockpitPanel.tsx`, task card components, Cockpit preference migration |
| Discussion open-request contract | `threadViewerModel.ts`, `ThreadDetail.tsx`, `ThreadViewer.tsx`, Discussion body components |
| Commander host dispatch and pane reducer | `InternalAgentPanel.tsx`, Commander viewer model/bodies, `TaskSlideOver.tsx` |
| Draft and focus restoration | `EntryComposer.tsx`, pane reducer/hooks, stable origin refs |
| Live invalidation and query gating | `LiveUpdatesProvider.tsx`, Cockpit query hook, relevant mutation hooks |
| Seed and verification | Commander service/component tests, Thread tests, `commander-viewer.spec.ts`, review seeder |

### Test flow

```text
Hierarchy fixtures
  -> scope unit tests
  -> service placement and permission tests
  -> summary/pagination route tests
  -> Active Work component tests
  -> Commander E2E placement tests

ThreadOpenRequest fixtures
  -> exhaustive dispatch unit tests
  -> Discussions host parity tests
  -> Commander host component tests
  -> pane reducer and draft tests
  -> desktop/tablet/mobile E2E

Mutation and event fixtures
  -> targeted invalidation integration tests
  -> partial-response UI tests
  -> hidden-query performance assertions
```

## Delivery Phases

### Phase 0: Plan and branch integrity

- Keep all work in the isolated `codex/commander-cockpit` worktree.
- Reconcile with current `main` before implementation resumes.
- Preserve existing Commander behavior not superseded by this plan.
- Lock this revised plan after product, design, and engineering review.

### Phase 1: Responsibility graph and work-query foundation

- Extract a reusable company-scoped responsibility graph loader from the unified org-tree data pattern.
- Resolve reporting descendants across active humans and agents with visited-set and depth protection and no per-node queries.
- Build one permission-aware work-query builder for Mine, Managed, Awaiting Review, Today, and Done Today.
- Implement Mine-wins deduplication, explicit reviewer inclusion, and `in_review` exclusion from Active Work.
- Add bounded server-side ranking and total counts.

### Phase 2: API contract, pagination, and resilience

- Add `activeWork`, `awaitingReview`, `meta`, and compatibility aliases to shared types.
- Add the paginated `/cockpit/tasks` bucket endpoint and lightweight `/cockpit/counts` endpoint.
- Use settled execution for independent Cockpit slices while failing hard on authentication and scope errors.
- Add stable cursor ordering, partial metadata, and contract tests.
- Update the UI API client before dependent presentation changes.

### Phase 3: Active Work presentation and interaction consistency

- Change Review to Awaiting Review and My Tasks to Active Work.
- Render Mine and Managed groups, bounded rows, totals, labels, and server-backed View All actions.
- Audit every referenceable card against the gesture contract.
- Keep real tasks on `TaskSlideOver` from every source.
- Preserve chip identity, drag behavior, and row/Ask separation.
- Add loading, missing, forbidden, and stale-reference states.
- Preserve existing preference ids through a migration or stable-id mapping.

### Phase 4: Extract the host-neutral Discussion body

- Define the discriminated `ThreadOpenRequest` union and convert existing tab factories to use it.
- Separate nested-open request creation from Discussions viewer state and rendering.
- Separate Discussion body state from Discussions page shell and viewer ownership without forking the body.
- Keep the Discussions host on its existing viewer with no regression.
- Mount only the Discussion body as a dedicated Commander pane.
- Route real tasks to `TaskSlideOver` in Commander.
- Route supported non-task targets to Commander viewer bodies.

### Phase 5: Commander viewer parity for Discussion targets

- Reuse existing registered bodies wherever possible.
- Add safe Commander bodies for pre-task, scope/source context, memory, browser, and map targets that do not yet exist.
- Preserve mutating actions, RBAC, optimistic state, stale handling, and query invalidation from Discussions.
- Use an explicit full-page fallback when parity is not yet safe; never render a decorative summary in place of a real workbench.

### Phase 6: Pane choreography and responsive UX

- Implement a single Commander pane reducer and the two-expanded-pane limit.
- Add a Commander viewer snapshot/restore API covering tabs, active tab, and expanded state.
- Move Discussion composer drafts into controlled storage keyed by company and Discussion.
- Snapshot and restore pane, viewer-tab, selected-tab, origin focus, and collapse state.
- Verify keyboard focus, Back/Escape behavior, resizing, and mobile stacking.
- Disable expensive hidden-pane queries.

### Phase 7: Live updates, query gating, and scale

- Gate full Cockpit and hidden detail queries by active visibility while collapsed rails use lightweight counts.
- Add targeted invalidation for task, hierarchy, Hub, approval, pin, note, run, and budget mutations and events.
- Prove bounded query counts and stable cursor ordering with large hierarchy fixtures.

### Phase 8: Verification and founder review

- Extend deterministic seed data for Mine, Managed human, Managed agent, Awaiting Review, lens overlap, and Discussion nested targets.
- Run unit, component, integration, E2E, responsive, and live-browser tests.
- Run `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
- Leave the isolated seeded application open at an exact review URL.

## Failure And Rescue Registry

| Failure | User-visible rescue | Required verification |
|---|---|---|
| A task matches Mine and Managed | Render once under Mine with responsibility badges | Scope and API dedupe tests |
| An `in_review` task also matches Active Work | Render only in Awaiting Review as its primary placement | Service and E2E placement tests |
| Explicit reviewer is outside responsibility subtree | Include in Awaiting Review with `Your review` reason | Reviewer-scope integration test |
| Reporting hierarchy contains a cycle or stale parent | Stop traversal safely, log diagnostics, and retain direct/explicit work | Cycle and missing-parent integration tests |
| Founder hierarchy produces a large result | Return bounded ranked rows plus accurate totals | Scale test with large hierarchy fixture |
| Permission differs from hierarchy | Permission wins; do not return or summarize the task | Company/RBAC integration tests |
| One Cockpit slice fails | Return successful slices with partial metadata; never show all-clear | Settled-slice route and UI tests |
| Cockpit task pagination races updates | Use stable ordering and opaque cursor; tolerate changed totals on refresh | Pagination mutation integration test |
| Reference target was deleted | Preserve identity and show unavailable state with close/full-page options | Viewer 404 component test |
| User lacks target permission | Show access message without leaked summary data | Cross-company and role tests |
| Repeated Ask or drop adds duplicates | Retain one chip by `(kind, id)` | Model, component, and E2E tests |
| Drag is interpreted as click | Drop attaches; source row does not open or navigate | Pointer/drop E2E |
| Discussion body mounts its native viewer in Commander | Fail DOM guard; only host-owned detail is allowed | Component and E2E tab-bar assertions |
| Commander host lacks a Discussion target body | Show explicit unsupported fallback and full-page action | Per-kind fallback tests |
| Discussions host regresses after extraction | Existing nested viewer workflows remain unchanged | Existing Discussions suite plus parity E2E |
| Pane close loses prior Commander state | Restore exact tabs, selection, and collapsed panels | State-machine and E2E restoration tests |
| Discussion remount or replacement loses draft | Restore controlled draft by company and Discussion id | Draft lifecycle component and E2E tests |
| Narrow viewport starves the composer | Switch to primary-pane stacking with Back navigation | Responsive browser tests |
| Hidden pane continues polling | Disable query and subscriptions while hidden | Query-enable component tests |
| Live mutation does not update Cockpit | Targeted event invalidates the affected slice; background refresh is rescue only | Live-update integration tests |
| Live update races an action | Reconcile through canonical service/query invalidation and retain undo where supported | Mutation integration tests |

## Test Map

| Layer | Coverage |
|---|---|
| Unit/model | Responsibility partitioning, Mine-wins dedupe, status placement, ranking, ref identity, typed Discussion open requests, pane state reducer. |
| Service | Mixed human/agent hierarchy scope, explicit reviewer, permission boundary, totals, cursor stability, bounded query count, cycle protection, company isolation. |
| Component | Mine/Managed groups, Awaiting Review, task slide-over dispatch, host-specific Discussion dispatch, loading/error/permission states. |
| Integration | Shared scope across cards and paginated buckets, partial slice responses, Hub actions, Discussion extraction parity, Commander viewer mutations, targeted live invalidation. |
| E2E | No Review/My Work primary duplication; managed human/agent coverage; task slide-over from every source; Discussion pane plus host viewer; state restoration. |
| Responsive/browser | Two-pane limit, wide/mid/mobile choreography, focus, Escape/Back, drag affordance, no overlapping controls. |
| Repository | Full typecheck, tests, build, and diff hygiene. |

### Critical E2E scenarios

1. Directly assigned task appears under Mine and opens `TaskSlideOver`.
2. Explicitly responsible task appears under Mine even with a different assignee.
3. Reporting-human and reporting-agent tasks appear under Managed.
4. The same task is never duplicated between Mine and Managed.
5. Moving a managed task to `in_review` removes it from Active Work and adds it to Awaiting Review.
6. A running due-today task may appear in Active Work, Today, and Running Now with lens labels, while retaining one primary state.
7. Discussion opens as a pane without changing `/commander` and without a nested Discussions viewer.
8. A real task opened from the Commander-hosted Discussion uses `TaskSlideOver`.
9. An artifact opened from the Commander-hosted Discussion uses Commander viewer.
10. The same artifact opened on the Discussions page uses Discussions viewer.
11. Closing nested detail and Discussion restores prior Commander state exactly.
12. Mobile Back returns from nested detail to Discussion without losing draft text.
13. A failed Cockpit request shows Retry and never shows `All clear`.
14. Keyboard-only users can reach row, Ask, Pin, external-link, resize, Escape, and focus-return workflows.
15. Touch users can add a reference and access row actions without hover or drag.
16. Loading, stale refresh, forbidden, deleted, and partial-response states retain stable layout and expose the correct rescue action.
17. An explicit reviewer receives an Awaiting Review task outside their normal responsibility subtree without receiving unrelated work.
18. Mine, Managed, and Awaiting Review `View all` pagination preserves summary ordering and company scope.
19. A mixed human/agent hierarchy fixture resolves all descendants with a bounded number of database queries and survives cycles and stale parents.
20. Replacing one Discussion with another and returning restores each unsent draft independently.
21. Task, hierarchy, Hub, approval, pin, note, run, and budget events refresh only the affected Cockpit data without hidden eight-second polling.

## Review Record

### Product and design review

**Final verdict:** PASS

The review initially flagged false all-clear failure states, incomplete pane transitions, hover-only actions, unspecified Managed density, unclear lens repetition, missing breakpoint contracts, and unfrozen defaults. All findings were incorporated through the surface state matrix, pane reducer contract, accessibility requirements, bounded Mine/Managed presentation, badge grammar, responsive tiers, and default-card policy.

Final reviewed dimensions:

| Dimension | Score |
|---|---:|
| Information architecture | 9.5/10 |
| Interaction-state coverage | 9.5/10 |
| User journey and recovery | 8.5/10 |
| Visual specificity and density | 9/10 |
| Design-system alignment | 8/10 |
| Responsive and accessibility | 8/10 before final 44px and two-pane wording fixes; re-review PASS |
| Decision completeness | 9/10 |

### Engineering review

**Final verdict:** PASS. Implementation may begin in the documented phase order.

The review initially flagged permission-versus-relevance ambiguity, missing partial-response metadata, an unsupported View All contract, omitted explicit reviewers, insufficient mixed hierarchy traversal, understated Discussion extraction, incomplete pane/draft ownership, hidden polling, and API migration order. The plan now specifies canonical permission authority, settled slice metadata, dedicated bucket and count endpoints, bounded unified graph loading, `ThreadOpenRequest`, reducer-owned pane restoration, controlled drafts, targeted invalidation, additive compatibility, and API-first delivery.

No unresolved P0 or P1 gap remains in the reviewed plan. Engineering re-review explicitly confirmed that the plan is ready to implement.

## Definition Of Done

- Product, design, and engineering reviews contain no unresolved critical gap.
- Primary workflow placement is mutually exclusive and secondary lens overlap is explicit.
- My Work covers direct, responsible, and reporting-subtree work for humans and agents.
- Awaiting Review includes explicit reviewers and responsibility-scope review work without Active Work duplication.
- Summary and `View all` task buckets share one permission-aware query contract and stable ranking.
- Partial slice failures are explicit and can never produce a false all-clear state.
- Every Commander task entry uses `TaskSlideOver`.
- Commander-hosted Discussion uses host-owned detail surfaces; Discussions retains its own viewer.
- No duplicate viewer tab systems are visible.
- Pane snapshots and per-Discussion drafts survive nested detail, replacement, responsive transitions, and restoration.
- Hidden panes do not poll continuously; targeted live invalidation keeps visible data current.
- All permission, failure, restoration, and responsive tests pass.
- Full repository typecheck, tests, and production build pass.
- The seeded isolated app demonstrates every category and interaction.

## Not In Scope

- Replacing Inbox, Tasks, Discussions, or any other domain feature with Commander.
- A free-form dashboard builder.
- Shared or collaborative notes.
- Renaming database tables or existing API route families.
- Changing company visibility or RBAC through hierarchy references.
- Persisting structured message references server-side in this wave.
- Rebuilding unrelated Goal or Agent pages solely for Commander.
- Showing every managed task as an unbounded Cockpit list.

## Decision Audit Trail

| # | Decision | Classification | Rationale | Rejected |
|---|---|---|---|---|
| 1 | Use operating-mode sections with primary placement and secondary lenses | Product/UX | Prevents accidental duplication while preserving Today, Running, and Pinned perspectives | A single mixed feed or overlapping primary buckets |
| 2 | Rename Review to Awaiting Review | Product/UX | Names the workflow gate rather than a vague activity | Keep ambiguous Review label |
| 3 | My Work includes Mine and Managed across humans and agents | Product/UX | Matches real managerial accountability, not only direct assignment | Direct assignments only |
| 4 | Exclude `in_review` from Active Work | Product/UX | A task has one primary workflow location | Show in both Review and My Work |
| 5 | Keep `TaskSlideOver` universal inside Commander | Interaction | Task behavior stays predictable regardless of source | Card-specific Task viewers |
| 6 | Open Discussion as a dedicated pane, not a Commander tab | Interaction | Preserves a conversational workspace and Commander route | Embed Discussion in Commander viewer tabs |
| 7 | Make viewer ownership host-specific | Architecture | Commander and Discussions reuse one body without nested viewers | Hard-code either viewer into the body |
| 8 | Limit the workspace to two expanded work panes | UX/Performance | Protects readable widths, composer access, and query cost | Squeeze every panel onscreen |
| 9 | Use server-side bounded ranking with totals | Scale | Keeps founder and manager Cockpits useful at company scale | Fetch and rank the full hierarchy in the browser |
| 10 | Reuse real domain bodies and lifecycle rules | Architecture | Keeps permissions and mutations consistent with source features | Summary-only decorative previews |
| 11 | Start Managed expanded with three ranked rows | Product/UX | Keeps managerial responsibility visible without dominating the Cockpit | Collapse Managed by default or show an unbounded list |
| 12 | Require an explicit surface state matrix | Reliability/UX | Prevents loading and failures from masquerading as an all-clear state | Reuse empty defaults for loading and errors |
| 13 | Model pane changes as a reversible state machine | Interaction/Architecture | Makes Escape, focus, draft preservation, and restoration deterministic | Independent boolean toggles without transition rules |
| 14 | Freeze four responsive behavior tiers | Responsive UX | Removes implementation guesswork and protects the composer at constrained widths | Defer responsive arbitration to visual QA |
| 15 | Provide non-hover actions and drag alternatives | Accessibility | Keyboard and touch users must have complete workflows | Hover-only Ask, Pin, and drag controls |
| 16 | Use explicit primary and lens reason labels | Product/UX | Makes intentional repetition understandable at a glance | Display identical rows without context |
| 17 | Keep current default-on versus optional card policy | Scope/UX | Preserves user expectations while the taxonomy changes | Turn every available card on by default |
| 18 | Treat hierarchy as relevance and canonical permissions as authority | Security/Architecture | Avoids accidental Cockpit-only authorization while preserving accountable ranking | Invent stricter or broader Cockpit RBAC |
| 19 | Include explicit reviewers outside normal responsibility scope | Product/Data | A direct review assignment must not disappear because of hierarchy | Responsibility-subtree review only |
| 20 | Add a dedicated paginated Cockpit task-bucket endpoint | API/Scale | Keeps View All identical to summary placement and ranking | Approximate through singular Tasks filters or remove View All |
| 21 | Return additive per-slice Cockpit metadata | Reliability/API | Supports partial rescue and prevents false all-clear states | Fail every card when one independent slice fails |
| 22 | Load the unified responsibility graph in bounded queries | Performance/Architecture | Supports mixed human-agent descendants without N+1 traversal | Reuse direct-report or per-level queries |
| 23 | Replace `unknown` Discussion viewer payloads at the host boundary | Type safety/Architecture | Makes host dispatch exhaustive and testable | Runtime kind inspection of untyped payloads |
| 24 | Persist Discussion drafts outside transient pane components | Reliability/UX | Pane replacement and responsive transitions cannot lose unsent work | Rely on component-local composer state |
| 25 | Use targeted live invalidation with polling as rescue | Performance/Correctness | Keeps visible data current without hidden high-frequency fetches | Treat eight-second polling as the event model |
| 26 | Keep unrelated department work out of My Work | Product/Data | Managerial accountability follows explicit responsibility and reporting hierarchy | Treat every led-department task as personal work |
| 27 | Add a lightweight collapsed-rail counts endpoint | Performance/UX | Rail indicators remain current while full Cockpit queries are disabled | Circularly disable the query that supplies the badge |
| 28 | Roll out Cockpit v2 fields additively for one window | API compatibility | Allows synchronized UI migration and safer rollback without indefinite dual logic | Immediate unversioned removal or permanent aliases |
