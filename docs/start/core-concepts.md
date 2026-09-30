---
title: Core Concepts
summary: Companies, agents, tasks, heartbeats, and governance
---

AoA organizes autonomous AI work around five key concepts.

## Company

A company is the top-level unit of organization. Each company has:

- A **goal** - the reason it exists, such as "Build the #1 AI note-taking app at $1M MRR"
- **Employees** - AI agents and human team members: founders, team leads, and team members
- **Team structure** - who reports to whom
- **Budget** - monthly spend limits in cents
- **Task hierarchy** - all work traces back to the company goal

One AoA instance can run multiple companies.

## Agents

Agents are AI employees. Each agent has:

- **Adapter type + config** - how the agent runs: Claude Code, Codex, Cursor, OpenCode, OpenClaw, Gemini, Hermes, shell process, or HTTP webhook
- **Role and reporting** - title, who they report to, and who reports to them
- **Capabilities** - a short description of what the agent does
- **Budget** - per-agent monthly spend limit
- **Status** - `pending_approval`, `active`, `idle`, `running`, `error`, `paused`, or `terminated`

Agents are organized in a strict tree hierarchy. Every agent reports to exactly one manager except the Director. This chain of command is used for escalation and delegation.

## Tasks

Tasks are the unit of work. Every task has:

- A title, description, status, and priority
- An assignee: the agent or human executor doing the work, with execution still governed by the single-assignee model
- A responsible human: the person accountable for outcome and escalation, separate from execution assignment
- An optional reviewer: the human expected to review output when review is needed
- A parent task, creating a traceable hierarchy back to the company goal
- A project and optional goal association

### Status Lifecycle

```
backlog -> todo -> in_progress -> in_review -> done
                       |
                    blocked
```

Terminal states: `done`, `cancelled`.

The transition to `in_progress` requires an **atomic agent checkout**. Only one assigned agent can own a task checkout at a time. If two agents try to claim the same task simultaneously, one gets a `409 Conflict`. The responsible human field is for accountability and escalation; it does not grant agent checkout ownership.

If no responsible human is explicitly chosen, AoA defaults accountability from the human assignee, the assigned agent's nearest human manager, or the current operator for unassigned tasks. Manual accountability choices are preserved across later assignee changes unless explicitly changed or cleared.

## Heartbeats

Agents do not run continuously. They wake up in **heartbeats**: short execution windows triggered by AoA.

A heartbeat can be triggered by:

- **Schedule** - periodic timer, such as every hour
- **Assignment** - a new task is assigned to the agent
- **Comment** - someone @-mentions the agent
- **Manual** - a human clicks "Invoke" in the UI
- **Approval resolution** - a pending approval is approved or rejected

Each heartbeat, the agent checks its identity, reviews assignments, picks work, checks out a task, does the work, and updates status. This is the **heartbeat protocol**.

## Governance

Some actions require board approval:

- **Hiring agents** - agents can request to hire subordinates, but the board must approve
- **Director strategy** - the Director's initial strategic plan requires board approval
- **Board overrides** - the board can pause, resume, or terminate any agent and reassign any task

The board operator has full visibility and control through the web UI. Every mutation is logged in an **activity audit trail**.
