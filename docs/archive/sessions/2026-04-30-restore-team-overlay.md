# Restore Team Overlay on the Org Tree

> **For agentic workers:** small focused fix; can be implemented in one pass + reviewed afterwards. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the dashed-border colored box that visually frames each team's members on `/IMP/org` (and any other company's org route).

**Architecture:**
The overlay rendering currently lives in dead-code file `ui/src/pages/OrgChart.tsx` (no import path reaches it — tree-shaking strips it from every bundle). The route `<Route path="org" element={<TeamPage />} />` mounts `TeamPage` → `OrgTreeTab`, which was forked from `OrgChart` and **lost the overlay during the fork** (the comment `// Layout algorithm (reused from OrgChart.tsx)` confirms the lineage).

Plan: port the missing pieces into `OrgTreeTab.tsx`, then delete the orphan file. The overlay div is already implemented and reusable in `ui/src/components/team/TeamOrgOverlay.tsx`; only the `OrgTreeTab` component needs to fetch teams + memberships and call `computeTeamBoxes()`.

**Tech Stack:** React 18, react-query v5, Tailwind, shared tooling — no new dependencies.

---

## File Structure

| File | Action | Why |
|---|---|---|
| `ui/src/components/team/OrgTreeTab.tsx` | **Modify** — add overlay rendering | Active component at `/org` |
| `ui/src/components/team/TeamOrgOverlay.tsx` | Reuse as-is | Already reusable |
| `ui/src/components/team/teamBoundingBox.ts` | Reuse as-is | Pure function `computeTeamBoxes()` |
| `ui/src/api/teams.ts` | Reuse as-is | `teamsApi.list` + `teamsApi.listMembers` |
| `ui/src/lib/queryKeys.ts` | Reuse as-is | `queryKeys.teams.list` + `queryKeys.teams.members` |
| `ui/src/pages/OrgChart.tsx` | **Delete** | Orphan dead code |

## Decisions

1. **Color hashing util — inline into OrgTreeTab.** It's a 7-line stable hash (`hashStringToInt`) + a 6-color palette; not worth a new shared module, and OrgTreeTab is now the sole consumer.
2. **Data fetching — inline in OrgTreeTab, not lifted to TeamPage.** Keeps cohesion. OrgTreeTab already uses several context hooks; one `useCompany()` + two react-query calls won't change its shape meaningfully. If a future component needs the same memberships data, lift then — YAGNI today.
3. **Don't render the overlay for ghost (pending-invite) nodes.** Their IDs use the `ghost-` prefix and they have no real `team_members` row. `computeTeamBoxes` filters by `memberships.get(agentId) === team.id`, so ghosts naturally won't be in any team's box. No code change needed for that — just verify it.
4. **Render order:** overlay BEFORE cards in the same transformed container, so cards paint on top (later DOM siblings = higher z in normal flow). This matches what `OrgChart.tsx` did and is documented in its inline comment.
5. **No new tests.** OrgTreeTab has no existing test file, and the overlay is purely visual. Will verify via UI smoke (navigate to /IMP/org, confirm dashed boxes render with team names). If tests are wanted, they should be added in a follow-up RTL test for OrgTreeTab.

---

## Tasks

### Task 1: Port overlay rendering into OrgTreeTab

**Files:**
- Modify: `ui/src/components/team/OrgTreeTab.tsx`

- [ ] **Step 1: Add imports**

At the top of the file:
```tsx
import { useQuery, useQueries } from "@tanstack/react-query";
import { teamsApi } from "../../api/teams";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { TeamOrgOverlay } from "./TeamOrgOverlay";
import { computeTeamBoxes, type LaidOutCard } from "./teamBoundingBox";
```

- [ ] **Step 2: Add the color util (module-level, near `statusDotColor`)**

```tsx
// Stable team-overlay color palette. Keying by hash of `team.id` (rather
// than list position) means adding/removing teams doesn't recolor the others.
const TEAM_COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

function hashStringToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
```

- [ ] **Step 3: Inside `OrgTreeTab`, fetch teams + memberships**

Insert after the existing `edges` useMemo (around line 211):
```tsx
  // Team overlay data — teams + per-team members → memberships Map keyed by agentId.
  // Both queries are cheap; useQueries scales with team count.
  const { selectedCompanyId } = useCompany();

  const teamsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.teams.list(selectedCompanyId)
      : ["teams", "none"],
    queryFn: () => teamsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const teamItems = useMemo(
    () => teamsQuery.data?.items ?? [],
    [teamsQuery.data],
  );

  const memberQueries = useQueries({
    queries: teamItems.map((t) => ({
      queryKey: selectedCompanyId
        ? queryKeys.teams.members(selectedCompanyId, t.id)
        : ["teams", "none", t.id, "members"],
      queryFn: () => teamsApi.listMembers(t.id),
      enabled: Boolean(selectedCompanyId),
    })),
  });

  const memberships = useMemo(() => {
    const m = new Map<string, string>();
    teamItems.forEach((t, idx) => {
      const members = memberQueries[idx]?.data?.items ?? [];
      for (const mem of members) m.set(mem.agentId, t.id);
    });
    return m;
  }, [teamItems, memberQueries]);

  const teamMetas = useMemo(
    () =>
      teamItems.map((t) => ({
        id: t.id,
        name: t.name,
        color: TEAM_COLORS[hashStringToInt(t.id) % TEAM_COLORS.length]!,
      })),
    [teamItems],
  );

  const teamBoxes = useMemo(() => {
    const cards: LaidOutCard[] = allNodes.map((n) => ({
      agentId: n.id,
      x: n.x,
      y: n.y,
      w: CARD_W,
      h: CARD_H,
    }));
    return computeTeamBoxes(cards, memberships, teamMetas);
  }, [allNodes, memberships, teamMetas]);
```

- [ ] **Step 4: Render `<TeamOrgOverlay>` inside the card layer**

Locate the card layer JSX (around line 397-415):
```tsx
{/* Card layer */}
<div className="absolute inset-0" style={{...}}>
  {allNodes.map((node) => { ... })}
</div>
```

Insert overlay BEFORE the cards map:
```tsx
{/* Card layer */}
<div className="absolute inset-0" style={{...}}>
  {/* Team overlay — render BEFORE cards so cards paint on top of the
      framing box rather than the box covering them. */}
  <TeamOrgOverlay boxes={teamBoxes} />

  {allNodes.map((node) => { ... })}
</div>
```

- [ ] **Step 5: Verify build compiles**

Run from repo root:
```bash
pnpm -F ui build
```
Expected: build succeeds, bundle hash changes (different from current `index-Cqe80eYj.js`).

- [ ] **Step 6: Verify in browser**

Navigate to `/IMP/org`. Expected:
- Dashed colored box framing Maya + Sam + Felix + Ben + Quinn (Product Lifecycle Team)
- Dashed colored box framing Alice + Bob + Charlie (QA Team)
- Diana sits alone (Smoke Coord Team has only 1 member — overlay still renders, smaller box)
- Each box has a `⭐ TEAM_NAME` label at top-left
- Cards render on top of the boxes (not obscured)
- Different teams get different colors (deterministic from team id)

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/team/OrgTreeTab.tsx
git commit -m "fix(team): restore team overlay box on org tree

OrgChart.tsx was the original page component with overlay rendering, but
the route /:companyPrefix/org was rewired to TeamPage → OrgTreeTab in a
prior refactor. The fork carried over the layout algorithm (verified by
inline comment 'Layout algorithm (reused from OrgChart.tsx)') but
dropped the team-overlay code path, so the dashed colored box framing
each team's members never rendered.

Port the missing pieces into OrgTreeTab:
- teams + memberships fetch via useQuery/useQueries
- teamMetas with hash-based stable color
- computeTeamBoxes against laid-out cards
- TeamOrgOverlay rendered inside the transformed card layer, before
  the cards so they paint on top

Color hash util inlined (small, single consumer)."
```

---

### Task 2: Delete orphan OrgChart page

**Files:**
- Delete: `ui/src/pages/OrgChart.tsx`

- [ ] **Step 1: Confirm nothing imports it**

```bash
grep -rE "OrgChart" ui/src --include="*.tsx" --include="*.ts"
```
Expected: only the file's own self-references, plus the `// Layout algorithm (reused from OrgChart.tsx)` comment in OrgTreeTab. No `import` lines.

- [ ] **Step 2: Delete the file**

```bash
git rm ui/src/pages/OrgChart.tsx
```

- [ ] **Step 3: Update the OrgTreeTab inline comment**

In `ui/src/components/team/OrgTreeTab.tsx`, the comment `// Layout algorithm (reused from OrgChart.tsx)` is now stale. Either remove the parenthetical or change it to `// Layout algorithm — single owner of the org-tree rendering`. Pick one and update.

- [ ] **Step 4: Verify build still compiles**

```bash
pnpm -F ui build
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/OrgChart.tsx ui/src/components/team/OrgTreeTab.tsx
git commit -m "chore(team): drop orphan OrgChart.tsx page

OrgChart was the predecessor of TeamPage + OrgTreeTab. After the prior
refactor it had no remaining import path and was tree-shaken from every
bundle. Now that the team-overlay feature has been ported to its
successor, the file has no value beyond historical reference.

Update the 'reused from OrgChart' comment in OrgTreeTab so we don't
leave a dangling reference."
```

---

### Task 3: Code review

- [ ] Spec compliance: every step in Tasks 1+2 produced the change it claimed
- [ ] Code quality: imports correct, no unused variables, useMemo deps complete, no stale closures, no perf regressions
- [ ] No regressions: smoke test the org tree still renders cards, edges, drag-pan, zoom — same as before plus overlays
- [ ] Type-check passes: `pnpm -F ui exec tsc -b`

---

## Self-Review

**Spec coverage:** 3 tasks (port → delete orphan → review). All check.

**Placeholder scan:** None — every step has concrete code.

**Type consistency:** `LaidOutCard` matches `teamBoundingBox.ts`. `teamMetas` shape matches the `TeamMeta` interface. `TEAM_COLORS[...] ?? '#6366f1'` would be safer than `[...]!` if ESLint disallows non-null; but the modulo arithmetic guarantees a defined value, so `!` is safe and idiomatic here.

**Risk:** Low. The change is localized to one component; no schema, API, or business-logic changes. Worst case: overlay renders incorrectly, doesn't break agent execution or data integrity.
