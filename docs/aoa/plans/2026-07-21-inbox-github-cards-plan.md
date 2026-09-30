# Inbox & GitHub Settings — Card Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two purely-presentational restructures of existing, working settings surfaces — no wiring, prop, behaviour, `aria-label`, `onChange`, value, or helper-text changes.
1. **Inbox settings panel** (`InboxSettingsPanel.tsx`) — its one flat list becomes **three bordered cards** (Layout / Autopilot / Notifications), each with an icon-tile header; the Autopilot card header carries a **mode pill**, and the Notifications sub-panel becomes always-visible inside its card (the collapsible toggle is removed).
2. **GitHub integration page** (`GitHubIntegrationCard.tsx`) — its one flat panel becomes a **connection status strip** plus **two cards** (GitHub App / Personal access token) with an "or" divider between them.

**Architecture:** Both components keep every query, mutation, handler, state field (except the now-dead notification collapsible flag), control, `aria-label`, and helper sentence exactly as-is. Only the surrounding JSX changes: existing control *blocks are re-parented into card wrappers*. A single shared presentational primitive `SettingsCard` (icon tile + title + description + optional header aside + body) is introduced and consumed by both surfaces. The app's shadcn `Card` primitive (`ui/src/components/ui/card.tsx`) is deliberately **not** used (justified below). No server, API, schema, or type-contract change.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 (CSS-var tokens), lucide-react, TanStack Query, Vitest + Testing Library, Playwright e2e.

**Branch:** `feat/provider-readiness`, worktree `C:\Users\TK\.aoa\wt\providers`. Baseline HEAD before this plan: `c1f46f45a`.

---

## Design decisions (locked before coding)

1. **Both restructures are presentational only.** Every existing control keeps its `aria-label`, current `value`, `onChange`/`onClick`, `disabled` logic, and the explanatory helper sentence added earlier. No prop is added to or removed from `InboxSettingsPanel` or `GitHubIntegrationCard`. The approved mock's card grouping is the spec.

2. **The shadcn `Card` primitive is NOT used; we compose divs matching the app's card idiom.** `ui/src/components/ui/card.tsx` exists, but its `Card` hard-codes `flex flex-col gap-6 border py-6 shadow-sm` with **no rounded corners** and fixed `px-6`/`gap-6`/`py-6` spacing tuned for large marketing-style cards. These settings panels are dense (`text-xs`, `gap-3`) with custom header rows (icon tile + pill + "Saving" indicator). Both reference surfaces the prompt points at — `ProvidersSection` (`rounded-xl border border-border bg-card p-4`) and `GitHubSection` — hand-compose their chrome for the same reason. Fighting the primitive's spacing would cost more than composing. Decision: a small shared `SettingsCard` div-composition, idiomatic (`rounded-xl border border-border bg-card`).

3. **Notifications become always-visible inside their own card (collapsible removed).** Once Notifications has its own bordered card, a second collapse control inside it is redundant chrome and hides the section behind a click the mock does not show. This is the prompt's stated preference. **Consequence:** the `notificationPanelOpen` state, the `useState` import, and the toggle `Button` are deleted, and the three existing tests that reveal the panel by clicking that button must drop the now-unnecessary reveal click (their control + explanation assertions are unchanged and still pass). Enumerated precisely in Task 1, Step 1 and in Risks.

4. **Card grouping (exact):**
   - **Layout** — Default landing, Visible lanes, Grouping, Density.
   - **Autopilot** — the "Autopilot entry" checkbox (`showAutopilotEntry`), Mode select, the per-type autopilot rules, Reset Autopilot. Header aside: a **mode pill** (Off = neutral, Assist = amber, Drive = brand/accent) + the existing "Saving" indicator.
   - **Notifications** — the per-type delivery+toast rules, Quiet hours, Daily digest (+ Acknowledge / Reset buttons). Header aside: the existing "Saving" indicator.

5. **GitHub layout (exact):** a **status strip** at the very top (status dot + one-line summary derived from `appInstalled`/`patConnected`), then the **GitHub App** card (recommended — install / connected-org / authorized-repos), then an **"or"** divider, then the **Personal access token** card (input/connected + docs link). All existing App/PAT queries, mutations, branches, loading/error paths, and the `if (!selectedCompanyId) return null` / `if (isLoading)` early returns stay.

6. **Icons:** `SlidersHorizontal` (Layout), `Zap` (Autopilot), `Bell` (Notifications), `Github` (App), `KeyRound` (PAT) — all standard lucide-react exports.

7. **Token/idiom confirmations (grep-verified against HEAD `c1f46f45a`):** `bg-brand/10 text-brand` (CockpitDiscussionsCard.tsx:70), `bg-muted` (ActivityCharts.tsx), `size-8` tile + `size-2` dot (composer components), `text-brand` (GitHubIntegrationCard.tsx), `cn` from `@/lib/utils`, `type LucideIcon` from `lucide-react` (AgentIconPicker.tsx:44). Settings tabs `?tab=inbox` and `?tab=github` exist (SettingsPage.tsx:29-30, 58, 72).

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `ui/src/components/settings/SettingsCard.tsx` | **Create** | Shared presentational card: icon tile + title + description + optional `headerAside` + body. Used by both restructures. |
| `ui/src/components/settings/__tests__/SettingsCard.test.tsx` | **Create** | Renders title/description/icon/aside/children; header aside only when supplied. |
| `ui/src/components/inbox/InboxSettingsPanel.tsx` | **Modify** | Re-parent existing controls into 3 `SettingsCard`s; add `AutopilotModePill`; delete collapsible state + toggle. No prop change. |
| `ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx` | **Modify** | Keep every control + explanation assertion; drop 3 reveal-clicks; retarget the notification heading; add 3-card-header + mode-pill tests. |
| `ui/src/components/GitHubIntegrationCard.tsx` | **Modify** | Wrap App/PAT content in `SettingsCard`s; add `GitHubStatusStrip`. No query/mutation change. |
| `ui/src/__tests__/GitHubIntegrationCard.test.tsx` | **Modify** | Keep every App/PAT assertion; add status-strip + two-card-header tests. |

`ui/src/__tests__/SettingsPage-redesign.test.tsx` — **no change** (its GitHub test asserts content, not flat structure; verified below).

---

## Repo conventions (apply throughout — these have bitten this initiative)

- `ui/tsconfig.json` **excludes** `__tests__` (`"exclude": ["src/__tests__", "src/**/__tests__"]`) — test files are never typechecked. Type-level guarantees live in source.
- Run everything from the **repo root**.
- **This repo has NO ESLint** (no config, no lint script). The unused-symbol gate is `tsc --noUnusedLocals` over the UI package; **report only NEW diagnostics in files this plan touches.** (Deleting the collapsible in Task 1 makes the `useState` import unused — this plan removes that import in the same edit, so it introduces no new diagnostic. Verify.)
- **Mutation testing is mandatory and the harness itself must be self-verified.** Known harness lies, all of which have occurred on this branch:
  1. **CRLF-vs-LF anchors** silently fail to apply on multi-line patterns — **normalise the file to LF in memory, anchor there, then re-write in the file's ORIGINAL EOL.**
  2. A **stale pristine snapshot** makes every mutation read "applied" — snapshot the pristine file **immediately before each mutation**.
  3. A pure reorder has a **+0 byte delta** — decide "applied" with `git diff --no-index <pristine> <mutated>` (non-empty diff), **never a byte count**.
  4. Diffing against `git HEAD` while the tree has uncommitted edits reads every mutation as APPLIED — diff against the pristine **snapshot**, not HEAD.
  5. **Vitest output decode:** decode the child-process stdout as **UTF-8**, and restore the mutated file in a **`finally`** block. A cp1252 decode has crashed this harness repeatedly on this Windows host, leaving mutants in files. UTF-8 + `finally`-restore is required.
  - Require a **negative control with an impossible anchor** that must report **DID-NOT-APPLY**.
  - Delete the harness script when done (no repo precedent for committing one).
- Known pre-existing flake: `ui/src/__tests__/LobbySidebar.test.tsx` fails intermittently (~3–6%), unrelated to this work. If seen, re-run once and note it.

---

## Task 1: Inbox settings panel → 3 cards

**Files:**
- Create: `ui/src/components/settings/SettingsCard.tsx`
- Create: `ui/src/components/settings/__tests__/SettingsCard.test.tsx`
- Modify: `ui/src/components/inbox/InboxSettingsPanel.tsx`
- Modify: `ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx`

### Step 1: Update the panel tests FIRST (they encode the new structure)

In `ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx`, make these mechanical edits. Every control/explanation assertion is preserved; only the collapsible-reveal machinery is dropped and the notification heading is retargeted.

**(a)** In `"opens notification preferences and changes delivery + toast + quiet hours"` — remove the reveal click and retarget the heading. Find:

```ts
    renderPanel({ onUpdateNotificationPreferences });
    await user.click(screen.getByRole("button", { name: /notification preferences/i }));
    expect(
      screen.getByRole("heading", { name: /notification preferences/i }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/reminder delivery/i), "digest");
```

Replace with:

```ts
    renderPanel({ onUpdateNotificationPreferences });
    // Notifications live in their own always-visible card now (no reveal click).
    expect(
      screen.getByRole("heading", { name: /^Notifications$/ }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/reminder delivery/i), "digest");
```

**(b)** In `"acknowledges and resets from the notification panel"` — remove the reveal click. Find:

```ts
    await user.click(screen.getByRole("button", { name: /notification preferences/i }));
    expect(screen.getByText("Digest reminder")).toBeInTheDocument();
```

Replace with:

```ts
    expect(screen.getByText("Digest reminder")).toBeInTheDocument();
```

**(c)** In `"explains each setting group in plain language"` — the notification explanation is now always visible. Find:

```ts
  it("explains each setting group in plain language", async () => {
    const user = userEvent.setup();
    renderPanel();
```

Replace with:

```ts
  it("explains each setting group in plain language", async () => {
    renderPanel();
```

and find:

```ts
    // The notification explanation lives inside the collapsible sub-panel.
    await user.click(screen.getByRole("button", { name: /notification preferences/i }));
    expect(
      screen.getByText(/how and when each kind of update reaches you/i),
    ).toBeInTheDocument();
```

Replace with:

```ts
    expect(
      screen.getByText(/how and when each kind of update reaches you/i),
    ).toBeInTheDocument();
```

**(d)** Append a new describe block asserting the 3 card headers and the mode pill:

```ts
describe("InboxSettingsPanel card structure", () => {
  it("renders the three settings cards", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: /^Layout$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Autopilot$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Notifications$/ })).toBeInTheDocument();
  });

  it("shows the Autopilot mode pill reflecting the current mode", () => {
    const { rerender } = renderPanel();
    expect(screen.getByTestId("autopilot-mode-pill")).toHaveTextContent(/^Off$/);
    rerender(
      <InboxSettingsPanel
        {...({
          preferences: preferences(),
          onPreferencesChange: vi.fn(),
          autopilotPolicy: autopilotPolicy({ mode: "drive" }),
          autopilotPending: false,
          onUpdateAutopilotPolicy: vi.fn(),
          onResetAutopilotPolicy: vi.fn(),
          notificationPreferences: notificationPreferences(),
          notificationPreferencesPending: false,
          onUpdateNotificationPreferences: vi.fn(),
          onResetNotificationPreferences: vi.fn(),
          digestItems: [],
          onAckDigest: vi.fn(),
        } as React.ComponentProps<typeof InboxSettingsPanel>)}
      />,
    );
    expect(screen.getByTestId("autopilot-mode-pill")).toHaveTextContent(/^Drive$/);
  });
});
```

> Note: `autopilotPolicy({ mode: "drive" })`, `preferences()`, `notificationPreferences()`, and the `React` type are already available in this file (the existing factory helpers + `React.ComponentProps` usage in `renderPanel`). `rerender` comes from the `render` return; capture it via `const { rerender } = renderPanel();`.

### Step 2: Run the panel tests to verify the new ones fail

Run: `pnpm vitest run ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx`
Expected: FAIL — no `Layout`/`Notifications` headings yet, no `autopilot-mode-pill`, and (until Step 4) the removed reveal clicks would still be needed. This confirms the tests bind to the new structure.

### Step 3: Create the shared `SettingsCard`

Create `ui/src/components/settings/SettingsCard.tsx`:

```tsx
/**
 * A settings card: an icon tile + title + one-line description header row, then a
 * body. Presentational only — used by the Inbox settings panel and the GitHub
 * integration surface to group existing controls without changing any of them.
 *
 * We compose divs (not the shadcn `Card` primitive): `Card` hard-codes heavy
 * `py-6`/`gap-6`/`px-6` spacing and carries no rounded corners, which does not
 * fit these dense settings panels. This matches the hand-composed card idiom in
 * `ProvidersSection` and `GitHubSection`.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsCardProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional right-aligned header content (e.g. a mode pill or "Saving" note). */
  headerAside?: ReactNode;
  /** Extra classes for the body wrapper (callers control inner spacing). */
  bodyClassName?: string;
  children: ReactNode;
}

export function SettingsCard({
  icon: Icon,
  title,
  description,
  headerAside,
  bodyClassName,
  children,
}: SettingsCardProps) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-tight">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerAside ? <div className="shrink-0 self-center">{headerAside}</div> : null}
      </header>
      <div className={cn("px-4 py-3", bodyClassName)}>{children}</div>
    </section>
  );
}
```

Create `ui/src/components/settings/__tests__/SettingsCard.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { SettingsCard } from "../SettingsCard";

describe("SettingsCard", () => {
  it("renders the title, description and body", () => {
    render(
      <SettingsCard icon={Bell} title="Notifications" description="How updates reach you">
        <div>body content</div>
      </SettingsCard>,
    );
    expect(screen.getByRole("heading", { name: /^Notifications$/ })).toBeInTheDocument();
    expect(screen.getByText(/how updates reach you/i)).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("renders a header aside only when supplied", () => {
    const { rerender } = render(
      <SettingsCard icon={Bell} title="Notifications">
        <div>x</div>
      </SettingsCard>,
    );
    expect(screen.queryByTestId("aside")).toBeNull();
    rerender(
      <SettingsCard
        icon={Bell}
        title="Notifications"
        headerAside={<span data-testid="aside">pill</span>}
      >
        <div>x</div>
      </SettingsCard>,
    );
    expect(screen.getByTestId("aside")).toBeInTheDocument();
  });
});
```

Run: `pnpm vitest run ui/src/components/settings/__tests__/SettingsCard.test.tsx` — Expected: PASS (2 tests).

### Step 4: Rewrite `InboxSettingsPanel.tsx`

**(a) Imports.** Replace line 1:

```ts
import { useState } from "react";
```

with:

```ts
import { Bell, SlidersHorizontal, Zap } from "lucide-react";
```

Add, immediately after the existing `import { Button } from "@/components/ui/button";` line:

```ts
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/SettingsCard";
```

> `HubAutopilotMode` is already imported (it is in the existing `import type { ... } from "@armyofagents/shared"` block, used by the Mode `onChange`). Confirm it is present; it is required by `AutopilotModePill`.

**(b) Delete the collapsible state.** Remove line 52:

```ts
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
```

**(c) Replace the entire `return (...)` block.** The current return spans the outer `<div className="grid gap-3 border-b border-border bg-card px-4 py-3 text-xs">` … through its matching close at the end of the component (the JSX returned by the function, lines 90–462). Replace that whole returned JSX with the following. Every control block below is moved verbatim from the original (same `aria-label`, `value`, `onChange`, helper `<p>`); only the wrappers change.

```tsx
  return (
    <div className="grid gap-4">
      {/* ── Layout ─────────────────────────────────────────────────────── */}
      <SettingsCard
        icon={SlidersHorizontal}
        title="Layout"
        description="How the Inbox is laid out — landing view, lanes, grouping, and density."
        bodyClassName="grid gap-3 text-xs"
      >
        <label className="grid gap-1">
          <span className="text-muted-foreground">Default landing</span>
          <p className="text-[11px] text-muted-foreground">
            Which view opens when you land on the Inbox.
          </p>
          <select
            aria-label="Default landing"
            value={preferences.defaultLanding}
            onChange={(event) =>
              onPreferencesChange({ defaultLanding: event.target.value as "home" | HubLane })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="home">Home</option>
            <option value="waiting_on_you">Waiting on you</option>
            <option value="notifications">Notifications</option>
            <option value="suggestions">Suggestions</option>
          </select>
        </label>
        <div className="grid gap-1">
          <span className="text-muted-foreground">Visible lanes</span>
          <p className="text-[11px] text-muted-foreground">
            Choose which lanes appear in the rail.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(["waiting_on_you", "notifications", "suggestions"] as const).map((lane) => (
              <label key={lane} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={preferences.visibleLanes.includes(lane)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...preferences.visibleLanes, lane]
                      : preferences.visibleLanes.filter((value) => value !== lane);
                    if (next.length > 0) onPreferencesChange({ visibleLanes: next });
                  }}
                />
                <span>{laneTitle(lane)}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="grid gap-1">
          <span className="text-muted-foreground">Grouping</span>
          <p className="text-[11px] text-muted-foreground">
            How items are grouped in each lane.
          </p>
          <select
            aria-label="Grouping"
            value={preferences.groupMode}
            onChange={(event) =>
              onPreferencesChange({ groupMode: event.target.value as HubGroupMode })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="auto">Auto</option>
            <option value="source">Source</option>
            <option value="scope">Scope</option>
            <option value="type">Type</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">Density</span>
          <p className="text-[11px] text-muted-foreground">
            Row height — Comfortable for readability, Compact to fit more.
          </p>
          <select
            aria-label="Density"
            value={preferences.density}
            onChange={(event) =>
              onPreferencesChange({ density: event.target.value as HubDensity })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
      </SettingsCard>

      {/* ── Autopilot ──────────────────────────────────────────────────── */}
      <SettingsCard
        icon={Zap}
        title="Autopilot"
        description="Let the Hub act on items automatically within the limits you set."
        headerAside={
          <div className="flex items-center gap-2">
            {autopilotPending ? (
              <span className="text-[11px] text-muted-foreground">Saving</span>
            ) : null}
            <AutopilotModePill mode={autopilotPolicy.mode} />
          </div>
        }
        bodyClassName="grid gap-3 text-xs"
      >
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Autopilot entry"
            checked={preferences.showAutopilotEntry}
            onChange={(event) =>
              onPreferencesChange({ showAutopilotEntry: event.target.checked })
            }
          />
          <span>Autopilot entry</span>
        </label>
        <label className="grid gap-1">
          <span className="text-muted-foreground">Mode</span>
          <select
            aria-label="Autopilot mode"
            value={autopilotPolicy.mode}
            disabled={autopilotPending}
            onChange={(event) =>
              onUpdateAutopilotPolicy({
                mode: event.target.value as HubAutopilotMode,
              })
            }
            className="h-8 rounded border border-border bg-bg px-2"
          >
            <option value="off">Off</option>
            <option value="assist">Assist</option>
            <option value="drive">Drive</option>
          </select>
        </label>
        <div className="grid gap-2">
          {autopilotPolicy.rules
            // Hide internal-only sink types (legacy_other) from the
            // founder-facing rules list — they can never fire in a
            // fresh install (Task 10). The stored rule stays intact.
            .filter((rule) => !isInternalSemanticType(rule.semanticType))
            .map((rule) => {
              const label = semanticTypeLabel(rule.semanticType);
              const founderGated = isFounderGatedAutopilotType(rule.semanticType);
              return (
                <div key={rule.semanticType} className="grid gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{label}</div>
                    {founderGated ? (
                      <span className="text-[11px] uppercase text-muted-foreground">
                        Founder-gated
                      </span>
                    ) : null}
                  </div>
                  {founderGated ? (
                    <div className="text-muted-foreground">
                      Escalation only.
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="flex items-center gap-2 self-end">
                        <input
                          type="checkbox"
                          aria-label={`${label} autopilot enabled`}
                          checked={rule.enabled}
                          disabled={autopilotPending}
                          onChange={(event) =>
                            updateAutopilotRule(rule.semanticType, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        <span>Enabled</span>
                      </label>
                      <label className="grid gap-1">
                        <span className="text-muted-foreground">Action</span>
                        <select
                          aria-label={`${label} autopilot action`}
                          value={rule.action}
                          disabled={autopilotPending}
                          onChange={(event) =>
                            updateAutopilotRule(rule.semanticType, {
                              action: event.target.value as HubAutopilotAction,
                            })
                          }
                          className="h-8 rounded border border-border bg-bg px-2"
                        >
                          <option value="none">None</option>
                          <option value="resolve">Resolve</option>
                          <option value="archive">Archive</option>
                        </select>
                      </label>
                      <label className="grid gap-1">
                        <span className="text-muted-foreground">Min trust</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          aria-label={`${label} min trust`}
                          value={rule.minTrustScore}
                          disabled={autopilotPending}
                          onChange={(event) =>
                            updateAutopilotRule(rule.semanticType, {
                              minTrustScore: Number(event.target.value),
                            })
                          }
                          className="h-8 rounded border border-border bg-bg px-2"
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          disabled={autopilotPending}
          onClick={onResetAutopilotPolicy}
        >
          Reset Autopilot
        </Button>
      </SettingsCard>

      {/* ── Notifications ──────────────────────────────────────────────── */}
      <SettingsCard
        icon={Bell}
        title="Notifications"
        description="How and when each kind of update reaches you."
        headerAside={
          notificationPreferencesPending ? (
            <span className="text-[11px] text-muted-foreground">Saving</span>
          ) : null
        }
        bodyClassName="grid gap-3 text-xs"
      >
        <div className="grid gap-2">
          {notificationPreferences.rules
            // Hide internal-only sink types (legacy_other) — see the
            // autopilot list above (Task 10).
            .filter((rule) => !isInternalSemanticType(rule.semanticType))
            .map((rule) => {
              const label = semanticTypeLabel(rule.semanticType);
              return (
                <div key={rule.semanticType} className="grid gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
                  <div className="font-medium">{label}</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1">
                      <span className="text-muted-foreground">Delivery</span>
                      <select
                        aria-label={`${label} delivery`}
                        value={rule.deliveryMode}
                        disabled={notificationPreferencesPending}
                        onChange={(event) =>
                          updateNotificationRule(rule.semanticType, {
                            deliveryMode: event.target.value as NotificationPreference,
                          })
                        }
                        className="h-8 rounded border border-border bg-bg px-2"
                      >
                        <option value="realtime">Realtime</option>
                        <option value="digest">Digest</option>
                        <option value="silent">Silent</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 self-end">
                      <input
                        type="checkbox"
                        aria-label={`${label} toast`}
                        checked={rule.toastEnabled}
                        disabled={notificationPreferencesPending || rule.deliveryMode !== "realtime"}
                        onChange={(event) =>
                          updateNotificationRule(rule.semanticType, {
                            toastEnabled: event.target.checked,
                          })
                        }
                      />
                      <span>Toast</span>
                    </label>
                  </div>
                </div>
              );
            })}
        </div>
        <div className="grid gap-2 border-t border-border pt-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Quiet hours"
              checked={notificationPreferences.quietHours.enabled}
              disabled={notificationPreferencesPending}
              onChange={(event) => updateQuietHours({ enabled: event.target.checked })}
            />
            <span>Quiet hours</span>
          </label>
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="grid gap-1">
              <span className="text-muted-foreground">Start</span>
              <input
                aria-label="Quiet hours start"
                value={notificationPreferences.quietHours.start}
                disabled={notificationPreferencesPending}
                onChange={(event) => updateQuietHours({ start: event.target.value })}
                className="h-8 rounded border border-border bg-bg px-2"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">End</span>
              <input
                aria-label="Quiet hours end"
                value={notificationPreferences.quietHours.end}
                disabled={notificationPreferencesPending}
                onChange={(event) => updateQuietHours({ end: event.target.value })}
                className="h-8 rounded border border-border bg-bg px-2"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">Timezone</span>
              <input
                aria-label="Quiet hours timezone"
                value={notificationPreferences.quietHours.timezone}
                disabled={notificationPreferencesPending}
                onChange={(event) => updateQuietHours({ timezone: event.target.value })}
                className="h-8 rounded border border-border bg-bg px-2"
              />
            </label>
          </div>
        </div>
        <div className="grid gap-2 border-t border-border pt-3">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Digest enabled"
              checked={notificationPreferences.digest.enabled}
              disabled={notificationPreferencesPending}
              onChange={(event) => updateDigest({ enabled: event.target.checked })}
            />
            <span>Digest enabled</span>
          </label>
          <div className="grid gap-1">
            <div className="text-muted-foreground">Pending digest</div>
            {digestItems.length > 0 ? (
              <ul className="grid gap-1">
                {digestItems.slice(0, 5).map((item) => (
                  <li key={item.id} className="truncate rounded border border-border px-2 py-1">
                    {item.title}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-muted-foreground">No pending digest items</div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={notificationPreferencesPending || digestItems.length === 0}
              onClick={onAckDigest}
            >
              Acknowledge digest
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={notificationPreferencesPending}
              onClick={onResetNotificationPreferences}
            >
              Reset notification preferences
            </Button>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
```

**(d) Add `AutopilotModePill` + keep the existing helpers.** The two helper functions `semanticTypeLabel` and `laneTitle` at the bottom of the file stay unchanged. Directly **above** `semanticTypeLabel`, add:

```tsx
/** Compact pill echoing the current Autopilot mode in the card header. */
function AutopilotModePill({ mode }: { mode: HubAutopilotMode }) {
  const label = mode === "drive" ? "Drive" : mode === "assist" ? "Assist" : "Off";
  const tone =
    mode === "drive"
      ? "bg-brand/10 text-brand"
      : mode === "assist"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span
      data-testid="autopilot-mode-pill"
      className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}
    >
      {label}
    </span>
  );
}
```

### Step 5: Run the panel + card suites

Run: `pnpm vitest run ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx ui/src/components/settings/__tests__/SettingsCard.test.tsx`
Expected: PASS — all original control + explanation tests (with the reveal clicks removed) plus the new 3-card + mode-pill tests. No `notificationPanelOpen` remains; no unused `useState`.

### Step 6: Typecheck the touched package

Run: `pnpm --filter @armyofagents/ui exec tsc --noEmit --noUnusedLocals`
Expected: no NEW diagnostics in `SettingsCard.tsx` or `InboxSettingsPanel.tsx` (the `useState` import was removed in the same edit, so it is not reported). Note any pre-existing diagnostics elsewhere and ignore them.

### Step 7: Mutation-check (self-verified harness — see Repo conventions)

Target `AutopilotModePill` in `InboxSettingsPanel.tsx`. Each mutation must be KILLED by the mode-pill test:
- `mode === "drive" ? "Drive" : ...` → force label `"Off"` for all modes → the `Drive` assertion fails.
- `mode === "drive"` condition → `false` → the drive rerender never shows "Drive" → fails.
- Card headers: delete the `title="Notifications"` card's `title` value (e.g. → `"Notes"`) → the `/^Notifications$/` heading test fails (confirms the 3-card test is non-vacuous).
- Negative control (impossible anchor) → **DID-NOT-APPLY**.

Report the mutation table (applied? / killed?) and the negative control.

### Step 8: Commit

```bash
git add ui/src/components/settings/SettingsCard.tsx \
        ui/src/components/settings/__tests__/SettingsCard.test.tsx \
        ui/src/components/inbox/InboxSettingsPanel.tsx \
        ui/src/components/inbox/__tests__/InboxSettingsPanel.test.tsx
git commit -m "feat(inbox): group Inbox settings into Layout / Autopilot / Notifications cards"
```

---

## Task 2: GitHub integration → status strip + 2 cards

**Files:**
- Modify: `ui/src/components/GitHubIntegrationCard.tsx`
- Modify: `ui/src/__tests__/GitHubIntegrationCard.test.tsx`

All queries (`statusQuery`, `appStatusQuery`, `installUrlQuery`, `authorizedReposQuery`), mutations (`setPatMutation`, `removePatMutation`, `disconnectAppMutation`), handlers (`handleConnectWithGitHub`, `handleConnectPat`), and the `if (!selectedCompanyId) return null` / `if (isLoading)` early returns stay **exactly** as they are (lines 28–151). Only the final `return (...)` JSX (lines 153–357) changes.

### Step 1: Add status-strip + card-header tests FIRST

In `ui/src/__tests__/GitHubIntegrationCard.test.tsx`, append a new describe block (the existing `setupDefaults` / `renderCard` / mocks are module-scoped and reused):

```ts
describe("GitHubIntegrationCard — card structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedCompanyId = "co-1";
    setupDefaults();
  });

  it("shows a Not-connected status strip when neither App nor PAT is configured", async () => {
    renderCard();
    const strip = await screen.findByTestId("github-status-strip");
    expect(strip).toHaveTextContent(/not connected/i);
  });

  it("shows a Connected-via-App status strip when the App is installed", async () => {
    mockAppStatus.mockResolvedValue({
      installed: true,
      accountLogin: "myorg",
      accountType: "Organization",
    });
    renderCard();
    const strip = await screen.findByTestId("github-status-strip");
    expect(strip).toHaveTextContent(/connected via github app/i);
    expect(strip).toHaveTextContent(/myorg/i);
  });

  it("renders the GitHub App and Personal access token card headers", async () => {
    renderCard();
    expect(
      await screen.findByRole("heading", { name: /^GitHub App$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^Personal access token$/ }),
    ).toBeInTheDocument();
  });
});
```

Run: `pnpm vitest run ui/src/__tests__/GitHubIntegrationCard.test.tsx`
Expected: FAIL on the three new tests (no strip, no card headings yet); the existing App/PAT tests still PASS (they assert content that has not moved).

### Step 2: Replace the `return (...)` JSX in `GitHubIntegrationCard.tsx`

**(a) Imports.** Add `KeyRound` to the existing lucide import (line 3–9). Change:

```ts
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Github,
  Loader2,
} from "lucide-react";
```

to:

```ts
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Github,
  KeyRound,
  Loader2,
} from "lucide-react";
```

Add, after the existing `import { Button } from "@/components/ui/button";` line:

```ts
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/SettingsCard";
```

**(b) Replace the whole final `return (...)` block** (the `<div className="space-y-6"> … </div>` returned at the end, lines 153–357) with the following. Every App/PAT inner block is moved verbatim; only the wrappers change (App section → `SettingsCard`, PAT section → `SettingsCard`) and the status strip is added on top.

```tsx
  return (
    <div className="space-y-4">
      {/* ── Connection status strip ────────────────────────────────────── */}
      <GitHubStatusStrip
        appInstalled={appInstalled}
        patConnected={patConnected}
        appLogin={appStatusQuery.data?.accountLogin ?? null}
        patUser={statusQuery.data?.githubUser ?? null}
      />

      {/* ── GitHub App card ────────────────────────────────────────────── */}
      <SettingsCard
        icon={Github}
        title="GitHub App"
        description="Org-wide access. Tokens auto-rotate. No manual PAT needed."
        headerAside={
          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
            Recommended
          </span>
        }
        bodyClassName="space-y-2"
      >
        {appInstalled ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
              <CheckCircle2
                className="h-4 w-4 text-emerald-500 shrink-0"
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <span className="font-medium">
                  Connected to{" "}
                  <span className="font-mono">
                    @{appStatusQuery.data?.accountLogin}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground ml-1">
                  ({appStatusQuery.data?.accountType})
                </span>
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => disconnectAppMutation.mutate()}
                disabled={disconnectAppMutation.isPending}
                aria-label="Disconnect App"
              >
                {disconnectAppMutation.isPending
                  ? "Disconnecting…"
                  : "Disconnect App"}
              </Button>
            </div>
            {authorizedReposQuery.data && authorizedReposQuery.data.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Authorized repositories ({authorizedReposQuery.data.length})
                </div>
                <div className="space-y-1 max-h-36 overflow-y-auto rounded-md border border-border/50 px-2 py-1.5">
                  {authorizedReposQuery.data.map((repo) => (
                    <div key={repo.fullName} className="flex items-center gap-2 text-xs">
                      <span className="font-mono truncate flex-1 min-w-0">{repo.fullName}</span>
                      {repo.private && (
                        <span className="shrink-0 rounded px-1 py-0.5 text-[10px] bg-muted text-muted-foreground border border-border/60">
                          private
                        </span>
                      )}
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${repo.fullName} on GitHub`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {authorizedReposQuery.isLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Loading repositories…
              </div>
            )}
          </div>
        ) : (
          <Button
            size="sm"
            variant="default"
            className="gap-1.5"
            onClick={handleConnectWithGitHub}
            disabled={installUrlQuery.isLoading || installUrlQuery.isError}
          >
            {installUrlQuery.isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Github className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Connect with GitHub
          </Button>
        )}
      </SettingsCard>

      {/* Divider */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="flex-1 h-px bg-border" />
        or
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* ── Personal access token card ─────────────────────────────────── */}
      <SettingsCard
        icon={KeyRound}
        title="Personal access token"
        description="Fine-grained PAT fallback for repo + pull-request access."
        headerAside={
          appInstalled ? (
            <span className="text-[11px] text-muted-foreground/60">
              fallback — App is active
            </span>
          ) : null
        }
        bodyClassName="space-y-2"
      >
        {patConnected ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
              <CheckCircle2
                className="mt-0.5 h-4 w-4 text-emerald-500"
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium">
                  Connected as{" "}
                  <span className="font-mono">
                    @{statusQuery.data?.githubUser ?? "unknown"}
                  </span>
                </div>
                {statusQuery.data?.createdAt && (
                  <div className="text-xs text-muted-foreground">
                    Saved {new Date(statusQuery.data.createdAt).toLocaleString()}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => removePatMutation.mutate()}
                disabled={removePatMutation.isPending}
              >
                {removePatMutation.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Fine-grained PAT with <span className="font-mono">repo</span> and{" "}
              <span className="font-mono">pull_requests</span> permissions.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="password"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={patInput}
                onChange={(e) => {
                  setPatInput(e.target.value);
                  if (inlineError) setInlineError(null);
                }}
                placeholder="github_pat_…"
                aria-label="GitHub Personal Access Token"
                disabled={setPatMutation.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && patInput.trim()) {
                    e.preventDefault();
                    handleConnectPat();
                  }
                }}
              />
              <Button
                size="sm"
                onClick={handleConnectPat}
                disabled={!patInput.trim() || setPatMutation.isPending}
              >
                {setPatMutation.isPending ? "Connecting…" : "Connect"}
              </Button>
            </div>
            {inlineError && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle
                  className="mt-0.5 h-4 w-4"
                  aria-hidden="true"
                />
                <span>{inlineError}</span>
              </div>
            )}
            <a
              href={PAT_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Create a GitHub PAT
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
```

**(c) Add `GitHubStatusStrip`** at the bottom of the file, after the `GitHubIntegrationCard` function's closing brace:

```tsx
/** One-line connection summary above the App / PAT cards. Derived, not fetched. */
function GitHubStatusStrip({
  appInstalled,
  patConnected,
  appLogin,
  patUser,
}: {
  appInstalled: boolean;
  patConnected: boolean;
  appLogin: string | null;
  patUser: string | null;
}) {
  const connected = appInstalled || patConnected;
  const summary = appInstalled
    ? `Connected via GitHub App${appLogin ? ` — @${appLogin}` : ""}`
    : patConnected
      ? `Connected via personal access token${patUser ? ` — @${patUser}` : ""}`
      : "Not connected";
  return (
    <div
      data-testid="github-status-strip"
      className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
    >
      <span
        data-testid="github-status-dot"
        className={cn(
          "size-2 shrink-0 rounded-full",
          connected ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
        aria-hidden="true"
      />
      <span className={connected ? "font-medium" : "text-muted-foreground"}>
        {summary}
      </span>
    </div>
  );
}
```

### Step 3: Run the GitHub + SettingsPage suites

Run: `pnpm vitest run ui/src/__tests__/GitHubIntegrationCard.test.tsx ui/src/__tests__/SettingsPage-redesign.test.tsx`
Expected: PASS.
- All existing `GitHubIntegrationCard` App/PAT assertions pass (content unmoved): `/connect with github/i`, `/myorg/i`, `/disconnect app/i`, `github_pat` placeholder, `/@octocat/`, `/github personal access token/i` label, `/^connect$/i`, `/create a github pat/i` link, `/connected as/i`, `/^disconnect$/i`, inline-error path, empty-input disabled.
- New status-strip + card-header tests pass.
- `SettingsPage-redesign` GitHub test (asserts heading `/^GitHub/i` from `GitHubSection`, `/github personal access token/i` label, ≥1 `/Connect/i` button — all unchanged) and the MCP-tab test (`/Personal Access Token/i` null on the **mcp** tab — GitHub card not rendered there) both hold.

### Step 4: Typecheck the touched package

Run: `pnpm --filter @armyofagents/ui exec tsc --noEmit --noUnusedLocals`
Expected: no NEW diagnostics in `GitHubIntegrationCard.tsx` (`KeyRound`, `cn`, `SettingsCard`, `GitHubStatusStrip` all consumed; no symbol left unused).

### Step 5: Mutation-check (self-verified harness)

Target `GitHubStatusStrip`. Each mutation must be KILLED:
- `appInstalled || patConnected` → `appInstalled && patConnected`: the PAT-only case would flip the dot to not-connected — add coverage by asserting the dot class in the App-connected test, OR assert the summary. Simpler: mutate the summary ternary `appInstalled ? ... : patConnected ? ...` first branch to `"Not connected"` → the "Connected via GitHub App" strip test fails.
- Card `title="GitHub App"` → `"App"`: the `/^GitHub App$/` heading test fails (confirms the header test is non-vacuous).
- Negative control (impossible anchor) → **DID-NOT-APPLY**.

Report the mutation table + negative control.

### Step 6: Commit

```bash
git add ui/src/components/GitHubIntegrationCard.tsx ui/src/__tests__/GitHubIntegrationCard.test.tsx
git commit -m "feat(github): status strip + GitHub App / PAT cards on the integration surface"
```

---

## Task 3: Full suite + typecheck + build + LIVE pass

**Files:** none (verification only).

### Step 1: Full UI suite + typecheck + build (repo root)

```bash
pnpm vitest run ui
pnpm -r typecheck
pnpm build
```
Expected: UI suite green (report the new total — this plan adds `SettingsCard.test.tsx` and new cases in two existing files). Typecheck + build clean. If `LobbySidebar.test.tsx` flakes (~3–6%, pre-existing, unrelated), re-run once and note it.

Also run the unused-symbol gate one more time across the touched files:
```bash
pnpm --filter @armyofagents/ui exec tsc --noEmit --noUnusedLocals
```
Report only NEW diagnostics in `SettingsCard.tsx`, `InboxSettingsPanel.tsx`, `GitHubIntegrationCard.tsx`.

### Step 2: Live pass on a fresh HEAD build

Boot the local instance per the initiative runbook (short-path detached worktree; `AOA_HOME=C:\Users\TK\.aoa\prov-live`, `PORT=3493`, `AOA_EMBEDDED_POSTGRES_PORT=54493`, `SERVE_UI=true`, `AOA_UI_DEV_MIDDLEWARE=false`, `AOA_DEV_LOCAL_IDENTITY=1`, run via `npx tsx src/index.ts` from `server/` after `pnpm build`). `local_trusted` needs no auth.

**Inbox** — load `/<prefix>/settings?tab=inbox` and confirm:
1. Three bordered cards render — Layout, Autopilot, Notifications — each with an icon tile + title + description header.
2. The Autopilot card header shows a mode pill matching the Mode select; changing Mode to Assist/Drive updates the pill's text and tone (amber / brand), and the change persists on reload (the mutation still fires).
3. Notifications content (delivery/toast rules, Quiet hours, Digest) is always visible inside its card — no reveal button.
4. Every control still edits and persists: change Density, toggle a lane, flip Autopilot entry, change a rule delivery, toggle Quiet hours, Acknowledge/Reset digest.
5. No console errors.

**GitHub** — load `/<prefix>/settings?tab=github` and confirm:
1. A status strip sits at the top: "Not connected" (neutral dot) with no creds, or "Connected via GitHub App — @org" / "Connected via personal access token — @user" (emerald dot) when configured.
2. A GitHub App card (with a "Recommended" pill) and a Personal access token card, separated by an "or" divider.
3. Every control still works: the PAT input accepts a token and the Connect button enables; the docs link opens; (if an App/PAT is connected in the test instance) the Disconnect buttons work.
4. No console errors.

Capture proof: a screenshot of each page (both cards visible) and one showing the Autopilot mode pill after switching modes.

### Step 3: Report

Report each task's commit SHA, the full UI suite total, the typecheck/build result, the `--noUnusedLocals` result on touched files, both mutation tables + negative controls, the live-pass screenshots/observations, and anything deferred. End with a STATUS line.

---

## Deferred (out of scope, note but do not build)

- **Reusing `SettingsCard` across other settings sections** (Providers, Memory, Environments, Secrets): those surfaces already have bespoke chrome; migrating them is a separate cleanup, not part of this presentational pass.
- **Status-strip actions** (e.g. a "Manage" quick-link in the GitHub strip): the strip is summary-only here.
- **Section header copy changes** in `InboxSection.tsx` / `GitHubSection.tsx`: the outer page headers are untouched; only the inner panels are restructured.

---

## Self-Review

- **Spec coverage:** Inbox → 3 cards (Layout / Autopilot / Notifications) with icon-tile headers (Task 1 Step 4); Autopilot mode pill with off/assist/drive tones (Task 1 Step 4d + test); Notifications always-visible, collapsible removed (Task 1 Steps 1, 4b, 4c); GitHub status strip (Task 2 Step 2c); GitHub App + PAT cards + "or" divider (Task 2 Step 2b); all existing controls keep `aria-label`/value/`onChange`/helper text (verbatim-moved blocks); existing tests preserved or minimally retargeted (Task 1 Step 1, Task 2 Step 1); shared `SettingsCard` primitive, shadcn `Card` explicitly declined with justification (Decision 2); full suite + typecheck + build + live pass (Task 3). All present.
- **Type consistency:** `SettingsCard(props: { icon: LucideIcon; title: string; description?: string; headerAside?: ReactNode; bodyClassName?: string; children: ReactNode })`; `AutopilotModePill({ mode: HubAutopilotMode })`; `GitHubStatusStrip({ appInstalled: boolean; patConnected: boolean; appLogin: string | null; patUser: string | null })`. `InboxSettingsPanel` / `GitHubIntegrationCard` public props unchanged. No new hosted-key or API path (Rule #11 untouched).
- **Placeholder scan:** none — every code step shows complete JSX with the real card wrappers and the exact moved control blocks; every test step shows the test; every run step shows the command + expected result.
- **Unused-symbol check:** `useState` import removed in the same edit that deletes the collapsible (Task 1 Step 4a/4b); all new imports (`Bell`/`Zap`/`SlidersHorizontal`/`KeyRound`/`cn`/`SettingsCard`) are consumed. Gate run in Task 1 Step 6, Task 2 Step 4, Task 3 Step 1.
</content>
</invoke>
