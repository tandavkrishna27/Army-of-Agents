---
title: Managing Tasks
summary: Creating issues, assigning work, and tracking progress
---

Issues (tasks) are the unit of work in AoA. They form a hierarchy that traces all work back to the company goal.

## Ownership Terms

- **Assignee** - the executor doing the work. This may be an agent (`assigneeAgentId`) or, where supported, a human (`assigneeUserId`). Execution still follows the single-assignee task model.
- **Responsible human** - the human accountable for the task outcome and escalation (`responsibleUserId`). This does not make the human the executor.
- **Reviewer** - the human expected to review output when review is needed (`reviewerUserId`).

## Creating Issues

Create issues from the web UI or API. Each issue has:

- **Title** — clear, actionable description
- **Description** — detailed requirements (supports markdown)
- **Priority** — `critical`, `high`, `medium`, or `low`
- **Status** — `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, or `cancelled`
- **Assignee** — the agent or human assigned to execute the work
- **Responsible human** — the human accountable for outcome and escalation
- **Reviewer** — the human expected to review output when review is needed
- **Acceptance criteria** — the checks that define a successful result
- **Completion policy** — whether the assigned agent may complete directly or must request review
- **Parent** — the parent issue (maintains the task hierarchy)
- **Project** — groups related issues toward a deliverable

## Task Hierarchy

Every piece of work should trace back to the company goal through parent issues:

```
Company Goal: Build the #1 AI note-taking app
  └── Build authentication system (parent task)
      └── Implement JWT token signing (current task)
```

This keeps agents aligned — they can always answer "why am I doing this?"

## Assigning Work

Assign an issue to an agent by setting `assigneeAgentId`, or to a human by setting `assigneeUserId` where human assignment is supported. If heartbeat wake-on-assignment is enabled, assigning an agent triggers a heartbeat for that agent.

Set `responsibleUserId` when a specific human should be accountable for the task's outcome or escalation path, even when an agent is the executor. Updating `responsibleUserId` does not dispatch work or change task checkout ownership.

If no responsible human is explicitly chosen, AoA defaults it from the human assignee, the assigned agent's nearest human manager, or the current operator for unassigned tasks. A manually selected responsible human stays sticky when the assignee changes unless it is explicitly changed or cleared.

## Working in the Task Panel

Select a task to open its detail panel. Click the title or a property to edit it in place. The description supports Markdown and saves when you leave the editor. Drag the panel's left edge to resize it; double-click the resize handle to switch to a wider reading layout.

Use the panel tabs to keep different kinds of context separate:

- **Overview** — description and core task properties
- **Work** — execution workspace and active work context
- **Comments** — discussion and progress updates, with the composer kept available at the bottom
- **Sub-tasks** — child work in the task hierarchy
- **Activity** — the task's audit trail

When a task has an execution workspace, open its workspace view for the full run timeline, preview, services, and repository context. See [Execution Workspaces](execution-workspaces.md).

## Acceptance and Completion

Define acceptance criteria before assigning autonomous work. An agent can move
its task directly to `done` only when the effective policy is
`agent_can_complete` and at least one acceptance criterion exists. Crew and
internal-agent tools also require effective Drive autonomy from their thread or
company context. Org-agent HTTP API keys are outside that dial and are treated
as Drive. Both paths still require task ownership. Otherwise, route the task
through `in_review`.

For review-required work, AoA chooses an eligible reviewer from the explicit reviewer, responsible human, scoped team lead, or founder. A company-level guardrail can require review regardless of project, automation, or task overrides.

For exact policy precedence, fields, and API errors, see the [Tasks API](../../api/issues.md).

## Status Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked -> todo / in_progress
```

- `in_progress` requires an atomic checkout (only one agent at a time)
- `blocked` should include a comment explaining the blocker
- `done` and `cancelled` are terminal states

## Monitoring Progress

Track task progress through:

- **Comments** — agents post updates as they work
- **Status changes** — visible in the activity log
- **Home** — shows task counts by status and highlights stale work
- **Run history** — see each heartbeat execution on the agent detail page

Questions that block agent work appear as work questions for the responsible human or another eligible recipient. Follow [How to Resolve Work Questions](work-questions.md) for the operator workflow, or use the [Work Questions API](../../api/work-questions.md) for the exact contract.
