# Team Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Team page to design-system parity with Settings — secondary sidebar shell, eyebrow page headers, unified primitives, promote Teams to first-class peer nav, kill dead code paths, and add a daily-triage agent slide-over.

**Architecture:** Wrap `TeamPage` in a new `TeamLayout` (mirror of `SettingsLayout`) that renders `SecondarySidebar` with two groups (`VISUALIZE`, `WORKFORCE`) and auto-collapses the primary sidebar (Decision #98). Each tab/section reuses existing primitives (`PageHeader`, `AgentCard`, `EmptyState`). Teams gets promoted out of `AgentsTab` into its own list page + the existing `TeamDetail` route. The `BuildFromScratchForm` "Create new agent inline" path is removed. The current `/agents/:id` page stays unchanged; a new `AgentDetailSheet` slide-over is added for daily-triage quick-peek.

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui + Radix · Vitest + React Testing Library · Drizzle ORM (server) + Express 5

**Mockup reference:** `mockups/team-redesign.html` (live at `http://localhost:5174/team-redesign` when the `mock` preview server is running).

---

## File Structure

### Created
- `ui/src/components/team/TeamLayout.tsx` — secondary-sidebar shell (mirror of `SettingsLayout`)
- `ui/src/components/team/AgentDetailSheet.tsx` — daily-triage slide-over (NOW / TODAY / QUEUE / RECENT)
- `ui/src/components/team/RoleBadge.tsx` — extracted from `HumansTab` `ROLE_STYLES` map
- `ui/src/lib/initials.ts` — single util replacing `getInitials` (`OrgTreeTab.tsx:648`) + `deriveInitials` (`HumansTab.tsx:61`)
- `ui/src/pages/TeamsListPage.tsx` — promoted from `TeamsSection.tsx` to first-class page
- `ui/src/__tests__/TeamLayout.test.tsx`
- `ui/src/__tests__/AgentDetailSheet.test.tsx`
- `ui/src/components/team/__tests__/RoleBadge.test.tsx`
- `ui/src/__tests__/initials.test.ts`

### Modified
- `ui/src/App.tsx` — add `/team` routes, redirect `/org` → `/team`
- `ui/src/pages/TeamPage.tsx` — drop card-shaped header, use `TeamLayout` + `PageHeader`
- `ui/src/components/team/OrgTreeTab.tsx` — tokenize status dots, `<Button>` zoom controls, `<Badge>` Chief of Staff, unified team palette, `<EmptyState>`, use shared `initials`
- `ui/src/components/team/AgentsTab.tsx` — drop card header + `TeamsSection`, migrate to shared `<AgentCard>`, `<EmptyState>`
- `ui/src/components/team/HumansTab.tsx` — drop card header + nested invite-card, use `<RoleBadge>`, shared `initials`, `rounded-md` invite list
- `ui/src/pages/TeamDetail.tsx` — page header overhaul (use `<PageHeader>`)
- `ui/src/components/team/CoordinationEditor.tsx` — preview-default + Edit toggle button
- `ui/src/components/team/NewTeamEntryDialog.tsx` — drop the SOON marketplace card (3-card → 2-card chooser)
- `ui/src/components/team/BuildFromScratchForm.tsx` — strip "Create new" path entirely, members are pick-existing only
- `ui/src/components/team/MemberRow.tsx` — collapse the discriminated union (`existing | new`) to single `existing` shape
- `ui/src/components/team/AgentsTab.tsx` — confirmation dialog severity split (amber Terminate / red Delete + type-to-confirm)
- `ui/src/lib/status-colors.ts` — add hex-value variants (`agentStatusDotHex`) for inline-style consumers (org canvas)
- `ui/src/components/AgentConfigForm.tsx` — fix duplicate `Test environment` button (lines 559 + 573 currently render together for some adapter combinations)
- `server/src/services/teams.ts` — simplify `create()` flow (no atomic-`newAgents` transaction, since "Create new" is gone)

### Deleted / Inlined
- `ui/src/components/team/TeamsSection.tsx` — content moves to new `TeamsListPage.tsx`; old file deleted

---

## Phase A — Layout shell (route + secondary sidebar)

### Task A1: Add `/team` route alongside `/org` with redirect

**Files:**
- Modify: `ui/src/App.tsx:32-33,134-137`
- Test: `ui/src/__tests__/navigation.test.tsx` (existing, add cases)

- [ ] **Step 1: Write a failing route test for `/team` redirect from `/org`**

Append to `ui/src/__tests__/navigation.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { TeamPage } from "@/pages/TeamPage";

it("redirects /org to /team", () => {
  render(
    <MemoryRouter initialEntries={["/c/acme/org"]}>
      <Routes>
        <Route path="/c/:slug/team" element={<div data-testid="team-route" />} />
        <Route path="/c/:slug/org" element={<TeamPage />} />
      </Routes>
    </MemoryRouter>
  );
  expect(screen.queryByTestId("team-route")).not.toBeNull();
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter ui test --run ui/src/__tests__/navigation.test.tsx
```

Expected: FAIL ("Unable to find element by testid").

- [ ] **Step 3: Add `/team` route + `/org` redirect in `ui/src/App.tsx`**

Replace line 134 `<Route path="org" element={<TeamPage />} />` with:

```tsx
<Route path="team" element={<TeamPage />} />
<Route path="org" element={<Navigate to="../team" replace />} />
```

Ensure `Navigate` is imported from `react-router-dom` at the top of the file (it likely already is — check the existing imports near `useNavigate`).

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter ui test --run ui/src/__tests__/navigation.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/__tests__/navigation.test.tsx
git commit -m "feat(team): add /team route with /org redirect"
```

---

### Task A2: Create `TeamLayout` (secondary-sidebar shell)

**Files:**
- Create: `ui/src/components/team/TeamLayout.tsx`
- Test: `ui/src/__tests__/TeamLayout.test.tsx`

- [ ] **Step 1: Write a failing test for `TeamLayout` rendering**

Create `ui/src/__tests__/TeamLayout.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TeamLayout, type TeamSectionId } from "@/components/team/TeamLayout";
import { SidebarProvider } from "@/context/SidebarContext";

function renderLayout(active: TeamSectionId, onChange = vi.fn()) {
  return render(
    <SidebarProvider>
      <TeamLayout activeSection={active} onSectionChange={onChange}>
        <div data-testid="content">main</div>
      </TeamLayout>
    </SidebarProvider>,
  );
}

it("renders the four nav items grouped under VISUALIZE and WORKFORCE", () => {
  renderLayout("org-tree");
  expect(screen.getByText("Visualize")).toBeInTheDocument();
  expect(screen.getByText("Workforce")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Org Tree/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Agents/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Humans/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Teams/i })).toBeInTheDocument();
});

it("marks the active section with data-active=true", () => {
  renderLayout("agents");
  const agentsBtn = screen.getByRole("button", { name: /Agents/i });
  expect(agentsBtn).toHaveAttribute("data-active", "true");
});

it("calls onSectionChange when a nav item is clicked", async () => {
  const user = userEvent.setup();
  const handler = vi.fn();
  renderLayout("org-tree", handler);
  await user.click(screen.getByRole("button", { name: /Humans/i }));
  expect(handler).toHaveBeenCalledWith("humans");
});

it("renders children in the main content area", () => {
  renderLayout("org-tree");
  expect(screen.getByTestId("content")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamLayout.test.tsx
```

Expected: FAIL ("Cannot find module …/TeamLayout").

- [ ] **Step 3: Implement `TeamLayout`**

Create `ui/src/components/team/TeamLayout.tsx`. This is a thin wrapper over `SecondarySidebar` (mirror `ui/src/components/settings/SettingsLayout.tsx:48-130`):

```tsx
import { useEffect, type ReactNode } from "react";
import { Network, Bot, Users, UsersRound } from "lucide-react";
import { useSidebar } from "@/context/SidebarContext";
import { SecondarySidebar, type SecondarySidebarSection } from "@/components/SecondarySidebar";

export type TeamSectionId = "org-tree" | "agents" | "humans" | "teams";

interface TeamLayoutProps {
  activeSection: TeamSectionId;
  onSectionChange: (id: TeamSectionId) => void;
  children: ReactNode;
  counts?: Partial<Record<TeamSectionId, number>>;
}

export function TeamLayout({ activeSection, onSectionChange, children, counts }: TeamLayoutProps) {
  const { setCollapsed, isMobile } = useSidebar();

  // Decision #98 — auto-collapse primary sidebar so the secondary takes over.
  useEffect(() => {
    if (!isMobile) setCollapsed(true);
  }, [isMobile, setCollapsed]);

  const sections: SecondarySidebarSection[] = [
    {
      title: "Visualize",
      items: [
        {
          id: "org-tree",
          label: "Org Tree",
          icon: <Network />,
          active: activeSection === "org-tree",
          onClick: () => onSectionChange("org-tree"),
        },
      ],
    },
    {
      title: "Workforce",
      items: [
        { id: "agents", label: "Agents", icon: <Bot />, count: counts?.agents,
          active: activeSection === "agents", onClick: () => onSectionChange("agents") },
        { id: "humans", label: "Humans", icon: <Users />, count: counts?.humans,
          active: activeSection === "humans", onClick: () => onSectionChange("humans") },
        { id: "teams", label: "Teams", icon: <UsersRound />, count: counts?.teams,
          active: activeSection === "teams", onClick: () => onSectionChange("teams") },
      ],
    },
  ];

  return (
    <div className="flex h-full min-h-0">
      <SecondarySidebar sections={sections} className="hidden md:flex" />
      {/* Mobile pill-row sub-nav (Phase I) — placeholder div for now, filled in Task I1. */}
      <div className="flex-1 min-w-0 overflow-y-auto">{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamLayout.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/team/TeamLayout.tsx ui/src/__tests__/TeamLayout.test.tsx
git commit -m "feat(team): add TeamLayout secondary-sidebar shell"
```

---

### Task A3: Wire `TeamPage` to `TeamLayout` and drop the card-shaped page header

**Files:**
- Modify: `ui/src/pages/TeamPage.tsx:159-213`

- [ ] **Step 1: Replace the wrapper + header in `TeamPage`**

Open `ui/src/pages/TeamPage.tsx`. The current return (lines 159-213) wraps content in a `<TooltipProvider>` + `space-y-6` div with a card-shaped header (lines 163-170) + `<Tabs>` + `<PageTabBar>`.

Replace from `return (` down to the matching close with:

```tsx
const TAB_TO_SECTION: Record<string, TeamSectionId> = {
  org: "org-tree", agents: "agents", humans: "humans", teams: "teams",
};
const SECTION_TO_TAB: Record<TeamSectionId, TeamTab> = {
  "org-tree": "org", agents: "agents", humans: "humans", teams: "teams" as TeamTab,
};

return (
  <TooltipProvider>
    <TeamLayout
      activeSection={TAB_TO_SECTION[activeTab] ?? "org-tree"}
      onSectionChange={(id) => handleTabChange(SECTION_TO_TAB[id])}
      counts={{
        agents: agentsQuery.data?.length,
        humans: teamSummary?.members.length,
        teams: undefined, // wired in Task E2
      }}
    >
      {isLoading && <PageSkeleton variant={activeTab === "org" ? "org-chart" : "list"} />}
      {!isLoading && activeTab === "org" && (
        <OrgTreeTab orgTree={orgTreeQuery.data ?? []} pendingInvites={teamSummary?.pendingInvites}
          onNodeClick={handleNodeClick} onNodeAction={handleNodeAction} />
      )}
      {!isLoading && activeTab === "agents" && (
        <AgentsTab agents={agentsQuery.data ?? []} orgTree={orgTreeQuery.data ?? []}
          highlightId={highlightId} permissions={{ isFounder: role === "founder" }}
          onMutationSuccess={invalidateAll} />
      )}
      {!isLoading && activeTab === "humans" && teamSummary && (
        <HumansTab teamSummary={teamSummary} highlightId={highlightId} permissions={permissions}
          isSystemAdmin={teamSummary.currentUser?.isSystemAdmin ?? false}
          onMutationSuccess={invalidateAll} />
      )}
      {/* "teams" section wired in Task E1 */}
    </TeamLayout>
  </TooltipProvider>
);
```

Also extend `VALID_TABS` to include `"teams"`:

```tsx
const VALID_TABS = ["org", "agents", "humans", "teams"] as const;
```

Add the imports at the top of the file:

```tsx
import { TeamLayout, type TeamSectionId } from "@/components/team/TeamLayout";
```

Remove the unused `Tabs` and `PageTabBar` imports (they're no longer needed).

- [ ] **Step 2: Run the existing TeamPage test**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamPage.test.tsx
```

Existing tests should still pass (the component output changes shape, but the visible labels and click handlers don't). If any test asserts on the specific card-shaped header text, update it to assert on the same text rendered via `TeamLayout`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/TeamPage.tsx
git commit -m "refactor(team): wrap TeamPage in TeamLayout, drop card-shaped header"
```

---

## Phase B — Org Tree polish

### Task B1: Add hex variants to `status-colors` and tokenize the org canvas dots

**Files:**
- Modify: `ui/src/lib/status-colors.ts`
- Modify: `ui/src/components/team/OrgTreeTab.tsx:157-165`
- Test: `ui/src/__tests__/status-colors.test.ts` (create)

- [ ] **Step 1: Write a failing test for the hex map**

Create `ui/src/__tests__/status-colors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { agentStatusDotHex, agentStatusDotHexDefault } from "@/lib/status-colors";

describe("agentStatusDotHex", () => {
  it("returns the canonical hex for each known status", () => {
    expect(agentStatusDotHex.running).toBe("#22d3ee"); // cyan-400
    expect(agentStatusDotHex.active).toBe("#4ade80");  // green-400
    expect(agentStatusDotHex.paused).toBe("#facc15");  // yellow-400
    expect(agentStatusDotHex.idle).toBe("#facc15");
    expect(agentStatusDotHex.error).toBe("#f87171");   // red-400
    expect(agentStatusDotHex.terminated).toBe("#a3a3a3");
  });

  it("exposes a default for unknown statuses", () => {
    expect(agentStatusDotHexDefault).toBe("#a3a3a3");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter ui test --run ui/src/__tests__/status-colors.test.ts
```

- [ ] **Step 3: Add the hex variants in `ui/src/lib/status-colors.ts`**

Append:

```ts
// Hex variants for inline-style consumers (e.g., SVG fills, absolute-positioned
// canvas dots). Keep in sync with the Tailwind `agentStatusDot` map above —
// the mapping is `bg-cyan-400` ↔ `#22d3ee` etc.
export const agentStatusDotHex: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
export const agentStatusDotHexDefault = "#a3a3a3";
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter ui test --run ui/src/__tests__/status-colors.test.ts
```

- [ ] **Step 5: Replace the inline `statusDotColor` map in `OrgTreeTab.tsx`**

In `ui/src/components/team/OrgTreeTab.tsx`, delete lines 157-165:

```ts
const statusDotColor: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#facc15",
  idle: "#facc15",
  error: "#f87171",
  terminated: "#a3a3a3",
};
const defaultDotColor = "#a3a3a3";
```

Replace with an import at the top:

```ts
import { agentStatusDotHex, agentStatusDotHexDefault } from "../../lib/status-colors";
```

Update the single use site (currently around line 551):

```ts
const dotColor = agentStatusDotHex[node.status] ?? agentStatusDotHexDefault;
```

- [ ] **Step 6: Run the existing OrgTreeTab test**

```bash
pnpm --filter ui test --run ui/src/__tests__/OrgTreeTab.test.tsx
```

Should still pass — the rendered colors are identical bytes, just sourced from a single export.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/status-colors.ts ui/src/components/team/OrgTreeTab.tsx ui/src/__tests__/status-colors.test.ts
git commit -m "refactor(team): tokenize org-tree status dot colors via shared status-colors map"
```

---

### Task B2: Convert org-tree zoom controls to `<Button>` components

**Files:**
- Modify: `ui/src/components/team/OrgTreeTab.tsx:462-486`

- [ ] **Step 1: Replace the bare `<button>` zoom controls**

In `ui/src/components/team/OrgTreeTab.tsx`, find the block at lines 463-486 (zoom-in / zoom-out / fit). Replace it with:

```tsx
<div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
  <Button variant="outline" size="icon-xs" onClick={() => zoomTo(1.2)} aria-label="Zoom in">
    <Plus className="h-3.5 w-3.5" />
  </Button>
  <Button variant="outline" size="icon-xs" onClick={() => zoomTo(0.8)} aria-label="Zoom out">
    <Minus className="h-3.5 w-3.5" />
  </Button>
  <Button variant="outline" size="icon-xs" onClick={fitToScreen} aria-label="Fit chart to screen" title="Fit to screen">
    <Maximize2 className="h-3.5 w-3.5" />
  </Button>
</div>
```

Ensure `Button` is imported from `@/components/ui/button` and `Plus, Minus, Maximize2` from `lucide-react`. The existing imports already have `MoreVertical` from lucide — extend that line.

- [ ] **Step 2: Run the existing OrgTreeTab test**

```bash
pnpm --filter ui test --run ui/src/__tests__/OrgTreeTab.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/OrgTreeTab.tsx
git commit -m "refactor(team): use Button component for org-tree zoom controls"
```

---

### Task B3: Replace hand-rolled Chief of Staff badge with `<Badge>`

**Files:**
- Modify: `ui/src/components/team/OrgTreeTab.tsx:580-587`

- [ ] **Step 1: Replace the Chief of Staff `<span>` with `<Badge>`**

In `ui/src/components/team/OrgTreeTab.tsx`, find lines 580-587:

```tsx
<span
  className="absolute -top-2.5 left-3 rounded bg-amber-500 text-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide shadow-sm"
  aria-label="Chief of Staff (apex executive)"
>
  ⭐ Chief of Staff
</span>
```

Replace with:

```tsx
<Badge
  variant="secondary"
  className="absolute -top-2.5 left-3 bg-amber-500 text-white border-0 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide shadow-sm"
  aria-label="Chief of Staff (apex executive)"
>
  <Star className="h-2.5 w-2.5 mr-1" />
  Chief of Staff
</Badge>
```

Ensure `Badge` is imported from `@/components/ui/badge` and `Star` from `lucide-react`.

- [ ] **Step 2: Run the existing OrgTreeTab test**

```bash
pnpm --filter ui test --run ui/src/__tests__/OrgTreeTab.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/OrgTreeTab.tsx
git commit -m "refactor(team): use Badge component for Chief of Staff marker"
```

---

### Task B4: Consolidate `getInitials` / `deriveInitials` into `lib/initials.ts`

**Files:**
- Create: `ui/src/lib/initials.ts`
- Create: `ui/src/__tests__/initials.test.ts`
- Modify: `ui/src/components/team/OrgTreeTab.tsx:648-655` (delete + import)
- Modify: `ui/src/components/team/HumansTab.tsx:61-65` (delete + import)

- [ ] **Step 1: Write tests for the consolidated util**

Create `ui/src/__tests__/initials.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getInitials } from "@/lib/initials";

describe("getInitials", () => {
  it("returns first letter of two words", () => {
    expect(getInitials("Tandav Krishna")).toBe("TK");
  });
  it("returns first + last letter for 3+ word names", () => {
    expect(getInitials("Sam Marquez Jr")).toBe("SJ");
  });
  it("falls back to first 2 letters when only one word", () => {
    expect(getInitials("Maya")).toBe("MA");
  });
  it("returns empty string for empty input", () => {
    expect(getInitials("")).toBe("");
  });
  it("uppercases output", () => {
    expect(getInitials("alice bob")).toBe("AB");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter ui test --run ui/src/__tests__/initials.test.ts
```

- [ ] **Step 3: Implement `lib/initials.ts`**

Create `ui/src/lib/initials.ts`:

```ts
/**
 * Derive 1–2 character initials from a display name.
 * - Two or more words → first letter of first word + first letter of last word
 * - Single word → first two letters of the word
 * - Empty string → empty string
 * Always uppercases the result.
 */
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return parts[0].slice(0, 2).toUpperCase();
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter ui test --run ui/src/__tests__/initials.test.ts
```

- [ ] **Step 5: Replace the duplicates**

In `ui/src/components/team/OrgTreeTab.tsx`, delete lines 648-655 (the `getInitials` function) and add at the top:

```ts
import { getInitials } from "../../lib/initials";
```

In `ui/src/components/team/HumansTab.tsx`, delete the `deriveInitials` function (around lines 61-65) and update its single call site (around line 79) from `deriveInitials(displayName)` to `getInitials(displayName)`. Add the same import.

- [ ] **Step 6: Run the surrounding tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/OrgTreeTab.test.tsx ui/src/__tests__/TeamPage.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/initials.ts ui/src/__tests__/initials.test.ts ui/src/components/team/OrgTreeTab.tsx ui/src/components/team/HumansTab.tsx
git commit -m "refactor(team): consolidate getInitials/deriveInitials into lib/initials"
```

---

### Task B5: Use `<EmptyState>` in `OrgTreeTab` empty branch

**Files:**
- Modify: `ui/src/components/team/OrgTreeTab.tsx:439-448`

- [ ] **Step 1: Replace inline empty JSX with `<EmptyState>`**

In `ui/src/components/team/OrgTreeTab.tsx`, find lines 439-448:

```tsx
if (orgTree.length === 0) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="org-tree-empty">
      <Network className="h-10 w-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">
        Add agents and invite teammates to build your org chart
      </p>
    </div>
  );
}
```

Replace with:

```tsx
if (orgTree.length === 0) {
  return (
    <EmptyState
      icon={Network}
      title="Build your org"
      description="Start by hiring an agent or inviting a teammate. Both will appear here automatically."
      data-testid="org-tree-empty"
    />
  );
}
```

Add the import:

```ts
import { EmptyState } from "@/components/ui/empty-state";
```

If the existing `<EmptyState>` API differs (check `ui/src/components/ui/empty-state.tsx`), adapt the prop names but keep the icon + title + description semantics.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/OrgTreeTab.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/OrgTreeTab.tsx
git commit -m "refactor(team): use shared EmptyState in OrgTreeTab"
```

---

## Phase C — Agents tab

### Task C1: Detach `TeamsSection` from `AgentsTab`

**Files:**
- Modify: `ui/src/components/team/AgentsTab.tsx:163-219`

- [ ] **Step 1: Remove `TeamsSection` rendering from both empty + populated branches**

In `ui/src/components/team/AgentsTab.tsx`:

1. Remove the import: delete `import { TeamsSection } from "./TeamsSection";`.
2. In the empty branch (around line 161-193), delete the `<TeamsSection />` element.
3. In the main branch (around line 198), delete the `<TeamsSection />` element.

The "Individual agents" `<section>` wrapper can also collapse — there's no longer a sibling section to differentiate it from. Drop the `<section>` + `<header>` wrapper entirely; `AgentsTab` now renders just the agents grid (and confirmation dialog).

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentsTab.test.tsx
```

If a test asserts on the "Teams" header text, that assertion should be moved to the new TeamsListPage test in Task E2.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/AgentsTab.tsx
git commit -m "refactor(team): detach TeamsSection from AgentsTab (Teams becomes peer nav)"
```

---

### Task C2: Replace inline agent card markup with shared `<AgentCard>`

**Files:**
- Modify: `ui/src/components/team/AgentsTab.tsx:222-368`

- [ ] **Step 1: Replace the inline grid with `<AgentCard>` consumers**

In `ui/src/components/team/AgentsTab.tsx`, the current loop renders a hand-rolled card (lines 222-368). Replace the entire `<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">…</div>` block with:

```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {agents.map((agent) => {
    const isHighlighted = agent.id === highlightId;
    const score = trustScores?.get(agent.id) ?? null;
    return (
      <div
        key={agent.id}
        ref={isHighlighted ? highlightRef : undefined}
        className={cn(isHighlighted && "ring-2 ring-primary rounded-lg")}
        data-testid={`agent-card-${agent.id}`}
      >
        <AgentCard agent={agent} trustScore={score} />
      </div>
    );
  })}
</div>
```

Add the import:

```ts
import { AgentCard } from "../AgentCard";
```

Drop now-unused imports: `Bot`, `Edit2`, `MoreHorizontal`, `Pause`, `Play`, `XCircle`, `User`, `StatusBadge`, `TrustScoreBadge`, `AgentIcon`, `formatCents`, the `pauseResume` mutation, `handleEdit`, `parentNameMap`. Confirm-action dialog state stays — those mutations live in this file because the `MoreMenu` lives inside `AgentCard` and triggers via callback. **Important:** verify whether `AgentCard` already exposes the terminate/delete actions internally (read `ui/src/components/AgentCard.tsx`); if it does, drop the `confirmAction` state + `terminateAgent` + `deleteAgent` mutations + `<ConfirmActionDialog>` from this file too.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentsTab.test.tsx ui/src/__tests__/AgentCard.test.tsx
```

If `AgentsTab.test.tsx` asserts on specific markup that no longer exists (e.g., the inline pause/edit buttons), update those assertions to query through `AgentCard`'s rendered output (e.g., `screen.getByRole("button", { name: /pause/i })`).

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/AgentsTab.tsx
git commit -m "refactor(team): use shared AgentCard in AgentsTab grid"
```

---

### Task C3: Use `<EmptyState>` in `AgentsTab` empty branch

**Files:**
- Modify: `ui/src/components/team/AgentsTab.tsx` (the empty-branch return after C1's section-wrapper removal)

- [ ] **Step 1: Replace the empty-state JSX**

The empty branch (after C1, this is the early-return when `agents.length === 0`) currently renders a hand-rolled icon + text + button. Replace with:

```tsx
if (agents.length === 0) {
  return (
    <EmptyState
      icon={Bot}
      title="No agents yet"
      description="Hire your first agent. Pick a Claude / Codex / OpenClaw adapter and assign a role."
      action={permissions.isFounder ? { label: "New agent", onClick: openNewAgent } : undefined}
    />
  );
}
```

Add the import:

```ts
import { EmptyState } from "@/components/ui/empty-state";
import { Bot } from "lucide-react";
```

Adapt prop names to whatever `EmptyState`'s actual API is (read `ui/src/components/ui/empty-state.tsx` once before writing).

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentsTab.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/AgentsTab.tsx
git commit -m "refactor(team): use EmptyState in AgentsTab empty branch"
```

---

## Phase D — Humans tab

### Task D1: Extract `<RoleBadge>` primitive

**Files:**
- Create: `ui/src/components/team/RoleBadge.tsx`
- Create: `ui/src/components/team/__tests__/RoleBadge.test.tsx`

- [ ] **Step 1: Write a failing test**

Create `ui/src/components/team/__tests__/RoleBadge.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { RoleBadge } from "../RoleBadge";

it("renders the human-readable label for each role", () => {
  render(<><RoleBadge role="founder" /><RoleBadge role="team_lead" /><RoleBadge role="team_member" /></>);
  expect(screen.getByText("Founder")).toBeInTheDocument();
  expect(screen.getByText("Team Lead")).toBeInTheDocument();
  expect(screen.getByText("Team Member")).toBeInTheDocument();
});

it("uses role-specific styling classes", () => {
  const { rerender, container } = render(<RoleBadge role="founder" />);
  expect(container.firstChild).toHaveClass(/emerald/);
  rerender(<RoleBadge role="team_lead" />);
  expect(container.firstChild).toHaveClass(/amber/);
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter ui test --run ui/src/components/team/__tests__/RoleBadge.test.tsx
```

- [ ] **Step 3: Implement `RoleBadge`**

Create `ui/src/components/team/RoleBadge.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { UserRole } from "@armyofagents/shared";

const ROLE_STYLES: Record<UserRole, string> = {
  founder: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  team_lead: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  team_member: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

const ROLE_LABELS: Record<UserRole, string> = {
  founder: "Founder",
  team_lead: "Team Lead",
  team_member: "Team Member",
};

interface RoleBadgeProps {
  role: UserRole;
  className?: string;
}

export function RoleBadge({ role, className }: RoleBadgeProps) {
  return (
    <Badge variant="secondary" className={cn("border-0 text-[10px]", ROLE_STYLES[role], className)}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter ui test --run ui/src/components/team/__tests__/RoleBadge.test.tsx
```

- [ ] **Step 5: Migrate `HumansTab` to use `<RoleBadge>`**

In `ui/src/components/team/HumansTab.tsx`:

1. Delete the `ROLE_STYLES` constant (lines 21-25). Keep `ROLE_LABELS` (it's reused by `PendingInvitesSection`).
2. Replace the `<Badge>` inside `MemberCard` (around line 121-123) with:
   ```tsx
   <RoleBadge role={member.role} />
   ```
3. Add the import: `import { RoleBadge } from "./RoleBadge";`

- [ ] **Step 6: Run tests**

```bash
pnpm --filter ui test --run ui/src/components/team/__tests__/RoleBadge.test.tsx ui/src/__tests__/TeamPage.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/team/RoleBadge.tsx ui/src/components/team/__tests__/RoleBadge.test.tsx ui/src/components/team/HumansTab.tsx
git commit -m "feat(team): extract RoleBadge primitive, migrate HumansTab"
```

---

### Task D2: Drop the card-shaped header + nested invite-card from `HumansTab`

**Files:**
- Modify: `ui/src/components/team/HumansTab.tsx:182-239,272-302`

- [ ] **Step 1: Replace the page-card header with `<PageHeader>`**

In `ui/src/components/team/HumansTab.tsx`, find the outer wrapper at lines 272-302:

```tsx
<div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
  <div className="space-y-1">
    <h2 className="text-lg font-semibold">Team Members</h2>
    <p className="text-sm text-muted-foreground">…</p>
  </div>
  <div className="flex gap-2">…buttons…</div>
</div>
```

Replace with:

```tsx
<PageHeader
  breadcrumb={<>Team · Workforce</>}
  title="Humans"
  subtitle="Roles, reporting structure, and invites for human collaborators."
  primaryAction={
    <PermissionDisabledButton disabled={!permissions.canInviteUsers} tooltip="You don't have permission to add members">
      <Button onClick={() => setAddMemberOpen(true)} disabled={!permissions.canInviteUsers}>
        <UserPlus className="mr-1.5 h-4 w-4" />
        Add Member
      </Button>
    </PermissionDisabledButton>
  }
  secondaryAction={
    isSystemAdmin ? (
      <Button variant="outline" onClick={() => setTransferAdminOpen(true)}>
        <ArrowRightLeft className="mr-1.5 h-4 w-4" />
        Transfer Admin
      </Button>
    ) : null
  }
/>
```

Add the import: `import { PageHeader } from "@/components/PageHeader";`.

- [ ] **Step 2: Replace the nested-card pending invites with an inline list**

Find `PendingInvitesSection` (around lines 146-238). Replace its outer wrapper (currently `<div className="rounded-2xl border border-border bg-card p-5">…</div>`) with:

```tsx
<div className="px-6">
  <div className="flex items-center justify-between mb-3">
    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
      Pending invites <span className="ml-1 font-mono text-[10px]">{pendingInvites.length}</span>
    </h3>
  </div>
  <div className="rounded-md border border-border overflow-hidden">
    {pendingInvites.map((invite) => (
      <div key={invite.id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-b-0">
        {/* keep the existing per-row contents — email, role/dept, expires, resend/revoke buttons */}
        …existing row body…
      </div>
    ))}
  </div>
</div>
```

The body of each row (email, role, expires, action buttons) stays — only the wrapper chrome changes.

- [ ] **Step 3: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamPage.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/team/HumansTab.tsx
git commit -m "refactor(team): use PageHeader, inline pending invites in HumansTab"
```

---

## Phase E — Teams promotion

### Task E1: Create `TeamsListPage` (lift `TeamsSection`)

**Files:**
- Create: `ui/src/pages/TeamsListPage.tsx`
- Delete: `ui/src/components/team/TeamsSection.tsx`
- Modify: `ui/src/pages/TeamPage.tsx` (render `<TeamsListPage>` for the `teams` tab)

- [ ] **Step 1: Copy `TeamsSection` body into `TeamsListPage` with a real header**

Read the current `ui/src/components/team/TeamsSection.tsx` to grab its query logic + grid markup.

Create `ui/src/pages/TeamsListPage.tsx` with:

```tsx
import { useState } from "react";
import { Plus, UsersRound, Workflow } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { teamsApi } from "../api/teams";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { TeamCard } from "../components/team/TeamCard";
import { NewTeamEntryDialog } from "../components/team/NewTeamEntryDialog";

export function TeamsListPage() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [entryOpen, setEntryOpen] = useState(false);

  const teamsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.teams.list(selectedCompanyId) : ["teams", "none"],
    queryFn: () => teamsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const projectsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const teams = teamsQuery.data?.items ?? [];

  return (
    <>
      <PageHeader
        breadcrumb={<>Team · Workforce</>}
        title="Teams"
        subtitle="Group agents into squads with shared context, budgets, and pipelines."
        primaryAction={
          <Button onClick={() => setEntryOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Build a team
          </Button>
        }
      />

      {teams.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No teams yet"
          description="Group agents into squads with shared context, budgets, and pipelines."
          action={{ label: "Build a team", onClick: () => setEntryOpen(true) }}
        />
      ) : (
        <div className="px-6 py-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {teams.map((team, idx) => (
            <TeamCard
              key={team.id}
              team={team}
              colorIdx={idx}
              onClick={() => navigate(`/team/teams/${team.slug}`)}
            />
          ))}
        </div>
      )}

      <NewTeamEntryDialog
        open={entryOpen}
        onOpenChange={setEntryOpen}
        projects={projectsQuery.data ?? []}
      />
    </>
  );
}
```

(Adapt to the existing `TeamCard` and `NewTeamEntryDialog` signatures; check those files for the exact prop names if they differ.)

- [ ] **Step 2: Wire `<TeamsListPage>` into `TeamPage`**

Open `ui/src/pages/TeamPage.tsx`. Add the import:

```ts
import { TeamsListPage } from "./TeamsListPage";
```

Inside the `<TeamLayout>` body (from Task A3), add the new branch:

```tsx
{!isLoading && activeTab === "teams" && <TeamsListPage />}
```

- [ ] **Step 3: Delete `ui/src/components/team/TeamsSection.tsx`**

```bash
git rm ui/src/components/team/TeamsSection.tsx
```

If any test references it (`ui/src/__tests__/AgentsTab.test.tsx` likely does), remove those references — TeamsSection is gone.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamPage.test.tsx ui/src/__tests__/AgentsTab.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/TeamsListPage.tsx ui/src/pages/TeamPage.tsx ui/src/components/team/TeamsSection.tsx
git commit -m "feat(team): promote Teams to peer nav with TeamsListPage"
```

---

### Task E2: Wire teams count into `TeamLayout`

**Files:**
- Modify: `ui/src/pages/TeamPage.tsx`

- [ ] **Step 1: Add a teams count query**

In `ui/src/pages/TeamPage.tsx`, add after the existing `agentsQuery`:

```tsx
const teamsQuery = useQuery({
  queryKey: selectedCompanyId ? queryKeys.teams.list(selectedCompanyId) : ["teams", "none"],
  queryFn: () => teamsApi.list(selectedCompanyId!),
  enabled: Boolean(selectedCompanyId),
});
```

Update the `counts` prop in the `<TeamLayout>` invocation:

```tsx
counts={{
  agents: agentsQuery.data?.length,
  humans: teamSummary?.members.length,
  teams: teamsQuery.data?.items.length,
}}
```

Also extend `invalidateAll` to invalidate the teams list:

```tsx
queryClient.invalidateQueries({ queryKey: queryKeys.teams.list(selectedCompanyId) });
```

Add the import:

```ts
import { teamsApi } from "../api/teams";
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamPage.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/TeamPage.tsx
git commit -m "feat(team): wire teams count into TeamLayout sidebar"
```

---

### Task E3: Drop the marketplace card from `NewTeamEntryDialog`

**Files:**
- Modify: `ui/src/components/team/NewTeamEntryDialog.tsx`

- [ ] **Step 1: Find and remove the marketplace card**

Open `ui/src/components/team/NewTeamEntryDialog.tsx`. Locate the third entry card (currently labeled "Browse marketplace" with a SOON badge and `disabled` cursor). Delete that card's JSX block entirely.

Update the surrounding grid container className from `grid-cols-3` to `grid-cols-2`.

Append a small contextual note below the chooser:

```tsx
<p className="text-xs text-muted-foreground mt-3 text-center">
  Browse the marketplace from the main Marketplace page — pre-built teams will appear there once published.
</p>
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamPage.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/NewTeamEntryDialog.tsx
git commit -m "refactor(team): drop SOON marketplace card from NewTeamEntryDialog"
```

---

### Task E4: Strip the "Create new" path from `BuildFromScratchForm`

**Files:**
- Modify: `ui/src/components/team/BuildFromScratchForm.tsx`
- Modify: `ui/src/components/team/MemberRow.tsx`
- Modify: `server/src/services/teams.ts` (remove `newAgents` transaction path)
- Modify: `server/src/__tests__/teams.test.ts` (drop tests for the deleted path)

- [ ] **Step 1: Audit the existing form for the discriminated union**

Read `ui/src/components/team/BuildFromScratchForm.tsx` and `MemberRow.tsx`. Identify:
- The state shape (likely something like `{ kind: "existing" | "new"; agentId?: string; name?: string; adapter?: string; skills?: string }`)
- The "Create new" button handler (likely `setMembers([...members, makeDraftNew()])`)
- The skills comma-sep input
- The adapter inline picker
- Where the form payload is split into `existingAgentIds` and `newAgents` arrays

- [ ] **Step 2: Collapse `MemberRow` to existing-only**

In `ui/src/components/team/MemberRow.tsx`, change the discriminated union to a single shape:

```ts
export interface TeamMemberDraft {
  agentId: string;
  agentName: string;
  agentIcon?: string | null;
  agentStatus?: string;
  role: "lead" | "member";
}
```

Remove all branches that handle the `"new"` kind (skills input, adapter dropdown, name input). The row reduces to: avatar + name + EXISTING badge + role select + remove button.

- [ ] **Step 3: Strip "Create new" from the form**

In `BuildFromScratchForm.tsx`:
- Remove the "Create new" button from the members section header.
- Replace it with a single "Pick existing" button that opens the existing-agent picker.
- Remove all `makeDraftNew()` callsites.
- Remove the `newAgents` field from the form payload — only `existingAgentIds` (with role) is sent.

- [ ] **Step 4: Simplify the server-side `teams.create()`**

In `server/src/services/teams.ts`, find the `create` function (search for `newAgents` to locate it). Remove:
- The `newAgents` argument from the input type.
- The atomic transaction block that creates agents inline.
- The agent-creation imports if they're now unused.

The function reduces to: insert team row, insert team_members rows, optionally trigger `regenerateCoordination`. All inside one transaction.

- [ ] **Step 5: Update server tests**

In `server/src/__tests__/teams.test.ts`, remove tests for the deleted "creates inline agents atomically" path. Add a test confirming the simplified path still works:

```ts
it("creates a team with existing agents and skips the inline-create path", async () => {
  const result = await teamsService.create({
    companyId: company.id,
    name: "Engineering",
    parentProjectId: dept.id,
    existingAgentIds: [{ agentId: agent.id, role: "lead" }],
  });
  expect(result.team.name).toBe("Engineering");
  const members = await teamsService.listMembers(result.team.id);
  expect(members.items).toHaveLength(1);
  expect(members.items[0].agentId).toBe(agent.id);
});
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamPage.test.tsx
pnpm --filter server test --run server/src/__tests__/teams.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/team/BuildFromScratchForm.tsx ui/src/components/team/MemberRow.tsx server/src/services/teams.ts server/src/__tests__/teams.test.ts
git commit -m "refactor(team): pick-existing only, drop inline agent creation in team builder"
```

---

### Task E5: Add Edit toggle to Coordination tab

**Files:**
- Modify: `ui/src/components/team/CoordinationEditor.tsx`

- [ ] **Step 1: Read the current editor structure**

Open `ui/src/components/team/CoordinationEditor.tsx`. Likely the component renders an editable textarea + preview side-by-side unconditionally.

- [ ] **Step 2: Add an `editing` state with default `false`**

```tsx
const [editing, setEditing] = useState(false);
```

- [ ] **Step 3: Render preview-only by default, source/preview split when editing**

Wrap the existing source pane in `{editing && (...)}`. Add a header row above the editor:

```tsx
<div className="flex items-center justify-between mb-3">
  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
    coordination.md
  </span>
  <Button
    variant={editing ? "default" : "outline"}
    size="sm"
    onClick={() => setEditing((v) => !v)}
  >
    <Edit2 className="h-3.5 w-3.5 mr-1.5" />
    {editing ? "Done" : "Edit"}
  </Button>
</div>
```

When `editing` is `false`, render the markdown preview full-width. When `true`, render the existing source/preview 2-col layout.

Add imports:

```ts
import { Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamDetail.smoke.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/team/CoordinationEditor.tsx
git commit -m "feat(team): preview-default Coordination tab with Edit toggle"
```

---

### Task E6: Update `TeamDetail` page header to use `<PageHeader>`

**Files:**
- Modify: `ui/src/pages/TeamDetail.tsx`

- [ ] **Step 1: Replace the existing header with `<PageHeader>`**

Open `ui/src/pages/TeamDetail.tsx`. Find the current page header rendering (look for `<h1>` or the team title block — it's the area that currently shows the team name and the `<PageTabBar>`). Replace with:

```tsx
<PageHeader
  breadcrumb={<>Team · Workforce · Teams</>}
  title={team.name}
  subtitle={`${memberCount} agents · led by ${lead?.agentName ?? "—"} · ${parentProjectName ?? "no department"}`}
  secondaryAction={
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm"><MoreHorizontal className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem className="text-destructive" onClick={() => dismantleMut.mutate()}>
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Dismantle team
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  }
/>
```

(Use the actual team data fields from `teamQuery.data` — check the file to map.)

The existing `<PageTabBar>` for Overview/Coordination/Manifest/Activity stays below the header.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamDetail.smoke.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/TeamDetail.tsx
git commit -m "refactor(team): use PageHeader on TeamDetail page"
```

---

## Phase F — Confirmation modals (severity split + consequence preview)

### Task F1: Split confirm dialog into amber Terminate / red Delete with consequence preview

**Files:**
- Modify: `ui/src/components/team/AgentsTab.tsx` (the `ConfirmActionDialog` component)
- Test: `ui/src/__tests__/AgentsTab.test.tsx` (add cases)

**Note:** if Task C2 moved confirm-action handling into `<AgentCard>`, do this work there instead.

- [ ] **Step 1: Write a failing test for type-to-confirm**

Append to `ui/src/__tests__/AgentsTab.test.tsx`:

```tsx
it("disables the Delete button until the agent name is typed", async () => {
  const user = userEvent.setup();
  // … render AgentsTab + open delete confirmation for "Atlas" …
  const deleteBtn = screen.getByRole("button", { name: /^Delete agent$/i });
  expect(deleteBtn).toBeDisabled();
  const input = screen.getByPlaceholderText("Atlas");
  await user.type(input, "Atlas");
  expect(deleteBtn).not.toBeDisabled();
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentsTab.test.tsx
```

- [ ] **Step 3: Implement the severity-split confirmation dialog**

Replace the existing `ConfirmActionDialog` in `AgentsTab.tsx` with:

```tsx
function ConfirmActionDialog({
  type, agentName, isPending, onConfirm, onCancel, isFounder,
}: {
  type: "terminate" | "delete"; agentName: string; isPending: boolean;
  onConfirm: () => void; onCancel: () => void; isFounder: boolean;
}) {
  const isTerminate = type === "terminate";
  const [confirmText, setConfirmText] = useState("");
  const canConfirm = isTerminate || confirmText === agentName;
  if (type === "delete" && !isFounder) return null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className={cn(
              "h-9 w-9 rounded-full flex items-center justify-center shrink-0",
              isTerminate
                ? "bg-amber-500/15 text-amber-500 border border-amber-500/30"
                : "bg-destructive/15 text-destructive border border-destructive/30",
            )}>
              {isTerminate ? <AlertCircle className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
            </div>
            <div className="flex-1">
              <DialogTitle>{isTerminate ? "Terminate agent?" : "Delete agent permanently?"}</DialogTitle>
              <DialogDescription className="mt-2">
                {isTerminate ? (
                  <><strong className="text-foreground">{agentName}</strong> will stop all work and cannot be resumed. In-flight tasks will be marked <code>cancelled</code>.</>
                ) : (
                  <>This will permanently delete <strong className="text-foreground">{agentName}</strong>. All historical runs, comments, and trust scores will be lost. <strong className="text-foreground">This cannot be undone.</strong></>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {isTerminate && (
          <div className="rounded-md border border-border bg-muted/30 p-3 mt-2 space-y-1.5 text-xs">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">What this affects</div>
            <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-destructive" /> In-flight tasks → cancelled</div>
            <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-yellow-500" /> Reports → reassigned to founder</div>
            <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" /> Memory items kept (working layer archived)</div>
          </div>
        )}

        {!isTerminate && (
          <div className="mt-3">
            <label className="text-xs text-muted-foreground">
              Type <code className="px-1 py-0.5 rounded bg-muted text-foreground">{agentName}</code> to confirm
            </label>
            <input
              type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
              placeholder={agentName} autoFocus
              className="mt-1.5 w-full h-9 px-3 rounded-md border border-destructive bg-background text-sm font-mono outline-none focus:ring-1 focus:ring-destructive"
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={isPending}>Cancel</Button>
          <Button
            variant={isTerminate ? "outline" : "destructive"}
            className={isTerminate ? "border-amber-500/40 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400" : ""}
            onClick={onConfirm}
            disabled={isPending || !canConfirm}
          >
            {isPending ? (isTerminate ? "Terminating…" : "Deleting…") : (isTerminate ? "Terminate" : "Delete agent")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Add imports: `AlertCircle, Trash2` from `lucide-react`.

- [ ] **Step 4: Run tests — expect PASS**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentsTab.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/team/AgentsTab.tsx ui/src/__tests__/AgentsTab.test.tsx
git commit -m "feat(team): split confirm dialog into amber Terminate / red Delete with type-to-confirm"
```

---

## Phase G — Agent slide-over (NEW)

### Task G1: Build `AgentDetailSheet` shell + NOW block

**Files:**
- Create: `ui/src/components/team/AgentDetailSheet.tsx`
- Create: `ui/src/__tests__/AgentDetailSheet.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `ui/src/__tests__/AgentDetailSheet.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDetailSheet } from "@/components/team/AgentDetailSheet";

const stubAgent = {
  id: "a1", name: "Maya", role: "cxo", title: "Chief of Staff",
  adapterType: "claude_local", status: "running",
  budgetMonthlyCents: 20000, parentId: null, icon: null,
} as any;

it("renders the agent name and Running status when open", () => {
  render(<AgentDetailSheet open={true} onOpenChange={vi.fn()} agent={stubAgent} />);
  expect(screen.getByText("Maya")).toBeInTheDocument();
  expect(screen.getByText(/Running/i)).toBeInTheDocument();
});

it("calls onOpenChange(false) when close button clicked", async () => {
  const user = userEvent.setup();
  const handler = vi.fn();
  render(<AgentDetailSheet open={true} onOpenChange={handler} agent={stubAgent} />);
  await user.click(screen.getByRole("button", { name: /close/i }));
  expect(handler).toHaveBeenCalledWith(false);
});

it("renders the NOW / TODAY / QUEUE / RECENT section labels", () => {
  render(<AgentDetailSheet open={true} onOpenChange={vi.fn()} agent={stubAgent} />);
  expect(screen.getByText(/Now/i)).toBeInTheDocument();
  expect(screen.getByText(/Today/i)).toBeInTheDocument();
  expect(screen.getByText(/Queue/i)).toBeInTheDocument();
  expect(screen.getByText(/Recent runs/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentDetailSheet.test.tsx
```

- [ ] **Step 3: Implement `AgentDetailSheet`**

Create `ui/src/components/team/AgentDetailSheet.tsx`:

```tsx
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pause, Play, X } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@armyofagents/shared";
import { agentsApi } from "../../api/agents";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { agentStatusDot, agentStatusDotDefault } from "../../lib/status-colors";
import { roleLabels } from "../agent-config-primitives";
import { AgentIcon } from "../AgentIconPicker";
import { agentUrl, cn, formatCents } from "../../lib/utils";

interface AgentDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
}

export function AgentDetailSheet({ open, onOpenChange, agent }: AgentDetailSheetProps) {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const isPaused = agent.status === "paused";
  const statusColor = agentStatusDot[agent.status] ?? agentStatusDotDefault;

  const dailyQuery = useQuery({
    queryKey: ["agent-daily", agent.id],
    queryFn: () => agentsApi.getDaily(agent.id),
    enabled: open && Boolean(selectedCompanyId),
  });

  const pauseResume = useMutation({
    mutationFn: () => isPaused ? agentsApi.resume(agent.id) : agentsApi.pause(agent.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    },
  });

  const daily = dailyQuery.data;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] p-0 flex flex-col">
        {/* Header */}
        <SheetHeader className="px-5 py-4 border-b border-border flex-row items-start gap-3 space-y-0">
          <div className="relative h-11 w-11 rounded-lg bg-accent flex items-center justify-center shrink-0">
            <AgentIcon icon={agent.icon} className="h-5 w-5" />
            <span className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card", statusColor)} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <SheetTitle className="text-base">{agent.name}</SheetTitle>
              <Badge variant="secondary" className="text-[10px]">{agent.status}</Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{roleLabels[agent.role] ?? agent.role}{agent.title ? ` · ${agent.title}` : ""}</div>
            <div className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">{agent.adapterType}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </SheetHeader>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* NOW */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
              Now {daily?.now ? `· ${daily.now.duration}` : ""}
            </h3>
            {daily?.now ? (
              <div className="rounded-lg border border-cyan-500/30 bg-card p-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{daily.now.taskKey}</span>
                  <span className="text-sm font-semibold flex-1">{daily.now.taskTitle}</span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground bg-muted px-2 py-1.5 rounded mt-2">
                  ▸ {daily.now.lastLogLine}
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-2 font-mono">
                  <span>turn {daily.now.turn} / {daily.now.maxTurns}</span>
                  <span>{formatCents(daily.now.spentCents)} spent</span>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
                Idle · no in-flight task
              </div>
            )}
          </section>

          {/* TODAY */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">Today</h3>
            <div className="grid grid-cols-4 gap-2">
              <StatTile label="Runs" value={daily?.today.runs ?? 0} />
              <StatTile label="Done" value={daily?.today.done ?? 0} />
              <StatTile label="Spend" value={formatCents(daily?.today.spentCents ?? 0)} />
              <StatTile label="Errors" value={daily?.today.errors ?? 0} tone={daily?.today.errors ? "error" : "ok"} />
            </div>
          </section>

          {/* QUEUE */}
          {daily?.queue && daily.queue.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                  Queue · {daily.queue.length} waiting
                </h3>
              </div>
              <div className="rounded-lg border border-border overflow-hidden">
                {daily.queue.slice(0, 3).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 px-3 py-2 border-b border-border-soft last:border-b-0 text-xs">
                    <span className="h-1.5 w-1.5 rounded-full bg-yellow-500" />
                    <span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
                    <span className="flex-1 truncate">{t.title}</span>
                    {t.priority === "high" && <Badge variant="secondary" className="text-[9px] bg-amber-100 text-amber-800">High</Badge>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* RECENT */}
          {daily?.recent && daily.recent.length > 0 && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">Recent runs</h3>
              <div className="rounded-lg border border-border overflow-hidden">
                {daily.recent.slice(0, 5).map((r) => (
                  <div key={r.id} className="flex items-center gap-2 px-3 py-2 border-b border-border-soft last:border-b-0 text-xs">
                    <span className={cn("h-1.5 w-1.5 rounded-full", r.outcome === "succeeded" ? "bg-green-500" : "bg-red-500")} />
                    <span className="font-mono text-[10px] text-muted-foreground">{r.taskKey}</span>
                    <span className="flex-1 truncate">{r.taskTitle}</span>
                    <span className="text-[10px] text-muted-foreground">{r.relativeTime}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border flex gap-2 bg-muted/30">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => pauseResume.mutate()} disabled={pauseResume.isPending}>
            {isPaused ? <><Play className="h-3 w-3 mr-1.5" />Resume</> : <><Pause className="h-3 w-3 mr-1.5" />Pause</>}
          </Button>
          <Button variant="outline" size="sm" className="flex-1" onClick={() => navigate(`/issues?agentId=${agent.id}`)}>
            View tasks
          </Button>
          <Button size="sm" className="flex-[1.4]" onClick={() => navigate(agentUrl(agent))}>
            Open agent page →
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "error" }) {
  return (
    <div className="rounded-md bg-muted/40 border border-border-soft px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
      <div className={cn("text-base font-bold tabular-nums mt-0.5",
        tone === "error" && value !== 0 && "text-red-500",
        tone === "ok" && "text-green-500")}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentDetailSheet.test.tsx
```

(The test stubs `daily` as undefined since `useQuery` returns undefined on first render — sections that depend on it should not throw. The "renders the NOW / TODAY / QUEUE / RECENT section labels" test will need to either mock the query or we accept that QUEUE/RECENT only render when `daily` is loaded. Adjust the test to assert on NOW + TODAY only on first render, or use MSW to mock the API.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/team/AgentDetailSheet.tsx ui/src/__tests__/AgentDetailSheet.test.tsx
git commit -m "feat(team): add AgentDetailSheet daily-triage slide-over"
```

---

### Task G2: Add the `agentsApi.getDaily` endpoint

**Files:**
- Modify: `ui/src/api/agents.ts` (add `getDaily` method)
- Modify: `server/src/routes/agents.ts` (add `GET /agents/:id/daily` route)
- Create: `server/src/services/agentDaily.ts` (compose the daily-triage payload)
- Create: `server/src/__tests__/agentDaily.test.ts`

- [ ] **Step 1: Define the payload type**

In `packages/shared/src/agents.ts` (or wherever agent types live), add:

```ts
export interface AgentDailyPayload {
  now: {
    taskId: string;
    taskKey: string;
    taskTitle: string;
    duration: string;        // "2m 14s"
    lastLogLine: string;
    turn: number;
    maxTurns: number;
    spentCents: number;
  } | null;
  today: {
    runs: number;
    done: number;
    spentCents: number;
    errors: number;
  };
  queue: Array<{ id: string; key: string; title: string; priority?: "low" | "medium" | "high" | "critical" }>;
  recent: Array<{ id: string; taskId: string; taskKey: string; taskTitle: string; outcome: "succeeded" | "failed" | "cancelled"; relativeTime: string }>;
}
```

- [ ] **Step 2: Write a server-side service test**

Create `server/src/__tests__/agentDaily.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { computeAgentDaily } from "../services/agentDaily";
import { createSequenceDb } from "./helpers/db-mock"; // existing helper

describe("computeAgentDaily", () => {
  it("returns null for now when no in-flight run exists", async () => {
    const db = createSequenceDb([
      [],                              // no in-flight runs
      [{ runs: 8, done: 4, spentCents: 2400, errors: 0 }],  // today aggregates
      [],                              // no queued tasks
      [],                              // no recent runs
    ]);
    const result = await computeAgentDaily(db, "agent-1");
    expect(result.now).toBeNull();
    expect(result.today).toEqual({ runs: 8, done: 4, spentCents: 2400, errors: 0 });
  });

  it("includes the NOW block when an in-flight run exists", async () => {
    const db = createSequenceDb([
      [{ id: "run-1", taskId: "t1", taskKey: "PAP-241", taskTitle: "Refactor heartbeat dispatch",
         startedAt: new Date(Date.now() - 134_000), turn: 3, maxTurns: 80, spentCents: 12, lastLogLine: "Reading server/src/services/heartbeat.ts..." }],
      [{ runs: 8, done: 4, spentCents: 2400, errors: 0 }],
      [],
      [],
    ]);
    const result = await computeAgentDaily(db, "agent-1");
    expect(result.now?.taskKey).toBe("PAP-241");
    expect(result.now?.turn).toBe(3);
  });
});
```

- [ ] **Step 3: Implement `computeAgentDaily`**

Create `server/src/services/agentDaily.ts`:

```ts
import { eq, and, sql } from "drizzle-orm";
import { agentRuns, issues, db as defaultDb } from "@armyofagents/db";
import type { AgentDailyPayload } from "@armyofagents/shared";

export async function computeAgentDaily(db = defaultDb, agentId: string): Promise<AgentDailyPayload> {
  // 1. NOW — most recent in-flight run
  const inFlight = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), eq(agentRuns.status, "running")))
    .orderBy(sql`started_at DESC`).limit(1);

  // 2. TODAY — runs since midnight, aggregated
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayAgg = await db.select({
    runs: sql<number>`count(*)`,
    done: sql<number>`count(*) filter (where status = 'succeeded')`,
    spentCents: sql<number>`coalesce(sum(cost_cents), 0)`,
    errors: sql<number>`count(*) filter (where status = 'failed')`,
  }).from(agentRuns).where(and(
    eq(agentRuns.agentId, agentId),
    sql`started_at >= ${todayStart}`,
  ));

  // 3. QUEUE — pending tasks assigned to this agent
  const queue = await db.select({ id: issues.id, key: issues.key, title: issues.title, priority: issues.priority })
    .from(issues).where(and(eq(issues.agentId, agentId), eq(issues.status, "todo")))
    .orderBy(sql`priority_rank desc, created_at asc`).limit(3);

  // 4. RECENT — last 5 completed runs
  const recent = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), sql`status in ('succeeded', 'failed', 'cancelled')`))
    .orderBy(sql`started_at DESC`).limit(5);

  // Compose payload (relative time + duration formatting)
  return {
    now: inFlight[0] ? formatNow(inFlight[0]) : null,
    today: todayAgg[0],
    queue,
    recent: recent.map(formatRecent),
  };
}

function formatNow(run: any) {
  const elapsedMs = Date.now() - new Date(run.startedAt).getTime();
  return {
    taskId: run.taskId, taskKey: run.taskKey, taskTitle: run.taskTitle,
    duration: formatDuration(elapsedMs),
    lastLogLine: run.lastLogLine ?? "(no log line yet)",
    turn: run.turn, maxTurns: run.maxTurns,
    spentCents: run.spentCents,
  };
}

function formatRecent(run: any) {
  return {
    id: run.id, taskId: run.taskId, taskKey: run.taskKey, taskTitle: run.taskTitle,
    outcome: run.status, relativeTime: formatRelative(run.startedAt),
  };
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function formatRelative(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
```

(Adjust the `agentRuns` / `issues` table imports + columns to match the actual schema in `packages/db/src/schema/`. `lastLogLine` / `turn` / `maxTurns` may live on a different table — check `agent_runs.ts` schema and adapt.)

- [ ] **Step 4: Add the route**

In `server/src/routes/agents.ts`, add:

```ts
router.get("/:agentId/daily", requireBoardSession, async (req, res) => {
  const payload = await computeAgentDaily(db, req.params.agentId);
  res.json(payload);
});
```

- [ ] **Step 5: Add the API client**

In `ui/src/api/agents.ts`, add to the `agentsApi` object:

```ts
async getDaily(agentId: string): Promise<AgentDailyPayload> {
  return apiFetch(`/api/agents/${agentId}/daily`, { method: "GET" });
},
```

Add the import: `import type { AgentDailyPayload } from "@armyofagents/shared";`

- [ ] **Step 6: Run tests**

```bash
pnpm --filter server test --run server/src/__tests__/agentDaily.test.ts
pnpm --filter ui test --run ui/src/__tests__/AgentDetailSheet.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agents.ts server/src/services/agentDaily.ts server/src/routes/agents.ts server/src/__tests__/agentDaily.test.ts ui/src/api/agents.ts
git commit -m "feat(team): add /agents/:id/daily endpoint for slide-over triage data"
```

---

### Task G3: Wire `AgentCard` click → open `AgentDetailSheet`

**Files:**
- Modify: `ui/src/components/team/AgentsTab.tsx`

- [ ] **Step 1: Add slide-over state and override card click**

In `AgentsTab.tsx`, add:

```tsx
const [sheetAgent, setSheetAgent] = useState<Agent | null>(null);
```

Wrap each `<AgentCard>` from Task C2 with a click handler that opens the sheet instead of navigating:

```tsx
<div
  key={agent.id}
  onClick={(e) => { e.preventDefault(); setSheetAgent(agent); }}
  className={cn(/* … */)}
>
  <AgentCard agent={agent} trustScore={score} />
</div>
```

(`AgentCard` itself navigates on click — we need to either pass a `href` override or wrap with a stop-propagation click handler. Read `AgentCard.tsx` for the actual click target and adapt.)

Render the sheet at the bottom:

```tsx
{sheetAgent && (
  <AgentDetailSheet
    open={true}
    onOpenChange={(open) => { if (!open) setSheetAgent(null); }}
    agent={sheetAgent}
  />
)}
```

Add the import: `import { AgentDetailSheet } from "./AgentDetailSheet";`.

- [ ] **Step 2: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentsTab.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/team/AgentsTab.tsx
git commit -m "feat(team): open AgentDetailSheet on agent card click"
```

---

## Phase H — Bug fix

### Task H1: Fix duplicate "Test environment" button in `AgentConfigForm`

**Files:**
- Modify: `ui/src/components/AgentConfigForm.tsx:559,573`

- [ ] **Step 1: Read both render branches to understand which adapter triggers each**

Open `ui/src/components/AgentConfigForm.tsx`, jump to lines 555-580. Two `Test environment` buttons exist; identify the conditions guarding each (likely something like `adapterType === "claude_local"` for one and a more general `localAdapters.includes(adapterType)` for the other — the conditions overlap for `claude_local`, causing both to render).

- [ ] **Step 2: Consolidate to a single button**

Pick the version with the more inclusive condition (covers all local adapters that have a CLI test path) and delete the narrower duplicate. Move the button up to a single render site at the top of the adapter section so it doesn't depend on which sub-block is being rendered.

If the conditions are functionally different (e.g., one tests the CLI binary, one tests model availability), rename one to `Test connection` and the other to `Test models` — but only do that after grepping for actual differing implementations. If they're calling the same `testEnvironment.mutate()`, they're the same button.

- [ ] **Step 3: Add a regression test**

In `ui/src/__tests__/AgentConfigForm.test.tsx` (create if missing):

```tsx
it("renders only one Test environment button for claude_local", () => {
  render(<AgentConfigForm mode="create" values={{ ...defaults, adapterType: "claude_local" }} onChange={vi.fn()} />);
  const buttons = screen.getAllByRole("button", { name: /test environment/i });
  expect(buttons).toHaveLength(1);
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/AgentConfigForm.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/AgentConfigForm.tsx ui/src/__tests__/AgentConfigForm.test.tsx
git commit -m "fix(agent-config): render Test environment button only once per adapter"
```

---

## Phase I — Mobile pill row

### Task I1: Add the mobile sub-nav pill row to `TeamLayout`

**Files:**
- Modify: `ui/src/components/team/TeamLayout.tsx`

- [ ] **Step 1: Add the pill-row JSX**

In `TeamLayout.tsx`, replace the `{/* Mobile pill-row sub-nav (Phase I) — placeholder */}` line with:

```tsx
<div className="md:hidden border-b border-border-soft py-2 px-3 flex gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
  {sections.flatMap((g) => g.items).map((item) => {
    const active = item.active;
    return (
      <button
        key={item.id}
        type="button"
        onClick={item.onClick}
        className={cn(
          "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium border whitespace-nowrap",
          active
            ? "bg-brand/[0.12] border-brand/40 text-[hsl(15_60%_75%)]"
            : "bg-card border-border text-muted-foreground",
        )}
      >
        {item.icon && <span className="[&_svg]:size-3.5">{item.icon}</span>}
        {item.label}
      </button>
    );
  })}
</div>
```

(Wrap in a sibling `<div>` above the main content area so it shows on mobile only — `md:hidden`.)

Add the `cn` import.

- [ ] **Step 2: Add a mobile rendering test**

Append to `ui/src/__tests__/TeamLayout.test.tsx`:

```tsx
it("renders pill row buttons that fire onSectionChange", async () => {
  const user = userEvent.setup();
  const handler = vi.fn();
  renderLayout("org-tree", handler);
  // Pill row buttons share the same accessible name — pick the second one
  const buttons = screen.getAllByRole("button", { name: /Humans/i });
  await user.click(buttons[buttons.length - 1]);
  expect(handler).toHaveBeenCalledWith("humans");
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter ui test --run ui/src/__tests__/TeamLayout.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/team/TeamLayout.tsx ui/src/__tests__/TeamLayout.test.tsx
git commit -m "feat(team): add mobile pill-row sub-nav to TeamLayout"
```

---

## Deferred (not in this plan)

### New Agent modal redesign

The full redesign of `NewAgentDialog` (state 12 in the mockup) is **explicitly deferred**. Today the dialog renders all fields top-to-bottom in a single 580px column (`AgentConfigForm.tsx`). The mockup at `mockups/team-redesign.html#state-12` shows a 2-column layout (form left + live preview right) with grouped sections, an inline Test-environment status pill, and a resolved-details pane.

Reasons to defer:
- Touches a separate code path (`AgentConfigForm.tsx`, ~900 LOC) that's used by both the `NewAgentDialog` and the agent edit/configure flow at `/agents/:id/configure`. A standalone redesign session is the right shape.
- Phase H (Task H1) closes the most user-visible bug (duplicate Test environment button) without redesigning, so the dialog is left in a clean state.

When tackled, open a new plan: `docs/superpowers/plans/YYYY-MM-DD-new-agent-modal-redesign.md`.

---

## Self-Review

**Spec coverage:** 6 user-locked decisions × phases:
- Nav groups + Teams peer + `/team` rename → Phase A (A1, A2, A3, E1, E2)
- Page-header overhaul → A3, D2, E6
- Coordination edit button → E5
- Marketplace card drop → E3
- Pick-existing only → E4
- Confirm modal severity → F1
- Daily slide-over → G1, G2, G3
- Coordination/Manifest/Activity tabs → already in `TeamDetail.tsx` (no work needed; only header touch in E6)
- Test environment dupe fix → H1
- Mobile pill row → I1

**Placeholder scan:** Each task has real code or exact replacement targets. The two places that flag for inspection-before-implementation (rather than placeholders) are explicit:
- Task C2 step 1 — verify `AgentCard`'s internal action handling before duplicating mutations
- Task G2 step 3 — adapt the schema column references to the actual `agent_runs` schema

These are deliberate "read before writing" notes, not work-deferral.

**Type consistency:** `TeamSectionId` ("org-tree" | "agents" | "humans" | "teams") is defined once in `TeamLayout.tsx` and consumed in `TeamPage.tsx`. `AgentDailyPayload` is defined in `packages/shared/src/agents.ts` and consumed by the route, the service, and the slide-over — single source.

**Phase shippability:** Each phase ships standalone:
- Phase A alone replaces the chrome — fully usable with existing tabs
- Phase B–D are pure cosmetic / dedup — no behavior change
- Phase E adds the Teams promotion and locks the team-builder simplification
- Phase F is a UX win on destructive actions
- Phase G is the new feature (slide-over)
- Phases H + I are short polish passes

You can ship after any phase boundary.
