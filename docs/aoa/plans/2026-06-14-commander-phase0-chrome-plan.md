# Commander Phase 0 — Rounded-Panel Chrome Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Render the Commander page's panels (sessions, chat, viewer) as rounded "cards" with uniform gaps + a muted backdrop, matching Memory / Discussions / Workspace.

**Architecture:** Commander is already full-bleed at `Layout` level (`shouldUseFullBleedMain` true for `commander` — leave unchanged; Workspace is full-bleed too). Add chrome *inside the page*, mirroring `WorkspaceLayout`: a `gap-2 p-2 bg-muted/30` wrapper on the panel row + a card class on each panel.

**v2 — revised after a Codex review of v1, which caught four real issues:**
1. `chatColumn` is shared by Commander, the (currently unrendered) docked `InternalAgentPanel`, and the mobile sheet → the card must be **scoped to Commander via a prop**, not applied unconditionally.
2. `SessionsSidebar` root already owns `border-r border-border bg-secondary-sidebar` → **modify its root** (swap those for the card class), don't wrap it (a wrapper double-borders + keeps the wrong bg).
3. `overflow-hidden` in the card class **clips the viewer's `-left-1` resize divider** → the card constant must **NOT** include `overflow-hidden`; add it per-panel only where content should clip (sessions, chat), and **omit it on the viewer** so the divider stays grabbable.
4. The collapsed rail must keep `w-9 … py-2` so the card class doesn't bloat it.
Codex confirmed as non-issues: nested gaps read uniform, the rightmost viewer gets a right gutter (outer `p-2`), chat-input scrolling survives, full-bleed matches Workspace.

**Tech Stack:** React + Tailwind v4. Verification is **visual-first** (chrome is presentational; a full-render unit test of `AgentPanelContent` needs ~6 context providers and is brittle — the skilled call is a visual checklist + a cheap token test, not a brittle render test).

**Phase 1 relationship:** Phase 1 (composition) restructures this into a `react-resizable-panels` group and replaces the hand-rolled divider with the lib's `Separator`. The card *classes* + the `chrome`/`cardChrome` props added here carry forward; the divider concern (#3) is fully retired by Phase 1's `Separator`.

**Verified anchors (read before editing):**
- `ui/src/components/Layout.tsx:29-47` `shouldUseFullBleedMain` (commander :42). **Leave unchanged.**
- `ui/src/pages/Commander.tsx:56` root; `:67` panel row; `:69-75` desktop `<SessionsSidebar>`; `:77` chat container `flex-1 min-w-0 overflow-hidden bg-bg`; `:87-98` mobile drawer `<SessionsSidebar>` (must NOT get chrome).
- `ui/src/components/commander/SessionsSidebar.tsx:469-470` root `<div className="flex flex-col h-full w-56 shrink-0 border-r border-border bg-secondary-sidebar">`.
- `ui/src/components/InternalAgentPanel.tsx` `AgentPanelContentProps` (~:300-325); `chatColumn` const (~:922-924); `AgentPanelContent` return flex-row (~:1343); the docked `InternalAgentPanel()` wrapper (~:1357, renders `<AgentPanelContent />` with no props — must stay card-free).
- `ui/src/components/commander/viewer/CommanderViewerPanel.tsx` expanded container (`relative flex h-full shrink-0 flex-col border-l border-border bg-card`); collapsed rail (`flex h-full w-9 shrink-0 flex-col items-center … border-l border-border bg-card … py-2`); divider at `:252` (`absolute inset-y-0 -left-1 w-2 …`).
- Reference recipe: `ui/src/components/workspace/WorkspaceLayout.tsx:426` row + `:430` panels.

---

## Task 1: Chrome constants + Commander.tsx wiring

**Files:**
- Create: `ui/src/components/commander/commanderChrome.ts`
- Modify: `ui/src/pages/Commander.tsx`

- [ ] **Step 1: Create the constants (no `overflow-hidden` in the card — see fix #3)**

```ts
// ui/src/components/commander/commanderChrome.ts
// Single source of truth for Commander panel chrome (Phase 0). Mirrors the
// Workspace/Memory/Discussions recipe (design-system §5.1 radius, §6 shadow).
// NOTE: overflow-hidden is intentionally NOT here — it clips the viewer's
// resize divider. Add "overflow-hidden" per-panel only where content must clip
// (sessions, chat); omit it on the viewer. Phase 1 reuses these unchanged.
export const COMMANDER_PANEL_CARD =
  "rounded-xl border border-border bg-background shadow-sm";

/** The row that holds the panels: gap + padding + muted backdrop. */
export const COMMANDER_PANEL_ROW = "gap-2 p-2 bg-muted/30";
```

- [ ] **Step 2: Commander.tsx — row wrapper, chat passthrough, pass the scoping props**

Imports:
```ts
import { cn } from "../lib/utils"; // if not already imported
import { COMMANDER_PANEL_ROW } from "../components/commander/commanderChrome";
```

Row `:67`:
```tsx
<div className={cn("flex flex-1 min-h-0 overflow-hidden", COMMANDER_PANEL_ROW)}>
```

Desktop sessions `:69-75` — pass `chrome` (do NOT wrap; SessionsSidebar applies it to its root in Task 2). The **mobile drawer** copy `:87-98` gets **no** `chrome`:
```tsx
{!useDrawerSessions && (
  <SessionsSidebar
    chrome
    activeConversationId={activeConversationId}
    onSelect={setActiveConversationId}
    onNewConversation={handleNewConversation}
  />
)}
```

Chat container `:77` — drop `bg-bg` (the chat panel becomes the card in Task 3) and pass `cardChrome`:
```tsx
<div className="flex-1 min-w-0 overflow-hidden">
  <AgentPanelContent
    conversationId={activeConversationId}
    onSelectConversation={handleSelectConversation}
    onOpenSessions={useDrawerSessions ? () => setSessionsDrawerOpen(true) : undefined}
    enableViewerPanel
    cardChrome
  />
</div>
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/commander/commanderChrome.ts ui/src/pages/Commander.tsx
git commit -m "feat(commander): chrome constants + row wrapper + scoping props (Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SessionsSidebar — `chrome` prop on its root (fix #2)

**Files:**
- Modify: `ui/src/components/commander/SessionsSidebar.tsx` (props + root `:470`)

- [ ] **Step 1: Add the prop**

Find the props interface/signature for `SessionsSidebar` and add:
```ts
  /** Commander desktop: render the sidebar root as a rounded card (drops its
   *  own right border + sidebar bg). Off for the mobile drawer. */
  chrome?: boolean;
```
Destructure `chrome = false` in the component signature.

- [ ] **Step 2: Swap the root classes when `chrome` is on**

Root `:470` — replace `border-r border-border bg-secondary-sidebar` with the card class (keep `flex flex-col h-full w-56 shrink-0`; add `overflow-hidden` since the session list scrolls):
```tsx
import { cn } from "@/lib/utils"; // if not present
import { COMMANDER_PANEL_CARD } from "./commanderChrome";
// ...
<div
  className={cn(
    "flex flex-col h-full w-56 shrink-0",
    chrome
      ? `${COMMANDER_PANEL_CARD} overflow-hidden`
      : "border-r border-border bg-secondary-sidebar",
  )}
>
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/commander/SessionsSidebar.tsx
git commit -m "feat(commander): SessionsSidebar card chrome variant (Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: AgentPanelContent — `cardChrome` prop scopes the chat card (fix #1)

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx` (props ~:300-325; `chatColumn` ~:922; return flex-row ~:1343)

- [ ] **Step 1: Add the prop**

In `AgentPanelContentProps` add `cardChrome?: boolean;`; destructure `cardChrome = false` in the `AgentPanelContent` signature. (The docked `InternalAgentPanel()` wrapper renders `<AgentPanelContent />` with no props → `cardChrome` stays false there. Leave it.)

Import:
```ts
import { COMMANDER_PANEL_CARD } from "./commander/commanderChrome";
```

- [ ] **Step 2: Card the chat column, gated**

`chatColumn` (~:922) — the card + `overflow-hidden` (chat content clips/scrolls) only when `cardChrome`:
```tsx
const chatColumn = (
  <div
    className={cn(
      "flex h-full min-w-0 flex-1 flex-col",
      cardChrome && `${COMMANDER_PANEL_CARD} overflow-hidden`,
    )}
  >
```
(`cn` already imported in this file — confirm.)

- [ ] **Step 3: Inner gap between chat and viewer, gated**

The `AgentPanelContent` return flex-row (~:1343) — add `gap-2` only when `cardChrome` (the `p-2 bg-muted/30` is on the parent row from Task 1; the docked variant has no viewer so it needs no gap):
```tsx
return (
  <div className={cn("flex h-full min-h-0 flex-row overflow-hidden", cardChrome && "gap-2")}>
    {chatColumn}
    {enableViewerPanel && companyId && (
      <CommanderViewerPanel /* ...unchanged props... */ />
    )}
  </div>
);
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/InternalAgentPanel.tsx
git commit -m "feat(commander): cardChrome prop scopes chat-panel card to Commander (Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Viewer panel + rail as cards (fixes #3, #4)

**Files:**
- Modify: `ui/src/components/commander/viewer/CommanderViewerPanel.tsx`

- [ ] **Step 1: Expanded panel — card WITHOUT overflow-hidden (divider stays grabbable)**

Import: `import { COMMANDER_PANEL_CARD } from "../commanderChrome";`

Expanded container — replace `border-l border-border bg-card` with the card class; **do not add `overflow-hidden`** (the inner ViewerTabs header + body already manage their own overflow; leaving the container un-clipped keeps the `-left-1` divider usable):
```tsx
<div ref={containerRef} className={cn("relative flex h-full shrink-0 flex-col", COMMANDER_PANEL_CARD)} style={...}>
```
Leave the divider at `:252` exactly as-is (`absolute inset-y-0 -left-1 w-2 …`) — with no `overflow-hidden` on the container it is no longer clipped.

- [ ] **Step 2: Collapsed rail — card, keep `w-9 … py-2` (fix #4)**

Rail container — replace `border-l border-border bg-card` with the card class; **keep `w-9`, `items-center`, `py-2`** and all icon children unchanged:
```tsx
<div
  className={cn("flex h-full w-9 shrink-0 flex-col items-center gap-2 py-2", COMMANDER_PANEL_CARD)}
  data-testid="commander-viewer-rail"
>
```
(Confirm the exact existing class string and swap only `border-l border-border bg-card` for `COMMANDER_PANEL_CARD`, preserving width/padding/gap/items-center.)

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/commander/viewer/CommanderViewerPanel.tsx
git commit -m "feat(commander): card the viewer panel + rail; keep divider unclipped (Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Token test + visual verification

**Files:**
- Create: `ui/src/components/commander/commanderChrome.test.ts`

- [ ] **Step 1: Token test (cheap regression guard)**

```ts
// ui/src/components/commander/commanderChrome.test.ts
import { describe, it, expect } from "vitest";
import { COMMANDER_PANEL_CARD, COMMANDER_PANEL_ROW } from "./commanderChrome";

describe("commander chrome tokens", () => {
  it("card = rounded + border + shadow, and NOT overflow-hidden (divider safety)", () => {
    expect(COMMANDER_PANEL_CARD).toContain("rounded-xl");
    expect(COMMANDER_PANEL_CARD).toContain("border");
    expect(COMMANDER_PANEL_CARD).toContain("shadow-sm");
    expect(COMMANDER_PANEL_CARD).not.toContain("overflow-hidden");
  });
  it("row = gap + padding + backdrop", () => {
    expect(COMMANDER_PANEL_ROW).toContain("gap-2");
    expect(COMMANDER_PANEL_ROW).toContain("p-2");
    expect(COMMANDER_PANEL_ROW).toContain("bg-muted/30");
  });
});
```
Run: `cd ui && pnpm vitest run src/components/commander/commanderChrome.test.ts` → PASS.

- [ ] **Step 2: Visual verification (the real gate)** — run the app, open `/<prefix>/commander`:
1. Three rounded cards (sessions, chat, viewer rail), uniform 8px gaps, muted backdrop gutter on all sides incl. the right of the viewer.
2. Sessions card has a single hairline border (no double border) + the card bg (not the old sidebar bg).
3. Expand the viewer (⌂) → rounded card sibling to the chat; **drag its left divider → still resizes** (not clipped).
4. Collapse → rail is still the slim `w-9` card (not bloated).
5. Chat input + message scroll behave (no clipped input).
6. Docked-panel check: the chat card chrome appears ONLY on `/commander` (the `cardChrome`/`chrome` props are off elsewhere) — no rounded chrome leaks into other Agent-panel usages.
7. Existing UI green: `cd ui && pnpm vitest run src/components/commander/ src/components/InternalAgentPanel.outputRefs.test.tsx src/__tests__/OutputViewerRegistry.test.ts`.
8. Mobile (narrow window): drawer sessions (no card) + viewer pill still work; page not broken. (Phase 1 reworks mobile fully.)

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/commander/commanderChrome.test.ts
git commit -m "test(commander): chrome token guard (Phase 0)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (applied) + Codex resolution

- **All 4 Codex findings addressed:** #1 chat card gated by `cardChrome` (docked/mobile untouched); #2 SessionsSidebar root modified via `chrome` prop (no wrapper, swaps its border-r/bg); #3 `overflow-hidden` removed from the card constant + omitted on the viewer (divider unclipped), token test asserts its absence; #4 rail keeps `w-9 … py-2`.
- **No placeholders;** exact classes/commands throughout. **Names consistent:** `COMMANDER_PANEL_CARD`/`COMMANDER_PANEL_ROW`, props `chrome` (SessionsSidebar) + `cardChrome` (AgentPanelContent), used identically across 5 files.
- **Scope:** UI-only, 1 new constant + 1 token test + 4 edited files; no backend/schema/behavior change; classes + props carry into Phase 1.
