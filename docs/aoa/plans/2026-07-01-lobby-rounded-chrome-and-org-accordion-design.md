# Lobby rounded chrome + New-organization accordion — Design

**Date:** 2026-07-01
**Branch:** `feat/lobby-ui` (off `origin/main` @ `de90427e1`)
**Status:** Approved (design), pending implementation plan
**Author:** TK + Claude

---

## Goal

Two lobby-tier UI refinements requested by the founder:

1. **Rounded chrome** — make the lobby sidebar (and the lobby-tier secondary
   sidebar) float as rounded "island" panels instead of flush full-height rails
   with a right border.
2. **New-organization accordion** — turn the single "+ New organization" CTA into
   a split control: a primary create button plus a chevron that expands an inline
   accordion revealing an "Import organization" option.

## Scope

**Lobby-tier chrome only** — the surfaces rendered through `LobbyShell`
(`ui/src/components/LobbyShell.tsx`): the Lobby (org list / empty state),
Marketplace, and Settings.

**Explicitly out of scope (follow-up):** the in-company primary `Sidebar`
(WORK / DEPARTMENTS / etc.) and the in-company consumers of `SecondarySidebar`
(`TeamLayout`, in-company `SettingsLayout`). These keep the flush-rail look for
now. A later follow-up may propagate the floating treatment app-wide for
consistency. (User decision: "lobby now, app later.")

## Design decisions (locked during brainstorm)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Aesthetic = "floating rail only"**, not "full floating panels". Only the sidebar(s) become rounded islands; main content stays flush to the window edge. | User compared both live and chose the lighter treatment. |
| D2 | **No drop shadow** on the floating *rail* (inline chrome). The org *menu* is a floating overlay and keeps its shadow. | design-system §7: inline UI never has shadows — but overlays (dropdowns) do. Rail float is carried by border + `bg-card/50`. |
| D3 | **Attached split button**, primary click still creates in one click (no regression). The chevron is a *joined* segment (rounded-r on the primary, rounded-l + left divider on the chevron) so the two read as one control. | Preserves the existing one-click create; the chevron feels part of the button, not a detached second button. |
| D4 | **Import via a floating dropdown menu** anchored to the chevron (`DropdownMenu`, `align="end"`), NOT an inline accordion. | Revised 2026-07-01 after live review: the inline accordion pushed the nav rows down (layout shift) and spanned the full sidebar width (not tied to the button). A floating menu overlays content with no shift and stays aligned to the trigger. |
| D5 | **Collapsed rail (56px) = create-only.** Chevron + accordion hidden; the `+` icon just creates, as today. | User: "when collapsed we don't need to show it." Import is a rarer action; no room at 56px. |
| D6 | **Secondary sidebar rounding is opt-in** via a new `floating` prop (default `false`). | `SecondarySidebar` is shared with in-company pages; a global change would leak past the agreed scope. |

## Components touched

### 1. `LobbySidebar.tsx` (primary rail)

- **Rounded island:** the non-drawer `<aside>` drops `border-r`, gains
  `my-2 ml-2 overflow-hidden rounded-2xl border border-border`, and switches
  height from `h-dvh` to `h-[calc(100dvh-1rem)]` to account for the vertical
  margin. Drawer mode (mobile Sheet) is unchanged (`w-full h-dvh`, no rounding).
- **Attached split-button CTA (expanded only):** a `DropdownMenu` wraps a
  `flex` row of two `Button`s: the primary create button (`onCreateCompany`,
  `flex-1`, `rounded-r-none`) and a `DropdownMenuTrigger`-wrapped chevron button
  (`rounded-l-none`, `border-l border-l-black/20`, `px-2`, aria-label "More
  organization options"). The chevron's `ChevronDown` rotates 180° on open via
  `data-[state=open]:[&_svg]:rotate-180`. `DropdownMenuContent` (`align="end"`,
  `sideOffset={6}`, `min-w-[200px]`) holds one `DropdownMenuItem` — "Import
  organization" (`Upload` icon) whose `onSelect` calls `navTo("/import")`. Radix
  handles open/close, outside-click, keyboard nav, and the floating portal (no
  layout shift). No local open-state is needed.
- **Collapsed CTA:** unchanged — the icon-only `+` button that creates, wrapped
  in a tooltip. No chevron, no accordion.
- **Collapse toggle:** `SidebarCollapseToggle` gets `sidebarWidth + 8` (to sit on
  the seam after the 8px left gutter) and `top={17}` (to align with the header
  row inside the floated card).

### 2. `SecondarySidebar.tsx`

- Add `floating?: boolean` prop (default `false`).
- When `floating`, drop `border-r` and add
  `my-2 ml-2 overflow-hidden rounded-2xl border border-border` plus
  `h-[calc(100dvh-1rem)]`, mirroring the primary rail. When `false`, render
  exactly as today (protects `TeamLayout` + in-company `SettingsLayout`).

### 3. Lobby-tier call site

- `InstanceSettingsPage.tsx` (the only lobby-tier `SecondarySidebar` consumer)
  passes `floating` to its `SecondarySidebar`. In-company consumers are left
  untouched.

### 4. Docs

- `docs/architecture/design-system.md` §8 — document the lobby-tier floating-rail
  treatment (rounded island, `my-2 ml-2`, no shadow per §7, collapse-toggle seam
  offset) so future work stays consistent and knows it is lobby-scoped.

## Data flow / state

- No local open-state — `DropdownMenu` (Radix) owns open/close internally.
- No new props on `LobbyShell` / `LobbySidebar` for import: the sidebar already
  has `navigate`, so import is `navTo("/import")` — the same route the empty-state
  hero uses (`LobbyEmptyState.onImport`).

## Accessibility

- Chevron `DropdownMenuTrigger` button: `aria-label="More organization options"`.
  Radix manages `aria-expanded` / `aria-haspopup` and focus/keyboard nav on the
  menu automatically.
- Import is a `DropdownMenuItem` (role `menuitem`, keyboard-navigable).
- Rounded rails are cosmetic; nav semantics unchanged.

## Testing

- **`LobbySidebar` (new/updated tests):** mock `@/components/ui/dropdown-menu`
  (render children inline, map `DropdownMenuItem.onSelect` → `onClick`, expose
  `role="menuitem"`) following the `AgentCard.test` convention — Radix's real
  portal + pointer events don't run cleanly in jsdom.
  - Expanded: renders the primary create button + the "More organization
    options" trigger; the "Import organization" menuitem navigates to `/import`;
    primary button still calls `onCreateCompany`.
  - Collapsed: no trigger / no import menuitem rendered; `+` still creates.
  - Drawer mode: still renders full-width (no rounding regressions).
- **`SecondarySidebar` (updated test):** `floating` toggles the rounded classes;
  default render is byte-for-byte the flush rail (guards in-company usage).
- Existing `SettingsPage-redesign` / `InstanceSettingsPage-signout` /
  `SecondarySidebar` tests must stay green.

## Risks / edge cases

- **Menu open/close, outside-click, keyboard nav:** all handled by Radix
  `DropdownMenu` — no custom state to get wrong.
- **Menu width vs. narrow rail:** `min-w-[200px]` with `align="end"` keeps the
  floating menu anchored to the chevron and within/over the ~196px content width;
  it overlays the nav rows (by design) rather than shifting them.
- **Collapse-toggle offset is magic-number-ish** (`+8`, `top 17`). Tied to the
  `ml-2` / `my-2` gutter; if the gutter changes, the offset must change with it.
  Documented in §8 so it is not mysterious.
- **`overflow-hidden` on the rail** clips nothing important — the collapse toggle
  and tooltips are rendered outside the aside (sibling / portal), so they are not
  clipped.

## Non-goals

- No change to the empty-state hero (`LobbyEmptyState`) — its Create/Import CTAs
  stay. (The accordion is additive chrome, not a replacement.)
- No app-wide propagation of the floating look.
- No dropdown-menu variant of the org CTA.
