# Commander Cockpit Wave 0 Baseline

**Captured:** 2026-07-12

**Branch:** `codex/commander-cockpit`

**Application:** `http://127.0.0.1:3202/HAR/commander`

**Mock:** `http://127.0.0.1:3203/`

## Purpose

Freeze the behavior and data available before the person-centered Cockpit compositor or UI taxonomy changes. This baseline is evidence, not a release qualification campaign.

## Real Harbor State

Harbor Launch Studio is running in `local_trusted` mode with the synthetic `local-board` human. It therefore demonstrates current domain and UI behavior but cannot prove founder, lead, and member authorization boundaries.

| Source | Observed state |
|---|---|
| Tasks | HAR-1, HAR-2, and HAR-3 are `in_progress`, agent-assigned, and `responsibleUserId=local-board`. The current Cockpit classifies all three as Mine. |
| Managed tasks | HAR-4, HAR-5, and HAR-6 are generated productivity-review tasks assigned to managed agents and shown as Managed. |
| Review | No task is currently `in_review`; Awaiting Review is empty. |
| Inbox | One unread high-priority notification reports that Maya Product Analyst timed out after 600 seconds. |
| Discussion | One active Discussion, `Choose the first customer segment`, is shown under Conversations. |
| Approval | No active approval is present. |
| Question | No durable work question is present in Cockpit even though HAR-1 and HAR-2 instructed Maya to call `ask_founder`. |
| Runtime | Maya is in error after a timed-out Claude run. Dev Launch Engineer is idle after a Codex run. |
| Notes, pins, risk, budget | No sticky note, pin, at-risk objective, or configured monthly budget is present. |

## Baseline Findings

1. Clicking the timed-out Inbox row stays on Commander and opens a typed Viewer tab with the run, task, prompt, adapter, timing, retry, and Inbox actions.
2. The center empty state says everything looks good despite the visible unread high-priority timeout. This is a contradictory status signal to fix in a later UI wave.
3. Agent-assigned tasks for which the board is responsible are classified as Mine today. The approved v3 relationship contract classifies delegated accountable work as Managing.
4. The real question lifecycle did not complete. Maya timed out before creating a durable question, so seeded descriptions cannot be treated as question evidence.
5. Maya's captured adapter configuration has `dangerouslySkipPermissions=true`. This Harbor instance is not valid supervised-permission evidence.
6. The instance has one synthetic human and cannot qualify multi-user RBAC, takeover, or cross-company isolation.

## V3 Scenario Matrix

| Domain state | Stable home | Group | Attention | Primary open | Supporting detail |
|---|---|---|---|---|---|
| Human-assigned task | My Work | To do / Tasks | Status-derived | Workspace Focus | Viewer only for output or evidence |
| Human-responsible task with agent or report executing | My Work | Managing | Status-derived | Workspace Focus | Viewer for output, run, or approval |
| Managed task asks current user a question | My Work | Managing | Question / Needs me | Workspace Focus anchored to question | Run evidence in Viewer |
| Unrelated task routes a question to current user | My Work | To do / Decisions | Question / Needs me | Workspace Focus anchored to question | Run evidence in Viewer |
| Task awaits current user's review | Existing To do or Managing home | Existing group | Review / Needs me | Workspace Focus anchored to review | Artifact in Viewer |
| Single-task approval | Existing task home | Existing group | Approval / Needs me | Workspace Focus plus approval Viewer | Approval Viewer |
| Multi-task approval | My Work | To do / Decisions | Approval / Needs me | Approval Viewer | Related task links |
| Explicitly followed task | My Work | Following | Risk only when real risk exists | Workspace Focus | Evidence in Viewer |
| Relevant Discussion | Conversations | Discussions | Unread or reply request | Discussion Focus | Nested refs use Commander Viewer |
| Running or blocked agent operation | Company Overview | Current operations | Running or risk | Aggregate drill-in | Run Viewer |
| Objective or budget signal | Company Overview | Objectives and budget | At risk when applicable | Aggregate drill-in | Goal or budget detail |
| Personal note | Context | Personal notes | None | Note editor | None |
| Pinned entity | Context | Pinned context | Does not imply Following | Entity-defined target | Entity-defined Viewer |
| Standalone Inbox request | My Work | To do / Decisions | Needs me | Inbox Viewer | Canonical Inbox escape |

## Contract Scaffolding

Wave 0 adds pure, compatibility-safe contracts before visible UI replacement:

- Cockpit presentation v3 schemas and typed open targets.
- Stable relationship and attention classifiers.
- Versioned preference parsing and legacy migration.
- Commander breakpoint, accessibility, density, Focus, Viewer, and restoration state contracts.
- Existing Cockpit response remains unchanged during this wave.

## Mock Acceptance

| Gate | Result | Evidence |
|---|---|---|
| Separate To do Tasks and Decisions | Pass | Distinct rows and labels in My Work. |
| Managing keeps its home when a question appears | Pass | HAR-2 remains Managing with a Question marker. |
| Follow and Pin are independent | Pass | Unfollow and Pin change independently. |
| Drag grip and keyboard/touch alternative | Pass | Dedicated draggable grip plus Attach to chat creates one typed task chip. |
| Group-specific View all | Pass | My Work expands in place and changes to Show less. |
| Loading, empty, partial error, answered, continuation failed | Pass | Mock-state selector exposes all six deterministic states. |
| Focus and Viewer restoration | Pass | Viewer closes before Focus and the Workspace draft remains intact. |
| Persistent mobile Cockpit | Pass | A 44px Cockpit button opens a full-screen drawer at 390px. |
| Responsive screenshots | Pass | 390, 768, 1280, and 1600px have no horizontal overflow or horizontally clipped controls. |

Browser evidence is stored under `.aoa-qa/commander/wave-0/baseline/`.

## Remaining Qualification Work

- Build the authenticated founder, lead, and member harness.
- Build the execution manifest reporter and fail-fast gate runners.
- Create a fresh causal company through supported product APIs and UI.
- Run supervised Claude and Codex tasks that create real questions, permissions, outputs, review, approval, and continuation events.
- Leave the successful evidence organization running for user inspection.
