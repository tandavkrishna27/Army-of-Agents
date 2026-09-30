# Activity → Settings Secondary Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Activity item out of the primary sidebar's WORK section and into the Settings secondary sidebar as an inline tab. Nothing else in the primary navigation is touched.

**Architecture:** Extract Activity's content into a standalone `ActivitySection.tsx` component. Add `"activity"` to `SettingsSectionId` and `SETTINGS_SECTIONS` in `SettingsLayout.tsx`. Register it in `SettingsPage.tsx`. Remove the `SidebarNavItem` for Activity from `Sidebar.tsx`. Redirect the old `/activity` route to `/settings?tab=activity`.

**Tech Stack:** React, React Router, TailwindCSS, Lucide icons, TanStack Query

---

## File Map

| File | Change |
|---|---|
| `ui/src/components/settings/sections/ActivitySection.tsx` | **Create** — extracted from `CompanyActivityPage.tsx` |
| `ui/src/pages/CompanyActivityPage.tsx` | Thin wrapper only (keeps `/activity` route alive) |
| `ui/src/components/settings/SettingsLayout.tsx` | Add `"activity"` to `SettingsSectionId` + `SETTINGS_SECTIONS` |
| `ui/src/pages/SettingsPage.tsx` | Add `"activity"` to `VALID_SECTIONS`, add `case "activity"` renderer |
| `ui/src/components/Sidebar.tsx` | Remove Activity `SidebarNavItem` from WORK section |
| `ui/src/App.tsx` | Redirect `/activity` → `/settings?tab=activity` |

---

## Task 1: Extract `ActivitySection` from `CompanyActivityPage`

**Files:**
- Create: `ui/src/components/settings/sections/ActivitySection.tsx`
- Modify: `ui/src/pages/CompanyActivityPage.tsx`

- [ ] **Step 1: Create `ActivitySection.tsx`**

All logic moves here. Drop the `setBreadcrumbs` call — that belongs to the page wrapper, not the section.

```tsx
// ui/src/components/settings/sections/ActivitySection.tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import type { Agent } from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import { activityApi } from "@/api/activity";
import { agentsApi } from "@/api/agents";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { goalsApi } from "@/api/goals";
import { queryKeys } from "@/lib/queryKeys";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ActivityRow } from "@/components/ActivityRow";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export function ActivitySection() {
  const { selectedCompanyId } = useCompany();
  const [filter, setFilter] = useState("all");

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.activity(selectedCompanyId!),
    queryFn: () => activityApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    for (const g of goals ?? []) map.set(`goal:${g.id}`, g.title);
    return map;
  }, [issues, agents, projects, goals]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  if (!selectedCompanyId) {
    return (
      <div className="space-y-6 max-w-[1100px] mx-auto">
        <EmptyState icon={History} message="Select a company to view activity." />
      </div>
    );
  }

  const filtered = data && filter !== "all" ? data.filter((e) => e.entityType === filter) : data;
  const entityTypes = data ? [...new Set(data.map((e) => e.entityType))].sort() : [];

  return (
    <div className="space-y-6 max-w-[1100px] mx-auto">
      <div>
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Activity<span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All activity for this company — heartbeats, task changes, agent runs, and discussion entries.
        </p>
      </div>

      {isLoading ? (
        <div className="mt-6"><PageSkeleton variant="list" /></div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-end">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-[140px] h-8 text-xs">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {entityTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error.message}</p>}
          {filtered && filtered.length === 0 && (
            <EmptyState icon={History} message="No activity yet." />
          )}
          {filtered && filtered.length > 0 && (
            <div className="border border-border divide-y divide-border">
              {filtered.map((event) => (
                <ActivityRow
                  key={event.id}
                  event={event}
                  agentMap={agentMap}
                  entityNameMap={entityNameMap}
                  entityTitleMap={entityTitleMap}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Slim `CompanyActivityPage.tsx` to a thin wrapper**

Replace the entire file with:

```tsx
import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { ActivitySection } from "@/components/settings/sections/ActivitySection";

export function CompanyActivityPage() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Activity" }]); }, [setBreadcrumbs]);
  return <ActivitySection />;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ui typecheck`
Expected: no new errors

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/settings/sections/ActivitySection.tsx ui/src/pages/CompanyActivityPage.tsx
git commit -m "refactor(activity): extract ActivitySection for Settings embedding"
```

---

## Task 2: Add Activity to `SettingsLayout`

**Files:**
- Modify: `ui/src/components/settings/SettingsLayout.tsx`

- [ ] **Step 1: Add `"activity"` to `SettingsSectionId`**

On line 11–13, extend the union:

```ts
export type SettingsSectionId =
  | "general" | "commander" | "llm" | "budget" | "mcp" | "github"
  | "plugins" | "marketplace" | "archive"
  | "activity";
```

- [ ] **Step 2: Add the Activity icon import**

On line 4, add `Activity` to the lucide imports:

```ts
import { Building, Shield, KeyRound, DollarSign, Plug, Puzzle, Store, Archive, Github, Activity } from "lucide-react";
```

- [ ] **Step 3: Add Activity item to `SETTINGS_SECTIONS`**

In `SETTINGS_SECTIONS` (lines 27–45), add Activity as the last item in the existing `"Company"` group:

```ts
{ group: "Company", items: [
  { id: "general",   label: "General",   icon: Building },
  { id: "activity",  label: "Activity",  icon: Activity },
]},
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter ui typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/settings/SettingsLayout.tsx
git commit -m "feat(settings): add Activity tab to secondary sidebar"
```

---

## Task 3: Wire `ActivitySection` into `SettingsPage`

**Files:**
- Modify: `ui/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add import**

At the top of `SettingsPage.tsx`, add:

```tsx
import { ActivitySection } from "@/components/settings/sections/ActivitySection";
```

- [ ] **Step 2: Add `"activity"` to `VALID_SECTIONS`**

```tsx
const VALID_SECTIONS: readonly SettingsSectionId[] = [
  "general", "commander", "llm", "budget", "mcp", "github", "plugins", "marketplace", "archive",
  "activity",
];
```

- [ ] **Step 3: Add the case to `renderActiveSection`**

Add before the `default` case:

```tsx
case "activity":
  return <ActivitySection />;
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter ui typecheck`
Expected: the exhaustive `never` check in `default` still compiles — all `SettingsSectionId` values are handled.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/SettingsPage.tsx
git commit -m "feat(settings): render Activity section when tab=activity"
```

---

## Task 4: Remove Activity from the primary sidebar

**Files:**
- Modify: `ui/src/components/Sidebar.tsx`

- [ ] **Step 1: Delete the Activity `SidebarNavItem`**

In `Sidebar.tsx` around line 143, remove this line:

```tsx
<SidebarNavItem to="/activity" label="Activity" icon={Activity} collapsed={collapsed} />
```

Everything else in the primary sidebar (all WORK items, all COMPANY items) stays completely untouched.

- [ ] **Step 2: Remove the `Activity` icon import if unused**

Check the import statement at the top of `Sidebar.tsx`. If `Activity` is no longer referenced anywhere else in the file, remove it from the import. Leave all other imports as-is.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ui typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/Sidebar.tsx
git commit -m "refactor(sidebar): remove Activity from WORK section (moved to Settings)"
```

---

## Task 5: Redirect the old `/activity` route

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Replace the route**

Around line 185, replace:

```tsx
<Route path="activity" element={<CompanyActivityPage />} />
```

with:

```tsx
<Route path="activity" element={<Navigate to="../settings?tab=activity" replace />} />
```

- [ ] **Step 2: Remove the `CompanyActivityPage` import from `App.tsx`**

Find the import of `CompanyActivityPage` at the top of `App.tsx` and delete it — it is no longer mounted here.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ui typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "refactor(routes): redirect /activity to /settings?tab=activity"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| Activity accessible from Settings secondary sidebar as inline tab | Tasks 1, 2, 3 |
| Activity removed from primary sidebar WORK section | Task 4 |
| Old `/activity` URL still works | Task 5 |
| All other primary nav items untouched | ✅ No other sidebar changes made |

### Placeholder check

No TBDs. Every step has exact code or an exact file location.

### Type consistency

- `"activity"` added to `SettingsSectionId` in exactly one place (`SettingsLayout.tsx`) and flows through to `VALID_SECTIONS` and `renderActiveSection` in `SettingsPage.tsx`.
- `ActivitySection` exported from one file, imported by both `CompanyActivityPage` and `SettingsPage` — single source of truth.
