# Commander Cockpit — "In this conversation" Zone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a conversation-scoped **"In this conversation"** zone at the top of the Commander cockpit, showing the active chat's output refs (artifacts the agent created/referenced this conversation), live, with click-to-open. Reuses the exact deduped ref list the viewer's "Recent from this conversation" already uses.

**Architecture:** Frontend-only. `AgentPanelContent` already derives `const conversationRefs = collectConversationRefs(messages)` (`InternalAgentPanel.tsx:987`, deduped/merged, "created" wins) and feeds it to the viewer home. Thread that same array into `<CommanderCockpitPanel>` as a new optional prop; render a fixed, presentational `CockpitConversationZone` at the TOP of the cockpit body (above the `mountableCards` loop), null when empty. It is NOT a registry card (it's conversation-fed, not `/cockpit`-fed, and always-on — no opt-in/hide). Open a ref via the existing `onOpenArtifact` callback (→ `viewer.openRef`).

**Tech Stack:** React only. No backend, no schema, no `/cockpit` change, no shared-type change (reuses `CommanderOutputRef`).

**Scope (v1):**
- IN: the zone component; thread `conversationRefs` prop into the cockpit; render at top (null when empty); click→open artifact; the "All clear" empty-state accounts for the zone.
- OUT → follow-ups: non-artifact "touched entities" (tasks/goals) — `COMMANDER_OUTPUT_REF_KINDS` is `["artifact"]` only today, so widening to tasks/goals is a separate ref-kind epic; per-conversation persistence beyond the session (refs are ephemeral by design — die on hard reload, reset on conversation switch, both already handled).

**Verified anchors (read before editing):**
- `conversationRefs` source: `ui/src/components/commander/viewer/commanderViewerModel.ts:140-147` (`collectConversationRefs`), `:125-137` (`mergeRefs`); derived at `ui/src/components/InternalAgentPanel.tsx:987` and already passed to the viewer home.
- Viewer's existing section (mirror its UX): `ui/src/components/commander/viewer/CommanderViewerHome.tsx:68-81` ("Recent from this conversation": title + per-ref row + `action === "created"` → "created here" note).
- Ref type: `packages/shared/src/commander-output-refs.ts:15-25` (`CommanderOutputRef` = `{v:1, kind:"artifact", id, versionId?, title?, action:"created"|"referenced", ...}`).
- Cockpit panel: `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` — props/`CockpitInteractions` :31-38, panel signature ~:273, the body `<div ...overflow-y-auto p-2>` + `mountableCards(...).map` loop :340-354, the `visible`/All-clear empty check (the `visible.length === 0` branch). Card chrome to mirror: `CockpitReviewCard.tsx` (section/header/`ul` rows, `group-hover`).
- Cockpit call site: `ui/src/components/InternalAgentPanel.tsx:1487-1496` (`<CommanderCockpitPanel companyId=... onOpenArtifact={(id,title)=>viewer.openRef({v:1,kind:"artifact",id,title,action:"referenced"})} ... />`).

---

## Task 1: `CockpitConversationZone` component

**Files:** Create `ui/src/components/commander/cockpit/CockpitConversationZone.tsx`.

- [ ] Presentational, callbacks only:
```tsx
import { MessagesSquare, FileText } from "lucide-react";
import type { CommanderOutputRef } from "@armyofagents/shared";
// NOTE: sibling cards (CockpitReviewCard etc.) use the inline section classes below
// (`rounded-lg border border-border bg-background p-2`), NOT the panel-level
// COMMANDER_PANEL_CARD (which is the rounded-xl PANEL wrapper). Mirror the cards.

export function CockpitConversationZone({
  refs,
  onOpen,
}: {
  refs: CommanderOutputRef[];
  // Pass the WHOLE ref (Codex #1): opening must preserve versionId, like the
  // viewer home does — a lossy (id,title) rebuild would open the latest version.
  onOpen?: (ref: CommanderOutputRef) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-background p-2" data-testid="cockpit-zone-conversation">
      <header className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <MessagesSquare className="size-3.5" aria-hidden />
        In this conversation
        <span className="ml-auto tabular-nums">{refs.length}</span>
      </header>
      <ul className="space-y-0.5">
        {refs.map((r) => {
          const title = r.title ?? `Artifact ${r.id.slice(0, 8)}`;
          return (
            <li key={`${r.id}:${r.versionId ?? "latest"}`}
                className="group flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50">
              <button type="button" className="min-w-0 flex-1 truncate text-left"
                      onClick={() => onOpen?.(r)}>
                <FileText className="mr-1 inline size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-medium">{title}</span>
              </button>
              {r.action === "created" && (
                <span className="shrink-0 text-[10px] text-muted-foreground">created</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```
Uses the sibling-card section classes (`rounded-lg border border-border bg-background p-2`), NOT `COMMANDER_PANEL_CARD`. `data-testid="cockpit-zone-conversation"`.

---

## Task 2: Thread `conversationRefs` + render the zone at the top

**Files:** Modify `ui/src/components/commander/cockpit/CommanderCockpitPanel.tsx` + `ui/src/components/InternalAgentPanel.tsx`.

- [ ] **Panel props:** add `conversationRefs?: CommanderOutputRef[]` (default `[]`) AND `onOpenRef?: (ref: CommanderOutputRef) => void` to `CommanderCockpitPanel`'s props (alongside `companyId`). Import `CommanderOutputRef` + `CockpitConversationZone`. (`onOpenRef` is the full-ref open path — NOT the lossy `onOpenArtifact`, which drops versionId; Codex #1.)
- [ ] **Render the zone** at the TOP of the scrollable body, BEFORE the `mountableCards(...).map(...)`:
```tsx
<div className="min-h-0 flex-1 overflow-y-auto p-2">  {/* the body div at ~:336 */}
  <CockpitConversationZone refs={conversationRefs} onOpen={onOpenRef} />
  {conversationRefs.length > 0 && <div className="mb-2" />}  {/* spacing only if shown; the zone already has mb via the card stack pattern */}
  {mountableCards(...).map(...)}
  {visible.length === 0 && conversationRefs.length === 0 && (  /* All-clear only when truly nothing */
    <div className="...">All clear — nothing needs you right now.</div>
  )}
</div>
```
  - **Important:** update the existing All-clear empty check to `visible.length === 0 && conversationRefs.length === 0` (so the zone showing alone doesn't sit above an "All clear" message). (Use the cockpit card stack's existing `mb-2`/spacing idiom; don't double-space.)
- [ ] **Call site** (`InternalAgentPanel.tsx:1487`): add `conversationRefs={conversationRefs}` AND `onOpenRef={(ref) => viewer.openRef(ref)}` to `<CommanderCockpitPanel ... />` (both `conversationRefs` (the const at :987) and `viewer` are in scope — same component; `viewer.openRef(ref)` mirrors the viewer home's full-ref open, preserving versionId).
- [ ] `cd ui ; pnpm tsc -b` clean. Commit.

---

## Task 3: Tests + verification

- [ ] **Component tests** (`CockpitConversationZone.test.tsx`): renders refs (title shown; `data-testid` present); returns null when `refs` empty; click a row → `onOpen(ref)` called with the **full ref object** (assert it includes `versionId` — Codex #1, so the right version opens); title falls back to `Artifact <id8>` when `title` is null; shows "created" note only for `action: "created"`.
- [ ] **Panel test** (extend `cockpitCards.test.tsx` or the panel test): when `conversationRefs` is non-empty the zone (`cockpit-zone-conversation`) renders even if all cards are empty; the "All clear" message does NOT show in that case; when both empty, "All clear" shows.
- [ ] **Static:** `(cd ui && pnpm vitest run src/components/commander/ && pnpm tsc -b)` green. `pnpm --filter @armyofagents/shared typecheck` (no shared change, but cheap to confirm).
- [ ] **Live (reuse the running app at http://127.0.0.1:3100 / "Pinned Demo Co"):** the zone needs a conversation with output refs — simplest deterministic check: in the browser, set the active conversation's messages to include an artifact ref is non-trivial without a real agent run, so verify the wiring two ways: (1) **component/panel tests** prove rendering + open; (2) **smoke** — open `/commander`, confirm the cockpit renders with NO conversation zone when the chat has no refs (the `null`-when-empty path), and the page has no console errors. (A full agent-run-produces-artifact e2e is heavier and covered by the existing P1 ref pipeline tests; note it.) Screenshot the cockpit.
- [ ] **Clean tree; do NOT finish the branch.**

---

## Self-review + Codex review (both applied)

**Codex review (read-only vs real code) — 2 IMPORTANT applied, 4 NICE all-correct:**
1. opening must preserve `versionId` → zone uses a full-ref `onOpen(ref)` → `viewer.openRef(ref)` (NOT the lossy `onOpenArtifact(id,title)`). Tasks 1/2/3 updated.
2. don't use `COMMANDER_PANEL_CARD` (panel wrapper) → use the sibling-card `rounded-lg border border-border bg-background p-2`. Applied.
Verified correct: `conversationRefs` in scope at the cockpit render site (:987 & :1487 same closure; already passed to the viewer at :1466); insertion before the `mountableCards` map; empty-check at `:356` → `visible.length===0 && conversationRefs.length===0`; optional `conversationRefs` default `[]` won't break the existing panel-test mocks; `COMMANDER_OUTPUT_REF_KINDS=["artifact"]` (v1 artifact-only); `MessagesSquare`/`FileText` exist in lucide-react.

- **Reuse, not rebuild:** the zone consumes the EXISTING `conversationRefs` (`collectConversationRefs(messages)` at InternalAgentPanel:987) — the same deduped/merged list the viewer home uses. No new derivation, no new query, no backend.
- **Not a registry card:** it's conversation-fed + always-on (no opt-in/hide), so it lives OUTSIDE `COCKPIT_REGISTRY`, rendered as a fixed top zone. Correct per design (§3: session-scoped, distinct from company cards).
- **Empty handling:** zone returns null when no refs; the panel's "All clear" now requires BOTH no visible cards AND no conversation refs (so the zone never sits above a contradictory "All clear").
- **Lifecycle:** refs are ephemeral (die on reload, reset on conversation switch) — already handled by the existing messages-reset effect; the zone just reflects the live `conversationRefs`, so switching chats updates it for free.
- **Open path:** reuses `onOpenArtifact` (already wired to `viewer.openRef`) — no new interaction wiring.
- **Bug-watch:** `conversationRefs` must be in scope at the cockpit call site (it is — same component as :987); the title fallback handles null `title`; the key uses `id:versionId` (matches the viewer home's keying); v1 is artifact-only (kinds = `["artifact"]`) — non-artifact entities are a documented follow-up.
