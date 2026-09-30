---
name: AoA Workspace Architecture Decisions
description: Complete architectural decisions for universal workspace system across all departments - decided April 2026
type: project
---

## Overview

AoA's workspace system is a universal multi-panel work surface where agents and humans execute tasks. Workspaces are the primary place to see what happened, what's being produced, and where work stands. Every department gets workspaces — the shell is universal, the content adapts per department type.

**Date:** Decided across sessions 2026-04-01 to 2026-04-03.

---

## Core Concepts & Nomenclature

| Term | Definition |
|------|-----------|
| **Pure Human Task** | Work only a human can do, no agent involved (call someone, attend meeting) |
| **Agent Task** | Work an agent executes autonomously (generate ideas, write code) |
| **Human Input Point** | A moment in a workflow where human decision is needed (select from options, approve). Implemented as a separate task with dependency, NOT inline pause. |
| **Run** | One execution episode by an agent on a task (= heartbeat run) |
| **Session** | One continuous interaction context (may include multiple runs + human feedback between them) |
| **Workspace** | Persistent execution context across all sessions/runs for a task. Contains artifacts, context, run history. |
| **Isolated workspace** | One workspace per task. Tasks are independent. |
| **Shared workspace** | One workspace for a workflow/campaign. Multiple related tasks share context. |

---

## Layout Architecture

### Universal Workspace View

Route: `/:companyPrefix/workspaces/:workspaceId`

```
┌──────────┬───────────────┬────────────────────────┬──────────────────┐
│ App      │ Left Panel    │ Center Panel           │ Right Panel      │
│ Sidebar  │ (collapsible) │ (always visible)       │ (collapsible)    │
│ (auto-   │               │                        │                  │
│ collapsed│ Department    │ Center-Left: Timeline  │ Sections:        │
│ on enter)│ task          │ Center-Right: Preview  │ - Artifacts      │
│          │ navigator     │ (mode-switchable)      │ - Context        │
│          │               │                        │ - Process        │
│          │               │ + Dependency chain     │ - Tools (dept)   │
│          │               │   at top               │ - Notes          │
└──────────┴───────────────┴────────────────────────┴──────────────────┘
```

### App Sidebar
- Same sidebar as rest of AoA
- Auto-collapses when entering workspace view
- Always accessible via hamburger/hover
- Contains all normal navigation (Home, Tasks, Agents, Departments, etc.)

### Left Panel — Department Task Navigator
Shows tasks from the current department/project that have workspaces.

For **isolated** workspaces (one task = one workspace):
Only tasks WITH workspaces shown (no "No Workspace" group):
```
▼ Needs Attention (1)
  ⚠ MET-148 Deploy fix
▼ Running (1)
  ● MET-150 Fix auth ←── selected
▼ Idle (2)
  ○ MET-151 Add tests
  ○ MET-152 Update docs
▶ Completed (8)
```

For **shared** workspaces (workflow with multiple tasks):
```
▼ Workflow: "Q2 Social" (shared workspace)
  ✓ Generate ideas
  → Select ideas (you) ●    ← current task
  ○ Generate images
```

Clicking a task loads its workspace context into center + right panels.

### Center Panel — Timeline + Preview

**Top:** Horizontal dependency chain (only shown when task has dependencies):
```
[✓ Concept] → [✓ Dialogue] → [→ Finalize] → [○ Images] → [○ Video]
```
Clicking a node switches timeline below to that task.

**Center-Left:** Chronological timeline of work:
- Runs as expandable blocks (latest expanded, older collapsed with one-line summary)
- Human comments/actions flow between runs like chat
- Human Input Points shown as review/approval moments
- Input area at bottom (send to agent or mark human task complete)

**Center-Right:** Mode-switchable panel (like vibe-kanban):
- Changes mode: shows diffs (for code) or version comparison
- Preview mode: shows artifact preview (code app, document, image, chart)
- Logs mode: shows process output
- Only one mode at a time. Toggle between them.

### Right Panel — Context Sections (Collapsible)

2026-05-25 update: the right panel now includes an **Outputs** section above Artifacts. Outputs is the task-level summary for artifacts, previews, runtime services, branches, and PRs. Artifacts remains the versioned deliverable section and is not removed.

**Universal sections (all departments):**
1. **Artifacts** — produced outputs with versions. Click to preview in center-right pane.
2. **Context** — dependency outputs (working now) + memory placeholder "coming soon" (until MCP memory skill built)
3. **Process** — task dependency chain status, agents involved, blockers/decisions needed
4. **Notes** — scratch space for annotations

**Department-specific section:**
5. **Tools** — varies by department type:
   - Software Dev: Git (branch, PR, commits) + Terminal
   - Other departments: initially empty, grows with integrations
   - Custom: user-configurable

---

## Workspace Types & Department Configuration

### Department Function Types (at creation)

`functionType` field on projects table. When creating a department, user picks from 10 options:

- **💻 Product (Software)** — auto-enables code workspaces (git worktree strategy), shows Local/GitHub/Both repo setup
- **📢 Marketing** — workspace enabled, no git strategy, optional working directory
- **💰 Finance** — workspace enabled, no git strategy, optional working directory
- **🎧 Support** — workspace enabled, no git strategy, optional working directory
- **👥 HR** — workspace enabled, no git strategy, optional working directory
- **⚖ Legal** — workspace enabled, no git strategy, optional working directory
- **🔬 Research** — workspace enabled, no git strategy, optional working directory
- **📊 Operations** — workspace enabled, no git strategy, optional working directory
- **📋 General** — workspace enabled, no git strategy, optional working directory
- **⚙ Custom** — workspace enabled, user configures everything manually

ALL departments get `executionWorkspacePolicy.enabled = true`. Only Software Dev gets `workspaceStrategy.type = "git_worktree"`. The workspace experience is universal — Tools section in right panel varies (Git+Terminal for Software Dev, empty for others initially).

`enableIsolatedWorkspaces` instance setting defaults to true.

### Isolated vs Shared Workspaces

Both modes needed in ALL departments:

| Department | Isolated (when) | Shared (when) |
|-----------|-----------------|---------------|
| Engineering | Feature branches (most common) | Related tasks on same codebase |
| Marketing | Competing variants, A/B tests | One campaign, sequential tasks |
| Finance | Different scenarios, different periods | Related analysis steps |
| Creative | Parallel explorations | Sequential production pipeline |
| Support | Every ticket (always) | N/A |

Default: **isolated for ALL departments**. Most tasks are independent. Shared only when explicitly configured via workflow template (`workspaceMode: "shared"`) or manual override. Override at workflow or task level.

### Workspace Creation

- **No "Create Workspace" button** — workspace auto-creates on first agent run (heartbeat)
- **One workspace per task** — multiple attempts = multiple runs in same workspace, not multiple workspaces
- Once created, workspace persists across runs until archived/cleaned

### Task Detail Panel (TaskSlideOver) — Two Modes

The task detail panel (Sheet, right side) has two modes:

**Mode 1 — Task Properties (default):** Existing task detail + workspace section showing status/branch/age. Click workspace row to enter Mode 2.

**Mode 2 — Workspace Chat:** Breadcrumb navigation back. Timeline of runs + comments (chat-like feel). "Open Workspace" button to full view. Input area: text + agent selector + Send (= comment + heartbeat wakeup). Agent hire approvals shown inline.

### Chat-Like Feel on Heartbeat Architecture

"Send" in workspace = creates comment on task + triggers `heartbeat.wakeup(agentId, { source: "on_demand" })`. Agent wakes, reads all comments as context, executes. Output streams via SSE/LiveEvents. UI looks like chat, backend is heartbeat. Preserves: cost tracking per run, approval gates, timer/automation triggers, dependency chains.

---

## How Agent Chaining Works

Already implemented in AoA via heartbeat + dependencies:

1. Task A assigned to Agent 1, set to "todo"
2. Agent 1 wakes, executes Task A → status "done"
3. `resolveDependencies()` auto-finds dependent Task B
4. Checks if ALL of Task B's dependencies are "done"
5. If yes: Task B set to "todo", Agent 2 auto-woken with reason "dependency_unblocked"
6. Agent 2 receives Task A's outputs as context via dependency output packaging
7. Chain continues automatically

**Requirements:** Agents must be pre-assigned to tasks. Workflow templates create tasks + dependencies but don't auto-assign agents.

**Agents cannot spawn other agents.** All task creation and agent assignment is via workflow templates, manual setup, or discussion extraction.

---

## Human Input Points

Implemented via **Approach A: separate tasks with dependencies** (works today).

Example: "Agent generates 30 ideas → human selects 10 → agent generates images"

```
Task A: "Generate ideas" (agent) → produces artifact with 30 ideas → done
Task B: "Select ideas" (human) → marks selected → done
Task C: "Generate images" (agent) → reads selected from artifact → produces images
Dependencies: A blocks B, B blocks C. Auto-chains when each completes.
```

In the workspace UI, the dependency chain at top and the chronological timeline in center make this FEEL like one continuous flow, even though it's separate tasks.

---

## Runs Display (Center Panel)

Mixed approach — runs as expandable blocks, comments as inline chat:

```
Run 1 · Claude Code · 2h ago                    ← collapsed
▶ "Fixed auth middleware, 3 files changed"         one-line summary

─── You commented · 1h ago ────────────────────  ← inline chat-style
"Scene 3 needs darker lighting"

Run 2 · Claude Code · running                    ← expanded (latest)
┌──────────────────────────────────────────────┐
│ Agent: Regenerating scene 3...               │   live streaming
│ ● Running                                    │
└──────────────────────────────────────────────┘
```

---

## Task Detail (TaskSlideOver)

Universal across all departments. Shows:
- Properties (status, priority, assignee, labels, project, dates)
- **Workspace section** (only for workspace-enabled tasks):
  - Workspace status, branch name (if code), age
  - "Open Workspace" button → navigates to full workspace route
- Recent runs (collapsed, summary view)
- Artifacts
- Dependencies
- Comments

TaskSlideOver needs to be wired into ProjectDetail (currently only works in global Issues page).

---

## Commander Agent

Separate from workspace system entirely. Implemented as a sidebar nav item + dedicated page. See `CLAUDE.md` §Commander (Internal Agent) for implementation details.

---

## Discussions & External Input

Discussions happen OUTSIDE workspaces via MCP integrations:
- Meeting transcriptions (Zoom, Google Meet via MCP)
- Chat tool conversations (Slack, etc.)
- Direct MCP push from any tool

Flow: External input → Discussion → Extraction → Tasks + Memory → Workspace (for execution)

Workspace is for executing tasks, not capturing input.

---

## Decision Tracking

AoA already tracks decisions via memory system:
- Memory items with `category: "decision"`, scoped to department/project/goal
- Discussion extraction captures decisions
- Memory feedback patterns detect repeated corrections (3+ times → suggest memory item)
- Suggestions engine surfaces gaps

In workspace right panel, the "Context" section surfaces relevant decisions from memory.

Future enhancement: auto-capture decisions from human choices in workspace (approvals, selections).

---

## Existing Systems & What Changes

### Keep as-is:
- Heartbeat system (agent execution)
- Task dependencies (blocking + auto-unblock)
- Workflow templates (task chain creation)
- Memory system (4 layers)
- Discussion → extraction → tasks pipeline
- Artifact versioning
- Approval flows
- Company portability (import/export)

### Keep for now, consolidate later:
- LiveRunWidget (in task detail) — keep alongside workspace view
- ActiveAgents page — keep, links to workspaces later
- AgentDetail runs tab — keep (agent-centric view, different from workspace task-centric view)

### New (to build):
- Universal workspace view (multi-panel layout)
- Workspace backend (ported from Paperclip — files already copied, prompt written)
- Department function picker at creation
- TaskSlideOver workspace section
- TaskSlideOver wiring into ProjectDetail
- Left panel task navigator
- Center panel timeline with dependency chain
- Right panel with universal + department-specific sections
- "Workspaces" tab in ProjectDetail for departments

---

## Backend Status

**Completed (verified 2026-04-03):**
- 14 files ported from Paperclip → AoA and fully wired
- Migration 0050 applied (execution_workspaces, workspace_runtime_services, workspace_operations)
- Heartbeat fully integrated with workspace realization, runtime services, cleanup
- Routes registered in app.ts
- All services operational: workspace-runtime.ts, execution-workspace-policy.ts, workspace-operations.ts

**Remaining backend (Phase 1):**
- Add `functionType` field to projects schema
- Add `workspaceMode` field to workflow_templates schema
- Change `enableIsolatedWorkspaces` default to true
- Auto-configure executionWorkspacePolicy on department creation based on functionType

---

## Plugin System Status

Decided: **Hybrid approach, evaluate later.**
- MCP for agent-side tool use (already exists)
- Paperclip's full plugin system (19 services) evaluated later for: webhooks, background jobs, scheduled sync, external integrations
- NOT ruled out — just deferred

---

## Department Templates

Templates = user-configurable department setup, NOT imported packages.

When creating a department:
1. User picks function type from 10 options (Product Software / Marketing / Finance / Support / HR / Legal / Research / Operations / General / Custom)
2. Function type auto-configures executionWorkspacePolicy (all enabled, isolated default, git_worktree only for Software)
3. User can customize workspace mode (Isolated/Shared) during creation
4. User customizes everything else themselves (agents, workflows, memory) after creation

Import/export of department configurations can be added later as convenience feature using existing company-portability infrastructure.

---

## References

- Vibe-kanban codebase studied for UX patterns (at `Paperclip-AoA/vibe-kanban-main/`)
- Paperclip codebase as source for workspace backend (at `Paperclip-AoA/paperclip-master/`)
- Backend wiring prompt: `Paperclip-AoA/workspace-port-prompt.md`
