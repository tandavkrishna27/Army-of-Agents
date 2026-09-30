# Lobby Redesign — Design Spec

> **Status:** awaiting user approval before implementation plan is written.
> **Branch context:** the redesign should ride on top of `feat/m4-plugin-management` after that branch merges `origin/main` (Sprints 1–5 security work). The lobby redesign itself is UI-only and does not depend on the security PRs, but they share the `ui/` package — merging main first avoids stacked-rebase pain.

## Goal

Turn the AoA lobby from a single-header company picker into a real-app shell: a left sidebar with Home / Marketplace / Settings, a "+ New ▾" dropdown for low-frequency creation actions, slightly richer cards that surface pending approvals and unread notifications inline, a designed empty state for first-time users, and a soft purple-wash background that lifts the visual ceiling without committing to brand-heavy styling.

A future polish PR is reserved for richer card visual treatment and an ambient/Momentum-style daily-prompt surface (the rotating-quote feature was scoped out of this PR for that reason — see §10).

## Architecture

The redesign is intentionally **lobby-only**. Marketplace / Settings / Profile pages keep their existing headers and standalone layouts — adding a persistent shell around them would create a second sidebar convention that competes with the in-company sidebar already inside `/{companyPrefix}/...` routes. Two competing sidebar conventions in the same app is the architecture failure mode this scope explicitly avoids.

The lobby itself splits into a 220px sidebar (left) and a flexible main column (right). The sidebar contains brand → 3 nav rows → user menu. The main column contains a header row (page title + "+ New ▾"), and the company-card grid. Everything is wrapped in a purple-wash gradient page background.

Backend changes are limited to extending the existing `GET /api/companies/stats` aggregation with two new counts (pending approvals, unread notifications) — no new routes, no schema changes, no new tables.

## Tech Stack

- React + Vite + Tailwind (existing UI stack)
- `framer-motion` (already a dep — used elsewhere in `ui/src/`)
- `lucide-react` icons (existing convention — `Bot`, `CircleDot`, plus new `AlertCircle` and `Bell`)
- Existing `UserMenu` component (`ui/src/components/UserMenu.tsx`) — reused at sidebar bottom
- Existing onboarding wizard (triggered via `useDialog().openOnboarding()`) — kept, no longer auto-triggered
- Express + Drizzle on the server side; aggregation joins existing `approvals` and `notifications` tables (no migrations)

---

## §1 — Layout architecture

The lobby root (`ui/src/pages/Lobby.tsx`) becomes a two-column flex container:

```
┌────────────────┬─────────────────────────────────────────────┐
│  LobbySidebar  │  Header row:  "Welcome back"   [+ New ▾]   │
│  (220px wide)  │                                             │
│                │  Card grid (2-3 cols, responsive)           │
│  · Home        │                                             │
│  · Marketplace │  [card] [card] [card]                       │
│  · Settings    │  [card] [card]                              │
│                │                                             │
│  ────────────  │                                             │
│  [UserMenu]    │                                             │
└────────────────┴─────────────────────────────────────────────┘
```

The page itself sits on a diagonal purple-wash gradient (see §4).

**Sidebar**:
- Top: AoA brand wordmark, 14px font weight 700, vertical padding ~16px
- Middle: 3 nav rows (Home, Marketplace, Settings) — each is `flex items-center gap-2 h-9 px-3 rounded-md`, lucide icon + label, hover/active states using existing `text-foreground` / `bg-accent` tokens
- Active state: Home is highlighted when on `/` (which is the lobby itself)
- Bottom: existing `<UserMenu />` rendered with `collapsed={false}` so it shows the user's name + avatar + dropdown chevron

**Main column header**:
- Title `<h1 class="text-xl font-semibold">Welcome back</h1>` (existing pattern)
- Right-aligned `<DropdownMenu>` (existing shadcn primitive) trigger labeled `+ New` with a chevron
- Menu items: "Create company" (calls `openOnboarding()`), "Import company" (navigates to `/import`)

**Routing back to the lobby from Marketplace / Settings / Profile (verified):**

| Page | Current back nav | Status |
|---|---|---|
| `/me` | `navigate(-1)` (browser back) at `Me.tsx:99` | ✅ works — back from lobby returns to lobby |
| `/instance/settings` | `navigate("/")` at line 124 | ✅ works — goes directly to lobby |
| `/marketplace` | `navigate("/home")` at `MarketplaceLayout.tsx:27` | ❌ **broken for the new flow** — `/home` redirects to the most-recent company's home, not lobby |

**Fix included in this PR**: change `MarketplaceLayout.tsx:27` from `navigate("/home")` to `navigate(-1)` (browser back). That handles both flows correctly: from-lobby → back-to-lobby; from-company → back-to-company. Matches the `/me` page's existing back semantics, so the chrome behaves consistently across all sibling pages.

## §2 — Cards and stats

**Visual treatment is unchanged in this PR.** `LobbyCompanyCard.tsx` keeps its current shape (border, brand-color top accent, 10×10 logo, name + prefix, stats row). Richer card treatment (brand-tinted hero, banner images, editorial featured cards) is explicitly deferred to a future polish PR.

**Stats row gets two new fields** beside the existing two:

```
🤖 N agents · ● N tasks · ⚠ N approvals · 🔔 N notifications
```

- `⚠` is `AlertCircle` from `lucide-react`, rendered at `h-3.5 w-3.5` to match the existing `Bot` and `CircleDot`
- `🔔` is `Bell` from `lucide-react`, same size
- Same `text-xs text-muted-foreground` typography as existing stats
- Always rendered (including zeros) — matches the current pattern that shows `0 agents` and `0 tasks` rather than hiding empty values
- Skeleton placeholders during stats loading: extend the existing two `<Skeleton>` children to four

**Card translucency for the new background**: change the card background from solid `bg-card` to `bg-card/85` so the purple wash breathes through faintly at the gaps. No backdrop-blur (it adds GPU cost and the current bg is dark enough that blur isn't load-bearing).

## §3 — Empty state

The auto-trigger of the onboarding modal at `Lobby.tsx:22-29` is removed:

```ts
// REMOVE this block:
useEffect(() => {
  if (companiesLoading || onboardingTriggered.current) return;
  if (visibleCompanies.length === 0) {
    onboardingTriggered.current = true;
    openOnboarding();
  }
}, [companiesLoading, visibleCompanies.length, openOnboarding]);
```

In its place, the main column renders a `<LobbyEmptyState />` component when `visibleCompanies.length === 0`:

- Centered hero, vertically centered in the main column
- Building icon (lucide `Building2`) in a 56×56 rounded-square with a brand-purple gradient background and a soft shadow
- Title: "Let's build your first company" (`text-base font-semibold`)
- Subtitle: "Create one from scratch, or import a saved AoA bundle." (`text-sm text-muted-foreground`)
- Two ghost buttons inline: "Create company" (filled, opens onboarding) and "Import company" (outline, navigates to `/import`)
- Sidebar still renders normally — the empty state does not take over the whole viewport

The "+ New ▾" dropdown in the header still works in this state too — the empty hero is just a bigger, friendlier surface for the same two actions. Onboarding wizard remains unchanged; it's just no longer forced.

## §4 — Page background

A diagonal gradient applied to the lobby root:

```css
background: linear-gradient(
  135deg,
  hsl(260 40% 8%),    /* top-left: muted purple */
  hsl(240 25% 5%) 60%, /* mid: near-black with cool cast */
  hsl(220 30% 4%)      /* bottom-right: deepest blue-black */
);
```

Implementation: a single Tailwind arbitrary-value class on the lobby root, e.g.:

```tsx
<div className="flex h-dvh bg-[linear-gradient(135deg,hsl(260_40%_8%),hsl(240_25%_5%)_60%,hsl(220_30%_4%))] text-foreground">
```

The gradient is **static** — no animation, no parallax. Cards become `bg-card/85` so the wash registers behind them without dominating.

## §5 — Quote (deferred)

The rotating-quote feature is out of scope for this PR. A future polish PR will revisit ambient/Momentum-style content surfaces (a daily prompt, a "what's on your mind today" question, or a curated quote rotation tied to companies/agents/goals you're working on). The placement reservation in the layout — bottom of the main column, below the card grid — is left available; no markup or component is built for it now.

## §6 — Animations

`framer-motion` is already a dependency of `@armyofagents/ui`. All animation paths respect `prefers-reduced-motion`: when set, the animation `transition` becomes `duration: 0` and transforms are skipped.

**Mount sequence** (one cohesive choreography, total ~500ms):
- Sidebar: `initial={{ x: -32, opacity: 0 }}` → `animate={{ x: 0, opacity: 1 }}`, 200ms ease-out
- Heading: 200ms delay, `y: -8` → `0`, fade-in, 200ms
- Cards: stagger 30ms apart starting at 250ms, each fades from `y: 8` to `0`

**Hover** (cards):
- `whileHover={{ scale: 1.02 }}`, transition `{ duration: 0.15, ease: 'easeOut' }`
- Existing CSS hover (border + shadow) stays — framer-motion adds the scale, CSS handles the rest

**Hover** (sidebar items):
- CSS only — `transition-colors duration-120`. No transform (we don't want sidebar items bouncing).

**Badge tick** (when an approval/notification count changes):
- A small `<motion.span key={count}>` wrapper around the count number with `initial={{ scale: 1.1 }}` → `animate={{ scale: 1 }}` 220ms
- Triggers naturally when React re-renders with a new key — no manual trigger logic needed

**`prefers-reduced-motion` branch**: a single `useReducedMotion()` hook from framer-motion at the top of `Lobby.tsx`; the variants are conditional on its return value (transforms collapse to identity, durations to 0).

## §7 — Backend changes

**Endpoint extension**: `GET /api/companies/stats` (already exists at `server/src/routes/companies.ts` — confirm path during implementation; current contract returns `Record<companyId, { agentCount, issueCount }>`).

**New response shape**:

```ts
type CompanyStats = Record<string, {
  agentCount: number;
  issueCount: number;
  pendingApprovalCount: number;     // NEW
  unreadNotificationCount: number;  // NEW
}>;
```

**Service-layer aggregation** (`server/src/services/companies.ts` or wherever the stats handler lives):
- Two new SQL count queries:
  ```sql
  SELECT companyId, COUNT(*) FROM approvals WHERE status = 'pending' GROUP BY companyId;
  SELECT companyId, COUNT(*) FROM notifications WHERE readAt IS NULL GROUP BY companyId;
  ```
- Both filtered by the requesting actor's accessible company set (existing `assertCompanyAccess` pattern still gates which companies the user can see in the response — no information leak across tenants)
- Drizzle ORM idiomatic: `db.select({ companyId: approvals.companyId, count: sql<number>\`COUNT(*)\`.mapWith(Number) }).from(approvals).where(eq(approvals.status, 'pending')).groupBy(approvals.companyId)`

**Type updates** (`ui/src/api/companies.ts` and shared types):
- Extend the `CompanyStats` type to include the two new fields
- Update mock data in any tests that build a `CompanyStats` fixture

## §8 — File touches (for the eventual implementation plan)

**New files**

| Path | Purpose |
|---|---|
| `ui/src/components/LobbySidebar.tsx` | The 220px sidebar with brand + nav rows + UserMenu |
| `ui/src/components/LobbyEmptyState.tsx` | The designed empty hero (replaces auto-modal) |

**Modified**

| Path | Change |
|---|---|
| `ui/src/pages/Lobby.tsx` | Restructured to sidebar+main layout; remove auto-onboarding effect; integrate sidebar/header/empty-state; add framer-motion choreography |
| `ui/src/components/LobbyCompanyCard.tsx` | Stats row gains `AlertCircle`+count and `Bell`+count; skeleton row extends to 4 placeholders; bg becomes `bg-card/85`; framer-motion hover scale |
| `ui/src/components/marketplace/MarketplaceLayout.tsx` | Back arrow at line 27 changes from `navigate("/home")` → `navigate(-1)` |
| `ui/src/api/companies.ts` | `CompanyStats` type expansion (add `pendingApprovalCount`, `unreadNotificationCount`) |
| `server/src/routes/companies.ts` | Stats route returns new counts |
| `server/src/services/companies.ts` | Aggregation queries for approvals + notifications |
| `ui/src/__tests__/Lobby.test.tsx` | New test cases for sidebar, empty state, stats expansion, dropdown |

**Test surface to add**

- `LobbySidebar` renders 3 nav items + brand + UserMenu; clicking each navigates to the right route (using a `useNavigate` mock)
- `LobbyEmptyState` renders when `companies.length === 0`; "Create company" calls `openOnboarding`; "Import company" navigates to `/import`
- `LobbyCompanyCard` renders all 4 stats with mock data; skeleton renders 4 placeholders during loading
- `Lobby.tsx` integration: with 0 companies, no auto-modal opens (the regression check); with N companies, all are rendered as cards
- `Lobby.tsx` "+ New ▾" dropdown: opens menu, "Create company" calls `openOnboarding`, "Import company" navigates to `/import`
- `MarketplaceLayout` back arrow: clicking it calls `navigate(-1)` (snapshot-based test that asserts the call signature, not browser-history side effects)
- Server: `GET /api/companies/stats` returns the new counts; aggregation respects company-access scoping (can't see other companies' counts)

## §9 — Decision matrix

| # | Question | Locked answer |
|---|---|---|
| 1 | Sidebar persistence | Lobby-only — no shell wrapping Marketplace/Settings/Profile |
| 2 | Sidebar shape | ~220px labeled with icons; AoA brand top, UserMenu bottom |
| 3 | Create/Import placement | Single "+ New ▾" dropdown in page header, two menu items |
| 4 | Card visual style | Keep current; defer richer treatment to a future polish PR |
| 5 | Inbox info on cards | Inline stats row with approvals + notifications, same format as agents+tasks |
| 6 | Quote treatment | **Deferred** — out of scope for this PR; reserved for a future Momentum-style polish PR |
| 7 | Animation level | Choreographed entry, hover lift, badge tick, prefers-reduced-motion respected |
| 8a | Empty state | Designed empty hero (no auto-modal), sidebar still visible |
| 8b | Page background | Diagonal purple-wash gradient |

## §10 — Out of scope (deferred)

- **Rotating quote / Momentum-style daily prompt**: deferred to a future polish PR. The placement reservation in the layout (bottom of the main column) is left available; nothing is built for it now.
- **Card visual polish**: brand-tinted hero, editorial featured-card layout, banner image field (`bannerAssetId`). Spec preserves the existing `LobbyCompanyCard` shape so a future PR can swap the visual treatment without restructuring the data flow.
- **Mobile / responsive sidebar**: this design assumes desktop-first. Mobile collapse, narrow viewport behavior, and tablet adaptations are a separate question.
- **Live notification updates**: counts refresh on mount only. WebSocket-pushed badge increments while the user looks at the page is a future enhancement.
- **Sidebar collapse toggle**: no expand/collapse control. Width is fixed at 220px.

## §11 — Self-review

**Placeholder scan.** No "TBD", no "fill in details", no "similar to X" references. File paths are concrete; types are spelled out; the gradient and class strings are exact.

**Internal consistency.** Section §6 references the badge tick that depends on the count fields introduced in §2 and §7 — those are consistent. The "auto-modal removal" in §3 explicitly cites the line range in `Lobby.tsx:22-29` from recon. The bg gradient in §4 is the same string referenced in §8's `Lobby.tsx` row. §5 is now marked deferred and removed from the file-touches table — no orphan references.

**Scope check.** This is one focused implementation plan — UI redesign of the lobby page plus a server stats extension and a small Marketplace back-arrow fix. Suggested PR boundaries (for the implementation plan):
1. **Backend stats extension** — `companiesApi.stats` + shared types. Can land independently; doesn't block UI.
2. **UI structural refactor** — sidebar + header + empty state + `MarketplaceLayout` back-arrow fix. Depends on PR 1's type.
3. **UI polish** — animations + purple-wash bg + card translucency. Depends on PR 2.

**Ambiguity check.** All previously-open questions resolved:
- Cross-page back-to-lobby: verified during spec-writing. Marketplace's back arrow is broken for the new flow (`navigate("/home")` redirects to a company instead of lobby) — fixed in PR 2 by switching to `navigate(-1)`. Settings and `/me` are already correct.
- Quote selection: out of scope this PR (see §10).

**False-positive guard / risk surface.**
- The auto-onboarding-modal removal changes the flow for genuinely-first-time users. The empty hero is friendlier but less directive. Mitigation: a 0-company user lands on the lobby, sees a clear hero with two ghost buttons, and one of them ("Create company") still opens the existing wizard. Functional regression risk is low; UX experience risk requires user-test on a fresh sign-up.
- The translucent card (`bg-card/85`) on the purple gradient might wash out depending on the source brand color. Visual QA on at least 3 companies with distinct `brandColor` values during implementation.

---

## §12 — Next step

User reviews this spec (in this file). If approved, I invoke the **superpowers:writing-plans** skill to produce `docs/superpowers/plans/2026-05-07-lobby-redesign.md` with TDD step quintets per task across the 3 PR boundaries above, then dispatch implementation per the established subagent-driven pattern.
