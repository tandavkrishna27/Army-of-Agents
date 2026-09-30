# localStorage Stale-FK Audit

## Method

Searched `ui/src/**/*.{ts,tsx}` for `localStorage.getItem`. Filtered to callsites
where the rehydrated value is used as an entity id (assigneeId, projectId,
agentId, taskId, etc.) in either a request body or a query argument. Test files
(`__tests__/`) and the storage-migration helpers (`lib/storage-migration.ts`,
`lib/storage-migrations.ts`) are excluded — those files read old keys only to
migrate them, not to consume the value as an FK.

**Total `localStorage.getItem` callsites scanned:** 27 (across 14 production files)  
**Test / migration helper callsites excluded:** 18  
**Id-shaped suspects evaluated:** 6  
**Confirmed suspects in final table:** 5

---

## Findings

| File:Line | Hydrated key | Used as | Risk | Mitigation |
|---|---|---|---|---|
| `ui/src/components/NewIssueDialog.tsx:143` | `aoa:issue-draft` | `assigneeId` (→ `assigneeAgentId`), `projectId` in POST `/issues` body | **Fixed** (commit `4e1d1d7`) | `pruneStaleId` helper + `useEffect` prunes after agents/projects load |
| `ui/src/lib/recent-assignees.ts:6` (consumed in `NewIssueDialog.tsx:542`, `IssueProperties.tsx:187`, `Routines.tsx:162`, `RoutineDetail.tsx:626`) | `aoa:recent-assignees` | Agent IDs used to sort the assignee picker dropdown | **Low** | Stale IDs fall through `sortAgentsByRecency` as unknown → they simply don't move any live agent to the top; no server request is made with the stale ID itself |
| `ui/src/components/IssuesList.tsx:68` | `aoa:issues-view:<companyId>` (e.g. `aoa.issues-view.tasks`) | `assignees[]` (agent IDs), `labels[]` (label IDs) stored in view-filter state | **Medium** | Stale IDs cause the filter to show zero results (silent empty state); no server write. `assignees` filter is applied client-side in `applyFilters` — it never reaches the API. No mitigation exists yet. |
| `ui/src/context/CompanyContext.tsx:42,68` | `aoa.selectedCompanyId` | Company ID used to auto-select active company on load | **Low** | Line 69 validates the stored ID against the live companies list: `if (stored && selectableCompanies.some((c) => c.id === stored)) return;`. If the ID is stale the block is skipped and the first available company is auto-selected. Self-healing by design. |
| `ui/src/hooks/useCompanyPageMemory.ts:11` | `aoa.companyPaths` | Company IDs as keys in a `Record<companyId, lastPath>` — not sent to server | **Low** | Stale keys are orphaned map entries; they are never looked up unless that company is re-selected, in which case the fallback is `/home`. No server impact. |

### Callsites evaluated and ruled safe

| File:Line | Hydrated key | Why safe |
|---|---|---|
| `ui/src/context/SidebarContext.tsx:25` | `aoa:sidebar-collapsed` | Boolean flag — `"true"` / `"false"` |
| `ui/src/context/AgentPanelContext.tsx:25` | `aoa:agent-panel-open` | Boolean flag |
| `ui/src/pages/Agents.tsx:84` | `aoa.agents.liveActivityCollapsed` | Boolean flag |
| `ui/src/components/workspace/OpenInIdeButton.tsx:29` | `aoa:workspace:preferred-editor` | Enum string — `"vscode"` / `"cursor"` / `"zed"` |
| `ui/src/components/workspace/WorkspaceRightPanel.tsx:36` | `aoa:workspace:section:<name>` | Boolean flag (section expanded/collapsed) |
| `ui/src/components/workspace/useSidebarCollapsed.ts:9` | `aoa:workspace:<id>:sidebar-<side>-collapsed` | Boolean flag; workspace ID is in the *key* name, not the value |
| `ui/src/components/workspace/FileTree.tsx:113` | `aoa:workspace:filetree-collapsed:<id>` | JSON array of folder *paths* (strings), not entity IDs |
| `ui/src/components/workspace/sections/NotesSection.tsx:15,37` | `aoa:workspace:notes:<id>` | Free-text notes; workspace ID in key name, value is plain text |
| `ui/src/components/CommentThread.tsx:63` | `aoa:issue-comment-draft:<id>` | Draft body text; issue ID is in the key name, value is comment text |
| `ui/src/lib/project-order.ts:29` | `aoa.projectOrder:<companyId>:<userId>` | Ordered project-ID array used only to sort the sidebar list — never sent to server. Stale IDs are silently skipped in `sortProjectsByStoredOrder` (line 62: `byId.get(id)` returns undefined, continues). |
| `ui/src/hooks/useInboxBadge.ts:12,35` | `aoa:inbox:dismissed` / `aoa:inbox:dismissed:migrated` | Notification-ID strings used for local dismiss tracking / one-shot migration flag; not FKs sent to server |

---

## Risk summary

| Risk | Count | Sites |
|---|---|---|
| Fixed | 1 | `NewIssueDialog` draft (`assigneeId` + `projectId`) |
| High | 0 | — |
| Medium | 1 | `IssuesList` view-filter state (`assignees[]`, `labels[]`) |
| Low | 3 | `recent-assignees` sort order, `selectedCompanyId` (self-healing), `companyPaths` (orphaned key) |
| Safe | 11 | All other callsites |

**Highest-risk open site:** `ui/src/components/IssuesList.tsx:68`  
Rehydrates `assignees[]` (agent UUIDs) and `labels[]` (label UUIDs) from
`aoa.issues-view.*` into the active filter state. If those agents or labels
were deleted since the view state was saved, the filter silently produces zero
results and there is no visual indication that the filter is stale. No server
write is involved, so data loss is not possible — hence Medium, not High.

---

## Recommended next steps

### Medium: IssuesList stale assignee / label filter

Open a separate task:

1. After the agents query resolves, run `pruneStaleId` (or an equivalent `pruneStaleIds` variant for arrays) across `viewState.assignees`.
2. After the labels query resolves, similarly prune `viewState.labels`.
3. Optionally: display a toast "1 filter removed (agent deleted)" so the founder knows why results changed.
4. Add a unit test mirroring `issueDraft.test.ts` for the `IssuesList` filter-pruning path.

### Pattern to watch in new dialogs

- Any dialog that persists a draft with entity-id fields → add a `useEffect` that calls `pruneStaleId` after the relevant query resolves (copy the pattern from `NewIssueDialog.tsx:406-413`).
- Any list-filter widget that stores selected entity IDs → prune on query completion (same pattern, array variant).

### Future sprint: filter state with selected entity IDs

Audit the following filter-state callsites when the filter system is extended:
- Department / project pickers in the `Tasks` page sidebar (if persisted)
- Goal-scoped task filters
- Any "assigned to me" saved view

These were not present as stored FK consumers in the current codebase but are
natural extension points that could introduce the pattern.

---

## Patterns to keep watching

- New dialogs that persist drafts → add pruning as part of the dialog template.
- Filter state with selected entity IDs (e.g. "assigned to X" picker) — audit
  in the next sprint if filter state is persisted.
- `recent-assignees` list grows unbounded across DB nukes; a light prune (keep
  only IDs that still appear in the agents list) would clean it up, though the
  failure mode is cosmetic-only.
