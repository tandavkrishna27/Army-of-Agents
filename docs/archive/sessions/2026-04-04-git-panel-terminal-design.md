# Session 11: Git Panel + Terminal for Software Development Workspaces

## Overview

Replace the placeholder Git and Terminal tools in the workspace right panel's ToolsSection with functional components. Git panel shows branch/repo/PR info from the already-fetched ExecutionWorkspace record. Terminal panel renders run stdout/stderr via xterm.js in read-only mode.

## Components

### GitPanel (`ui/src/components/workspace/tools/GitPanel.tsx`)

**Props:** `workspace: ExecutionWorkspace`

**Renders:**
- Branch name (`workspace.branchName`) with copy-to-clipboard icon button. Uses `navigator.clipboard.writeText()`. Brief "Copied!" tooltip on success.
- Base branch (`workspace.baseRef`) as a muted label, e.g. "from main".
- Repo URL (`workspace.repoUrl`) — rendered as a clickable external link with `ExternalLink` icon if URL starts with `http`. Plain text otherwise. Null = hidden.
- PR status: checks `workspace.metadata?.pr` (shape: `{ url: string; status: string; number: number }`). If present, renders a status badge (open/merged/closed with color) + link. If absent, renders "No PR created" muted text.
- "Create PR" button — disabled, with tooltip "Coming soon". Placeholder for future backend endpoint.

**No new API calls.** All data sourced from the `ExecutionWorkspace` object already fetched by the workspace view.

### TerminalPanel (`ui/src/components/workspace/tools/TerminalPanel.tsx`)

**Props:** `issueId: string, companyId: string`

**Behavior:**
1. Determine latest run: use `heartbeatsApi.liveRunsForIssue(issueId)` via React Query (already polled at 3s interval in the workspace view — reuse the same query key so no duplicate fetches). Pick the first run (most recent). Fall back to `activityApi.runsForIssue(issueId)` if no live runs, to get the latest completed run.
2. **Active run (status running/starting):** Poll `heartbeatsApi.events(runId, afterSeq)` every 2s. Filter events where `stream === "stdout" || stream === "stderr"`. Write each `event.message` to the xterm instance. Track `afterSeq` to avoid re-fetching old events.
3. **Completed run:** Fetch `heartbeatsApi.log(runId)` once. Write full `content` string to xterm. If `nextOffset` exists, fetch additional chunks until exhausted.
4. **No runs:** Show "No run output yet" placeholder text (not inside xterm — a simple div).
5. When the run changes (new runId), clear the xterm buffer (`terminal.clear()`) and re-fetch.

**xterm configuration:**
- `disableStdin: true` (read-only)
- `fontSize: 12`, `fontFamily: "monospace"`
- `theme: { background: "transparent" }` — inherits from the panel's dark background
- `convertEol: true` for proper line breaks
- `scrollback: 5000` lines
- FitAddon to auto-size to container width
- Container height: `h-[200px]` with xterm's own scrollbar

**Lifecycle:**
- Create Terminal instance on mount, attach to DOM ref
- Load FitAddon, call `fitAddon.fit()` on mount and on container resize (ResizeObserver)
- Dispose terminal on unmount
- Clean up polling intervals on unmount

### ToolsSection Updates (`ui/src/components/workspace/sections/ToolsSection.tsx`)

**New props:** Add `workspace: ExecutionWorkspace`, `issueId: string`, `companyId: string`.

**When `functionType === "software_development"`:**
- Render two collapsible sub-sections (using simple div + button toggle, not the outer Collapsible component):
  1. **Git** — `<GitPanel workspace={workspace} />`
  2. **Terminal** — `<TerminalPanel issueId={issueId} companyId={companyId} />`
- Each sub-section has a header row with icon + label + chevron toggle
- Both default to expanded

**When other functionType:** Keep existing "No tools configured" message.

### Data Flow Changes

`WorkspaceRightPanel` currently receives `workspaceId: string` and `functionType: string | null`. Changes:
- Add `workspace: ExecutionWorkspace` prop (replacing or supplementing `workspaceId`)
- Pass `workspace`, `issueId`, `companyId` down to `ToolsSection`

`WorkspaceLayout` already has `workspace: ExecutionWorkspace` — just pass it through to `WorkspaceRightPanel`.

## Dependency

```bash
cd ui && pnpm add @xterm/xterm
```

The `@xterm/xterm` package includes TypeScript types. CSS import: `import "@xterm/xterm/css/xterm.css"` in TerminalPanel.

## Tests

### GitPanel.test.tsx (`ui/src/__tests__/GitPanel.test.tsx`)
- Renders branch name, base ref, repo URL when all present
- Copy button calls `navigator.clipboard.writeText` with branch name
- Renders "No PR created" when `metadata.pr` is absent
- Renders PR badge + link when `metadata.pr` is present
- Hides repo URL row when `repoUrl` is null

### TerminalPanel.test.tsx (`ui/src/__tests__/TerminalPanel.test.tsx`)
- Mock xterm's Terminal class (constructor, open, write, clear, dispose, loadAddon)
- Mock heartbeatsApi and activityApi
- Shows "No run output yet" when no runs exist
- Creates xterm instance and writes log content for completed run
- Cleans up terminal on unmount

## Files Changed

| File | Action |
|------|--------|
| `ui/src/components/workspace/tools/GitPanel.tsx` | **New** |
| `ui/src/components/workspace/tools/TerminalPanel.tsx` | **New** |
| `ui/src/components/workspace/sections/ToolsSection.tsx` | **Modify** — replace placeholders with real panels |
| `ui/src/components/workspace/WorkspaceRightPanel.tsx` | **Modify** — pass workspace + issueId + companyId to ToolsSection |
| `ui/src/components/workspace/WorkspaceLayout.tsx` | **Modify** — pass workspace to WorkspaceRightPanel |
| `ui/src/__tests__/GitPanel.test.tsx` | **New** |
| `ui/src/__tests__/TerminalPanel.test.tsx` | **New** |

## Out of Scope

- Interactive terminal (shell access) — this is read-only output display only
- Git operations (push, pull, commit) — future phase
- Create PR backend endpoint — button is a disabled placeholder
- Diff viewer — separate Phase 4 session
- Dev server preview — separate Phase 4 session
