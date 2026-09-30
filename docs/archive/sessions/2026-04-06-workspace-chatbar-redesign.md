# Workspace Chatbar Redesign

## Problem

The current workspace chatbar in `WorkspaceTimeline.tsx` has several issues:

1. **Agent selector dropdown** — lets users pick any active agent, but makes no sense since a task's assigned agent is the only one with context. Removed.
2. **Scrolling bug** — the input area scrolls with the timeline instead of being fixed at the bottom.
3. **Disconnected layout** — textarea and controls row are separate visual elements, not a cohesive input widget.
4. **No status information** — no visibility into adapter/model, token usage, or agent task progress from the chatbar.

## Design

Three-row unified input widget, fixed to the bottom of the timeline panel, wrapped in a single bordered container.

```
 ┌ 🟣 Claude ── 3 files +120 -45 ────────────── 🍩 📋 ┐  ← status row
 ├───────────────────────────────────────────────────────┤
 │  Message Claude...                                    │  ← auto-grow input
 │                                                       │
 ├───────────────────────────────────────────────────────┤
 │ 📎  Opus ▾                                      Send │  ← controls row
 └───────────────────────────────────────────────────────┘
```

### Status Row (top of widget)

| Position | Element | Behavior |
|----------|---------|----------|
| Left | Adapter icon + agent name | Read-only. Icon colored per provider (purple = Claude, green = OpenAI, blue = Gemini). Agent name from the task's `assigneeAgentId`. |
| Center-left | Diff stats badge | `3 files +120 -45`. Only visible when the latest run produced file changes. Uses existing `latestFileCount`/`latestTotalBytes` data. |
| Right corner | Context donut icon | Small donut/ring indicator. Shows token usage details on hover (tooltip: "42K / 200K tokens used"). Data source TBD — will need to aggregate from run token data. |
| Right corner | Todo icon | Click opens a popover showing agent's task progress list (similar to Vibe Kanban's "Tasks 3/5" with progress bar). Data source TBD — will need to parse from agent run output or subtask hierarchy. |

### Input Area (middle)

- Auto-growing `<textarea>` starting at 1 row, max 4 rows.
- Placeholder: `"Message {agentName}..."` using the assigned agent's name.
- `Cmd+Enter` (Mac) / `Ctrl+Enter` (Windows) to send.
- `resize-none` — height controlled by auto-grow only.

### Controls Row (bottom of widget)

| Position | Element | Behavior |
|----------|---------|----------|
| Left | Attach icon (📎) | AoA icon button. Future: opens artifact attachment flow. For now, disabled/placeholder. |
| Left (after attach) | Model dropdown | **API adapters only** (claude_api, openai_api, gemini_api): dropdown showing available models for that provider. Defaults to agent's configured model. **Per-message override** — selection resets to default after each send. Does NOT modify agent config. **Local adapters** (claude_local, opencode_local, cursor, etc.): show adapter name as a read-only label instead (model is controlled by the CLI tool, not overridable). |
| Right | Send button | Icon + "Send" text. Disabled when input is empty or send is pending. |

### Container Behavior

- **Single bordered container** wrapping all three rows — `border border-border rounded-lg`.
- **Fixed to bottom** of the timeline panel — `shrink-0`, parent chain must enforce `h-full overflow-hidden` to prevent scrolling.
- **No agent selector** — messages always go to the task's assigned agent (`assigneeAgentId`). No "No agent" state since workspaces only exist when an agent is executing.
- **Mark Complete removed** from chatbar — belongs in task header/actions area, not the chat input.

## Removals

1. **Agent selector dropdown** — removed entirely. The assigned agent is implicit.
2. **Mark Complete button** — moved out of chatbar. Should live in task header or context panel.
3. **`sendAgentId` state** — no longer needed. Always use `issue.assigneeAgentId`.

## Data Wiring (deferred)

These elements are part of the UI design but their data sources need separate investigation:

- **Context donut**: Needs token usage aggregation. Possible source: sum of `tokenUsage` from `internal_agent_runs` or heartbeat run data for the current task. Context limit depends on adapter/model.
- **Todo popover**: Needs agent task progress. Possible sources: (a) parse from structured agent run output if agents report todos, (b) count subtasks (child issues) of the current task, (c) new field on runs. To be determined.
- **Model dropdown options**: Need to know which models are available per adapter/provider. May need a static mapping or API endpoint.
- **Attach button**: Placeholder for now. Will connect to artifact attachment flow in future.

## Files to Modify

- `ui/src/components/workspace/WorkspaceTimeline.tsx` — primary changes: restructure input area, remove agent selector, add status row, auto-grow textarea
- `ui/src/components/workspace/WorkspaceLayout.tsx` — verify parent containers enforce `h-full overflow-hidden` to fix scroll bug
- New: `ui/src/components/workspace/ChatbarStatusRow.tsx` — status row component (adapter icon, diff stats, context donut, todo icon)
- New: `ui/src/components/workspace/ChatbarControls.tsx` — controls row component (attach, model dropdown, send)
- New: `ui/src/components/workspace/ContextDonut.tsx` — donut indicator with hover tooltip
- New: `ui/src/components/workspace/TodoPopover.tsx` — todo progress popover (click to open)

## Adapter Icon Mapping

| Adapter | Icon/Color |
|---------|-----------|
| claude_api, claude_local | Purple (Anthropic) |
| openai_api | Green (OpenAI) |
| gemini_api | Blue (Google) |
| opencode_local | Gray (generic terminal) |
| cursor | Cursor logo |
| codex_local | OpenAI green |
| Others | Gray generic robot |

## Model Dropdown — Available Models (static mapping)

For per-message override, show models available for the agent's adapter:

- **claude_api**: claude-sonnet-4-20250514, claude-opus-4-20250514, claude-haiku-4-5-20251001
- **openai_api**: gpt-4o, gpt-4o-mini, o1, o1-mini
- **gemini_api**: gemini-2.5-pro, gemini-2.5-flash

These can be hardcoded initially and moved to a config/API later.
