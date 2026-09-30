# Artifact UI — TaskSlideOver Integration

**Date:** 2026-03-21
**Session:** V2 Phase 2, Session 5
**Branch:** v2-phase-2

## Summary

Add artifact display and version management to TaskSlideOver as a 4th tab ("Artifacts") alongside Comments, Sub-tasks, and Activity. Includes version history browsing, new version upload (file or text), and input artifacts from upstream dependencies (Decision #71).

## Motivation

Session 4 built the full artifact backend (schema, service, routes, validators). The UI needs to surface this data so founders can:
- See what deliverable is linked to a task
- Browse version history (immutable versions per Decision #43/#45)
- Upload new versions directly (refinement loop per Decision #70)
- See input artifacts flowing from dependency tasks (artifact-as-input per Decision #71)

## Design

### API Client — `ui/src/api/artifacts.ts`

New file following existing pattern (`issuesApi`, `goalsApi`):

```ts
export const artifactsApi = {
  getByIssueId: (issueId: string) =>
    api.get<ArtifactWithVersions | null>(`/issues/${issueId}/artifacts`),

  get: (id: string) =>
    api.get<ArtifactWithVersions>(`/artifacts/${id}`),

  addVersion: (artifactId: string, data: CreateArtifactVersion) =>
    api.post<ArtifactVersion>(`/artifacts/${artifactId}/versions`, data),
};
```

No `list` or `create` — artifacts are accessed through tasks. Creation happens via brief pipeline or future flows.

**Note:** `getByIssueId` returns `null` (not 404) when no artifact is linked. The backend `res.json(artifact)` sends a JSON `null` body. The query hook must handle `data === null` as the empty state, not as an error.

### Query Keys — `ui/src/lib/queryKeys.ts`

```ts
artifacts: {
  byIssue: (issueId: string) => ["artifacts", "issue", issueId] as const,
  detail: (id: string) => ["artifacts", "detail", id] as const,
},
```

### Tab Addition

Add "Artifacts" as 4th tab in the existing `TabsList variant="line"` in TaskSlideOver.tsx:

```
Comments | Sub-tasks | Activity | Artifacts
```

Icon: `FileBox` from lucide-react.

### Tab Content

**Empty state (no linked artifact):**
"No artifact linked to this task."

**With linked artifact:**

1. **Artifact header**: Title, type badge (document/code/etc.), status badge (draft/active/archived), current version number, latest source badge (agent/founder/mcp/teammate/external)
2. **Latest version changelog**: If present, shown as muted text below header
3. **"Add Version" button**: Expands inline form (not a dialog)
4. **Version history list**: Newest first, each row shows version number, source badge, changelog excerpt, relative timestamp. Capped at 5 with "Show all" toggle.
5. **Input Artifacts subsection** (conditional): Only rendered if upstream dependency tasks have linked artifacts. Shows artifact name, version, and links to the dependency task.

### Tab Value

Use `value="artifacts"` for the new tab trigger/content, consistent with existing tab values (`comments`, `subissues`, `activity`).

### Add Version Form

Inline expansion below the button:

- **Source** select: `founder` (default), `external`, `teammate`
- **Mode toggle**: File | Text
  - File: standard file input
  - Text: textarea for pasting content (code, specs, markdown)
- **Changelog**: optional single-line text input
- **parentVersionId**: auto-populated from `artifact.currentVersionId` (the latest version). Not exposed in UI — every new version branches from current. Sent in payload.
- **sourceDetail**: omitted from UI for founder uploads. Sent as `null`.
- Submit calls `POST /artifacts/:id/versions` using the existing `CreateArtifactVersion` type from `@armyofagents/shared`
- On success: invalidate `artifacts.byIssue` query, collapse form
- On error: show inline error message

Note: File upload stores the file URL. For V2 MVP, files are referenced by URL (not uploaded to blob storage). This matches the backend `fileUrl` field.

### Input Artifacts (Decision #71)

Uses the existing `upstreamDeps` data already fetched by TaskSlideOver. For each upstream dependency task, query `GET /issues/:depId/artifacts` using React Query's `useQueries` hook (dynamic parallel queries). All dependency artifact queries fire in parallel, only when the Artifacts tab is active. Results are deduplicated by artifact ID (two deps could reference the same artifact).

If the dependency has an artifact, display it as a read-only row:

```
[TaskIdentifier] → ArtifactName  v{N}
```

Clicking the task identifier navigates to that task's slide-over.

### Source Badges

Color-coded badges matching the `ARTIFACT_VERSION_SOURCES` constant:
- `agent` — blue
- `founder` — green
- `mcp` — purple
- `teammate` — amber
- `external` — gray

### Files Changed

| File | Change |
|------|--------|
| `ui/src/api/artifacts.ts` | **New** — API client (3 methods) |
| `ui/src/api/index.ts` | Add `artifactsApi` re-export |
| `ui/src/lib/queryKeys.ts` | Add `artifacts` key group |
| `packages/shared/src/types/artifact.ts` | Add `ArtifactWithVersions` composite type |
| `ui/src/components/TaskSlideOver.tsx` | Add Artifacts tab + tab content |

No new component files. Tab content is inline in TaskSlideOver following the pattern of other tabs.

## Types Needed

**New type** — add to `packages/shared/src/types/artifact.ts` and re-export from barrel:

```ts
// Composite type returned by getById / getByIssueId service methods
export interface ArtifactWithVersions extends Artifact {
  versions: ArtifactVersion[];
}
```

**Existing type** — reuse `CreateArtifactVersion` from `@armyofagents/shared` validators (already exported). Do NOT create a duplicate payload type.

### Version List

All versions are returned in the `ArtifactWithVersions.versions` array (fetched in one query by the service). The "Show all" toggle at 5 items is purely client-side slicing — no pagination needed.

## Decisions Referenced

- **#43, #45**: Artifact versions are immutable. Founder picks winner for branching.
- **#70**: Refinement loop — founder can add versions (not just approve/reject).
- **#71**: Artifact-as-input — downstream tasks receive artifacts from dependencies.

## Out of Scope

- Artifact creation UI (happens via brief pipeline)
- Linking/unlinking artifacts from tasks (future)
- Blob storage for file uploads (V2 uses URL references)
- Artifact editing (versions are immutable)
- Branch/merge visualization for version trees
