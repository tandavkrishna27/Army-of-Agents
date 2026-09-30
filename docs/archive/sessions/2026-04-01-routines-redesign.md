# Routines UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Routines list and detail pages to match the AoA design system (card grid, sticky save bar, collapsed add-trigger, rich trigger cards).

**Architecture:** Two-file UI-only change — `Routines.tsx` gets card grid + filter tabs, `RoutineDetail.tsx` gets a bordered definition card + sticky save bar + redesigned trigger/runs/activity tabs. A small `RoutineCard.tsx` component is extracted for the card grid. No backend changes.

**Tech Stack:** React, TailwindCSS, lucide-react, existing shadcn/ui components (`Badge`, `Button`, `Tabs`, `Select`, etc.), `describeSchedule` from `ScheduleEditor`, `timeAgo` from `../lib/timeAgo`

**Spec:** `docs/superpowers/specs/2026-04-01-routines-redesign-design.md`

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Create | `ui/src/components/RoutineCard.tsx` | Card component for the grid view |
| Modify | `ui/src/pages/Routines.tsx` | Filter tabs, view toggle, card grid, polished table |
| Modify | `ui/src/pages/RoutineDetail.tsx` | Definition card, sticky save bar, triggers tab, runs/activity polish |

---

## Task 1: Create RoutineCard component

**Files:**
- Create: `ui/src/components/RoutineCard.tsx`

This is a self-contained card that follows the AgentCard visual pattern. It receives all data as props and emits action callbacks.

- [ ] **Step 1: Create the file**

```tsx
// ui/src/components/RoutineCard.tsx
import { Clock3, MoreHorizontal, Play, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentIcon } from "./AgentIconPicker";
import { describeSchedule } from "./ScheduleEditor";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import type { RoutineListItem } from "@armyofagents/shared";
import type { Agent } from "@armyofagents/shared";

interface Project {
  id: string;
  name: string;
  color: string | null;
}

interface RoutineCardProps {
  routine: RoutineListItem;
  agentById: Map<string, Agent>;
  projectById: Map<string, Project>;
  isRunning: boolean;
  isStatusPending: boolean;
  hasLiveRun?: boolean;
  onNavigate: () => void;
  onRun: () => void;
  onToggleStatus: () => void;
  onArchive: () => void;
}

function lastRunLabel(status: string): string {
  const map: Record<string, string> = {
    issue_created: "issue created",
    completed: "completed",
    failed: "failed",
    skipped: "skipped",
    coalesced: "coalesced",
    received: "running",
  };
  return map[status] ?? status.replaceAll("_", " ");
}

function lastRunColor(status: string): string {
  if (status === "issue_created" || status === "completed") return "text-emerald-400";
  if (status === "failed") return "text-destructive";
  if (status === "received") return "text-blue-400";
  return "text-muted-foreground";
}

export function RoutineCard({
  routine,
  agentById,
  projectById,
  isRunning,
  isStatusPending,
  hasLiveRun = false,
  onNavigate,
  onRun,
  onToggleStatus,
  onArchive,
}: RoutineCardProps) {
  const enabled = routine.status === "active";
  const isArchived = routine.status === "archived";
  const agent = routine.assigneeAgentId ? agentById.get(routine.assigneeAgentId) : undefined;
  const project = routine.projectId ? projectById.get(routine.projectId) : undefined;

  // Pick first schedule trigger's cron expression for display
  const scheduleTrigger = routine.triggers?.find((t) => t.kind === "schedule");
  const triggerCount = routine.triggers?.length ?? 0;

  return (
    <div
      className={cn(
        "group relative border bg-card rounded-lg p-4 cursor-pointer transition-all",
        hasLiveRun
          ? "border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.06)]"
          : "border-border hover:border-border/80",
      )}
      onClick={onNavigate}
    >
      {/* Header row: icon + title + toggle */}
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent">
          <Repeat className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{routine.title}</p>
        </div>
        {/* Toggle — stop propagation so click doesn't navigate */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? `Pause ${routine.title}` : `Enable ${routine.title}`}
          disabled={isStatusPending || isArchived}
          className={cn(
            "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
            enabled ? "bg-emerald-500" : "bg-muted",
            (isStatusPending || isArchived) && "cursor-not-allowed opacity-50",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStatus();
          }}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
              enabled ? "translate-x-4.5" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      {/* Metadata row */}
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        {project ? (
          <>
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project.color ?? "#64748b" }}
            />
            <span className="truncate">{project.name}</span>
          </>
        ) : (
          <span>No project</span>
        )}
        {agent ? (
          <>
            <span className="text-border">·</span>
            <AgentIcon icon={agent.icon} className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{agent.name}</span>
          </>
        ) : null}
      </div>

      {/* Schedule line */}
      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock3 className="h-3 w-3 shrink-0" />
        {triggerCount === 0 ? (
          <span className="italic">No triggers</span>
        ) : scheduleTrigger?.cronExpression ? (
          <span>{describeSchedule(scheduleTrigger.cronExpression)}</span>
        ) : triggerCount === 1 ? (
          <span>{routine.triggers![0].kind} trigger</span>
        ) : (
          <span>{triggerCount} triggers</span>
        )}
      </div>

      {/* Last run line */}
      <div className="mt-1 text-xs text-muted-foreground">
        {routine.lastRun ? (
          <>
            <span>Last: {timeAgo(routine.lastRun.triggeredAt)}</span>
            <span className="mx-1 text-border">·</span>
            <span className={lastRunColor(routine.lastRun.status)}>
              {lastRunLabel(routine.lastRun.status)}
            </span>
          </>
        ) : (
          <span className="italic">Never run</span>
        )}
      </div>

      {/* Hover footer */}
      <div className="mt-3 border-t border-border/50 pt-2.5 opacity-0 transition-opacity group-hover:opacity-100 flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={isRunning || isArchived}
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
        >
          <Play className="mr-1 h-3 w-3" />
          {isRunning ? "Running..." : "Run now"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onNavigate(); }}>
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isStatusPending || isArchived}
              onClick={(e) => { e.stopPropagation(); onToggleStatus(); }}
            >
              {enabled ? "Pause" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isStatusPending}
              onClick={(e) => { e.stopPropagation(); onArchive(); }}
            >
              {isArchived ? "Restore" : "Archive"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify file compiles (no TS errors)**

Run: `cd "C:\Users\TK\OneDrive\Desktop\Claude Data\AoA-AoA\AoA-2.5" && pnpm --filter ui tsc --noEmit 2>&1 | head -30`

Expected: Zero errors (or only pre-existing errors unrelated to this file).

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/RoutineCard.tsx
git commit -m "feat: add RoutineCard component for grid view"
```

---

## Task 2: Redesign Routines list page

**Files:**
- Modify: `ui/src/pages/Routines.tsx`

Replace the plain table view with: filter tabs + view toggle + card grid (default) + polished table (list view) + EmptyState.

**What changes in `Routines.tsx`:**
1. Add `filterTab` state (`"all" | "active" | "paused" | "archived"`)
2. Add `viewMode` state (`"grid" | "list"`)
3. Add `RoutineCard` import + `LayoutGrid`/`List` icon imports
4. Add `describeSchedule` import (for card, already used in RoutineCard)
5. Replace the header to include filter tabs + view toggle
6. Add `filteredRoutines` derived value
7. Replace the `<div>` with table with `{viewMode === "grid" ? <grid> : <table>}`
8. Update empty state to use the spec's message

**Key filter logic:**
```ts
function matchesFilterTab(status: string, tab: "all" | "active" | "paused" | "archived"): boolean {
  if (tab === "all") return status !== "archived";
  return status === tab;
}
```
(Note: "All" tab hides archived items; "Archived" tab shows only archived.)

- [ ] **Step 1: Add new state + imports to Routines.tsx**

At the top of `Routines.tsx`, update the imports block. The existing imports are:
```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { ChevronDown, ChevronRight, MoreHorizontal, Play, Plus, Repeat } from "lucide-react";
```

Replace with:
```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { ChevronDown, ChevronRight, LayoutGrid, List, MoreHorizontal, Play, Plus, Repeat } from "lucide-react";
import { RoutineCard } from "../components/RoutineCard";
```

Then after the existing `useState` declarations inside `Routines()` (after `const [advancedOpen, setAdvancedOpen] = useState(false);`), add:
```tsx
const [filterTab, setFilterTab] = useState<"all" | "active" | "paused" | "archived">("all");
const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
```

- [ ] **Step 2: Add filteredRoutines derived value**

Inside `Routines()`, after the `projectById` useMemo, add:
```tsx
const filteredRoutines = useMemo(() => {
  return (routines ?? []).filter((r) => {
    if (filterTab === "all") return r.status !== "archived";
    return r.status === filterTab;
  });
}, [routines, filterTab]);
```

- [ ] **Step 3: Replace the header JSX**

Find the existing header `<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">` block (lines ~230–244 in Routines.tsx) and replace it with:

```tsx
{/* Page header */}
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div className="space-y-0.5">
    <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
      Routines
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">Beta</span>
    </h1>
    <p className="text-sm text-muted-foreground">
      {(routines ?? []).length} {(routines ?? []).length === 1 ? "routine" : "routines"}
    </p>
  </div>
  <Button onClick={() => setComposerOpen(true)}>
    <Plus className="mr-2 h-4 w-4" />
    Create routine
  </Button>
</div>

{/* Filter tabs + view toggle */}
<div className="flex items-center justify-between gap-3">
  <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
    {(["all", "active", "paused", "archived"] as const).map((tab) => (
      <button
        key={tab}
        type="button"
        onClick={() => setFilterTab(tab)}
        className={`rounded-md px-3 py-1 text-sm font-medium transition-colors capitalize ${
          filterTab === tab
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        {tab}
      </button>
    ))}
  </div>
  <div className="flex items-center gap-1 rounded-lg border border-border p-1">
    <button
      type="button"
      onClick={() => setViewMode("grid")}
      className={`rounded p-1.5 transition-colors ${
        viewMode === "grid" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
      aria-label="Grid view"
    >
      <LayoutGrid className="h-4 w-4" />
    </button>
    <button
      type="button"
      onClick={() => setViewMode("list")}
      className={`rounded p-1.5 transition-colors ${
        viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
      aria-label="List view"
    >
      <List className="h-4 w-4" />
    </button>
  </div>
</div>
```

- [ ] **Step 4: Replace the routines list JSX**

Find the `<div>` that starts at `{(routines ?? []).length === 0 ? (` and replace everything from that point to the end of the component's return (just before the final `</div>`) with:

```tsx
{/* Empty state */}
{filteredRoutines.length === 0 ? (
  <div className="py-12">
    <EmptyState
      icon={Repeat}
      message={filterTab === "all" ? "No routines yet" : `No ${filterTab} routines`}
      description={
        filterTab === "all"
          ? "Create your first routine to automate recurring work."
          : undefined
      }
      action={
        filterTab === "all" ? (
          <Button onClick={() => setComposerOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create routine
          </Button>
        ) : undefined
      }
    />
  </div>
) : viewMode === "grid" ? (
  /* Card grid view */
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {filteredRoutines.map((routine) => (
      <RoutineCard
        key={routine.id}
        routine={routine}
        agentById={agentById}
        projectById={projectById}
        isRunning={runningRoutineId === routine.id}
        isStatusPending={statusMutationRoutineId === routine.id}
        onNavigate={() => navigate(`/routines/${routine.id}`)}
        onRun={() => runRoutine.mutate(routine.id)}
        onToggleStatus={() =>
          updateRoutineStatus.mutate({
            id: routine.id,
            status: nextRoutineStatus(routine.status, routine.status !== "active"),
          })
        }
        onArchive={() =>
          updateRoutineStatus.mutate({
            id: routine.id,
            status: routine.status === "archived" ? "active" : "archived",
          })
        }
      />
    ))}
  </div>
) : (
  /* List (table) view */
  <div className="overflow-x-auto rounded-lg border border-border">
    <table className="min-w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/30">
          <th className="px-3 py-2.5 font-medium">Name</th>
          <th className="px-3 py-2.5 font-medium">Project</th>
          <th className="px-3 py-2.5 font-medium">Agent</th>
          <th className="px-3 py-2.5 font-medium">Last run</th>
          <th className="px-3 py-2.5 font-medium">Enabled</th>
          <th className="w-12 px-3 py-2.5" />
        </tr>
      </thead>
      <tbody>
        {filteredRoutines.map((routine) => {
          const enabled = routine.status === "active";
          const isArchived = routine.status === "archived";
          const isStatusPending = statusMutationRoutineId === routine.id;
          return (
            <tr
              key={routine.id}
              className="align-middle border-b border-border transition-colors hover:bg-accent/50 last:border-b-0 cursor-pointer"
              onClick={() => navigate(`/routines/${routine.id}`)}
            >
              <td className="px-3 py-2.5">
                <div className="min-w-[180px]">
                  <span className="font-medium">{routine.title}</span>
                  {(isArchived || routine.status === "paused") && (
                    <div className="mt-0.5 text-xs text-muted-foreground capitalize">{routine.status}</div>
                  )}
                </div>
              </td>
              <td className="px-3 py-2.5">
                {routine.projectId ? (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span
                      className="shrink-0 h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: projectById.get(routine.projectId)?.color ?? "#6366f1" }}
                    />
                    <span className="truncate">{projectById.get(routine.projectId)?.name ?? "Unknown"}</span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2.5">
                {routine.assigneeAgentId ? (() => {
                  const agent = agentById.get(routine.assigneeAgentId);
                  return agent ? (
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{agent.name}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unknown</span>
                  );
                })() : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-2.5">
                {routine.lastRun ? (
                  <div>
                    <div className="text-muted-foreground">{timeAgo(routine.lastRun.triggeredAt)}</div>
                    <div className={`mt-0.5 text-xs ${
                      routine.lastRun.status === "issue_created" || routine.lastRun.status === "completed"
                        ? "text-emerald-400"
                        : routine.lastRun.status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}>
                      {routine.lastRun.status.replaceAll("_", " ")}
                    </div>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">Never</span>
                )}
              </td>
              <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={enabled ? `Disable ${routine.title}` : `Enable ${routine.title}`}
                    disabled={isStatusPending || isArchived}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      enabled ? "bg-emerald-500" : "bg-muted"
                    } ${isStatusPending || isArchived ? "cursor-not-allowed opacity-50" : ""}`}
                    onClick={() =>
                      updateRoutineStatus.mutate({
                        id: routine.id,
                        status: nextRoutineStatus(routine.status, !enabled),
                      })
                    }
                  >
                    <span
                      className={`inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                        enabled ? "translate-x-4.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  <span className="text-xs text-muted-foreground">
                    {isArchived ? "Archived" : enabled ? "On" : "Off"}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${routine.title}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => navigate(`/routines/${routine.id}`)}>
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={runningRoutineId === routine.id || isArchived}
                      onClick={() => runRoutine.mutate(routine.id)}
                    >
                      {runningRoutineId === routine.id ? "Running..." : "Run now"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() =>
                        updateRoutineStatus.mutate({
                          id: routine.id,
                          status: enabled ? "paused" : "active",
                        })
                      }
                      disabled={isStatusPending || isArchived}
                    >
                      {enabled ? "Pause" : "Enable"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        updateRoutineStatus.mutate({
                          id: routine.id,
                          status: routine.status === "archived" ? "active" : "archived",
                        })
                      }
                      disabled={isStatusPending}
                    >
                      {routine.status === "archived" ? "Restore" : "Archive"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
)}
```

Also add `timeAgo` import at the top (it's not currently in Routines.tsx):
```tsx
import { timeAgo } from "../lib/timeAgo";
```

And remove the now-unused `formatLastRunTimestamp` function.

- [ ] **Step 5: Check that `RoutineListItem` has `triggers` field**

The `RoutineCard` component references `routine.triggers`. Verify this field exists in the shared type:

Run: `grep -n "triggers" "packages/shared/src/types/routine.ts"`

Expected: A line like `triggers?: RoutineTrigger[]` or similar on `RoutineListItem`. If it doesn't exist, the card falls back gracefully (the `?.` optional chaining handles this).

If `triggers` is missing from `RoutineListItem`, add it:
- Open `packages/shared/src/types/routine.ts`
- Find `RoutineListItem` interface
- Add: `triggers?: Array<{ id: string; kind: string; cronExpression: string | null; label: string | null }>;`

- [ ] **Step 6: Verify compilation**

Run: `cd "C:\Users\TK\OneDrive\Desktop\Claude Data\AoA-AoA\AoA-2.5" && pnpm --filter ui tsc --noEmit 2>&1 | head -40`

Expected: Zero new errors. Fix any type errors before proceeding.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/Routines.tsx packages/shared/src/types/routine.ts
git commit -m "feat: redesign Routines list page with card grid and filter tabs"
```

---

## Task 3: Redesign RoutineDetail — Definition Card + sticky save bar

**Files:**
- Modify: `ui/src/pages/RoutineDetail.tsx` (upper section only)

This task wraps the title/metadata/instructions/delivery settings in a single bordered card and replaces the always-visible save button with a sticky save bar that only appears when `isEditDirty`.

**What changes:**
1. Wrap the header + assignment row + markdown editor + delivery settings in `<div className="border border-border rounded-lg bg-card p-5 space-y-4">`
2. Remove the `<Separator />` and the old save button `<div>` (lines ~849–862)
3. Add sticky save bar AFTER the card, BEFORE the tabs: only renders when `isEditDirty`
4. Remove the `Separator` import (no longer needed) and `Save` icon (no longer needed in main header area)
5. Remove `advancedOpen` state + `Collapsible` for delivery settings — replace with always-visible inline row

**New sticky save bar JSX** (goes between the definition card and the `<Tabs>` block):
```tsx
{isEditDirty && (
  <div className="sticky bottom-0 z-10 border-t border-amber-500/30 bg-amber-950/50 backdrop-blur-sm px-5 py-3 flex items-center justify-between rounded-b-lg -mx-1">
    <span className="text-sm text-amber-200 flex items-center gap-1.5">
      ⚠ Unsaved changes
    </span>
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setEditDraft(routineDefaults!)}
        disabled={saveRoutine.isPending}
      >
        Discard
      </Button>
      <Button
        size="sm"
        onClick={() => saveRoutine.mutate()}
        disabled={saveRoutine.isPending || !editDraft.title.trim() || !editDraft.projectId || !editDraft.assigneeAgentId}
      >
        {saveRoutine.isPending ? "Saving..." : "Save"}
      </Button>
    </div>
  </div>
)}
```

**New delivery settings row** (replaces the Collapsible, goes inside the definition card after the markdown editor):
```tsx
{/* Delivery settings — always visible, compact */}
<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground">Concurrency:</span>
    <Select
      value={editDraft.concurrencyPolicy}
      onValueChange={(concurrencyPolicy) => setEditDraft((current) => ({ ...current, concurrencyPolicy }))}
    >
      <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-1 text-sm focus:ring-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {concurrencyPolicies.map((value) => (
          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground">Catch-up:</span>
    <Select
      value={editDraft.catchUpPolicy}
      onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}
    >
      <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-1 text-sm focus:ring-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {catchUpPolicies.map((value) => (
          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
</div>
```

- [ ] **Step 1: Wrap definition section in a card**

In `RoutineDetail.tsx`, find the opening of the main return:
```tsx
return (
  <div className="max-w-2xl space-y-6">
    {/* Header: editable title + actions */}
    <div className="flex items-start gap-4">
```

Replace with:
```tsx
return (
  <div className="max-w-2xl space-y-4">
    {/* Routine definition card */}
    <div className="border border-border rounded-lg bg-card p-5 space-y-4">
      {/* Header: editable title + actions */}
      <div className="flex items-start gap-4">
```

Then find the closing of the delivery settings section (the `</Collapsible>` tag at the end of the delivery block) and close the card div after it:
```tsx
      {/* delivery settings ... */}
    </div>  {/* ← closes definition card */}
```

- [ ] **Step 2: Replace collapsible delivery settings with inline row**

Find and remove the entire `{/* Advanced delivery settings */}` Collapsible block (from `<Collapsible open={advancedOpen}` to `</Collapsible>`).

Replace with the always-visible delivery row:
```tsx
{/* Delivery settings */}
<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground">Concurrency:</span>
    <Select
      value={editDraft.concurrencyPolicy}
      onValueChange={(concurrencyPolicy) => setEditDraft((current) => ({ ...current, concurrencyPolicy }))}
    >
      <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-1 text-sm focus:ring-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {concurrencyPolicies.map((value) => (
          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground">Catch-up:</span>
    <Select
      value={editDraft.catchUpPolicy}
      onValueChange={(catchUpPolicy) => setEditDraft((current) => ({ ...current, catchUpPolicy }))}
    >
      <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-1 text-sm focus:ring-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {catchUpPolicies.map((value) => (
          <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
</div>
```

- [ ] **Step 3: Remove old save bar and separator, add sticky save bar**

Find and remove the old save bar block:
```tsx
      {/* Save bar */}
      <div className="flex items-center justify-between">
        {isEditDirty ? (
          <span className="text-xs text-amber-600">Unsaved changes</span>
        ) : (
          <span />
        )}
        <Button
          onClick={() => saveRoutine.mutate()}
          disabled={saveRoutine.isPending || !editDraft.title.trim() || !editDraft.projectId || !editDraft.assigneeAgentId}
        >
          <Save className="mr-2 h-4 w-4" />
          Save routine
        </Button>
      </div>

      <Separator />
```

Replace with:
```tsx
    </div>  {/* closes definition card */}

    {/* Sticky save bar — only visible when dirty */}
    {isEditDirty && (
      <div className="sticky bottom-0 z-10 border border-amber-500/30 bg-amber-950/60 backdrop-blur-sm px-5 py-3 rounded-lg flex items-center justify-between">
        <span className="text-sm text-amber-200">⚠ Unsaved changes</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditDraft(routineDefaults!)}
            disabled={saveRoutine.isPending}
          >
            Discard
          </Button>
          <Button
            size="sm"
            onClick={() => saveRoutine.mutate()}
            disabled={saveRoutine.isPending || !editDraft.title.trim() || !editDraft.projectId || !editDraft.assigneeAgentId}
          >
            {saveRoutine.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    )}
```

- [ ] **Step 4: Remove unused imports**

Remove `Separator` from the import (it's no longer used).
Remove `Save` from lucide imports (no longer used in this section — it's still used in TriggerEditor, so check first).

To check: `grep -n "Save" ui/src/pages/RoutineDetail.tsx`

If `Save` only appears in the old save bar (now removed) and not in `TriggerEditor`, remove it. If it appears in `TriggerEditor`, keep it.

Remove `advancedOpen` state and its setter if no longer referenced:
```tsx
// Remove this line:
const [advancedOpen, setAdvancedOpen] = useState(false);
```

Remove `ChevronRight` import if it was only used in the Collapsible trigger (check: `grep -n "ChevronRight" ui/src/pages/RoutineDetail.tsx`).

- [ ] **Step 5: Verify compilation**

Run: `pnpm --filter ui tsc --noEmit 2>&1 | head -40`

Fix any type or reference errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/RoutineDetail.tsx
git commit -m "feat: redesign RoutineDetail definition card and sticky save bar"
```

---

## Task 4: Redesign RoutineDetail — Triggers tab

**Files:**
- Modify: `ui/src/pages/RoutineDetail.tsx` (triggers tab section)

**What changes:**
1. Replace always-open add-trigger form with a collapsible triggered by `[+ Add trigger]` button
2. Redesign existing trigger cards with: left-border color coding, header with kind badge, human-readable schedule, key-value metadata grid, inline edit expansion
3. New state: `addTriggerOpen: boolean` for the collapsed add form

**New state to add:**
```tsx
const [addTriggerOpen, setAddTriggerOpen] = useState(false);
```

**Trigger left-border colors:**
```tsx
const triggerBorderColor: Record<string, string> = {
  schedule: "border-l-blue-500",
  webhook: "border-l-purple-500",
  api: "border-l-gray-500",
};
```

- [ ] **Step 1: Add `addTriggerOpen` state**

Inside `RoutineDetail()`, find the `const [newTrigger, setNewTrigger] = useState({` line and add before it:
```tsx
const [addTriggerOpen, setAddTriggerOpen] = useState(false);
```

Also add the color map as a module-level constant (outside the component, near the other constants):
```tsx
const triggerBorderColor: Record<string, string> = {
  schedule: "border-l-blue-500",
  webhook: "border-l-purple-500",
  api: "border-l-gray-500",
};
```

- [ ] **Step 2: Replace the triggers TabsContent**

Find the `<TabsContent value="triggers" className="space-y-4">` block and replace everything inside it (from the opening tag to `</TabsContent>`) with:

```tsx
<TabsContent value="triggers" className="space-y-3">
  {/* Existing trigger cards */}
  {routine.triggers.length === 0 && !addTriggerOpen ? (
    <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground space-y-3">
      <p>No triggers configured.</p>
      <p className="text-xs">Add a schedule or webhook trigger to automate this routine.</p>
      <Button variant="outline" size="sm" onClick={() => setAddTriggerOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add trigger
      </Button>
    </div>
  ) : (
    <>
      <div className="space-y-3">
        {routine.triggers.map((trigger) => (
          <TriggerCard
            key={trigger.id}
            trigger={trigger}
            onSave={(id, patch) => updateTrigger.mutate({ id, patch })}
            onRotate={(id) => rotateTrigger.mutate(id)}
            onDelete={(id) => deleteTrigger.mutate(id)}
          />
        ))}
      </div>

      {/* Add trigger — collapsed button or expanded form */}
      {addTriggerOpen ? (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <p className="text-sm font-medium">New trigger</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Kind</Label>
              <Select value={newTrigger.kind} onValueChange={(kind) => setNewTrigger((current) => ({ ...current, kind }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {triggerKinds.map((kind) => (
                    <SelectItem key={kind} value={kind} disabled={kind === "webhook"}>
                      {kind}{kind === "webhook" ? " — coming soon" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {newTrigger.kind === "schedule" && (
              <div className="md:col-span-2 space-y-1.5">
                <Label className="text-xs">Schedule</Label>
                <ScheduleEditor
                  value={newTrigger.cronExpression}
                  onChange={(cronExpression) => setNewTrigger((current) => ({ ...current, cronExpression }))}
                />
              </div>
            )}
            {newTrigger.kind === "webhook" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Signing mode</Label>
                  <Select value={newTrigger.signingMode} onValueChange={(signingMode) => setNewTrigger((current) => ({ ...current, signingMode }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {signingModes.map((mode) => (<SelectItem key={mode} value={mode}>{mode}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Replay window (seconds)</Label>
                  <Input value={newTrigger.replayWindowSec} onChange={(e) => setNewTrigger((c) => ({ ...c, replayWindowSec: e.target.value }))} />
                </div>
              </>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAddTriggerOpen(false)}
              disabled={createTrigger.isPending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                createTrigger.mutate(undefined, {
                  onSuccess: () => setAddTriggerOpen(false),
                });
              }}
              disabled={createTrigger.isPending}
            >
              {createTrigger.isPending ? "Adding..." : "Add trigger"}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setAddTriggerOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add trigger
        </Button>
      )}
    </>
  )}
</TabsContent>
```

- [ ] **Step 3: Replace TriggerEditor with TriggerCard**

The existing `TriggerEditor` component always shows an expanded edit form. Replace it with a new `TriggerCard` that shows a read-only card with an inline edit expansion.

Replace the entire `function TriggerEditor(...)` definition (lines ~114–232) with:

```tsx
function TriggerCard({
  trigger,
  onSave,
  onRotate,
  onDelete,
}: {
  trigger: RoutineTrigger;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRotate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState({
    label: trigger.label ?? "",
    cronExpression: trigger.cronExpression ?? "",
    signingMode: trigger.signingMode ?? "bearer",
    replayWindowSec: String(trigger.replayWindowSec ?? 300),
  });

  useEffect(() => {
    setDraft({
      label: trigger.label ?? "",
      cronExpression: trigger.cronExpression ?? "",
      signingMode: trigger.signingMode ?? "bearer",
      replayWindowSec: String(trigger.replayWindowSec ?? 300),
    });
  }, [trigger]);

  const borderColorClass =
    trigger.kind === "schedule"
      ? "border-l-blue-500"
      : trigger.kind === "webhook"
        ? "border-l-purple-500"
        : "border-l-gray-500";

  return (
    <div className={`rounded-lg border border-l-4 ${borderColorClass} p-4 space-y-3`}>
      {/* Card header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {trigger.kind === "schedule" ? (
            <Clock3 className="h-3.5 w-3.5 text-blue-400" />
          ) : trigger.kind === "webhook" ? (
            <Webhook className="h-3.5 w-3.5 text-purple-400" />
          ) : (
            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="capitalize text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {trigger.kind}
          </span>
          {trigger.label && trigger.label !== trigger.kind && (
            <span className="text-muted-foreground text-xs">{trigger.label}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isEditing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setIsEditing(true)}
            >
              Edit
            </Button>
          )}
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => onDelete(trigger.id)}
              >
                Delete
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Schedule description */}
      {trigger.kind === "schedule" && trigger.cronExpression && (
        <p className="text-sm">{describeSchedule(trigger.cronExpression)}</p>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {trigger.kind === "schedule" && trigger.nextRunAt && (
          <>
            <span className="font-medium text-foreground/70">Next run</span>
            <span>{new Date(trigger.nextRunAt).toLocaleString()}</span>
          </>
        )}
        {trigger.lastFiredAt && (
          <>
            <span className="font-medium text-foreground/70">Last fired</span>
            <span>{new Date(trigger.lastFiredAt).toLocaleString()}</span>
          </>
        )}
        {trigger.lastResult && (
          <>
            <span className="font-medium text-foreground/70">Last result</span>
            <span className={trigger.lastResult === "success" ? "text-emerald-400" : "text-muted-foreground"}>
              {trigger.lastResult}
            </span>
          </>
        )}
      </div>

      {/* Inline edit form — only when isEditing */}
      {isEditing && (
        <div className="border-t border-border pt-3 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input
                value={draft.label}
                onChange={(e) => setDraft((c) => ({ ...c, label: e.target.value }))}
              />
            </div>
            {trigger.kind === "schedule" && (
              <div className="md:col-span-2 space-y-1.5">
                <Label className="text-xs">Schedule</Label>
                <ScheduleEditor
                  value={draft.cronExpression}
                  onChange={(cronExpression) => setDraft((c) => ({ ...c, cronExpression }))}
                />
              </div>
            )}
            {trigger.kind === "webhook" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Signing mode</Label>
                  <Select
                    value={draft.signingMode}
                    onValueChange={(signingMode) => setDraft((c) => ({ ...c, signingMode }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {signingModes.map((mode) => (<SelectItem key={mode} value={mode}>{mode}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Replay window (seconds)</Label>
                  <Input
                    value={draft.replayWindowSec}
                    onChange={(e) => setDraft((c) => ({ ...c, replayWindowSec: e.target.value }))}
                  />
                </div>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {trigger.kind === "webhook" && (
              <Button variant="outline" size="sm" onClick={() => onRotate(trigger.id)}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Rotate secret
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onSave(trigger.id, buildRoutineTriggerPatch(trigger, draft, getLocalTimezone()));
                  setIsEditing(false);
                }}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" />
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

Also update the `createTrigger.mutate()` call in the add form — the current `mutationFn` takes no args, but we called `createTrigger.mutate(undefined, { onSuccess: ... })`. Verify this pattern works with React Query v5. If not, manage `setAddTriggerOpen(false)` inside the mutation's `onSuccess` directly instead of passing it inline.

Alternative (safer): Change the `onSuccess` in `createTrigger` mutation to also close the form:
```tsx
// Inside createTrigger.onSuccess:
onSuccess: async (result) => {
  setAddTriggerOpen(false);  // add this line
  if (result.secretMaterial) {
    // ... existing code
  }
  // ... existing invalidations
},
```
Then in the button: `onClick={() => createTrigger.mutate()}` (no inline callback needed).

- [ ] **Step 4: Verify `lastFiredAt` field exists on `RoutineTrigger`**

Run: `grep -n "lastFiredAt\|lastResult\|nextRunAt" packages/shared/src/types/routine.ts`

The `TriggerCard` uses `trigger.lastFiredAt`, `trigger.lastResult`, `trigger.nextRunAt`. If any are missing from the `RoutineTrigger` type, they are optional in the card rendering (using `&&`) so the card will just skip those rows. No type error since we use `?.` or `&&` guards.

If TypeScript complains about the property not existing, add the missing optional fields to `RoutineTrigger` in `packages/shared/src/types/routine.ts`.

- [ ] **Step 5: Compile check**

Run: `pnpm --filter ui tsc --noEmit 2>&1 | head -40`

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/RoutineDetail.tsx packages/shared/src/types/routine.ts
git commit -m "feat: redesign triggers tab with collapsed add form and rich trigger cards"
```

---

## Task 5: Redesign RoutineDetail — Runs/Activity tabs + tab count badges

**Files:**
- Modify: `ui/src/pages/RoutineDetail.tsx` (tabs header + runs + activity tab sections)

**What changes:**
1. Add count badges to tab labels: `Triggers (N)`, `Runs (N)`, `Activity (N)`
2. Polish runs tab: color-coded status badges, failure reason line
3. Polish activity tab: format action names (e.g. `routine.run_triggered` → `Run triggered`)

- [ ] **Step 1: Add count badges to TabsTrigger labels**

Find the `<Tabs value={activeTab}` block and update the three `TabsTrigger` elements:

```tsx
<TabsTrigger value="triggers" className="gap-1.5">
  <Clock3 className="h-3.5 w-3.5" />
  Triggers
  {routine.triggers.length > 0 && (
    <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      {routine.triggers.length}
    </span>
  )}
</TabsTrigger>
<TabsTrigger value="runs" className="gap-1.5">
  <Play className="h-3.5 w-3.5" />
  Runs
  {(routineRuns ?? []).length > 0 && (
    <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      {(routineRuns ?? []).length}
    </span>
  )}
  {hasLiveRun && <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />}
</TabsTrigger>
<TabsTrigger value="activity" className="gap-1.5">
  <ActivityIcon className="h-3.5 w-3.5" />
  Activity
  {(activity ?? []).length > 0 && (
    <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      {(activity ?? []).length}
    </span>
  )}
</TabsTrigger>
```

- [ ] **Step 2: Polish runs tab — color-coded status badges**

Find the runs tab `<TabsContent value="runs"` block and update the status badge JSX:

Replace:
```tsx
<Badge variant={run.status === "failed" ? "destructive" : "secondary"} className="shrink-0">
  {run.status.replaceAll("_", " ")}
</Badge>
```

With:
```tsx
<Badge
  variant="secondary"
  className={`shrink-0 ${
    run.status === "issue_created" || run.status === "completed"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      : run.status === "failed"
        ? "bg-destructive/10 text-destructive border-destructive/20"
        : run.status === "received"
          ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
          : ""
  }`}
>
  {run.status.replaceAll("_", " ")}
</Badge>
```

Also update the run row to use `px-4 py-3` padding (currently `px-3 py-2`):
```tsx
<div key={run.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
  <div className="flex items-center justify-between gap-2">
    <div className="flex items-center gap-2 min-w-0">
      {/* ... badges and link ... */}
    </div>
    <span className="text-xs text-muted-foreground shrink-0">{timeAgo(run.triggeredAt)}</span>
  </div>
  {run.status === "failed" && run.failureReason && (
    <p className="pl-2 text-xs text-muted-foreground">{run.failureReason}</p>
  )}
</div>
```

Note: `run.failureReason` may not exist on `RoutineRunSummary` type. Check: `grep -n "failureReason\|failure_reason" packages/shared/src/types/routine.ts`. If missing, skip that line.

- [ ] **Step 3: Polish activity tab — format action names**

Add a helper function (module-level, near `formatActivityDetailValue`):

```tsx
function formatActivityAction(action: string): string {
  // "routine.run_triggered" → "Run triggered"
  // "routine.created" → "Created"
  // "routine_trigger.created" → "Trigger created"
  const parts = action.split(".");
  const verb = parts[parts.length - 1];
  const subject = parts.length > 1 ? parts[0] : null;
  const verbFormatted = verb.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
  if (subject === "routine" || !subject) return verbFormatted;
  const subjectFormatted = subject.replace("routine_", "").replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
  return `${subjectFormatted} ${verb.replaceAll("_", " ")}`.replace(/^\w/, (c) => c.toUpperCase());
}
```

Then update the activity tab row to use it:
```tsx
<span className="font-medium text-foreground/90 shrink-0">{formatActivityAction(event.action)}</span>
```

Also update activity row padding to `px-4 py-3` (currently `px-3 py-2`):
```tsx
<div key={event.id} className="flex items-start justify-between px-4 py-3 text-xs gap-4">
```

- [ ] **Step 4: Update empty states**

Update runs empty state:
```tsx
{(routineRuns ?? []).length === 0 ? (
  <div className="py-8 text-center">
    <p className="text-sm text-muted-foreground">No runs yet.</p>
    <p className="text-xs text-muted-foreground/60 mt-1">Use Run now or add a trigger to start.</p>
  </div>
) : (
```

Update activity empty state:
```tsx
{(activity ?? []).length === 0 ? (
  <p className="py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
) : (
```

- [ ] **Step 5: Final compile check**

Run: `pnpm --filter ui tsc --noEmit 2>&1 | head -40`

Fix any remaining type errors.

- [ ] **Step 6: Run all tests to confirm no regressions**

Run: `cd "C:\Users\TK\OneDrive\Desktop\Claude Data\AoA-AoA\AoA-2.5" && pnpm test 2>&1 | tail -20`

Expected: All tests pass (same count as before).

- [ ] **Step 7: Final commit**

```bash
git add ui/src/pages/RoutineDetail.tsx
git commit -m "feat: polish RoutineDetail tabs — count badges, status colors, activity formatting"
```

---

## Self-Review Against Spec

| Spec Requirement | Covered? | Task |
|-----------------|----------|------|
| List: Card grid `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4` | ✅ | Task 2 |
| List: Filter tabs All/Active/Paused/Archived | ✅ | Task 2 |
| List: View toggle Grid/List | ✅ | Task 2 |
| List: Card with Repeat icon, title, toggle, metadata, schedule, last run | ✅ | Task 1 |
| List: Hover footer with Run now + dropdown | ✅ | Task 1 |
| List: Live run state border-cyan-500/30 | ✅ | Task 1 (`hasLiveRun` prop) |
| List: Empty state with EmptyState component | ✅ | Task 2 |
| Detail: Bordered definition card `border border-border rounded-lg bg-card p-5 space-y-4` | ✅ | Task 3 |
| Detail: Title textarea + Run now + toggle in header row | ✅ | Task 3 (kept existing, wrapped) |
| Detail: Metadata row (project, agent) via InlineEntitySelector | ✅ | Task 3 (kept existing, wrapped) |
| Detail: Instructions markdown editor | ✅ | Task 3 (kept existing, wrapped) |
| Detail: Delivery settings compact inline (not collapsible) | ✅ | Task 3 |
| Detail: Sticky save bar only when dirty | ✅ | Task 3 |
| Detail: No save button when not dirty | ✅ | Task 3 |
| Detail: Tab count badges | ✅ | Task 5 |
| Triggers: `[+ Add trigger]` button (not always open) | ✅ | Task 4 |
| Triggers: Collapsed form expands inline | ✅ | Task 4 |
| Triggers: Rich trigger cards with left-border color | ✅ | Task 4 |
| Triggers: Edit expands inline in card | ✅ | Task 4 |
| Triggers: Delete with confirmation | ✅ | Task 4 |
| Triggers: Empty state with Add trigger button | ✅ | Task 4 |
| Runs: Color-coded status badges | ✅ | Task 5 |
| Runs: Timestamp right-aligned | ✅ | Task 5 |
| Activity: Formatted action names | ✅ | Task 5 |
| Activity: Key-value detail pairs | ✅ | Task 5 (existing, kept) |

**Note on `hasLiveRun` in RoutineCard:** The `RoutineListItem` type likely doesn't include live run info. The `Routines.tsx` page would need to pass `hasLiveRun={false}` always (or omit it to default to false) unless a live-run query is added for the list page. For now, default to `false` — the glow effect is a nice-to-have that works fully on the detail page.
