# Diff Viewer & Dev Server Preview Design

**Session:** 12 — Software Dev Tools (Phase 4)
**Date:** 2026-04-04
**Status:** Draft

## Overview

Replace the "coming in Phase 4" placeholder in the workspace Changes view with a file-level change summary, and enhance Preview mode to show an iframe for running dev servers. Both features are gated to `functionType === "software_development"` departments.

## 1. Changes View (File-Level Change Summary)

### Data Source

Heartbeat runs store `detectedOutputs: DetectedOutput[] | null` — an array of up to 20 file entries, each with:

```typescript
interface DetectedOutput {
  path: string;           // e.g. "src/components/Button.tsx"
  filename: string;       // e.g. "Button.tsx"
  byteSize: number;
  contentType: string;    // MIME type
  assetId: string | null;
  sha256: string | null;
  source: "git_diff" | "workspace_scan" | "adapter_provided";
  label?: string | null;
  artifactType?: string | null;
  status: "pending" | "confirmed" | "rejected";
  confirmedArtifactId?: string | null;
  confirmedVersionId?: string | null;
}
```

This is file metadata only — no actual diff content (no before/after lines). The Changes view displays a file-level summary, not inline diffs.

### Backend Change

The existing `GET /issues/:issueId/runs` endpoint returns `RunForIssue[]`. Currently it selects a subset of columns from `heartbeat_runs`. Add `detectedOutputs` to the SELECT list so the frontend has access.

**File:** The route handler that serves `/issues/:issueId/runs` (in the heartbeats or activity routes).

**Type change in `ui/src/api/activity.ts`:**
```typescript
export interface RunForIssue {
  // ...existing fields...
  detectedOutputs: DetectedOutput[] | null; // ADD
}
```

### UI Component: `ChangesView`

Replaces the placeholder in `WorkspacePreviewPanel.tsx`.

**Props:** `issueId: string`, `functionType: string | null`

**Behavior:**
1. If `functionType !== "software_development"` → render: "No code changes to display"
2. Fetch runs via `activityApi.runsForIssue(issueId)` (query enabled when Changes mode active)
3. If no runs → render: "No runs yet"
4. Run selector at top (dropdown or pill buttons, same pattern as LogsView). Defaults to latest run.
5. For selected run, read `detectedOutputs`:
   - If null or empty → render: "No changes detected in this run"
   - Otherwise → render file list

**File list row:**
- File icon (based on extension or contentType)
- File path (truncated with full path on hover via `title` attr)
- Source badge: `git_diff` → "Modified" (green), `workspace_scan` → "Detected" (blue), `adapter_provided` → "Provided" (purple)
- File size formatted (e.g. "2.1 KB")
- Summary footer: "N files changed in this run"

### Props Threading

`WorkspacePreviewPanel` needs `functionType` passed down. `WorkspaceLayout` already has access to `project?.functionType`. Add it as a prop.

## 2. Dev Server Preview

### New Backend Endpoint

`GET /execution-workspaces/:id/runtime-services`

Returns all `workspace_runtime_services` rows for the given execution workspace.

```typescript
// Response shape (from workspace_runtime_services table)
interface WorkspaceRuntimeService {
  id: string;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  port: number | null;
  url: string | null;
  command: string | null;
  cwd: string | null;
  provider: "local_process" | "adapter_managed";
  lifecycle: "shared" | "ephemeral";
  startedAt: string | null;
  stoppedAt: string | null;
}
```

**Route file:** `server/src/routes/execution-workspaces.ts`
**Auth:** Same company access check as existing workspace endpoints.

### New API Client

In `ui/src/api/execution-workspaces.ts`:
```typescript
runtimeServices: (workspaceId: string) =>
  api.get<WorkspaceRuntimeService[]>(
    `/execution-workspaces/${workspaceId}/runtime-services`
  ),
```

### UI Enhancement: PreviewView

Current PreviewView shows artifacts. Enhance it to check for running dev servers first.

**Additional props:** `workspaceId: string | null`, `functionType: string | null`

**Behavior:**
1. If `functionType === "software_development"` and `workspaceId` is provided:
   - Query `executionWorkspacesApi.runtimeServices(workspaceId)`
   - Find first service with `status === "running"` and a non-null `url`
   - If found → render dev server iframe view
   - If not found → render: "No dev server running. Dev servers start automatically during agent runs."
2. Fall through to existing artifact preview behavior for non-software departments or when no workspace.

**Dev server iframe view:**
- Toolbar: read-only URL display + refresh button
- Full-height iframe pointing to the running service URL
- Note: iframe wraps in ScrollArea should be removed for this case (iframe manages its own scroll)

### Props Threading

`WorkspacePreviewPanel` needs `workspaceId` in addition to `functionType`. Both passed from `WorkspaceLayout`.

## 3. Component Changes Summary

### WorkspaceLayout.tsx
- Pass `functionType={project?.functionType ?? null}` to `WorkspacePreviewPanel`
- Pass `workspaceId={workspace.id}` to `WorkspacePreviewPanel`

### WorkspacePreviewPanel.tsx
- Add `functionType` and `workspaceId` to `WorkspacePreviewPanelProps`
- Replace `ChangesView` placeholder with full implementation
- Enhance `PreviewView` with dev server iframe logic
- Add runtime services query

### activity.ts (API client)
- Add `detectedOutputs: DetectedOutput[] | null` to `RunForIssue`
- Import `DetectedOutput` from shared types

### execution-workspaces.ts (API client)
- Add `runtimeServices(workspaceId)` method
- Add `WorkspaceRuntimeService` interface

### execution-workspaces.ts (server route)
- Add `GET /:id/runtime-services` endpoint

### Backend runs route
- Add `detectedOutputs` to the SELECT in the runs-for-issue query

## 4. Not In Scope

- **`@git-diff-view/react` library** — not needed for file-level summary. Install when implementing actual line-by-line diffs.
- **Real git diffs** — would require server-side `git diff` execution in workspace directories. Future enhancement.
- **Device emulation toggle** — mentioned in the plan but deferred. The iframe is sufficient for now.
- **File click-through** — files in the Changes list are display-only. No drill-down to content.

## 5. Testing

Test file: `ui/src/components/workspace/__tests__/WorkspacePreviewPanel.test.tsx`

1. **Changes mode renders file list for code workspaces** — Mock `activityApi.runsForIssue` returning runs with `detectedOutputs` containing 3 files. Verify file rows render with paths, source badges, sizes.

2. **Changes mode shows "no changes" for non-code workspaces** — Set `functionType="marketing"`. Verify "No code changes to display" message renders.

3. **Preview mode shows iframe when dev server URL available** — Mock `executionWorkspacesApi.runtimeServices` returning a service with `status: "running"` and `url: "http://localhost:3000"`. Verify iframe renders with correct `src`.

4. **Preview mode shows "no dev server" when none running** — Mock runtime services returning empty array or all stopped services. Verify "No dev server running" message.

## 6. Files Changed

| File | Type | Description |
|------|------|-------------|
| `server/src/routes/execution-workspaces.ts` | Edit | Add runtime-services GET endpoint |
| `server/src/routes/heartbeats.ts` (or activity route) | Edit | Add detectedOutputs to runs query |
| `ui/src/api/activity.ts` | Edit | Add detectedOutputs to RunForIssue type |
| `ui/src/api/execution-workspaces.ts` | Edit | Add runtimeServices() + type |
| `ui/src/components/workspace/WorkspaceLayout.tsx` | Edit | Pass functionType + workspaceId to PreviewPanel |
| `ui/src/components/workspace/WorkspacePreviewPanel.tsx` | Edit | Replace ChangesView, enhance PreviewView |
| `ui/src/components/workspace/__tests__/WorkspacePreviewPanel.test.tsx` | New | 4 test cases |
