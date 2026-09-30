# AoA Design System

> **Status:** locked from brainstorm session 2026-05-07
> **Owner:** founder + design (changes require explicit approval — see [decisions log](decisions.md))
> **Implementation:** tokens live in [`ui/src/index.css`](../../ui/src/index.css) `@theme inline` block; component primitives in [`ui/src/components/ui/`](../../ui/src/components/)

The single source of truth for AoA's visual system. Every page, component, and motion in the app should derive from this document. When something feels off, fix it in the system, not in the page.

---

## 1. Personality

AoA is an operator tool with a warm brand. It must read as serious, technical, and respected — never toy-like, never marketing-noisy — but warmer than pure-engineering tools (Linear, Vercel) thanks to brand color, typography, and considered density.

**Anchor references:**

- **Openclaw** — operator/militant red, undecorated, dev-first
- **Anthropic** — terracotta warmth, considered, slow-built

We sit between the two: Openclaw's confidence with Anthropic's warmth.

**Adjectives we are:** operator, considered, warm, technical, premium-restrained.
**Adjectives we are not:** playful, casual, gradient-heavy, emoji-decorated, aggressive.

---

## 2. Color system

### 2.1 Brand red — singular

| Token | Dark mode | Light mode | OKLch (dark) | Use |
|-------|-----------|------------|--------------|-----|
| `--brand` | `#b82d1c` | `#921a0d` | `oklch(0.50 0.18 25)` | Primary CTAs, brand wordmark, accent strokes, focus rings, brand-tinted washes |
| `--brand-hover` | `#d13a26` | `#b32616` | — | Hover state for primary CTAs |
| `--brand-wash` | `color-mix(... 8%, transparent)` | `color-mix(... 6%, transparent)` | — | Page header radial wash, modal/empty state bg |
| `--brand-focus-ring` | `color-mix(... 15%, transparent)` | `color-mix(... 12%, transparent)` | — | Focus rings (3px outer glow) |

**Rules:**

- Brand red is reserved for **brand identity + primary actions + focus rings + active state indicators**. Nothing else.
- Brand red NEVER appears as: a data series color, a state-of-data color, a destructive action color, a form-field background, body text.
- "One primary per region": a page header, a modal footer, and a form footer can each have a primary CTA — but not two in the same region.

### 2.2 Semantic states — separate from brand

| Token | Hex | Use |
|-------|-----|-----|
| `--success` | `#4FB67E` (dark) / `#0a8a4f` (light) | Success toasts, "active" / "done" badges, passing-test indicators |
| `--warning` | `#D9A938` (dark) / `#a87a1c` (light) | Warning toasts, "pending" / "blocked" badges, budget thresholds |
| `--error` | `#ef4444` (both modes) | Error toasts, destructive buttons, validation errors, "failed" badges |
| `--info` | `#3b82f6` (both modes) | Info toasts, link variants, "draft" / "todo" indicators |

**Rule:** error red (`#ef4444`, bright) is a different shade than brand red (`#b82d1c`, muted). Errors must read as system, not brand. This is why we have two reds.

### 2.3 Data palette — for identity, charts, labels

Six muted-vibrant hues. Used for project `functionType` mapping (department badges, agent dots, chart series, function tags). Each hex works on both dark and light backgrounds without re-tinting.

| Token | Hex | Function | Used on |
|-------|-----|----------|---------|
| `--data-teal` | `#3FA8C7` | research / knowledge | Research dept, info pills (not the semantic info color), knowledge accents |
| `--data-indigo` | `#6470DC` | software_development | Engineering dept, code-writer agents, workspace badges |
| `--data-green` | `#4FB67E` | qa / testing | QA dept, test-runner agents (NOT semantic success — different role) |
| `--data-amber` | `#D9A938` | design | Design dept, design agents, visual artifact tags |
| `--data-magenta` | `#C25BA8` | marketing | Marketing dept, content agents, growth work |
| `--data-slate` | `#7E8AA8` | operations / other | Ops dept, neutral default when functionType isn't set |

**Rules:**

- Data palette **never appears as page bg, body text, or semantic states.**
- All 6 chroma in 0.13–0.16 range, lightness 0.55–0.72 — disciplined system.
- Sage `--data-green` and `--success` look adjacent but render distinctly because semantic success uses a brighter emerald (#10B981 in light / #4FB67E only in dark).

### 2.4 Neutral system — surface tiers

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| `--bg` | `#0a0a0a` | `oklch(0.99 0.005 30)` | Page background |
| `--card` | `oklch(0.19 0.005 30)` | `oklch(0.97 0.005 30)` | Card / surface bg |
| `--card-2` | `oklch(0.205 0.005 30)` | `oklch(0.95 0.005 30)` | Elevated card (popovers, raised cards) |
| `--hd` | `oklch(0.16 0.005 30)` | `oklch(0.94 0.005 30)` | Card header / footer bg |
| `--field` | `oklch(0.13 0.005 30)` | white | Input fields, code blocks, list-row insets |
| `--border` | `hsl(0 0% 14%)` | `hsl(20 8% 88%)` | Default border |
| `--border-soft` | `hsl(0 0% 11%)` | `hsl(20 8% 92%)` | Soft divider (between rows in same card) |
| `--border-strong` | `hsl(0 0% 22%)` | `hsl(20 8% 78%)` | Strong border (input borders, secondary buttons) |
| `--text` | `#eee` | `hsl(20 12% 18%)` | Body text |
| `--dim` | `hsl(0 0% 60%)` | `hsl(20 8% 40%)` | Secondary text |
| `--very-dim` | `hsl(0 0% 45%)` | `hsl(20 8% 55%)` | Tertiary text, placeholders |

All neutrals carry a 30° hue undertone (warm) so they belong to the same family as brand red. Pure-cool greys would clash.

---

## 3. Typography

### 3.1 Font stack

```css
--font-sans: 'Inter', -apple-system, system-ui, sans-serif;
--font-mono: 'Geist Mono', ui-monospace, monospace;
```

**Inter** for everything UI: headings, body, labels, button text. Loaded with feature settings `cv11, ss01, ss03` for cleaner letterforms.

**Geist Mono** for: numbers, IDs, timestamps, file paths, code blocks, version markers, costs, durations, counts in chips.

**Rule:** Geist Mono is never used for prose. Inter is never used for tabular data. Mixing them is the design system's signature.

### 3.2 Type scale

| Role | Size | Weight | Letter spacing | Line height | Use |
|------|------|--------|----------------|-------------|-----|
| Display | 1.7rem | 800 | -0.02em | 1.1 | Hero wordmark on landing |
| H1 (page title) | 1.4rem | 700 | -0.025em | 1.2 | Page header title |
| H2 (section) | 1.05rem | 600 | -0.015em | 1.3 | Card / modal title |
| H3 (sub-section) | 0.95rem | 600 | -0.01em | 1.4 | Form section, sub-card |
| Body | 0.85rem | 400 | 0 | 1.5 | Descriptions, paragraphs |
| Body-emphasis | 0.85rem | 500 | 0 | 1.5 | Labels, button text, inline emphasis |
| Caption | 0.78rem | 400 | 0 | 1.45 | Subtitle, page subtitle |
| Micro | 0.7rem | 500 | 0 | 1.4 | Hints, helper text, metadata |
| Small-caps | 0.62rem | 600 | 0.08em uppercase | 1.4 | Section labels, table headers |

### 3.3 Mono-specific scale

| Use | Size | Token |
|-----|------|-------|
| Inline reference (paths, IDs, costs in body) | 0.74rem | `--mono-base` |
| Numeric chip ($42.15 in stat) | 1.4rem | `--mono-stat` |
| Hero number | 1.15rem | `--mono-emphasis` |
| Timestamp / counter | 0.7rem | `--mono-meta` |

### 3.4 Geist Mono usage — what counts

**Always mono:**

- Currency ($42.15)
- Percentages where precision matters (78%)
- Counts in monospaced columns (`38`, `12/15`)
- Timestamps (14:32:08)
- Durations (1.2s, 38s)
- IDs (ENG-247, agent slugs)
- File paths (`server/src/routes/agents.ts`)
- Version markers (v3, sha 4a5472e)
- Code, JSON, CLI commands

**Never mono:**

- Prose
- Headings
- Button text (except numeric in chips)
- Form labels
- Display text

---

## 4. Spacing & sizing

### 4.1 Spacing scale (4px base)

| Token | Value | Use |
|-------|-------|-----|
| `--space-0` | 0 | — |
| `--space-1` | 4px | Tight inline gaps (icon ↔ label, dot ↔ text) |
| `--space-2` | 8px | Default gap between related elements |
| `--space-3` | 12px | Card content padding (left/right) |
| `--space-4` | 16px | Card content padding (top/bottom), field-to-field |
| `--space-5` | 20px | Section internal padding |
| `--space-6` | 24px | Card outer padding (form-card body) |
| `--space-8` | 32px | Section break |
| `--space-10` | 40px | Page section break |
| `--space-12` | 48px | Hero block padding |
| `--space-16` | 64px | Page-level breathing |

### 4.2 Row heights

| Token | Value | Use |
|-------|-------|-----|
| `--row-data` | 40px | Tasks list, agents list, memory list, activity rows |
| `--row-form` | 56px | Form fields, comment thread items |
| `--row-airy` | 72px | Lobby cards, empty state, marketing rows |

### 4.3 Button heights

| Size | Height | Padding | Font | Radius |
|------|--------|---------|------|--------|
| sm | 26px | 4px 9px | 0.72rem | 5px |
| md (default) | 32px | 6px 12px | 0.78rem | 6px |
| lg | 40px | 9px 18px | 0.86rem | 8px |
| icon | 32×32 square | 0 | — | 6px |

### 4.4 Icon sizes

| Size | Value | Use |
|------|-------|-----|
| xs | 12px | Inside badges, dot adornments |
| sm | 14px | Inside buttons, inline with body text |
| md (default) | 16px | Default icon button, list-item icons |
| lg | 20px | Section header icons |
| xl | 24px | Page header icons |
| hero | 48px+ | Empty states, modal icon |

---

## 5. Border & radius

### 5.1 Radius scale

| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | 4px | Chips, status pills, inline tags |
| `--radius-md` | 6px | Buttons, inputs, small cards |
| `--radius-lg` | 8px | Cards, list rows, popovers |
| `--radius-xl` | 12px | Modals, dialogs, hero cards |
| `--radius-2xl` | 16px | Polished modals (Q16 B variant) |
| `--radius-full` | 999px | Pills, avatars, dots, switch tracks |

### 5.2 Border tokens

| Token | Width | Color | Use |
|-------|-------|-------|-----|
| `--border` | 1px | `--border` | Default — cards, inputs, list rows |
| `--border-soft` | 1px | `--border-soft` | Internal dividers (between rows in same card) |
| `--border-strong` | 1px | `--border-strong` | Outline buttons, secondary buttons, interactive borders |
| `--border-brand` | 1px | `var(--brand)` | Focus ring border (paired with `--brand-focus-ring` glow) |
| `--border-error` | 1px | `var(--error)` | Field error state |

---

## 6. Elevation / shadows

| Token | Value | Use |
|-------|-------|-----|
| `--shadow-none` | `none` | Inline cards, list rows — never shadowed |
| `--shadow-sm` | `0 4px 12px rgba(0,0,0,0.4), 0 16px 36px rgba(0,0,0,0.3)` | Popovers, dropdowns, tooltips |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.45), 0 24px 60px rgba(0,0,0,0.35)` | Sheets (slideovers) |
| `--shadow-lg` | `0 1px 3px rgba(0,0,0,0.5), 0 32px 80px rgba(0,0,0,0.5), 0 0 60px rgba(184,45,28,0.05)` | Polished modals (with subtle brand-red ambient) |

**Rule:** inline UI never has shadows. Shadows are reserved for floating overlays (popovers / dropdowns / tooltips / sheets / modals). Shadows imply "this floats above the page" — applying them to inline cards weakens the signal.

---

## 7. Motion

### 7.1 Timing tokens

| Token | Value | Use |
|-------|-------|-----|
| `--motion-fast` | 140ms | Popover open/close, tooltip appear, hover state changes |
| `--motion-base` | 180ms | Sheet slide-in, focus ring fade-in, button hover |
| `--motion-slow` | 280ms | Tab underline slide, route transitions, layout shifts |
| `--motion-shimmer` | 1600ms loop | Loading skeleton gradient sweep |
| `--motion-pulse` | 1500ms loop | Live-state badge dot pulse |

### 7.2 Easing tokens

| Token | Value | Use |
|-------|-------|-----|
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Default for entering elements (modal, sheet, popover) |
| `--ease-out-quart` | `cubic-bezier(0.4, 0, 0.2, 1)` | Sliding underline, transforms |
| `--ease-linear` | `linear` | Loading shimmer (constant speed) |

### 7.3 Motion principles

- **What animates:** focus states, overlays open/close, hover state changes, tab underlines, loading skeletons, live-state pulses, value updates (number ticking up).
- **What doesn't:** layout shifts when data updates, route transitions on data-dense pages, page scroll.
- **Cap:** no animation longer than 280ms except loops (shimmer, pulse) and route-level transitions.
- **Reduced motion:** respect `prefers-reduced-motion: reduce` — disable shimmers, pulses, and transitions, keep instant state changes.

---

## 8. Layout patterns

### 8.1 App shell

```
┌────────────────────────────────────────────────────────────┐
│ Primary sidebar │ (Secondary sidebar)? │ Page area         │
│ 200px           │ 200px (collapsible)  │ flex-1            │
│ collapsible     │ when page needs nav  │                   │
└────────────────────────────────────────────────────────────┘
```

- **Primary sidebar** (always present): app navigation. ~200px expanded, ~48px collapsed. Current company shell sections: Home, Inbox, Commander; WORK (Discussions, Tasks, Crew Board, Agents, Routines, Workspaces); COMPANY (Objectives, Memory, Team, Skills, Settings) plus dynamic plugin entries. Budget and activity live inside Settings surfaces, with compatibility redirects from older routes.
- **Secondary sidebar** (page-scoped, optional): used when a page has 4+ sub-sections or sub-views. ~200px expanded, ~48px collapsed. Section title in small-caps + items + counts.
- **Page area**: flex-1, contains page header + content.

**Lobby-tier shell:** the pre-company-selection pages (Lobby, Marketplace browse/detail/search/updates/package-detail, Settings) all share one wrapper component, `LobbyShell`. It owns the primary sidebar (desktop) + mobile drawer + an optional `secondarySidebar` slot rendered flush between the primary and the main content. Pages declare their `activeItem` (which primary nav row to highlight) and optionally pass a `secondarySidebar` ReactNode. Settings is currently the only consumer of the slot — see §8.1.1.

### 8.1.1 Primary auto-collapse rule

A page **force-collapses the primary sidebar on every mount** if and only if it provides a secondary sidebar. Pages without a secondary sidebar respect the user's manual primary-collapse preference (`localStorage["aoa.lobby.sidebar-collapsed"]`).

Mental model: *primary collapses BECAUSE secondary takes over.* Don't auto-collapse just to give a page more horizontal room — that's confusing because the user can't tell why their preference was overridden.

Implementation (2026-07 — persistent shell): the lobby pages render under a single
persistent `LobbyLayout` (§8.1.2), so the shell no longer remounts on navigation
and a mount-time override can't fire. The rule is now **reactive**: `LobbyShell`
passes `hasSecondarySidebar` (true when the current page filled the outlet-context
secondary-sidebar slot) to `LobbySidebar`, which force-collapses the primary while
it is true and restores the persisted preference (`localStorage["aoa.lobby.sidebar-collapsed"]`)
when it is false. A manual expand on a secondary-sidebar page is a **transient
peek** — it is not written to the preference. The old mount-time `defaultCollapsed`
prop is removed.

Current consumers (2026-07): `InstanceSettingsPage` only (it provides the secondary
sidebar via the `LobbyLayout` outlet context). Marketplace pages briefly used this
in Phase A but were removed in Phase D when this rule was formalized. Locked as
Decision #98.

### 8.1.2 Lobby-tier floating rails (2026-07)

The lobby-tier chrome (`LobbyShell` surfaces: Lobby, Marketplace, Settings) renders its primary rail — and, when present, its secondary sidebar — as a floating rounded "island": `my-2 ml-2 rounded-2xl border border-border`, `h-[calc(100dvh-1rem)]`, `overflow-hidden`, and **no drop shadow** (per §7 inline UI carries no shadow — the border + `bg-card/50` sells the float). Main content stays flush to the window edge ("floating rail only", not full floating panels).

The external collapse toggle is offset by the 8px left gutter (`sidebarWidth + 8`, `top 17`) so it still straddles the rail/main seam. The mobile drawer (`drawer` mode) is unaffected — it renders full-width inside the Sheet with no rounding.

**New-organization CTA:** the expanded primary rail's "+ New organization" is an *attached split button* — the primary segment creates (one click), and a joined chevron segment (`DropdownMenuTrigger`) opens a floating Radix `DropdownMenu` (`align="end"`) with "Import organization". The menu overlays the nav (no layout shift); shadows are allowed here because a dropdown is a floating overlay, not inline chrome. Collapsed rail = create-only (no chevron/import).

**Scope:** lobby-tier only. The in-company primary `Sidebar` and the in-company `SecondarySidebar` consumers (`TeamLayout`, in-company `SettingsLayout`) keep the flush-rail look. `SecondarySidebar` exposes an opt-in `floating` prop (default false) so only the lobby-tier `InstanceSettingsPage` gets the island treatment. Propagating the floating look app-wide is a tracked follow-up.

### 8.2 Sidebar collapse

- Both primary and secondary collapse to icon-only (~48–56px wide).
- Collapsed item shows icon, label appears as tooltip on hover.
- Default state by viewport:
  - **>1280px (xl):** both expanded
  - **1024–1280px (lg):** primary collapsed, secondary expanded if present
  - **768–1024px (md):** both collapsed
  - **<768px (sm):** neither shown — replaced by hamburger drawer

**Collapse toggle button — external, on the boundary.**

The toggle button sits on the *outside* of the sidebar, straddling the border between sidebar and main content. It is **not** a child of the sidebar's nav area.

- Position: `absolute`, `top: 15px` (vertically aligned with the AoA. wordmark / sidebar header row), `left: calc(<sidebar-width>px - 13px)` so it visually centers on the boundary.
- Size: 26×26 rounded square with `--border-strong` border, `--card-2` bg, subtle 2px shadow that lifts it off the surface.
- Icon: Lucide `PanelLeftClose` when expanded (clicking collapses), `PanelLeftOpen` when collapsed (clicking expands). The chevron inside the icon flips direction.
- Hover: `border-brand` + 5% scale-up.
- Persisted via `localStorage["aoa.<surface>.sidebar-collapsed"]` so the user's preference survives navigation and reload.

### 8.2.1 Sidebar active item — brand-tinted bg + glow dot

The active nav item uses `bg-brand/[0.08] text-[hsl(15_60%_75%)]` for the bg+text treatment, plus a small 5px brand-red dot at the trailing edge with a soft glow (`box-shadow: 0 0 6px rgba(184,45,28,0.55)`). When the sidebar is collapsed, the dot moves to the top-right corner of the icon area (because the row is icon-only). **Do not** use the inset 2px brand-red border that appeared in early Phase 2 commits — that was replaced by the dot indicator (lighter visual weight, more elegant).

### 8.3 Page header anatomy

```
┌──────────────────────────────────────────────────────┐
│ Breadcrumb (small, top, when nested)                 │
│ Title (1.4rem, weight 700)                           │
│ Subtitle (0.82rem, 65% opacity, one line)            │
│                                                      │
│ [filter pills]              [search] [primary CTA]   │
└──────────────────────────────────────────────────────┘
        ↑ subtle radial wash from top-left at <10% opacity ↑
        ↑ 1px border-bottom separates from content        ↑
```

- Breadcrumb appears only on sub-pages. Format: `Department · Section`.
- Filter pills appear on **list pages** (Tasks, Agents, Activity, Inbox). Pills mean "filter the same view," NOT "navigate." Navigation belongs in primary or secondary sidebar.
- Search aligns right with primary CTA.
- Page header gets a **subtle radial wash** from top-left at ~8–10% brand opacity. Same wash treatment as marketing hero.

### 8.4 Gradient placement

| Surface | Treatment |
|---------|-----------|
| Lobby (signed-out + signed-in landing) | Full radial brand wash |
| Onboarding / new-company setup / auth | Full wash |
| Empty states (no tasks yet, no agents) | Full wash |
| Page hero zone (top ~200px of any main page) | Subtle wash, fades to flat below |
| Modal headers | Subtle radial wash |
| Sheet headers | Subtle radial wash |
| Form card headers (high-stakes forms) | Subtle radial wash |
| Data-dense pages (tasks list, activity log, agents grid) | Flat — no wash |
| Modals body, sheet body, popovers | Flat |
| Cards inside any page | Flat |

**Principle:** wash for *moments*, flat for *work*.

### 8.5 Breakpoints (Tailwind defaults)

| Name | Min width | Use |
|------|-----------|-----|
| sm | 640px | Mobile landscape, small tablets |
| md | 768px | Tablets, sidebar drawer mode ends |
| lg | 1024px | Laptop, primary sidebar expanded |
| xl | 1280px | Desktop, both sidebars expanded |
| 2xl | 1536px | Wide desktop |

### 8.6 Mobile sub-nav for pages with a secondary sidebar

The desktop `SecondarySidebar` is hidden below the `md` breakpoint (`hidden md:flex` wrapper inside `LobbyShell`). On mobile, pages with a secondary sidebar render a **horizontal scrollable pill row** at the top of their content area as a sub-nav.

**Pattern:**

- Pill: rounded-full button with icon + label, `border` + `bg-card`. Active state matches the brand-tinted treatment from §8.2.1: `bg-brand/[0.08] text-[hsl(15_60%_75%)] border-brand/[0.25]`.
- Container: `<div className="md:hidden mb-5 relative">` wrapping `<div className="overflow-x-auto -mx-4 px-4 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">` for hidden-but-scrollable behavior.
- Right-edge gradient fade: `pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-bg to-transparent` — hints at horizontal overflow when not all pills fit.
- **Auto-scroll-active-into-view**: on mount and on every active-pill change, call `activePillRef.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" })` so the user lands with the active section centered.

**When to use:** every page that consumes the `LobbyShell` `secondarySidebar` slot must also provide this mobile sub-nav (rendered inside the page's content, not inside the slot). The pills consume the same `sections` data as the desktop sidebar — one source of truth, two render paths.

---

## 9. Components

### 9.1 Buttons

**When to use:** any interactive action. Primary for the main action of a region; one primary per region. Destructive for delete/remove only — uses system red, not brand red.

**Variants** (maps to shadcn/ui):

| Variant | Use |
|---------|-----|
| `default` (primary) | Brand red. Main action of a region. |
| `secondary` | Solid neutral. Modal Cancel, alt CTAs. |
| `outline` | Transparent w/ border. De-emphasized alt. |
| `ghost` | No bg, no border. Toolbars, table rows, inline. |
| `destructive` | System red `#ef4444`. Delete / remove only. |
| `link` | Brand-red text. "See all", inline references. |

**Sizes:** sm (26px) / md (32px, default) / lg (40px) / icon (32×32 square).

**Code:**

```tsx
<Button variant="default" size="md">+ New task</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="destructive">Delete</Button>
<Button variant="ghost" size="icon"><Plus className="h-4 w-4" /></Button>
```

**Rules:**

- One primary per region.
- Destructive ≠ brand. Two reds in different roles.
- Disabled state: 40% opacity, `cursor-not-allowed`.
- Icon spacing: 6px gap between icon and label inside button.

### 9.2 Inputs / Forms

**When to use:** any data entry surface.

**Anatomy:**

```
Field label * (asterisk = required, brand-red)        | optional (right, dim)
[Input — 32px tall, 1px border, 6px radius]
Help text in 0.7rem, 55% opacity (or red error message)
```

**States:** default / hover / focus / error / disabled.

**Focus ring:** 3px outer glow at 15% brand-red + brand-red border.

**Form pattern (locked at Q15v2 B "polished"):**

- **Sectioned** with small-caps section titles (0.62rem, 0.1em letter-spacing) + numeric badge (1/2/3/4) where steps exist.
- **Hero input** for the form's primary identifier (e.g., agent name, project name): 1.05–1.15rem, weight 600, 10px radius, larger focus ring.
- **Picker cards** for "select one of N" (e.g., adapter selection): 2-col grid of cards with selected card getting brand-tinted bg + 3px brand glow.
- **Validation:** on blur, not keystroke. Re-validate on input only after first blur.
- **Footer:** ghost Cancel + primary Submit, right-aligned. Bordered top, slightly darker bg.
- **Field spacing:** 16px (`--space-4`) between fields. 18–20px between sections.

**Code:**

```tsx
<form className="space-y-4">
  <div>
    <Label>Display name<span className="text-brand">*</span></Label>
    <Input className="bg-field border-border focus:ring-brand-15" />
    <p className="text-micro text-very-dim mt-1">Help text…</p>
  </div>
  <Section title="Identity" number={1}>
    {/* fields */}
  </Section>
</form>
```

### 9.3 Modals

**When to use:** confirmations (delete, archive), focused single-task forms, errors needing acknowledgment, full-attention decisions.

**Pattern (locked at Q16 B "polished"):**

- 14–16px radius
- Soft shadow (`--shadow-lg`) + subtle ambient brand-red glow
- Body bg has subtle radial brand wash (more pronounced for destructive)
- Icon (48px, haloed if destructive) + title (1.15rem hero) + message (with target name as inline mono pill)
- Close X top-right (24×24, ghost)
- Footer: ghost/secondary Cancel + primary/destructive Submit, gradient bg (slightly darker than body)

**Sizes:** sm 380px / md 480px / lg 720px.

**Animation:** slide-up 8px + fade-in 160ms (`--ease-out`).

**Dismiss:** Esc, X button, backdrop tap. **Exception:** destructive modals require explicit Cancel — no backdrop dismiss.

**Code:**

```tsx
<Dialog>
  <DialogContent>
    <DialogHeader>
      <Icon variant="destructive" />
      <DialogTitle>Delete agent?</DialogTitle>
      <DialogDescription>
        You're about to delete <code>research-lead</code>. This will unassign 12 tasks.
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="secondary">Cancel</Button>
      <Button variant="destructive">Delete agent</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

#### Dialog body padding (post-Phase H)

Background: the May-7 Dialog restyle (commit `6d133e2`) changed `DialogContent` from `p-6` (built-in body padding) to `p-0` (no padding). `DialogHeader` and `DialogFooter` pad themselves; the body content between them is the consumer's responsibility.

**Rule: always wrap body content in `<DialogBody>`.**

```tsx
<Dialog>
  <DialogContent>
    <DialogHeader>...</DialogHeader>
    <DialogBody>
      {/* form fields, grids, anything between header and footer */}
    </DialogBody>
    <DialogFooter>...</DialogFooter>
  </DialogContent>
</Dialog>
```

`DialogBody` defaults to `px-7 py-4`. The horizontal `px-7` matches `DialogHeader`'s inset (canonical). Override the className for tighter or looser layouts (e.g., `<DialogBody className="px-0 py-4">` for a full-bleed scroller).

**Exceptions** (do NOT use DialogBody):
- **Bespoke `p-0 gap-0` modals** (e.g., `NewAgentDialog`, `NewIssueDialog`, `NewGoalDialog`, `NewProjectDialog`) — explicitly opt out and roll their own layout.
- **SR-only title patterns** (e.g., `CommandDialog`, `ImageGalleryModal`, `MemoryQuickSwitcher`) — visible content IS the body; padding handled per-pattern.
- **Confirmation modals** with only header + footer (no form body) — description sits inside the padded header.

### 9.4 Sheets (slideovers)

**When to use:** detail views where users want context behind to stay visible — task detail, agent detail, memory item editor. Existing `TaskSlideOver` is the canonical example.

**Pattern (locked at Q16 B "polished"):**

- Slides in from right
- 380px (md) / 480px (lg) / 600px (xl)
- Backdrop at 35% opacity + 1px blur (page behind dimmed but visible)
- Header has subtle brand-red radial wash + status dot beside title + meta-pill row (replaces metadata table)
- Footer: ghost icon (open-in-new) + secondary alt + primary action, right-aligned

**Animation:** slide-in 20px + fade-in 180ms.

**Dismiss:** Esc, X button, backdrop click.

**Code:**

```tsx
<Sheet>
  <SheetContent side="right" className="w-[380px]">
    <SheetHeader className="bg-hd-wash">
      <SheetCrumb>ENG-247 · Engineering</SheetCrumb>
      <div className="flex items-center gap-2">
        <StatusDot variant="running" />
        <SheetTitle>Add user_roles index</SheetTitle>
      </div>
      <MetaPills>
        <MetaPill>running</MetaPill>
        <MetaPill>code-writer</MetaPill>
        <MetaPill>$0.42</MetaPill>
      </MetaPills>
    </SheetHeader>
    {/* body */}
    <SheetFooter>
      <Button variant="secondary">Comment</Button>
      <Button variant="default">Approve</Button>
    </SheetFooter>
  </SheetContent>
</Sheet>
```

### 9.5 Popovers

**When to use:** filter pickers, dropdown menus, kebab menus, color/category selectors. Dismisses on outside click. No backdrop.

**Two variants:**

- **A · List** (default) — flat checkbox list. 4–7 items. Compact.
- **B · Sectioned** — multiple categories at once. Section dividers + small-caps headers. Items can be richer (swatch + name + sub + count).

**Spec:**

- Min 220px (A) / 260px (B)
- 8px radius
- `--shadow-sm` (popovers shadow)
- Padding 6px (A) / 4px outer + 6px section (B)

**Animation:** slide-down 4px + fade-in 140ms.

**Dismiss:** Esc, click outside.

### 9.6 Stepper (navigable)

**When to use:** multi-step modals, wizards, onboarding.

**Three variants:**

- **A · Horizontal pill** (default for top-of-modal) — labels visible, brand-red glow on active.
- **B · Vertical** (long forms / wizards / onboarding sidebars) — sub-text per step.
- **C · Dots only** (≤5-step flows where labels would clutter) — dot expands on active step, shows step counter below.

**Rule:** done + active steps are clickable (jump back). Pending steps unclickable until previous is done.

### 9.7 Toasts

**When to use:** transient feedback after an action (success/error/warning/info). Top-right placement.

**Pattern (locked at Q17 A "basic"):**

- 320px wide
- Top-right stack, newest on top, max 4 visible (collapse to "and N more")
- Icon (18px, semantic-color circle) + title + message + close X
- Border-left 3px in semantic color
- Auto-dismiss: 4s default, 8s for errors
- Progress bar at bottom shows time remaining (semantic-colored, 50% opacity)

**Animation:** slide-in 20px from right + fade-in 180ms. Slide-out + fade-out on dismiss.

**Variants:** success / error / warning / info.

### 9.8 Empty states

**When to use:** lists/pages with no data.

**Pattern (locked at Q17 A "basic"):**

- 56px rounded-square icon (brand-tinted bg for "first time" / neutral bg for "no results")
- Title (1rem, weight 600)
- Description (0.82rem, 60% opacity, max 320px width)
- 1 primary CTA button
- Centered, padding around
- Subtle brand-red radial wash on bg

**Two contexts:**

- **First-time:** educational copy, brand-tinted icon, "Add memory" CTA.
- **Filtered no-results:** action-oriented copy, neutral icon, "Clear filters" CTA.

### 9.9 Loading skeletons

**When to use:** data fetching, before content renders.

**Pattern (locked at Q17 B "gradient sweep"):**

- Bones in `--field` bg color
- Gradient sweep (left-to-right, 1.6s linear loop) — eye tracks motion better than opacity pulse
- Bones match content shape — heading bone (16px tall, 30% width), body bone (14px tall, 100% width), row bone (40px tall card-shape), circle bone for avatars (22px)
- **Show after 200ms delay** — don't flash for fast loads

**Code (Tailwind utility):**

```tsx
<div className="h-4 w-32 rounded bg-gradient-to-r from-field via-field-2 to-field bg-[length:200%_100%] animate-shimmer" />
```

### 9.10 Tooltips

**When to use:** hover help on icon-only buttons, abbreviations, status indicators with extra context.

**Pattern (locked at Q17 B "frosted glass"):**

- Light bg on dark mode (`oklch(0.98 0.005 30)` at 92% with backdrop-blur 12px + saturate 140%)
- Dark bg on light mode (inverted)
- 5px radius (plain) / 8px (rich)
- Inset top highlight (`inset 0 1px 0 rgba(255,255,255,0.7)`) — feels like glass
- Auto-flip placement when no space

**Two variants:**

- **Plain** — single-line text, max 240px.
- **Rich** — multi-line, can include progress bar, dark frosted bg with brand-red gradient progress.

**Animation:** scale-in 0.96→1 + fade-in 140ms after 100ms hover delay.

### 9.11 Status badges

**When to use:** state indicators on agents, tasks, goals, runs, memory items.

**Pattern (locked at Q17 B "polished"):**

- Three forms:
  - **Dotted pill** (most common) — dot + label. Use for status (active/idle/pending/error).
  - **Solid pill** (rare) — just label, no dot. For marketing flags ("New", "Beta").
  - **Numeric badge** — `Geist Mono` 0.66rem, field-bg, 4px radius, 1px border. For counts, versions, costs.

**Polish:** subtle top-to-bottom gradient inside pill (depth, not flat color) + colored dot glow (6px shadow). Live states (running, in-progress) get a pulsing ring animation (1.5s ease-in-out loop).

**Status → semantic color mapping:**

| State | Color |
|-------|-------|
| active / done | success (green) |
| running / in-progress / live | brand red (with pulse) |
| idle / planned / backlog | slate (cool grey) |
| pending / blocked / at-risk | warning (amber, glow) |
| failed / error | error (red, glow) |
| draft / todo | info (blue) |
| archived / cancelled | neutral grey, bordered |

### 9.12 Tabs

**When to use:** shallow nav (≤4 sub-views). For 5+ views or persistent nav, use secondary sidebar.

**Pattern (locked at Q17 B "polished"):**

- Underline tabs
- Single sliding underline element with cubic-bezier easing (280ms)
- Brand-red glow on the underline edges
- Optional count badge per tab — turns brand-tinted on active

**Code:**

```tsx
<Tabs defaultValue="overview">
  <TabsList>
    <TabsTrigger value="overview">Overview</TabsTrigger>
    <TabsTrigger value="tasks">Tasks <TabCount>12</TabCount></TabsTrigger>
    <TabsTrigger value="activity">Activity <TabCount>38</TabCount></TabsTrigger>
  </TabsList>
  <TabsContent value="overview">…</TabsContent>
</Tabs>
```

### 9.13 Card chrome (Marketplace)

**When to use:** every card on the marketplace surface — `CatalogCard` (individual items) and `PackageCard` (skill packages, see §9.15).

**Shared anatomy:**

```
┌───────────────────────────────────────────────────────┐
│ {hero icon}  Name [✓ verified?]   │   {TYPE chip}     │
│              by {owner}            │                  │
│                                                       │
│  {1–2 line description, line-clamp-2}                 │
│                                                       │
│  [github] {owner/repo}              [Install button]  │
└───────────────────────────────────────────────────────┘
```

- **Top-right `TypeChip`**: uppercase 10px, `text-very-dim`, monochrome (no color). Values: `SKILL`, `PLUGIN`, `AGENT`, `TEAM`, `PACKAGE`. Absolute-positioned at `right-3 top-3`.
- **Verified-blue checkmark**: `<BadgeCheck>` from lucide, `text-[hsl(208_80%_60%)]` (see §10.2), rendered only when `trust.tier === "verified"`. Place inline next to the title with `gap-1.5`. Community/unverified items show no badge — no second pill, no clutter.
- **Hero icon tones** (single icon for skill/plugin/agent items):
  - skill: `bg-amber-500/15 border-amber-500/30 text-amber-500`
  - plugin: `bg-blue-500/15 border-blue-500/30 text-blue-500`
  - agent: `bg-purple-500/15 border-purple-500/30 text-purple-500`
  - team: not single — uses `<StackedIcon icon={Bot} tone="teal" />` (see §9.14)
- **Hover state**: `card-hover` class (defined in `index.css`) — `transition: border-color .2s, box-shadow .25s, transform .15s`; on hover applies brand-red glow (`box-shadow: 0 0 0 1px hsl(8 75% 50% / 0.25), 0 8px 28px hsl(8 75% 30% / 0.18)`) + `border-color: var(--border-strong)`.
- **Footer row** (aligned across all card types): `[github icon] {owner/repo}` on left, install action on right, both anchored to the same horizontal line.

### 9.14 StackedIcon

Used for cards that represent a **collection** — currently teams (multi-agent groups) and skill packages (skill bundles).

**Pattern:** 3 layers of the same lucide icon in absolute-positioned rounded squares. Back/mid layers translate up-and-right and reduce opacity (0.30 / 0.55) so they read as receding. Front layer renders at full opacity.

**Tones:**

| Tone | Used for | Layer classes (back / mid / front) |
|------|----------|------------------------------------|
| `teal` | Teams (Bot ×3) | `bg-teal-500/{10,15,20}` + `border-teal-500/{15,25,40}` + `text-teal-500/{70,85,100}` |
| `amber` | Skill packages (Sparkles ×3) | `bg-amber-500/{10,15,20}` + `border-amber-500/{15,25,40}` + `text-amber-500/{70,85,100}` |

**Sizes:** default `size-12` for cards; `size-20` for hero blocks (package detail page).

### 9.15 PackageCard specifics (extends §9.13)

In addition to the shared marketplace card chrome:

- **3px brand-amber left-edge accent rule**: `<span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r bg-amber-500" aria-hidden />`. Visually distinguishes packages from individual items in mixed feeds.
- **`PACKAGE` type chip with `Layers` icon** prefix (other type chips are text-only).
- **"N items" pill** rendered inline next to the title: `bg-amber-500/10 border-amber-500/25 text-amber-400`, `text-[10px] font-semibold`. Replaces the version pill that single-item cards would carry.
- **Footer install button** reads "Install all" instead of "Install" — single-click installs every member item.

### 9.16 Filter chips and sub-filter chips

**When to use:** marketplace browse, search, and any other type/sort discovery surface. Distinct from §9.12 Tabs — chips filter the *same view*; tabs switch *between views*.

**Filter chip** (pill button, single-select):

```css
inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-medium border;
/* idle */    bg-card border-border text-foreground/[0.78];
/* hover */   bg-card-2 hover:text-foreground hover:border-border-strong;
/* active */  bg-foreground text-bg border-foreground;
```

Each chip optionally shows a count: `<span className="text-[11px] text-very-dim ml-0.5">{count}</span>`.

**Sub-filter chip** (smaller "ghost" pill, single-select):

```css
inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-medium;
/* idle */    text-dim hover:text-foreground hover:bg-card;
/* active */  text-foreground bg-card-2;
```

Used for sort/discover modes (e.g., All / Featured / Recently added / A–Z) under a primary filter chip row.

### 9.17 "Part of {pkg}" pill

Rendered above the `<h1>` on individual item detail pages **when the item belongs to a package**.

```tsx
<Link to={packageDetailUrl(parentPackage)}
  className="inline-flex items-center gap-1.5 mb-2 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20 transition-colors w-fit">
  <Layers className="size-3" />
  Part of {parentPackage.name}
  <ChevronRight className="size-3" />
</Link>
```

Same amber tone as the package's accent rule (§9.15) so the visual rhyme makes the relationship obvious. Click navigates back to the package detail page — bidirectional nav between item and package.

### 9.18 Sectioned hub view

**When to use:** hub pages with a default-mixed feed and a type filter (e.g., marketplace `All` mode).

**Pattern:**

- "All" mode renders **type-grouped sections** instead of a flat grid. Each section has:
  - Header row with type icon + title + count (e.g., `🪄 Skills · 64`)
  - Optional "See all →" link that activates the corresponding type chip (which switches to single-section mode)
  - 6-item cap on the section's grid (cap removed in single-section mode)
- Empty sections (zero items after the active sort/search filter) are **omitted entirely** so the page only shows what's actually there.
- Single-type chip active → only that section is visible, no cap, full feed.

**Special case (Marketplace):** the Packages strip lives inside the Skills section. Clicking the Skills chip keeps it visible; clicking any non-Skills chip hides it along with the rest of the Skills section. (Tied to Decision #97 — packages are skill-only.)

---

## 10. Iconography

**Library:** [Lucide](https://lucide.dev) — already used in shadcn/ui, ~1500 icons, consistent stroke style. AoA's existing `ui/src/components/ui/` shadcn primitives already pull from Lucide.

**Stroke vs fill:** Lucide is stroke-only by default — preserve. Stroke width: 2 (default). For 12px icons, use stroke 1.5 to keep them legible.

**Sizes:**

| Use | Size | Stroke |
|-----|------|--------|
| Inline with body text | 12 | 1.5 |
| Inline with button label | 14 | 2 |
| Standalone icon button | 16 | 2 |
| Section header | 20 | 2 |
| Page header | 24 | 2 |
| Empty state | 48 | 2 |

**When to use icons:**

- Always with a label, OR with a tooltip if space-constrained (icon-only buttons in toolbars).
- Never as the only content of a primary CTA.
- Decorative icons (no semantic meaning) get `aria-hidden`.

### 10.1 Marketplace type icons

| Type | Lucide icon | Treatment |
|------|-------------|-----------|
| skill | `Sparkles` | Single icon, amber tone (§9.13) |
| plugin | `Puzzle` | Single icon, blue tone (§9.13) |
| agent | `Bot` | Single icon, purple tone (§9.13) |
| team | `Bot` | StackedIcon ×3, teal tone (§9.14) |
| package | `Sparkles` | StackedIcon ×3, amber tone (§9.14) |

Mapping lives in `ui/src/lib/marketplace-constants.ts` (`TYPE_ICONS` for single icons, `SINGLE_ICON_TONES` + `TEAM_ICON_TONE` for tile colors).

### 10.2 Verified-blue color

The verified checkmark color is `hsl(208 80% 60%)` — used as `text-[hsl(208_80%_60%)]` in Tailwind arbitrary syntax. Lucide icon: `BadgeCheck`. Always paired with `aria-label="Verified"`. Two consumers: marketplace card chrome (§9.13) and the matching hero block on detail pages.

---

## 11. Avatars

**Pattern:** initials in dept-colored circle. Uses data palette.

**Sizes:**

| Token | Size | Use |
|-------|------|-----|
| `--avatar-xs` | 18px | Comment thread micro-avatar |
| `--avatar-sm` | 24px | List rows, table rows |
| `--avatar-md` | 32px | Default — agent cards, headers |
| `--avatar-lg` | 40px | Profile, settings header |
| `--avatar-xl` | 56px | Profile detail page |

**Format:** circle, weight 700, letter-spacing -0.01em, white text on dept-colored bg.

**Initials rule:** first letter of each word in display name, max 2 chars. "Research Lead" → "RL". "QA Runner" → "QR". Single-word → first 2 chars: "Commander" → "CO".

**Fallback:** if no display name, use slug + slate bg.

---

## 12. Code blocks / inline mono

### 12.1 Inline `<code>`

```css
font-family: var(--font-mono);
font-size: 0.78rem;
background: var(--field);
border: 1px solid var(--border);
border-radius: 4px;
padding: 1px 6px;
color: var(--text);
```

For paths (`server/src/routes/agents.ts`), command names (`pnpm dev`), env vars (`AOA_FEEDBACK_ENDPOINT`), short identifiers.

### 12.2 Block `<pre><code>`

```css
font-family: var(--font-mono);
font-size: 0.82rem;
line-height: 1.55;
background: var(--field);
border: 1px solid var(--border);
border-radius: 8px;
padding: 12px 16px;
overflow-x: auto;
```

For multi-line code, JSON, CLI output, log snippets.

---

## 13. Breadcrumb

**When to use:** sub-pages within a section (e.g., Memory → Domain → Item detail).

**Pattern:**

- 0.66rem, 0.04em letter-spacing
- 50% opacity for parent links (clickable)
- 100% opacity for current item (plain text, not link)
- Separator: `·` (middle dot, dim)
- Max 3 levels visible — truncate middle: `Company · … · Domain`

**Format:** placed at top of page header, above title.

### 13.1 Chevron-back link variant

Detail pages (`MarketplaceDetail`, `MarketplacePackageDetail`) and the Settings page use a **chevron-back** link in place of the breadcrumb described in §13.

**Pattern:**

```tsx
<Link to="/marketplace"
  className="mb-4 inline-flex items-center gap-1 text-[12px] text-very-dim hover:text-foreground">
  <ChevronLeft className="size-3.5" /> Marketplace · Skills
</Link>
```

- Single-segment back navigation (one parent context, not a chain).
- Uses lucide `ChevronLeft` (size-3.5) at the start instead of the `·` separator.
- Color: `text-very-dim` idle, `text-foreground` hover.
- Place above the page heading or hero block.

**When to use breadcrumb (§13)** vs **chevron-back (§13.1):**

- **Breadcrumb (§13)**: 2+ levels of hierarchy where the user might navigate to multiple ancestors (`Company · Memory · Domain · Item`).
- **Chevron-back (§13.1)**: detail pages where there's effectively one parent (`Marketplace · Skills` → marketplace).

---

## 14. Light vs dark mode

**Toggle behavior:**

- Toggle in user settings + keyboard shortcut.
- Stored in `localStorage["aoa.theme"]` (legacy `paperclip.theme` migrated on boot per existing storage migration).
- Inline FOUC-prevention script in `index.html` reads the storage key before React mounts.

**Token mapping:**

- All tokens defined in `ui/src/index.css` with `@theme inline`. Each color token has `dark:` and `light:` variants.
- Components reference tokens, not hex values. **Never hardcode `#b82d1c`** — use `var(--brand)`.

**Mode-aware patterns:**

- Page bg, card bg, field bg, border, text — all flip with mode.
- Brand red shifts: `#b82d1c` (dark) → `#921a0d` (light) so it remains readable on both.
- Data palette: same hex on both modes (designed to work on both).

---

## 15. Accessibility

- **Color contrast:** WCAG AA minimum (4.5:1 for body text, 3:1 for large text + non-text). Brand red `#b82d1c` on dark bg passes; `#921a0d` on light bg passes.
- **Focus ring:** 3px outer glow at 15% brand-red + brand-red border. **Always visible** — never `outline: none` without replacement.
- **Keyboard navigation:** Tab cycles through interactive elements. Modal + Sheet trap focus while open. Esc closes overlays.
- **Screen reader:** all icons get `aria-label` or `aria-hidden`. Buttons must have a label or `aria-label`. Form fields have associated `<Label>`.
- **Motion:** respect `prefers-reduced-motion: reduce` — disable shimmers, pulses, transitions.

---

## 16. Implementation notes

### 16.1 Token export

Tokens live in [`ui/src/index.css`](../../ui/src/index.css) under the `@theme inline` block. Tailwind v4's `@theme` directive auto-generates utility classes from CSS variables, so `--space-4: 16px` becomes `p-4 → padding: 16px`, `m-4 → margin: 16px`, etc.

### 16.2 Tailwind config

The shadcn-style `tailwind.config.ts` (or v4 `@theme inline`) maps semantic names to tokens:

```css
@theme inline {
  --color-brand: var(--brand);
  --color-brand-hover: var(--brand-hover);
  --color-success: var(--success);
  --color-error: var(--error);
  --color-data-teal: var(--data-teal);
  /* ... */
  --radius-md: 6px;
  --radius-lg: 8px;
  --animate-shimmer: shimmer 1.6s linear infinite;
}
```

### 16.3 shadcn/ui mapping

AoA's existing primitives in [`ui/src/components/ui/`](../../ui/src/components/) need updating to consume new tokens:

| shadcn primitive | This system maps to |
|------------------|---------------------|
| `Button` variants | primary→default, destructive→destructive, etc. |
| `Dialog` | Modal pattern (§9.3) |
| `Sheet` | Sheet pattern (§9.4) |
| `Popover` | Popover pattern (§9.5) |
| `AlertDialog` | Modal pattern (§9.3) — destructive variant |
| `Tooltip` | Tooltip pattern (§9.10) |
| `Tabs` | Tabs pattern (§9.12) |
| `DropdownMenu` | Popover pattern (§9.5) |
| `ToastViewport` + `useToast().pushToast` (`@/context/ToastContext`) | Toasts pattern (§9.7) — unified glass toast, bottom-right |

### 16.4 Existing files to update during overhaul

- [`ui/src/index.css`](../../ui/src/index.css) — add new tokens
- [`ui/src/components/ui/button.tsx`](../../ui/src/components/ui/button.tsx) — restyle variants
- [`ui/src/components/ui/dialog.tsx`](../../ui/src/components/ui/dialog.tsx) — apply modal-B treatment
- [`ui/src/components/ui/sheet.tsx`](../../ui/src/components/ui/sheet.tsx) — apply sheet-B treatment
- [`ui/src/components/LobbySidebar.tsx`](../../ui/src/components/LobbySidebar.tsx) — already aligned with primary sidebar pattern from PR-B/C
- [`ui/src/components/SecondarySidebar.tsx`](../../ui/src/components/) — TBD, needs creation
- [`ui/src/components/PageHeader.tsx`](../../ui/src/components/) — TBD, needs creation

---

## 17. What this document doesn't cover (intentionally)

- **Per-page layouts** — those are implementation decisions made in the UI overhaul plan.
- **Copy / tone of voice** — separate document, deferred.
- **Animation choreography** for specific flows (lobby reveal, onboarding) — captured per-page during overhaul.
- **Dark mode previews of every component** — shown in mockups (`.superpowers/brand-q*.html`), not duplicated here.

---

## 17.1 Commander chat bubbles

**Context:** `InternalAgentPanel.tsx` renders a 1:1 chat between the founder and Commander (no multi-party participants, no avatars).

**Token choices (CSS variables — no per-theme branches):**

| Role | Background | Text | Shape |
|------|-----------|------|-------|
| User (founder) | `bg-card` | `text-card-foreground` | `rounded-2xl` + `shadow-sm` |
| Assistant (Commander) | `bg-muted` | inherited | `rounded-2xl` |

**Rationale:** brand red (`bg-primary`) is reserved for primary CTAs. A filled brand-red user bubble reads as an error state and is visually indistinguishable from a destructive-action highlight. Actor distinction is by alignment (user right, assistant left), not hue — matching the workspace timeline (`TimelineUserMessage.tsx`).

**Hover timestamp:** relative time (`relativeTime(msg.createdAt)`) fades in at bottom-right of the bubble on `group-hover` (`opacity-0 group-hover:opacity-100 transition-opacity`). Positioned `absolute bottom-1 right-2`, `pointer-events-none`, `text-[10px] text-muted-foreground`. Does not overlap the top-right Copy/ExternalLink icon cluster.

**No avatars:** 1:1 chat; avatars add no disambiguating value (only two actors, always aligned).

**Copy icon:** uses the neutral `text-muted-foreground hover:text-foreground` — no per-role color override. (Decision #101)

---

## 18. Change log

| Date | Change | By |
|------|--------|-----|
| 2026-05-07 | Initial system locked from brainstorm Q1–Q17 | Founder + AI brainstorm |
| 2026-05-08 | Phase A — lobby + marketplace UI overhaul: extracted `LobbyShell`, redesigned `CatalogCard` (§9.13: corner type chip, verified-blue check, aligned footer), added filter-chip nav (§9.16), deleted `MarketplaceLayout`/`TypeTile`/`CategoryTile`. Sidebar active-item dot pattern (§8.2.1) ported to all marketplace pages. | Founder + Sonnet |
| 2026-05-08 | Phase C — marketplace packages UI: added `PackageCard` (§9.15), `MarketplacePackageDetail` page (2-col items grid), `StackedIcon` (§9.14), "Part of {pkg}" pill (§9.17). | Founder + Sonnet |
| 2026-05-09 | Phase D — Settings → `LobbyShell` + `SecondarySidebar` slot: secondary sidebar flush with primary, brand-red glow dot active state matched across both sidebars (§8.2.1), mobile section pills with auto-scroll-into-view (§8.6), primary auto-collapse rule formalized (§8.1.1; Decision #98). | Founder + Sonnet |
| 2026-05-09 | Sectioned hub view (§9.18): Marketplace "All" mode renders type-grouped sections with 6-item cap + "See all →"; Packages strip nests inside the Skills section. derivePackages restricted to skill items only (Decision #97). | Founder + Opus |
| 2026-06-16 | Commander chat bubbles (§17.1): neutral `bg-card` user bubble, `bg-muted` assistant, `rounded-2xl`, hover relative-timestamp, no avatars. Neutral copy icon. (Decision #101) | Founder + Sonnet |

---

**For agentic workers:** When implementing UI work, link to the relevant section of this doc rather than restating tokens. If a design choice isn't covered here, flag it — the doc should grow to cover it, not be ignored.
