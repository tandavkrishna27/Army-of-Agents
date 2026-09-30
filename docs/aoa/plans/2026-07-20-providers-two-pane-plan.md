# Providers Tab — Two-Pane Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Settings → Providers grid-of-cards with a persistent two-pane layout — a fixed left "tertiary" provider list and one big right pane that renders the selected provider's detail inline (no overlay, no slide-over).

**Architecture:** `ProvidersSection` keeps every piece of behaviour it already owns (D3 cached-first fetch, one-slot probing, key save, login lifecycle). Only its *render* changes: the `.grid` of eight cards becomes `[ ProviderList | detail ]`, where the detail pane renders the **existing** `ProviderReadinessCard` for the selected provider. The card is presentation-only and already handles every state, so no readiness/status logic is rewritten. A new presentational `ProviderList` renders the left rail; a single extracted helper `deriveProviderBadge` gives the list's status dot the *same* verdict the card's badge shows, so the two cannot drift.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 (CSS-var tokens), shadcn/ui, TanStack Query, Vitest + Testing Library, Playwright e2e.

**Branch:** `feat/provider-readiness`, worktree `C:\Users\TK\.aoa\wt\providers`. Baseline HEAD before this plan: `a93715627`.

---

## Design decisions (locked before coding)

1. **The detail pane renders the existing `ProviderReadinessCard` unchanged.** It already renders ready / needs-sign-in / not-installed / failed / unchecked-agents / borrower states, plus checks, key input, login, and Test. Duplicating any of that into a bespoke detail view would create a second rendering of the same state — the exact drift this whole initiative exists to prevent. The detail pane is a layout container, not new status logic.

2. **The left list's status dot uses `deriveProviderBadge(row).tone`** — the *same* function the card's badge uses. Extracted in Task 1 so the dot and the badge cannot disagree.

3. **No collapse.** The left pane is a fixed-width column. (The user explicitly dropped the earlier collapsible variant.)

4. **Selection is local component state**, defaulting to the first in-use provider (else the first provider). No URL/deep-link sync in this plan — the in-app borrower link handles cross-provider navigation. Deep-linking (`?provider=`) is a deferred follow-up, noted at the end.

5. **The section header stays** (title + description + "Test all"). "Test all" keeps its `data-testid="providers-test-all"` and its home, so its behaviour and tests are untouched. Only the block *below* the header changes.

6. **Borrower navigation changes from scroll to select.** In a grid, `onOpenProvider` scrolled to the owner's card. With one card visible at a time, it now *selects* the owner. The old `cardRefs`/`scrollIntoView` machinery is deleted.

7. **Mobile:** at `<md` the two columns stack (list above detail). No back-button navigation state machine.

8. **No provider brand icons.** The catalog has none, and inventing per-brand colours is ad-hoc. The list uses a status dot + label (the app's existing status-dot idiom). Provider icons are a deferred enhancement.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `ui/src/components/providers/ProviderReadinessCard.tsx` | Modify | Export `deriveProviderBadge(row)` + `TONE_DOT`; card uses the helper for its badge (identical output). |
| `ui/src/components/providers/__tests__/provider-badge.test.ts` | Create | Unit tests for `deriveProviderBadge` + `TONE_DOT` completeness. |
| `ui/src/components/providers/ProviderList.tsx` | Create | Presentational left rail: grouped In-use / Available, status dot + label, selection. |
| `ui/src/components/providers/__tests__/ProviderList.test.tsx` | Create | Rendering, grouping, selection, dot-tone tests. |
| `ui/src/components/settings/sections/ProvidersSection.tsx` | Modify | Two-pane render + selection state; borrower→select; delete scroll refs. Behaviour otherwise unchanged. |
| `ui/src/components/settings/__tests__/ProvidersSection.test.tsx` | Modify | Selection-aware: wait on list items, `select()` helper, rewrite the cached-render and borrower tests. |
| `tests/e2e/providers-readiness.spec.ts` | Modify | Add `selectProvider()`; assertions on a specific provider select it first; "all render" counts list items. |

---

## Repo conventions (apply throughout — these have bitten this initiative)

- `ui/tsconfig.json` **excludes** `__tests__` — test files are never typechecked. Type-level guarantees must live in source.
- Run everything from the **repo root**.
- **Mutation testing is mandatory and the harness itself must be verified.** Known harness lies, all of which have occurred on this branch: (1) CRLF-vs-LF anchors silently fail to apply on multi-line patterns — normalise to LF in memory, anchor there, re-write in the file's original EOL; (2) a stale pristine snapshot makes every mutation read "applied"; (3) a pure reorder has a +0 byte delta — decide "applied" with a real `diff`, never a byte count; (4) diffing against `git HEAD` while the tree carries uncommitted edits makes every mutation read APPLIED — diff against a pristine snapshot with `git diff --no-index`. Require a **negative control with an impossible anchor** that must report DID-NOT-APPLY. Delete the harness script when done (no repo precedent for committing one).
- Known pre-existing flake: `ui/src/__tests__/LobbySidebar.test.tsx` fails intermittently (~3–6%), unrelated to this work. If seen, ignore.

---

## Task 1: Extract `deriveProviderBadge` + `TONE_DOT` (no visual change)

**Files:**
- Modify: `ui/src/components/providers/ProviderReadinessCard.tsx`
- Create: `ui/src/components/providers/__tests__/provider-badge.test.ts`

The card currently computes its badge inline via the private `badgeFor(...)`. Extract a single-call helper so the left list can paint the same verdict, and switch the card to it (identical output — the card's existing 73 tests must pass unmodified).

- [ ] **Step 1: Write the failing unit test**

Create `ui/src/components/providers/__tests__/provider-badge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getProviderById } from "@armyofagents/shared";
import type { ProviderStatusRow, ScopedReadiness } from "@/api/providers";
import {
  deriveProviderBadge,
  TONE_DOT,
  type OutcomeTone,
} from "../ProviderReadinessCard";

function scope(over: Partial<ScopedReadiness> = {}): ScopedReadiness {
  return { scopeType: "company_default", scopeId: null, outcome: "verified", testedAt: null, checks: [], ...over };
}
function agent(name: string, outcome: ScopedReadiness["outcome"]): ScopedReadiness {
  return { scopeType: "agent", scopeId: name, agentName: name, outcome, testedAt: null, checks: [] };
}
function row(over: Partial<ProviderStatusRow> = {}): ProviderStatusRow {
  const d = getProviderById("anthropic")!;
  return {
    descriptor: d,
    companyDefault: scope(),
    agents: [],
    existingKey: { configured: false, source: null, secretName: null, envVar: "X" },
    ...over,
  };
}

describe("deriveProviderBadge", () => {
  it("verified + clean -> plain Ready, ready tone", () => {
    expect(deriveProviderBadge(row())).toEqual({ label: "Ready", tone: "ready" });
  });

  it("verified default + a failing agent -> warn tone, names the count", () => {
    const b = deriveProviderBadge(row({ agents: [agent("A", "needs_auth")] }));
    expect(b.tone).toBe("warn");
    expect(b.label).toMatch(/1 agent failing/);
  });

  it("verified default + only never-probed agents -> neutral, NOT failing", () => {
    const b = deriveProviderBadge(row({ agents: [agent("A", "unknown"), agent("B", "unknown")] }));
    expect(b.tone).toBe("neutral");
    expect(b.label).toMatch(/not checked yet/);
    expect(b.label).not.toMatch(/failing/);
  });

  it("a non-verified company default carries the outcome straight through", () => {
    expect(deriveProviderBadge(row({ companyDefault: scope({ outcome: "needs_auth" }) })))
      .toEqual({ label: "Needs sign-in", tone: "warn" });
  });

  it("TONE_DOT has a class for every tone", () => {
    const tones: OutcomeTone[] = ["ready", "neutral", "warn", "error"];
    for (const t of tones) expect(typeof TONE_DOT[t]).toBe("string");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run ui/src/components/providers/__tests__/provider-badge.test.ts`
Expected: FAIL — `deriveProviderBadge` and `TONE_DOT` are not exported yet.

- [ ] **Step 3: Add `TONE_DOT` next to `TONE_CLASS`**

In `ui/src/components/providers/ProviderReadinessCard.tsx`, immediately after the `TONE_CLASS` declaration (the `export const TONE_CLASS: Record<OutcomeTone, string> = {...}` block), add:

```ts
/**
 * Dot colour per tone, for the compact Providers list where a full pill is too
 * heavy. Kept beside TONE_CLASS so the list dot and the card pill are two views
 * of one palette, not two palettes.
 */
export const TONE_DOT: Record<OutcomeTone, string> = {
  ready: "bg-green-500",
  neutral: "bg-muted-foreground/50",
  warn: "bg-amber-500",
  error: "bg-red-500",
};
```

- [ ] **Step 4: Add the exported `deriveProviderBadge` helper**

`badgeFor(...)` is the private function near the bottom of the file (signature: `badgeFor(outcome, canClaimReady, failingAgents, unverifiableAgents, uncheckedAgents)`). Directly **above** `badgeFor`, add a single-call wrapper that both the card and the list use:

```ts
/**
 * The one badge computation, shared by the card (its status pill) and the
 * Providers list (its status dot). Both call THIS, so a list dot cannot drift
 * from the card badge for the same row — the drift this initiative exists to
 * prevent, applied to the list surface.
 */
export function deriveProviderBadge(
  row: ProviderStatusRow,
): { label: string; tone: OutcomeTone } {
  const { outcome, failingAgents, unverifiableAgents, uncheckedAgents, canClaimReady } =
    deriveCardStatus(row);
  return badgeFor(outcome, canClaimReady, failingAgents, unverifiableAgents, uncheckedAgents);
}
```

`ProviderStatusRow` is already imported from `../../api/providers` in this file (it is in the existing import block alongside `deriveCardStatus`). Confirm by grep; if absent, add it to that existing import — do **not** add a second import line.

- [ ] **Step 5: Switch the card's badge to the helper (identical output)**

In `ProviderReadinessCard(...)`, find the line that computes `badge`:

```ts
  const badge = badgeFor(
    outcome,
    canClaimReady,
    failingAgents,
    unverifiableAgents,
    uncheckedAgents,
  );
```

Replace it with:

```ts
  const badge = deriveProviderBadge(row);
```

The destructured `outcome` / `failingAgents` / `unverifiableAgents` / `uncheckedAgents` / `canClaimReady` from `deriveCardStatus(row)` a few lines above are still used by the agent-block rendering below — leave them. `deriveProviderBadge` recomputes `deriveCardStatus` internally; that is a cheap pure call and keeps the helper self-contained. Output is byte-identical to the old inline call, so the card's rendered badge does not change.

- [ ] **Step 6: Run the new test + the full card suite**

Run: `pnpm vitest run ui/src/components/providers/__tests__/provider-badge.test.ts ui/src/components/providers/__tests__/ProviderReadinessCard.test.tsx`
Expected: PASS — new file green, and **every existing card test passes unmodified** (proves the badge output is unchanged).

- [ ] **Step 7: Mutation-check**

Run the verified mutation harness (see repo conventions). Mutations, each must be KILLED:
- In `deriveProviderBadge`, pass `true` for `canClaimReady` → the "failing agent -> warn" and "unchecked -> neutral" tests must fail.
- Change `TONE_DOT.warn` to `TONE_DOT.ready`'s value → the ProviderList dot-tone test (Task 2) will catch it; for now assert `TONE_DOT.warn !== TONE_DOT.ready` is exercised (add nothing — Task 2 covers it; note it in the report).
- Negative control (impossible anchor) → DID-NOT-APPLY.

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/providers/ProviderReadinessCard.tsx ui/src/components/providers/__tests__/provider-badge.test.ts
git commit -m "refactor(providers): extract deriveProviderBadge + TONE_DOT for the list surface"
```

---

## Task 2: `ProviderList` presentational component

**Files:**
- Create: `ui/src/components/providers/ProviderList.tsx`
- Create: `ui/src/components/providers/__tests__/ProviderList.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/providers/__tests__/ProviderList.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { getProviderById } from "@armyofagents/shared";
import type { ProviderStatusRow, ScopedReadiness } from "@/api/providers";
import { deriveProviderBadge, TONE_DOT } from "../ProviderReadinessCard";
import { ProviderList } from "../ProviderList";

function scope(over: Partial<ScopedReadiness> = {}): ScopedReadiness {
  return { scopeType: "company_default", scopeId: null, outcome: "verified", testedAt: null, checks: [], ...over };
}
function agentScope(name: string): ScopedReadiness {
  return { scopeType: "agent", scopeId: name, agentName: name, outcome: "verified", testedAt: null, checks: [] };
}
function row(id: string, over: Partial<ProviderStatusRow> = {}): ProviderStatusRow {
  const d = getProviderById(id)!;
  return {
    descriptor: d,
    companyDefault: scope(),
    agents: [],
    existingKey: { configured: false, source: null, secretName: null, envVar: d.credential.apiKey?.envVar ?? null },
    ...over,
  };
}
function item(id: string) {
  return screen
    .getAllByTestId("provider-list-item")
    .find((el) => el.getAttribute("data-provider") === id);
}

describe("ProviderList", () => {
  it("renders one item per provider, labelled", () => {
    render(<ProviderList rows={[row("anthropic"), row("openai")]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getAllByTestId("provider-list-item")).toHaveLength(2);
    expect(item("anthropic")?.textContent).toMatch(/Claude/);
  });

  it("splits In use (has agents) from Available, and hides an empty group", () => {
    render(
      <ProviderList
        rows={[row("anthropic", { agents: [agentScope("Scout")] }), row("openai")]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("In use")).toBeTruthy();
    expect(screen.getByText("Available")).toBeTruthy();
  });

  it("hides the In use header when nothing is in use", () => {
    render(<ProviderList rows={[row("anthropic"), row("openai")]} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText("In use")).toBeNull();
  });

  it("marks the selected item and fires onSelect with the provider id", () => {
    const onSelect = vi.fn();
    render(<ProviderList rows={[row("anthropic"), row("openai")]} selectedId="anthropic" onSelect={onSelect} />);
    expect(item("anthropic")?.getAttribute("aria-selected")).toBe("true");
    expect(item("openai")?.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(item("openai")!);
    expect(onSelect).toHaveBeenCalledWith("openai");
  });

  it("paints the status dot with the same tone the card badge would show", () => {
    // A verified default with a needs_auth agent -> warn tone.
    const r = row("anthropic", { agents: [{ scopeType: "agent", scopeId: "A", agentName: "A", outcome: "needs_auth", testedAt: null, checks: [] }] });
    render(<ProviderList rows={[r]} selectedId={null} onSelect={() => {}} />);
    const dot = item("anthropic")!.querySelector("[data-testid='provider-list-dot']")!;
    expect(deriveProviderBadge(r).tone).toBe("warn");
    expect(dot.className).toContain(TONE_DOT.warn);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run ui/src/components/providers/__tests__/ProviderList.test.tsx`
Expected: FAIL — `ProviderList` does not exist.

- [ ] **Step 3: Implement `ProviderList`**

Create `ui/src/components/providers/ProviderList.tsx`:

```tsx
/**
 * The Providers tab's left rail — a fixed tertiary list (third nav level under
 * the primary sidebar and the settings secondary nav). Presentational: it owns
 * no fetching and no selection state; the section supplies both.
 *
 * The status dot uses `deriveProviderBadge`, the SAME verdict the detail card's
 * pill shows, so the rail and the card can never disagree for one row.
 */
import type { ProviderId } from "@armyofagents/shared";
import type { ProviderStatusRow } from "../../api/providers";
import { deriveProviderBadge, TONE_DOT } from "./ProviderReadinessCard";
import { cn } from "@/lib/utils";

export interface ProviderListProps {
  rows: ProviderStatusRow[];
  selectedId: ProviderId | null;
  onSelect(id: ProviderId): void;
}

export function ProviderList({ rows, selectedId, onSelect }: ProviderListProps) {
  const inUse = rows.filter((r) => r.agents.length > 0);
  const available = rows.filter((r) => r.agents.length === 0);
  return (
    <nav
      className="flex flex-col gap-0.5 border-b border-border bg-muted/20 p-2 md:border-b-0 md:border-r"
      data-testid="provider-list"
      aria-label="Providers"
    >
      <ProviderGroup label="In use" items={inUse} selectedId={selectedId} onSelect={onSelect} />
      <ProviderGroup label="Available" items={available} selectedId={selectedId} onSelect={onSelect} />
    </nav>
  );
}

function ProviderGroup({
  label,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  items: ProviderStatusRow[];
  selectedId: ProviderId | null;
  onSelect(id: ProviderId): void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/60">
        {label}
      </div>
      {items.map((row) => (
        <ProviderListItem
          key={row.descriptor.id}
          row={row}
          selected={row.descriptor.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function ProviderListItem({
  row,
  selected,
  onSelect,
}: {
  row: ProviderStatusRow;
  selected: boolean;
  onSelect(id: ProviderId): void;
}) {
  const { descriptor } = row;
  const badge = deriveProviderBadge(row);
  return (
    <button
      type="button"
      data-testid="provider-list-item"
      data-provider={descriptor.id}
      aria-selected={selected}
      onClick={() => onSelect(descriptor.id)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
        selected ? "bg-background ring-1 ring-inset ring-border" : "hover:bg-white/[0.04]",
      )}
    >
      <span
        data-testid="provider-list-dot"
        className={cn("size-2 shrink-0 rounded-full", TONE_DOT[badge.tone])}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{descriptor.label}</span>
    </button>
  );
}
```

The selected-state uses `ring-1 ring-inset ring-border` — the repo's own idiom for a subtle inset outline (see `ui/src/components/IssueProperties.tsx:152` and `cockpitRowStyles.ts`). The `--color-border` token does exist (`ui/src/index.css:38`), but use the ring utility, not a hand-rolled `shadow-[inset...var(--...)]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run ui/src/components/providers/__tests__/ProviderList.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Mutation-check**

Mutations, each must be KILLED:
- `items.length === 0` guard → `false` (always render group): the "hides In use header" test fails.
- `r.agents.length > 0` → `>= 0` (everything In use): the grouping test fails.
- `TONE_DOT[badge.tone]` → `TONE_DOT.ready` (constant): the dot-tone test fails.
- `onSelect(descriptor.id)` → not called: the selection test fails.
- Negative control (impossible anchor) → DID-NOT-APPLY.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/providers/ProviderList.tsx ui/src/components/providers/__tests__/ProviderList.test.tsx
git commit -m "feat(providers): tertiary provider list component"
```

---

## Task 3: Rewire `ProvidersSection` to two-pane

**Files:**
- Modify: `ui/src/components/settings/sections/ProvidersSection.tsx`
- Modify: `ui/src/components/settings/__tests__/ProvidersSection.test.tsx`

All fetching, probing, key-save and login-lifecycle logic stays. Only selection state + the render below the header change, and borrower navigation becomes selection.

- [ ] **Step 1: Update the section tests FIRST (they encode the new structure)**

In `ui/src/components/settings/__tests__/ProvidersSection.test.tsx`:

(a) Replace the `renderAndSettle` helper's settle target and add a `select` helper. Find:

```ts
async function renderAndSettle(rows: ProviderStatusRow[]) {
  listMock.mockResolvedValue({ providers: rows });
  const utils = renderSection();
  await screen.findAllByTestId("provider-card");
  return utils;
}
```

Replace with:

```ts
async function renderAndSettle(rows: ProviderStatusRow[]) {
  listMock.mockResolvedValue({ providers: rows });
  const utils = renderSection();
  await screen.findAllByTestId("provider-list-item");
  return utils;
}

/** Click a provider in the left rail and wait for its detail card. */
async function select(providerId: string) {
  const target = screen
    .getAllByTestId("provider-list-item")
    .find((el) => el.getAttribute("data-provider") === providerId);
  if (!target) throw new Error(`no list item for ${providerId}`);
  fireEvent.click(target);
  await screen.findByTestId("provider-card");
}
```

(b) Replace the "renders one card per provider" test. Find the test titled `"renders one card per provider from the cached list"` and replace it with:

```ts
  it("renders one list item per provider and shows the selected provider's card", async () => {
    await renderAndSettle([row("anthropic"), row("openai"), row("opencode")]);
    expect(screen.getAllByTestId("provider-list-item")).toHaveLength(3);
    // Exactly one detail card is shown (the default selection), never eight.
    expect(screen.getAllByTestId("provider-card")).toHaveLength(1);
    // Labels are in the rail.
    const rail = screen.getByTestId("provider-list");
    expect(rail.textContent).toMatch(/Claude/);
    expect(rail.textContent).toMatch(/Codex/);
  });
```

(c) Replace the borrower test. Find the test titled `"links a borrower to the owner's card instead of a second key input"` and replace it with:

```ts
  it("selecting a borrower links to and selects the owner", async () => {
    // pi borrows provider:anthropic — two inputs on one secret means saving
    // either silently overwrites the other, so the borrower has no input of its
    // own; it points at the owner.
    await renderAndSettle([row("anthropic"), row("pi")]);
    await select("pi");
    const link = screen.getByTestId("provider-key-owner-link");
    expect(link.textContent).toMatch(/Claude/);
    fireEvent.click(link);
    // The owner is now selected: its list item is marked and its detail (a real
    // key section, not an owned-elsewhere pointer) is shown.
    await waitFor(() => {
      const anthropicItem = screen
        .getAllByTestId("provider-list-item")
        .find((el) => el.getAttribute("data-provider") === "anthropic");
      expect(anthropicItem?.getAttribute("aria-selected")).toBe("true");
    });
    expect(screen.getByTestId("provider-key-section")).toBeTruthy();
  });
```

(d) The `Element.prototype.scrollIntoView = vi.fn();` line in `beforeEach` is now unused by assertions but harmless; leave it (jsdom still lacks the method and some card path may call it). Do not assert on it.

- [ ] **Step 2: Run the section tests to verify the new ones fail**

Run: `pnpm vitest run ui/src/components/settings/__tests__/ProvidersSection.test.tsx`
Expected: FAIL — no `provider-list-item` yet; the two rewritten tests fail; several others fail at `renderAndSettle` (it now waits for a testid that does not exist).

- [ ] **Step 3: Add selection state + a default-selection helper**

In `ProvidersSection.tsx`, add the import for `ProviderList` near the other component imports:

```ts
import { ProviderList } from "@/components/providers/ProviderList";
```

Above the `ProvidersPanel` function, add:

```ts
/**
 * The provider the detail pane shows when the founder has not picked one.
 * Prefer an in-use provider — that is where a broken credential actually stops
 * work — then fall back to the first provider, then null (empty catalog).
 */
function defaultSelectedId(rows: ProviderStatusRow[]): ProviderId | null {
  const inUse = rows.find((r) => r.agents.length > 0);
  return (inUse ?? rows[0])?.descriptor.id ?? null;
}
```

Inside `ProvidersPanel`, after `const rows: ProviderStatusRow[] = data?.providers ?? [];`, add:

```ts
  const [selectedId, setSelectedId] = useState<ProviderId | null>(null);
  // Guard a stale id (e.g. after a refetch): fall back to the default rather
  // than render an empty pane for a provider that is no longer listed.
  const effectiveId: ProviderId | null =
    selectedId && rows.some((r) => r.descriptor.id === selectedId)
      ? selectedId
      : defaultSelectedId(rows);
  const selectedRow = rows.find((r) => r.descriptor.id === effectiveId) ?? null;
```

`useState` is already imported (the file imports `useCallback, useEffect, useRef, useState`). Confirm; if `useState` is missing, add it to that existing import.

- [ ] **Step 4: Replace borrower scroll machinery with selection**

Find the borrower-navigation block:

```ts
  /* ── borrower navigation ─────────────────────────────────────────────── */

  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const openProvider = useCallback((ownerId: ProviderId) => {
    const el = cardRefs.current.get(ownerId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();
  }, []);
```

Replace it with:

```ts
  /* ── borrower navigation ─────────────────────────────────────────────── */

  // One card is visible at a time now, so a borrower's "managed on the owner's
  // card" link SELECTS the owner rather than scrolling to it.
  const openProvider = useCallback((ownerId: ProviderId) => {
    setSelectedId(ownerId);
  }, []);
```

- [ ] **Step 5: Replace the render (`grid` of cards → two-pane)**

Find the render block that starts at `<div className="grid gap-3 md:grid-cols-2">` and ends at its closing `</div>` (it maps `rows` to a `data-provider` wrapper around `<ProviderReadinessCard .../>`). Replace the **entire** block with:

```tsx
      <div
        className="grid overflow-hidden rounded-lg border border-border md:grid-cols-[220px_minmax(0,1fr)]"
        data-testid="providers-two-pane"
      >
        <ProviderList rows={rows} selectedId={effectiveId} onSelect={setSelectedId} />
        <div className="min-w-0 p-4 md:p-6" data-testid="provider-detail" data-provider={selectedRow?.descriptor.id}>
          {selectedRow ? (
            <ProviderReadinessCard
              row={selectedRow}
              onTest={() => void runTest(selectedRow.descriptor.id)}
              onSaveKey={(value) => saveKey(selectedRow.descriptor.id, value)}
              onStartLogin={() => void startLogin(selectedRow.descriptor.id)}
              onCancelLogin={cancelLogin}
              login={
                login && login.providerId === selectedRow.descriptor.id
                  ? { status: login.status, loginUrl: login.loginUrl }
                  : null
              }
              onOpenProvider={openProvider}
              busy={busy[selectedRow.descriptor.id] ?? {}}
              error={errors[selectedRow.descriptor.id] ?? null}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Select a provider.</p>
          )}
        </div>
      </div>
```

The old block imported nothing else; the `ProviderReadinessCard` import and `type ProviderCardBusy` import already exist at the top. Leave them.

- [ ] **Step 6: Run the section tests to verify they pass**

Run: `pnpm vitest run ui/src/components/settings/__tests__/ProvidersSection.test.tsx`
Expected: PASS — all tests, including the fresh-company false-red guard (single anthropic row is default-selected, so its card and its unchecked-agents block render).

- [ ] **Step 7: Typecheck**

Run: `pnpm -r typecheck`
Expected: clean. (`ProviderReadinessCard` is now rendered for a possibly-null `selectedRow` — the `selectedRow ?` guard makes this type-safe.)

- [ ] **Step 8: Mutation-check**

Mutations, each must be KILLED by the section suite:
- `defaultSelectedId`: `rows.find((r) => r.agents.length > 0)` → `rows[0]` always. The D3 auto-refresh test and fresh-company test select anthropic by default because it is in use; forcing `rows[0]` still yields anthropic in those fixtures, so add a discriminating case: a fixture where the first row is NOT in use but a later row is, asserting the in-use row is the default card. (Add this test — see Step 8a.)
- `effectiveId` stale-guard: drop the `rows.some(...)` check → selecting then refetching a shrunk list would render an empty pane; hard to hit in a unit fixture, so verify by reasoning and note it.
- `openProvider`: `setSelectedId(ownerId)` → no-op. The borrower test fails (owner never becomes selected).
- Negative control → DID-NOT-APPLY.

- [ ] **Step 8a: Add the default-selection discrimination test**

Append to the `describe("ProvidersSection cached rendering", ...)` block:

```ts
  it("defaults the detail pane to the first IN-USE provider, not merely the first row", async () => {
    // openai is first in the list but idle; anthropic is later but in use.
    await renderAndSettle([
      row("openai"),
      row("anthropic", { agents: [agentScope("Scout")] }),
    ]);
    // The detail card is anthropic's (the in-use one), and its rail item is marked.
    const anthropicItem = screen
      .getAllByTestId("provider-list-item")
      .find((el) => el.getAttribute("data-provider") === "anthropic");
    expect(anthropicItem?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("provider-detail").getAttribute("data-provider")).toBe("anthropic");
  });
```

Run: `pnpm vitest run ui/src/components/settings/__tests__/ProvidersSection.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ui/src/components/settings/sections/ProvidersSection.tsx ui/src/components/settings/__tests__/ProvidersSection.test.tsx
git commit -m "feat(providers): two-pane settings layout (tertiary list + inline detail)"
```

---

## Task 4: Update the e2e spec for two-pane interaction

**Files:**
- Modify: `tests/e2e/providers-readiness.spec.ts`

The `card(page, id)` helper resolves `[data-provider="${id}"]` — which now matches the **detail pane wrapper**, present only when `id` is selected. So any assertion on a specific provider's card must select that provider first. "All render" counts become list-item counts.

- [ ] **Step 1: Add the `selectProvider` helper and adjust `card`**

Find:

```ts
const card = (page: Page, providerId: string) => page.locator(`[data-provider="${providerId}"]`);
const badgeOf = (page: Page, providerId: string) =>
  card(page, providerId).getByTestId("provider-status-badge");
```

Replace with:

```ts
/** Select a provider in the left rail; its detail pane then carries data-provider. */
async function selectProvider(page: Page, providerId: string): Promise<void> {
  await page.locator(`[data-testid="provider-list-item"][data-provider="${providerId}"]`).click();
  await expect(page.locator(`[data-testid="provider-detail"][data-provider="${providerId}"]`)).toBeVisible();
}
// `data-provider` appears on BOTH the rail item and the detail wrapper, so scope
// `card()` to the detail pane. A bare `[data-provider="id"]` double-matches the
// selected provider (its rail button + its detail); descendant testids happen to
// be detail-only today, but a direct .click()/.toBeVisible()/count on the bare
// locator would strict-violate. Do not rely on the coincidence.
const card = (page: Page, providerId: string) =>
  page.locator(`[data-testid="provider-detail"][data-provider="${providerId}"]`);
const badgeOf = (page: Page, providerId: string) =>
  card(page, providerId).getByTestId("provider-status-badge");
```

- [ ] **Step 2: Spec 1 — count list items, not cards; select anthropic before its badge**

In the D3 test, find:

```ts
    await expect(page.getByTestId("provider-card")).toHaveCount(8);
    await expect(badgeOf(page, "anthropic")).toContainText("Ready");
    await expect(card(page, "anthropic").getByTestId("provider-checked-at")).toContainText(
      "checked just now",
    );
```

Replace with:

```ts
    // All eight render in the rail, immediately, from cache.
    await expect(page.getByTestId("provider-list-item")).toHaveCount(8);
    // anthropic is in use (a seeded claude agent) so it is the default detail —
    // but select it explicitly so this assertion does not depend on defaulting.
    await selectProvider(page, "anthropic");
    await expect(badgeOf(page, "anthropic")).toContainText("Ready");
    await expect(card(page, "anthropic").getByTestId("provider-checked-at")).toContainText(
      "checked just now",
    );
```

- [ ] **Step 3: Specs 2, 3, 6a, 6b — select the provider before touching its card**

Each of these acts on a provider that is **not** anthropic (so not the default detail). Insert a `selectProvider` immediately after `openProvidersTab(...)` and before the first `card(page, id)` / `badgeOf(page, id)` use:

- Spec 2 ("Test updates the badge…"): after `await openProvidersTab(page, company.issuePrefix);` add `await selectProvider(page, "google");`
- Spec 3 ("saving an API key…"): after `await openProvidersTab(...)` add `await selectProvider(page, "google");`
- Spec 6a ("Sign in starts a challenge…"): after `await openProvidersTab(...)` add `await selectProvider(page, "openai");`
- Spec 6b ("navigating away cancels…"): after `await openProvidersTab(...)` add `await selectProvider(page, "openai");`

(Spec 4 and Spec 8 act on anthropic, which is the in-use default; add `await selectProvider(page, "anthropic");` after `openProvidersTab` in each anyway, so the specs do not depend on the defaulting rule.)

- [ ] **Step 4: Spec 8 — the page-wide "no failing" assertions still hold**

Spec 8 asserts `page.getByTestId("provider-failing-agents")` has count 0 and `page.getByText(agent.name)` has count 1. With one card visible, the agent name appears only in the selected anthropic card's unchecked block — count 1 holds. Add `await selectProvider(page, "anthropic");` after `openProvidersTab` (as in Step 3) so the anthropic card is deterministically shown before these assertions. No other change.

- [ ] **Step 5: Run the e2e spec**

Run: `AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e -- tests/e2e/providers-readiness.spec.ts`
Expected: **9 passed, 0 skipped.** Confirm it EXECUTED (embedded Postgres booted), not skipped. If any spec cannot run locally, say so explicitly — a silently-skipped spec reports green having tested nothing.

- [ ] **Step 6: Prove two specs are non-vacuous**

Temporarily break the layout to confirm the specs catch it:
- Remove `data-provider={selectedRow?.descriptor.id}` from the detail wrapper in `ProvidersSection.tsx` → `selectProvider` times out (the detail-visible wait fails). Confirm spec 2 goes red. Revert.
- Re-fold `unknown` into `failingAgents` in `deriveCardStatus` (the original false-red) → spec 8 goes red on the `provider-failing-agents` count. Revert.

Report both results.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/providers-readiness.spec.ts
git commit -m "test(providers): e2e adapts to the two-pane select-then-assert flow"
```

---

## Task 5: Full verification + live pass

**Files:** none (verification only).

- [ ] **Step 1: Full suites + typecheck + build from repo root**

Run:
```bash
pnpm vitest run ui
pnpm -r typecheck
pnpm build
```
Expected: UI suite green (baseline was 462 files / 3848 passed + this plan's new files; report the new total). Typecheck + build clean. If `LobbySidebar.test.tsx` flakes (~3–6%, pre-existing, unrelated), re-run once and note it.

- [ ] **Step 2: Live pass on a fresh HEAD build**

Rebuild the server + UI and boot the local instance (per the initiative's runbook: `AOA_HOME=C:\Users\TK\.aoa\prov-live`, `PORT=3493`, `AOA_EMBEDDED_POSTGRES_PORT=54493`, `SERVE_UI=true`, `AOA_UI_DEV_MIDDLEWARE=false`, `AOA_DEV_LOCAL_IDENTITY=1`, run via `npx tsx src/index.ts` from `server/`). Load `/<prefix>/settings?tab=providers` and confirm:
1. The left rail lists all eight providers, grouped In use / Available, each with a status dot.
2. Selecting a provider swaps the right pane inline (no overlay).
3. The default detail is the first in-use provider (Claude, with its unchecked-agents block and neutral "Ready, N agents not checked yet" badge).
4. A borrower (Pi) shows "Managed on the Claude card →"; clicking it selects Claude.
5. Test / key input / (where applicable) Sign in all work in the detail pane.

Capture proof (a screenshot of the two-pane and one after selecting a different provider).

- [ ] **Step 3: Report**

Report: each task's commit SHA, the full UI suite total, the e2e executed/skipped counts + the two break-it-to-prove-it results, the mutation tables, live-pass proof, and anything deliberately deferred. End with a STATUS line.

---

## Deferred (out of scope, note but do not build)

- **Deep-linking** (`?provider=<id>`): selection is component state. A shareable link that opens straight to one provider is a follow-up — it adds URL-sync + its own test surface and is not needed for the layout.
- **Provider brand icons**: the list uses a status dot + label. Per-provider icons/logos are a later enhancement (the catalog carries none today).
- **A reusable `TertiaryListPane` primitive**: this is the app's first in-panel tertiary split. If Memory or Environments later want the same, extract then — not now (YAGNI).

---

## Self-Review

- **Spec coverage:** two-pane layout (Task 3), collapsible removed / fixed pane (Task 3 render), left list grouped + selectable (Task 2), inline detail via existing card (Task 3), borrower→select (Task 3 Step 4), list dot matches card badge (Task 1 helper + Task 2 test), tests + e2e carried along (Tasks 3–4), live pass (Task 5). All present.
- **Type consistency:** `deriveProviderBadge(row: ProviderStatusRow): { label: string; tone: OutcomeTone }`, `TONE_DOT: Record<OutcomeTone, string>`, `ProviderList` props `{ rows, selectedId, onSelect }`, `defaultSelectedId(rows): ProviderId | null`, `openProvider(ownerId: ProviderId)` — names and signatures consistent across Tasks 1–4.
- **Placeholder scan:** none — every code step shows the code; every test step shows the test; every run step shows the command and expected result.

---

## Review record (2026-07-20)

- **Codex:** could not authenticate from this nested session (401 — Codex uses ChatGPT `auth.json`, absent here). Not run. This is a session artifact, not a Codex-on-this-machine failure.
- **Deterministic anchor check:** all 10 find-replace anchors (6 source, 3 test, 1 e2e) grep-verified verbatim against HEAD `a93715627`. Token `--color-border` confirmed present; selected-state locked to the repo idiom `ring-1 ring-inset ring-border`.
- **Independent reviewer (superpowers:code-reviewer):** VERDICT **SOUND — proceed**. Points 1–4, 6 (default-selection, badge extraction byte-identity, fresh-company guard, borrower rewrite, compile-safety) traced correct against the real code. One **P2** found and FIXED in this plan: the e2e `card()` helper double-matched because list items also carry `data-provider`; `card()` now scopes to `[data-testid="provider-detail"]`.
