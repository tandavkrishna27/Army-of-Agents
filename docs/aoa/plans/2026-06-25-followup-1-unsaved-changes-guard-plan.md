# Global Unsaved-Changes Guard (Follow-up #1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a single GLOBAL "unsaved changes" navigation guard that catches not only in-page tab nav (already covered) but also sidebar `<Link>` navigation and the browser Back/Forward button. Today's per-page guard in `AgentDetail` only intercepts its own tab switches and hero KPI deep-links; cross-page `<Link>` clicks and the Back button silently discard unsaved Config/Instructions edits.

**Architecture:** Option A (locked in the design doc, decision table row 1). Migrate `ui/src/main.tsx` from plain `<BrowserRouter>` to an *incremental* data router — `createBrowserRouter([{ path: "*", element: <App /> }])` + `<RouterProvider>` — so the entire existing `<Routes>`/`<Route>` tree in `App.tsx` rides along **untouched** (the officially-supported descendant-`<Routes>` nesting bridge). Add one `UnsavedChangesProvider` (mounted inside the router, outside `<Routes>`) that owns exactly **one** `useBlocker` and a centralized "Discard unsaved changes?" `ConfirmDialog`. Expose a `useUnsavedChanges(isDirty)` hook that page components call to register their dirty state. Rewire `AgentDetail` + `AoaAgentDetail` to the global guard and delete the bespoke `pendingNav`/`handleViewChange`/`onHeroNavigate` plumbing (plus the now-dead props threaded through `AgentDetailCore`/`AgentHeroCard`). **Keep `useBeforeUnload`** in both pages — `useBlocker` does not fire on tab-close/refresh.

**Tech Stack:** React 19, react-router-dom `^7.18.0` (supports `createBrowserRouter` + `RouterProvider` + `createMemoryRouter` + `useBlocker`), TypeScript, Vitest + @testing-library/react, Playwright (e2e). App navigation uses `@/lib/router` (auto-injects company prefix; `export * from "react-router-dom"` already re-exports `useBlocker` and `useBeforeUnload` transitively). UI test command: **`pnpm --filter @armyofagents/ui test:run`** (= `vitest run`). Typecheck: **`pnpm --filter @armyofagents/ui typecheck`** (= `tsc -b`). E2e command (real browser, throwaway local_trusted instance on :3199): **`pnpm test:e2e`** (= `playwright test --config=tests/e2e/playwright.config.ts`); single spec: **`pnpm test:e2e agent-unsaved-guard`**; headed for local debugging: **`pnpm test:e2e:headed agent-unsaved-guard`**. Manual runtime verification (spike only) uses the gstack `/browse` skill — never `preview_start` or claude-in-chrome for this app.

> **E2e platform reality (from `tests/e2e/playwright.config.ts`):** the suite boots ONE throwaway instance via `pnpm aoa onboard --yes --run` in `local_trusted` mode (no auth needed), chromium-only, `workers: 1` (specs share one embedded-postgres instance; helpers are not worker-safe), 60s per-test timeout. **On the user's Windows machine the suite self-skips** — `testMatch` collapses to `windows-embedded-postgres-skip.spec.ts` when `process.platform === "win32" && !DATABASE_URL` (embedded-postgres can't start as `runneradmin`). So `agent-unsaved-guard.spec.ts` is proven on **Linux CI (required gate)** and self-skips locally on Windows unless `DATABASE_URL` points at an external Postgres. Local hands-on proof for the dev is the Task 1 `/browse` spike + the Task 6 manual sweep; the e2e is the durable regression net on CI.

---

## File Structure

```
ui/src/
  main.tsx                                  ← MODIFY (router migration; spike then final)
  App.tsx                                   ← UNCHANGED (the <Routes> tree rides along)
  lib/router.tsx                            ← UNCHANGED (useBlocker/useBeforeUnload already re-exported via `export *`)
  context/
    UnsavedChangesProvider.tsx              ← NEW (provider + single useBlocker + centralized ConfirmDialog)
  hooks/
    useUnsavedChanges.ts                    ← NEW (registration hook page components call)
    __tests__/
      useUnsavedChanges.test.tsx            ← NEW (provider/hook unit + parity blocking tests)
  pages/
    AgentDetail.tsx                         ← MODIFY (delete pendingNav/handleViewChange/onHeroNavigate + ConfirmDialog; call useUnsavedChanges; keep useBeforeUnload)
    AoaAgentDetail.tsx                       ← MODIFY (call useUnsavedChanges; keep useBeforeUnload)
  components/agent-detail/
    AgentDetailCore.tsx                     ← MODIFY (remove onHeroNavigate prop)
    AgentHeroCard.tsx                       ← MODIFY (remove onNavigate prop + onClick interception)
    __tests__/
      AgentHeroCard.test.tsx               ← MODIFY (replace the stale onNavigate-fires test with a plain-<Link> render test)
  components/
    AgentConfigForm.tsx                     ← MODIFY (add data-testid="agent-config-name-input" to the Identity "Name" DraftInput — the e2e dirty handle; DraftInput spreads ...props onto its <input>)
  __tests__/
    AoaAgentDetail.test.tsx                 ← MODIFY (drop the mocked-router guard assumptions if any break; add dirty-nav parity if feasible)

tests/e2e/
  agent-unsaved-guard.spec.ts              ← NEW (real-browser Playwright proof of the global guard: sidebar <Link>, browser Back, Discard-vs-Cancel, clean-no-dialog)
  helpers/
    seed-company.ts                        ← UNCHANGED (reused verbatim: seedCompany + cleanupTestCompanies)
```

> **Why the new source `data-testid`:** the Config Identity "Name" field is a `DraftInput` (renders a plain `<input>` that spreads `...props`, so a forwarded `data-testid` lands on the input). It currently exposes only `placeholder="Agent name"`. A placeholder locator is brittle (copy can change), so Task 3 adds `data-testid="agent-config-name-input"` to that one DraftInput as the e2e/integration dirty handle. Everything else the specs touch is already stable via accessible roles/names: the Tabs (`role="tab"` named "Config"/"Instructions"/"Overview"), the sidebar nav (`role="link"` named "Tasks"/"Home"), and the centralized dialog (Radix `AlertDialog` → `role="alertdialog"`, title "Discard unsaved changes?", buttons "Discard & leave" / "Cancel"). No extra testids needed there.

**Repo rules honored:** use `@/lib/router` (auto-prefixing) for all app navigation, never raw `react-router-dom` for app links; AoA is not open source — no OSS/license headers; commit messages end with the `Co-Authored-By` trailer below; this ships as its own PR/branch off `main`.

**Prerequisite:** this is a fresh worktree — run `pnpm install` at the repo root before any build/test step.

---

## Task 1 — SPIKE (manual, throwaway): prove `useBlocker` fires on descendant-`<Routes>` navigations

> **This is the one runtime behavior that cannot be proven by reading.** It is the gating risk for the entire plan. It is manual-verification-driven (the exception to TDD). If the blocker does NOT fire on a sidebar `<Link>` click or the browser Back button, **STOP and report before building the real guard** — Option A is invalidated and the design must be reconsulted.

**Files:**
- `ui/src/main.tsx` (currently mounts `<BrowserRouter>` from `@/lib/router` at line 53; `<App/>` at line 60)

**Why this can't be a unit test:** the Back-button path depends on a real History API + popstate, which jsdom/MemoryRouter only approximate. We want eyes-on proof in a real browser before committing to the architecture.

- [ ] `pnpm install` at repo root (fresh worktree has no `node_modules`).
- [ ] Create a throwaway branch/stash point so the spike edits are trivially reverted (`git stash` or a scratch commit you will `git reset` after).
- [ ] Temporarily edit `ui/src/main.tsx`: replace the `<BrowserRouter>…</BrowserRouter>` wrapper around `<App/>` with a data router. Keep ALL the other providers in the same nesting order. The minimal spike form:
  ```tsx
  // main.tsx — SPIKE ONLY (revert after)
  import { RouterProvider, createBrowserRouter, useBlocker } from "react-router-dom";
  import { Link } from "@/lib/router";

  function SpikeBlocker() {
    // Hardcoded dirty=true to force the blocker on EVERY navigation.
    const blocker = useBlocker(true);
    return (
      <>
        {/* a sidebar-style in-app link to click during the spike */}
        <Link to="/agents" data-spike-link style={{ position: "fixed", top: 0, left: 0, zIndex: 9999 }}>
          SPIKE LINK
        </Link>
        {blocker.state === "blocked" && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 10000, color: "#fff", padding: 40 }}>
            BLOCKED — discard?
            <button onClick={() => blocker.proceed()}>Proceed</button>
            <button onClick={() => blocker.reset()}>Stay</button>
          </div>
        )}
      </>
    );
  }

  const router = createBrowserRouter([
    {
      path: "*",
      element: (
        <>
          <App />
          <SpikeBlocker />
        </>
      ),
    },
  ]);
  // …then replace <BrowserRouter><App/></BrowserRouter> with <RouterProvider router={router} />,
  // keeping every other provider (QueryClient/Theme/Company/Toast/LiveUpdates/Tooltip/Breadcrumb/Sidebar/Dialog/MarketplaceToast/ErrorBoundary) in the SAME order.
  ```
  > NOTE: `SpikeBlocker` and `<App/>` must both render INSIDE the data router (the `element`), because `useBlocker` requires a data-router context. The existing `@/lib/router` `Link` override needs `useCompany()` — that provider already wraps `RouterProvider` in `main.tsx`, so it resolves.
- [ ] Start the app the way this repo runs locally (see the running-instance notes / `pnpm dev` in `ui`, backend on its port). Confirm the app boots and routes normally with the data router (navigate to a couple of pages with dirty=false temporarily if needed to sanity-check the nesting bridge, then set dirty=true).
- [ ] Using the gstack **`/browse`** skill (mandated browser path), load the running app and perform the two critical interactions:
  - [ ] **(a) Sidebar `<Link>` click:** with the hardcoded dirty=true, click a real sidebar nav `<Link>` (or the injected SPIKE LINK). **Success = the BLOCKED overlay appears and the URL does NOT change** until you click "Proceed".
  - [ ] **(b) Browser Back button:** navigate forward once, then press the browser Back button. **Success = the BLOCKED overlay appears and the URL does NOT change** until "Proceed".
- [ ] Also confirm "Proceed" actually completes the navigation and "Stay" cancels it (sanity on `blocker.proceed()` / `blocker.reset()`).
- [ ] **Decision gate:**
  - If BOTH (a) and (b) block → spike PASSES. Record the result (one line in this plan's "Self-review" or a session note: "Spike passed YYYY-MM-DD: <Link> + Back both blocked via descendant-<Routes>"). Proceed to Task 2.
  - If EITHER fails → spike FAILS. **STOP.** Do not build the real guard. Report the exact failure (which interaction, what happened to the URL/overlay) and re-open the design — Option A's incremental-catch-all assumption is broken.
- [ ] Revert ALL spike edits to `main.tsx` (`git checkout ui/src/main.tsx` or pop the stash). The real migration is Task 4; the real provider is Tasks 2–3. Nothing from the spike is kept.

**Success criteria (crisp):** In a real browser, with dirty=true, BOTH a sidebar `<Link>` click and the browser Back button transition `useBlocker` to `state === "blocked"` and prevent the URL change; `proceed()` completes nav; `reset()` cancels. **Failure criteria:** either interaction navigates away without blocking.

---

## Task 2 — `useUnsavedChanges` hook + `UnsavedChangesProvider` (TDD)

Create the global guard primitive: a provider owning ONE `useBlocker` + the centralized confirm dialog, and a `useUnsavedChanges(isDirty)` hook that page components call to register/unregister their dirty state.

**Design of the guard contract:**
- The provider keeps a **count of active dirty registrants** (a ref-counted set keyed by a per-call id), so multiple pages/forms can register simultaneously and the blocker is active iff at least one is dirty. (For this PR only AgentDetail/AoaAgentDetail register, but the count makes it composable for the future opt-ins named in the design doc.)
- `useBlocker` is called with a function form: `useBlocker(({ currentLocation, nextLocation }) => isDirtyNow && currentLocation.pathname !== nextLocation.pathname)`. Same-path nav (e.g. query-only changes) is NOT blocked. Reading dirty state via a ref avoids stale closures.
- When `blocker.state === "blocked"`, the provider renders the centralized `ConfirmDialog` ("Discard unsaved changes?"). Confirm → clear all registrants + `blocker.proceed()`. Cancel/dismiss → `blocker.reset()`.

**Files:**
- `ui/src/hooks/useUnsavedChanges.ts` (NEW)
- `ui/src/context/UnsavedChangesProvider.tsx` (NEW)
- `ui/src/hooks/__tests__/useUnsavedChanges.test.tsx` (NEW)

### Steps

- [ ] **Write the failing test first** at `ui/src/hooks/__tests__/useUnsavedChanges.test.tsx`. Use `createMemoryRouter` + `RouterProvider` (NOT `MemoryRouter`, which is not a data router and has no blocker). Pattern:
  ```tsx
  import { describe, it, expect } from "vitest";
  import { render, screen, waitFor } from "@testing-library/react";
  import userEvent from "@testing-library/user-event";
  import { createMemoryRouter, RouterProvider, Link } from "react-router-dom";
  import { UnsavedChangesProvider } from "../../context/UnsavedChangesProvider";
  import { useUnsavedChanges } from "../useUnsavedChanges";

  function DirtyPage({ dirty }: { dirty: boolean }) {
    useUnsavedChanges(dirty);
    return (
      <div>
        <h1>Dirty Page</h1>
        {/* raw react-router Link is fine in this unit harness — no company prefix here */}
        <Link to="/other">go other</Link>
      </div>
    );
  }
  function OtherPage() {
    return <h1>Other Page</h1>;
  }

  function renderApp(dirty: boolean) {
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <UnsavedChangesProvider>
              {/* a tiny inline Routes-equivalent for the unit harness */}
              <RoutesShim dirty={dirty} />
            </UnsavedChangesProvider>
          ),
        },
      ],
      { initialEntries: ["/"] },
    );
    return render(<RouterProvider router={router} />);
  }
  ```
  Then write these cases as **separate `it(...)` blocks** (each asserting on the centralized dialog title "Discard unsaved changes?" via `screen.getByRole("alertdialog")` / `screen.getByRole("button", { name: "Discard & leave" })` / `screen.getByRole("button", { name: "Cancel" })`). Maximize coverage — these are distinct, independently-failing assertions, NOT one mega-test:

  1. **`dirty + <Link> click → dialog appears AND URL is unchanged` (the block half).**
     ```tsx
     it("dirty + cross-path <Link> → shows the confirm dialog and holds the URL", async () => {
       const user = userEvent.setup();
       renderApp(true);
       expect(screen.getByText("Dirty Page")).toBeInTheDocument();
       await user.click(screen.getByRole("link", { name: "go other" }));
       expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
       expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
       // URL/route did NOT change — still on the dirty page.
       expect(screen.getByText("Dirty Page")).toBeInTheDocument();
       expect(screen.queryByText("Other Page")).not.toBeInTheDocument();
     });
     ```
  2. **`dirty + <Link> + "Discard & leave" → navigation PROCEEDS` (discard-leaves, a SEPARATE assertion from #1).**
     ```tsx
     it("dirty + Discard & leave → proceeds to the target route", async () => {
       const user = userEvent.setup();
       renderApp(true);
       await user.click(screen.getByRole("link", { name: "go other" }));
       await user.click(await screen.findByRole("button", { name: "Discard & leave" }));
       expect(await screen.findByText("Other Page")).toBeInTheDocument();
       expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
     });
     ```
  3. **`dirty + <Link> + "Cancel" → STAYS put` (cancel-stays, a SEPARATE assertion from #2).**
     ```tsx
     it("dirty + Cancel → stays on the page and dismisses the dialog", async () => {
       const user = userEvent.setup();
       renderApp(true);
       await user.click(screen.getByRole("link", { name: "go other" }));
       await user.click(await screen.findByRole("button", { name: "Cancel" }));
       await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
       expect(screen.getByText("Dirty Page")).toBeInTheDocument();
       expect(screen.queryByText("Other Page")).not.toBeInTheDocument();
     });
     ```
  4. **`clean (dirty=false) + <Link> → NO dialog, navigates immediately` (the guard must NOT fire when not dirty).**
     ```tsx
     it("clean nav → no dialog, navigates immediately", async () => {
       const user = userEvent.setup();
       renderApp(false);
       await user.click(screen.getByRole("link", { name: "go other" }));
       expect(await screen.findByText("Other Page")).toBeInTheDocument();
       expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
     });
     ```
  5. **`same-path navigation while dirty → NO dialog` (the `pathname` equality guard).** Render a `<Link>` whose `to` equals the current path (e.g. `to="/"` from `/`) and assert clicking it never raises the dialog even with `dirty=true`.
  6. **Ref-count: two registrants — fires iff ANY is dirty.** Mount TWO `DirtyPage`-style children each calling `useUnsavedChanges(...)` with independent flags inside the same provider:
     - `editorA dirty + editorB clean → cross-path nav SHOWS the dialog` (one dirty is enough).
     - `editorA clean + editorB clean → cross-path nav shows NO dialog`.
     - `editorA dirty, then editorA unmounts (cleanup) → nav shows NO dialog` (unmount drops the registrant so a stale flag can't block forever; assert by conditionally rendering editorA off).
  7. **Two SIMULTANEOUS dirty editors both contribute (Config-dirty vs Instructions-dirty analogue).** Mount `editorA dirty` and `editorB dirty` together; assert one dialog appears on cross-path nav, and that "Discard & leave" clears BOTH registrants (a second immediate cross-path nav after discarding does NOT re-block, proving `registrantsRef.current.clear()` wiped both).
  > **Back-button (popstate):** add an `it.skip("blocks the browser Back button (proven by the Task 1 /browse spike + the agent-unsaved-guard e2e)", ...)` with a one-line comment that jsdom/MemoryRouter popstate is unreliable, so the REAL proof is (a) the manual `/browse` spike (Task 1) and (b) the Playwright `agent-unsaved-guard.spec.ts` `page.goBack()` case (Task 6). Do NOT fake-pass it in jsdom.
- [ ] **Run the test, confirm it FAILS** (modules don't exist yet): `pnpm --filter @armyofagents/ui test:run useUnsavedChanges`.
- [ ] **Implement `ui/src/context/UnsavedChangesProvider.tsx`:**
  ```tsx
  import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
  import { useBlocker } from "@/lib/router";
  import { ConfirmDialog } from "@/components/ui/confirm-dialog";

  interface UnsavedChangesContextValue {
    /** Register/refresh this caller's dirty state under a stable id. */
    setDirty: (id: string, dirty: boolean) => void;
    /** Drop this caller entirely (on unmount). */
    clear: (id: string) => void;
  }

  const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

  export function useUnsavedChangesContext(): UnsavedChangesContextValue {
    const ctx = useContext(UnsavedChangesContext);
    if (!ctx) throw new Error("useUnsavedChanges must be used within <UnsavedChangesProvider>");
    return ctx;
  }

  export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
    // Map of registrant-id → dirty. A ref so the blocker fn reads the latest
    // value without re-subscribing; mirrored into state to recompute `anyDirty`.
    const registrantsRef = useRef<Map<string, boolean>>(new Map());
    const [anyDirty, setAnyDirty] = useState(false);

    const recompute = useCallback(() => {
      let next = false;
      for (const v of registrantsRef.current.values()) {
        if (v) { next = true; break; }
      }
      setAnyDirty((prev) => (prev === next ? prev : next));
    }, []);

    const setDirty = useCallback((id: string, dirty: boolean) => {
      registrantsRef.current.set(id, dirty);
      recompute();
    }, [recompute]);

    const clear = useCallback((id: string) => {
      registrantsRef.current.delete(id);
      recompute();
    }, [recompute]);

    // Block only cross-path navigations while something is dirty. anyDirty is
    // read fresh each evaluation (it's a closed-over state that React keeps
    // current because useBlocker re-runs the fn on each navigation attempt).
    const blocker = useBlocker(
      useCallback(
        ({ currentLocation, nextLocation }) =>
          anyDirty && currentLocation.pathname !== nextLocation.pathname,
        [anyDirty],
      ),
    );

    const value = useMemo<UnsavedChangesContextValue>(() => ({ setDirty, clear }), [setDirty, clear]);

    const blocked = blocker.state === "blocked";

    return (
      <UnsavedChangesContext.Provider value={value}>
        {children}
        <ConfirmDialog
          open={blocked}
          onOpenChange={(open) => {
            if (!open && blocked) blocker.reset();
          }}
          title="Discard unsaved changes?"
          description="You have unsaved edits. Leaving this page will discard them."
          confirmLabel="Discard & leave"
          destructive
          onConfirm={() => {
            // Drop all dirty marks so the proceeded navigation doesn't re-block,
            // then continue.
            registrantsRef.current.clear();
            setAnyDirty(false);
            if (blocker.state === "blocked") blocker.proceed();
          }}
        />
      </UnsavedChangesContext.Provider>
    );
  }
  ```
  > `ConfirmDialog` signature (verified `ui/src/components/ui/confirm-dialog.tsx`): `{ open, onOpenChange, title, description?, confirmLabel?, cancelLabel?, destructive?, onConfirm, disabled? }`. It renders an `AlertDialog` (`role="alertdialog"`) with a Cancel button (default label "Cancel") that closes via `onOpenChange(false)`.
  > `useBlocker` is imported from `@/lib/router` (which `export *`s from `react-router-dom`) to keep the repo's import convention; it is the same symbol either way.
- [ ] **Implement `ui/src/hooks/useUnsavedChanges.ts`:**
  ```tsx
  import { useEffect, useId } from "react";
  import { useUnsavedChangesContext } from "@/context/UnsavedChangesProvider";

  /**
   * Register this component's unsaved-changes state with the global guard.
   * While `isDirty` is true, cross-page navigation (sidebar <Link>, browser
   * Back/Forward, in-app navigate) is intercepted by the central
   * "Discard unsaved changes?" dialog.
   *
   * Tab-close / refresh is NOT covered here (useBlocker can't) — pages that
   * need it keep their own useBeforeUnload.
   */
  export function useUnsavedChanges(isDirty: boolean): void {
    const id = useId();
    const { setDirty, clear } = useUnsavedChangesContext();

    useEffect(() => {
      setDirty(id, isDirty);
    }, [id, isDirty, setDirty]);

    // On unmount, drop this registrant so a stale dirty flag can't block forever.
    useEffect(() => {
      return () => clear(id);
    }, [id, clear]);
  }
  ```
- [ ] **Run the test, confirm it PASSES:** `pnpm --filter @armyofagents/ui test:run useUnsavedChanges`.
- [ ] Run typecheck: `pnpm --filter @armyofagents/ui typecheck`.
- [ ] **Commit:** `feat(ui): add global UnsavedChangesProvider + useUnsavedChanges hook`.

---

## Task 3 — Rewire `AgentDetail` to the global guard; delete bespoke plumbing (TDD)

Replace `AgentDetail`'s bespoke per-page guard with one `useUnsavedChanges(...)` call, and remove the dead navigation-interception machinery + props. Keep `useBeforeUnload`.

**Files:**
- `ui/src/pages/AgentDetail.tsx`
  - line 2: `import { useParams, useNavigate, Link, useBeforeUnload } from "@/lib/router";` → add `useUnsavedChanges`'s import (separate line) but **keep `useBeforeUnload`**.
  - line 201: `const [pendingNav, setPendingNav] = useState<string | null>(null);` → **DELETE**.
  - lines 404–410: `useBeforeUnload(...)` → **KEEP unchanged**.
  - lines 422–432: the `viewPath` helper + `handleViewChange` (the `pendingNav`-setting variant) → **REPLACE** with a plain navigate (no dirty interception — the global guard now handles it).
  - lines 601–610: `onHeroNavigate={(to) => {…setPendingNav(to)…}}` prop on `<AgentDetailCore>` → **DELETE the prop entirely**.
  - lines 687–701: the `<ConfirmDialog open={!!pendingNav} … title="Discard unsaved changes?" …>` → **DELETE** (now centralized in the provider). The terminate `<ConfirmDialog>` (702–713) stays.
- `ui/src/components/agent-detail/AgentDetailCore.tsx` (remove `onHeroNavigate` prop)
- `ui/src/components/agent-detail/AgentHeroCard.tsx` (remove `onNavigate` prop + its onClick interception)
- `ui/src/components/agent-detail/__tests__/AgentHeroCard.test.tsx` (replace the stale `onNavigate`-fires test with a plain-`<Link>` render test — see step below; same task as the prop deletion)

### Steps

- [ ] **Write/extend a failing test** that proves the new wiring. Add a focused spec — `ui/src/__tests__/AgentDetailGuard.test.tsx` (or extend an existing AgentDetail test) — that mounts `AgentDetail` wrapped in `UnsavedChangesProvider` inside a `createMemoryRouter`/`RouterProvider` with a sibling route target, drives the Config tab dirty (type into `getByTestId("agent-config-name-input")`, which is `immediate` → flips `configDirty`), and asserts **each trigger surface as a SEPARATE `it(...)`** so the three navigation entry points are independently covered:
  - **(tab switch, parity with the old `handleViewChange`)** dirty Config + click the **Instructions tab** (`getByRole("tab", { name: "Instructions" })`, a distinct `pathname` `/agents/<ref>/instructions`) → centralized "Discard unsaved changes?" dialog appears; "Discard & leave" proceeds to Instructions; "Cancel" stays on Config with the typed edit still present.
  - **(hero KPI deep-link)** dirty Config + click a hero KPI `<Link>` (`getByTestId("hero-kpi-last-run")` or `hero-kpi-tasks`, a cross-path route) → the SAME centralized dialog appears (proving the deleted per-card `onNavigate` interception was correctly replaced by the global guard, not lost).
  - **(sidebar `<Link>` — shimmed)** dirty Config + click a sibling sidebar-style `<Link to="/issues">` rendered next to `AgentDetail` in the harness → dialog appears; Cancel stays, Discard navigates. (Real sidebar+Back are proven in the e2e, Task 6; this shim proves the provider intercepts an out-of-page `<Link>`.)
  - **(clean control)** with Config NOT dirty, every one of the above navigations happens immediately with NO dialog.
  > Because `AgentDetail` mocks are heavy (see `AoaAgentDetail.test.tsx` for the established mock surface: `@/lib/router`, `../api/agents`, `../context/*`, `AgentDetailCore`, etc.), prefer the integration-style assertion (real `UnsavedChangesProvider` + real `useBlocker` in a `createMemoryRouter`) where the mock surface allows it — that's what proves the three trigger surfaces actually route through the one guard. If the heavy mocks make a full mount impractical, fall back to a `vi.mock` spy on `useUnsavedChanges` asserting `AgentDetail` calls it with `configDirty || instrDirty` AND keep the tab/KPI/sidebar trigger coverage in the Task 2 provider test (which already exercises a real `<Link>`). Do not let the fallback drop the multi-surface coverage — the whole point of this follow-up is that all three entry points hit the same dialog.
- [ ] **Assert BOTH editors independently arm the guard (Config-dirty vs Instructions-dirty).** `AgentDetail` registers `configDirty || instrDirty`, so each editor must be able to trigger the guard alone. Add two assertions (integration mount, or the spy fallback asserting the combined-flag argument transitions to `true`):
  - **Config-only dirty:** type into `getByTestId("agent-config-name-input")` (Instructions untouched) → cross-path nav shows the dialog.
  - **Instructions-only dirty:** switch to the Instructions tab, edit a file in the editor (drives `onDirtyChange(true)` via `AgentInstructionsTab`'s `instrDirty`) with Config clean → cross-path nav shows the dialog.
  > This proves the `||` combination, not just one branch — a regression that wired only `configDirty` (dropping `instrDirty`) would silently pass a Config-only test but fail this Instructions-only one.
- [ ] **Run the test, confirm it FAILS:** `pnpm --filter @armyofagents/ui test:run AgentDetail`.
- [ ] **Edit `AgentDetail.tsx`:**
  - Add the import (line ~2 area, after the `@/lib/router` import line — `useUnsavedChanges` is NOT a router symbol so it imports from the hook):
    ```tsx
    import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
    ```
  - **Delete** line 201 (`const [pendingNav, setPendingNav] = useState<string | null>(null);`).
  - **Register dirty state** — add this call alongside the existing `useBeforeUnload` block (after line 410), so the global guard tracks this page:
    ```tsx
    // Global cross-page guard (sidebar <Link> + browser Back/Forward). Tab-close
    // is still covered by useBeforeUnload above (useBlocker can't catch it).
    useUnsavedChanges(configDirty || instrDirty);
    ```
  - **Replace** the `viewPath`/`handleViewChange` block (422–432). Tab nav no longer needs to pre-empt — the provider blocks any resulting cross-path navigation, and same-path tab changes (overview↔configure are different paths under `/agents/<ref>/…`) are blocked by the provider's path check too. Keep `handleViewChange` as a thin navigate wrapper so `onViewChange`/the overflow menu keep working:
    ```tsx
    const viewPath = (v: string) =>
      v === "overview" ? `/agents/${canonicalAgentRef}` : `/agents/${canonicalAgentRef}/${v}`;
    const handleViewChange = (v: string) => {
      if (v === activeView) return;
      navigate(viewPath(v));
    };
    ```
    > IMPORTANT verify-during-impl: every tab path (`/agents/<ref>` vs `/agents/<ref>/configure` vs `/agents/<ref>/instructions`) is a DISTINCT `pathname`, so the provider's `currentLocation.pathname !== nextLocation.pathname` guard WILL block a dirty tab switch. Confirm in the parity test. If a tab switch were ever same-path (it isn't here), it would slip the guard — that's acceptable per design (same-path = no data loss risk).
  - **Delete** the `onHeroNavigate={…}` prop (601–610) from `<AgentDetailCore>`. Hero KPI deep-links (`/issues?...`, `/agents/<ref>/runs/<id>`) are cross-path and will be blocked by the provider automatically.
  - **Delete** the `pendingNav` `<ConfirmDialog>` (687–701) entirely. Leave the terminate `<ConfirmDialog>` (702–713) intact.
- [ ] **Add the stable e2e dirty handle** to `ui/src/components/AgentConfigForm.tsx`. The Identity "Name" field (lines ~513–520) is a `DraftInput` rendering a plain `<input>` that spreads `...props`. Add a `data-testid` so the e2e (and the AgentDetail integration test) can locate + dirty it reliably without depending on placeholder copy:
    ```tsx
    <Field label="Name" hint={help.name}>
      <DraftInput
        value={eff("identity", "name", props.agent.name)}
        onCommit={(v) => mark("identity", "name", v)}
        immediate
        className={inputClass}
        placeholder="Agent name"
        data-testid="agent-config-name-input"
      />
    </Field>
    ```
    > `DraftInput` (`agent-config-primitives.tsx:300`) destructures `value/onCommit/immediate/className` and spreads the rest onto `<input {...props}>`, so `data-testid` lands on the input element. `immediate` means each keystroke calls `onCommit` → marks the Config draft dirty synchronously (no blur needed) — exactly what the e2e/integration tests rely on to flip `configDirty`. This is the ONLY source-test-id this plan introduces.
- [ ] **Edit `AgentDetailCore.tsx`:** remove the `onHeroNavigate?: (to: string) => boolean;` prop (lines 35–37 of the interface), remove it from the destructure (line 66), and remove `onNavigate={onHeroNavigate}` from `<AgentHeroCard>` (line 81).
- [ ] **Edit `AgentHeroCard.tsx`:** remove the `onNavigate?: (to: string) => boolean;` prop (lines 30–32 of `AgentHeroCardProps`), remove it from the destructure (line 55), and remove the `onClick={(e) => { if (onNavigate?.(kpi.to!)) e.preventDefault(); }}` handler from the KPI `<Link>` (lines 119–121). The KPI `<Link>` keeps its `to`, `data-testid`, and className. After this edit the KPI link is a plain navigation `<Link>` again — the discard-confirm now happens globally via the provider's `useBlocker`, not via an inline per-Link interception.
- [ ] **UPDATE the existing `AgentHeroCard` test to match the deleted prop** at `ui/src/components/agent-detail/__tests__/AgentHeroCard.test.tsx`. The current file has a test (lines 65–78) that asserts the now-deleted `onNavigate` callback fires:
    ```tsx
    // Codex P2: KPI deep-links must run through the unsaved-changes guard so they
    // don't navigate away (and drop a dirty draft) without the discard-confirm.
    it("routes KPI deep-link clicks through onNavigate", () => {
      const onNavigate = vi.fn().mockReturnValue(true);
      renderWithProviders(
        <AgentHeroCard
          agent={agent}
          onNavigate={onNavigate}
          kpis={[{ key: "last-run", label: "Last run", value: "1m", to: "/agents/x/runs/r1" }]}
        />,
      );
      fireEvent.click(screen.getByTestId("hero-kpi-last-run"));
      expect(onNavigate).toHaveBeenCalledWith("/agents/x/runs/r1");
    });
    ```
    The `onNavigate` prop no longer exists, so this assertion is stale (it would also typecheck-fail on the unknown `onNavigate` prop). **Delete that whole `it(...)` block (lines 65–78, including the two-line `// Codex P2:` comment above it) and replace it** with a plain-`<Link>` rendering/navigation test — the hero KPI must still render a real link to the right route, but no longer intercept the click. The blocking behavior now lives in the provider/router tests (Task 2's `useUnsavedChanges.test.tsx` + Task 3's `AgentDetailGuard` spec), NOT the hero card. Replacement block:
    ```tsx
    // The KPI deep-link is now a plain navigation <Link> — the discard-confirm
    // is handled globally by UnsavedChangesProvider's useBlocker, not by an
    // inline onClick on the hero card. (Blocking behavior is covered in
    // useUnsavedChanges.test.tsx + the AgentDetail guard spec.)
    it("renders a KPI deep-link as a plain <Link> to its route", () => {
      renderWithProviders(
        <AgentHeroCard
          agent={agent}
          kpis={[{ key: "last-run", label: "Last run", value: "1m", to: "/agents/x/runs/r1" }]}
        />,
      );
      const lastRun = screen.getByTestId("hero-kpi-last-run");
      expect(lastRun.tagName).toBe("A");
      expect(lastRun.getAttribute("href")).toContain("/agents/x/runs/r1");
    });
    ```
    > NOTE: `renderWithProviders` (from `../../../__tests__/test-utils`) already mounts a `MemoryRouter`, so the `@/lib/router` `Link` resolves and renders an `<a>` with a company-prefixed `href` ending in `/agents/x/runs/r1` — hence `toContain` (not strict equality) on the href. The unused `fireEvent` import (line 2) can stay (the file's other tests don't use it after this change, but leaving it is harmless; if `pnpm typecheck`/lint flags an unused import, drop `fireEvent` from the line-2 destructure: `import { screen } from "@testing-library/react";`). `vi` is still used by other tests in the file (e.g. `onIconChange={vi.fn()}`), so keep it.
- [ ] **Run the test, confirm it PASSES.** Run the full UI suite to catch fallout: `pnpm --filter @armyofagents/ui test:run`.
- [ ] Run typecheck: `pnpm --filter @armyofagents/ui typecheck`.
- [ ] **Commit:** `refactor(ui): route AgentDetail through global unsaved-changes guard; remove bespoke pendingNav plumbing`.

---

## Task 4 — Migrate `main.tsx` to the data router (final, non-throwaway)

Apply the real router migration (the spike is reverted). The `<Routes>` tree in `App.tsx` is untouched; `UnsavedChangesProvider` is mounted inside the router, outside `<Routes>`.

**Files:**
- `ui/src/main.tsx` (lines 1–76)

### Steps

- [ ] **Write a failing/guard test** at `ui/src/__tests__/main-router.test.tsx` (or extend `LayoutRoutes.test.ts` style) that imports the app shell and asserts a `RouterProvider`-based render boots and `UnsavedChangesProvider` is present. If a full `main.tsx` mount is impractical (it has side effects: service worker, plugin bridge), instead assert at the provider-composition level: extract the provider tree into a testable component if needed, OR rely on the Task 2/3 tests + the spike for behavior coverage and make this a typecheck-only change. Prefer NOT to over-engineer — the spike + unit tests already prove the runtime contract.
- [ ] **Edit `main.tsx`:**
  - Replace the import on line 4 `import { BrowserRouter } from "@/lib/router";` with:
    ```tsx
    import { RouterProvider, createBrowserRouter } from "react-router-dom";
    ```
    > Note: `createBrowserRouter`/`RouterProvider` are data-router factories used ONCE at the app root — raw `react-router-dom` is correct here (the `@/lib/router` auto-prefix wrappers are for in-tree navigation components, not the root factory).
  - Add the new provider import (with the other context imports, ~lines 7–13):
    ```tsx
    import { UnsavedChangesProvider } from "./context/UnsavedChangesProvider";
    ```
  - Replace the `<BrowserRouter> … </BrowserRouter>` block (lines 53–69) with a catch-all data router. Build the router from a component that contains the exact same inner provider stack, then mount it. Concretely, replace lines 53–69 so the tree becomes (everything OUTSIDE `<BrowserRouter>` — `QueryClientProvider`/`ThemeProvider`/`CompanyProvider`/`ToastProvider`/`LiveUpdatesProvider` — stays where it is, wrapping the `RouterProvider`):
    ```tsx
    // Inner shell rendered as the data router's single catch-all element.
    // The existing <Routes>/<Route> tree in <App/> rides along unchanged.
    function RouterShell() {
      return (
        <TooltipProvider>
          <BreadcrumbProviderWithCompany>
            <SidebarProvider>
              <DialogProvider>
                <MarketplaceToastProvider>
                  <UnsavedChangesProvider>
                    <ErrorBoundary>
                      <App />
                    </ErrorBoundary>
                    <InstallToastSlot />
                    <Toaster />
                  </UnsavedChangesProvider>
                </MarketplaceToastProvider>
              </DialogProvider>
            </SidebarProvider>
          </BreadcrumbProviderWithCompany>
        </TooltipProvider>
      );
    }

    const router = createBrowserRouter([{ path: "*", element: <RouterShell /> }]);
    ```
    and the render becomes:
    ```tsx
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <CompanyProvider>
              <ToastProvider>
                <LiveUpdatesProvider>
                  <RouterProvider router={router} />
                </LiveUpdatesProvider>
              </ToastProvider>
            </CompanyProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </StrictMode>
    );
    ```
    > VERIFY during impl: provider ordering is preserved exactly — `UnsavedChangesProvider` must be INSIDE the router (it calls `useBlocker`) but it can be anywhere inside; placing it just outside `<App/>` keeps the centralized dialog mounted for the whole app. `useCompany()` (needed by `@/lib/router`'s `Link`) resolves because `CompanyProvider` wraps `RouterProvider`. `TooltipProvider`/`SidebarProvider`/etc. used to be inside `<BrowserRouter>`; they remain inside the router via `RouterShell`.
- [ ] Sanity-build: `pnpm --filter @armyofagents/ui build` (the `tsc -b && vite build` path) to catch the migration compiling cleanly.
- [ ] Run the full UI suite: `pnpm --filter @armyofagents/ui test:run`. Investigate any test that assumed `<BrowserRouter>` behavior (most tests mount their own `MemoryRouter` via `test-utils`, so they are unaffected — the migration is at the app root, not in the shared test wrapper).
- [ ] Run typecheck: `pnpm --filter @armyofagents/ui typecheck`.
- [ ] **Commit:** `feat(ui): migrate app root to createBrowserRouter (catch-all) for global nav blocking`.

---

## Task 5 — Wire `AoaAgentDetail` to the global guard (TDD)

`AoaAgentDetail` today has only `useBeforeUnload` (lines 136–145) and an unguarded `onViewChange` (lines 277–283) — a dirty Config/Instructions tab switch there silently discards edits. Register it with the global guard so it gains cross-page + tab + Back protection. No bespoke plumbing to delete here (it never had `pendingNav`).

**Files:**
- `ui/src/pages/AoaAgentDetail.tsx`
  - line 1–2 imports: keep `useBeforeUnload` (line 2); add the hook import.
  - lines 136–145: `useBeforeUnload(...)` → **KEEP**.
  - after line 145: add `useUnsavedChanges(configDirty || instrDirty)`.
  - lines 277–283: `onViewChange` stays a plain navigate (the provider now guards it).
- `ui/src/__tests__/AoaAgentDetail.test.tsx` (existing — verify it still passes; the file mocks `@/lib/router` with `useBeforeUnload: vi.fn()` but does NOT currently mock `useUnsavedChanges`/`useBlocker`).

### Steps

- [ ] **Write the failing test** (extend `AoaAgentDetail.test.tsx` or a new `AoaAgentDetailGuard.test.tsx`): assert `AoaAgentDetail` calls `useUnsavedChanges` with the combined dirty flag. Because this file mocks `@/lib/router`, add a `vi.mock("@/hooks/useUnsavedChanges", () => ({ useUnsavedChanges: vi.fn() }))` and assert it's invoked. (A full real-`useBlocker` integration test for Aoa is lower-value than the AgentDetail one — the provider/hook are already integration-tested in Task 2.)
  > The existing `AoaAgentDetail.test.tsx` mock of `@/lib/router` spreads `react-router-dom` actual and overrides `useBeforeUnload: vi.fn()`. `useBlocker` is NOT used directly by `AoaAgentDetail` (only via the provider, which isn't mounted in this test), so no extra router mock is needed — but DO add the `useUnsavedChanges` mock so the new hook call doesn't throw "must be used within provider" in the test harness.
- [ ] **Run, confirm it FAILS:** `pnpm --filter @armyofagents/ui test:run AoaAgentDetail`.
- [ ] **Edit `AoaAgentDetail.tsx`:**
  - Add import:
    ```tsx
    import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
    ```
  - After the `useBeforeUnload(...)` block (line 145), add:
    ```tsx
    useUnsavedChanges(configDirty || instrDirty);
    ```
- [ ] **Run, confirm it PASSES.** Run the full AoaAgentDetail file + full UI suite.
- [ ] Typecheck: `pnpm --filter @armyofagents/ui typecheck`.
- [ ] **Commit:** `feat(ui): guard AoaAgentDetail unsaved edits via global unsaved-changes provider`.

---

## Task 6 — Playwright e2e: real-browser proof of the global guard (`agent-unsaved-guard.spec.ts`)

> **This is the durable regression net.** The unit/integration tests (Tasks 2–3) prove the provider/hook in jsdom; the Task 1 `/browse` spike proves the runtime once, by hand, then is reverted. This spec is the ONLY automated proof in a REAL browser — and the only automated proof of the **browser Back button** (`page.goBack()`), which jsdom/MemoryRouter popstate can't exercise. It rides the existing e2e harness verbatim (no new helpers, no invented utilities).

**Files:**
- `tests/e2e/agent-unsaved-guard.spec.ts` (NEW)
- Reuses `tests/e2e/helpers/seed-company.ts` (`seedCompany`, `cleanupTestCompanies`) — verified present and used by `commander-team-tab.spec.ts` / `planning-mode.spec.ts`.

**Harness facts grounded by reading the suite (do NOT invent):**
- The webServer boots one throwaway `local_trusted` instance (`pnpm aoa onboard --yes --run`) on `:3199`; `baseURL` is set, so specs use **relative** paths (`page.goto("/...")`).
- `seedCompany(request, name)` POSTs `/api/companies` (synthetic local-board actor is auto-authorised in `local_trusted` — no Bearer token) and returns `{ id, issuePrefix }`.
- A worker agent is seeded by POST `/api/companies/${id}/agents` (pattern proven in `commander-team-tab.spec.ts`). Use `adapterType: "claude_local"` so the Config Identity form + Instructions bundle are available.
- Agent detail route (from `App.tsx`): `/{prefix}/agents/{agentId}` (Overview), `/{prefix}/agents/{agentId}/configure` (Config tab), `/{prefix}/agents/{agentId}/instructions`. Go straight to the Config tab via the `/configure` URL.
- Dirty handle: `getByTestId("agent-config-name-input")` (added in Task 3; `immediate` → keystroke flips `configDirty`).
- Cross-page sidebar nav: the expanded sidebar renders `NavLink`s → `page.getByRole("link", { name: "Tasks" })` (also "Home"/"Agents"). The dialog: Radix `AlertDialog` → `page.getByRole("alertdialog")`, title text "Discard unsaved changes?", buttons `getByRole("button", { name: "Discard & leave" })` and `{ name: "Cancel" }`.

### Steps

- [ ] **Add the seed helper inline in the spec** (mirrors `seedAoaAgent` in `commander-team-tab.spec.ts`, but kind=org/worker):
  ```ts
  async function seedWorkerAgent(request: APIRequestContext, companyId: string) {
    const res = await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name: "Guard E2E Agent",
        role: "general",
        title: "Guard E2E Agent",
        adapterType: "claude_local",
      },
    });
    if (!res.ok()) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`seedWorkerAgent failed: ${res.status()} ${body}`);
    }
    return (await res.json()) as { id: string; urlKey?: string };
  }
  ```
  > Confirm the worker-agent create payload against `server/src/routes/agents.ts` during impl (the AoA variant uses `kind: "aoa"`; a worker/org agent omits `kind` or sets `kind: "org"`). If `claude_local` requires extra fields at create, fall back to the minimal accepted shape and still open the Config tab — the Identity "Name" field exists for every adapter.
- [ ] **Write the spec.** Full skeleton (real locators, no placeholders):
  ```ts
  import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
  import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

  /**
   * E2E — Global unsaved-changes guard (Follow-up #1).
   *
   * Proves the ONE global UnsavedChangesProvider/useBlocker in a real browser:
   *  - dirty + sidebar <Link> → "Discard unsaved changes?" dialog; Cancel stays, Discard leaves
   *  - dirty + browser Back (page.goBack) → the same dialog (the jsdom-impossible case)
   *  - clean nav → no dialog, navigates immediately
   *
   * Self-skips on Windows-without-DATABASE_URL via the config's testMatch
   * (embedded-postgres can't start as runneradmin). Required gate on Linux CI.
   */

  async function seedWorkerAgent(request: APIRequestContext, companyId: string) { /* as above */ }

  async function openDirtyConfig(page: Page, request: APIRequestContext) {
    const company = await seedCompany(request, `E2E-Guard-${Date.now()}`);
    const agent = await seedWorkerAgent(request, company.id);
    const ref = agent.urlKey ?? agent.id;
    await page.goto(`/${company.issuePrefix}/agents/${ref}/configure`);
    const nameInput = page.getByTestId("agent-config-name-input");
    await expect(nameInput).toBeVisible({ timeout: 15_000 });
    // Make the Config form dirty (immediate commit on each keystroke).
    await nameInput.fill("Guard E2E Agent EDITED");
    return { company, ref, nameInput };
  }

  test.describe("global unsaved-changes guard", () => {
    test.beforeEach(async ({ request }) => {
      await cleanupTestCompanies(request, /^E2E-Guard-/);
    });

    test("dirty + sidebar <Link> + Cancel → stays on the agent page, edit intact", async ({ page, request }) => {
      const { ref, nameInput } = await openDirtyConfig(page, request);
      await page.getByRole("link", { name: /^Tasks$/ }).click();
      // Global confirm dialog appears; URL has NOT changed.
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/agents/${ref}/configure`));
      await expect(nameInput).toHaveValue("Guard E2E Agent EDITED");
    });

    test("dirty + sidebar <Link> + Discard → navigation proceeds, edit gone", async ({ page, request }) => {
      const { ref } = await openDirtyConfig(page, request);
      await page.getByRole("link", { name: /^Tasks$/ }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await dialog.getByRole("button", { name: "Discard & leave" }).click();
      // Navigated away from the agent page to /issues (Tasks).
      await expect(page).toHaveURL(/\/issues(\b|\/|\?|$)/, { timeout: 5_000 });
      await expect(page).not.toHaveURL(new RegExp(`/agents/${ref}/configure`));
    });

    test("dirty + browser Back → the confirm dialog appears (jsdom can't prove this)", async ({ page, request }) => {
      // Arrive at /configure from a real prior history entry so Back has a target.
      const company = await seedCompany(request, `E2E-Guard-${Date.now()}`);
      const agent = await seedWorkerAgent(request, company.id);
      const ref = agent.urlKey ?? agent.id;
      await page.goto(`/${company.issuePrefix}/agents/${ref}`); // Overview (history entry #1)
      await page.getByRole("tab", { name: "Config" }).click();   // → /configure (history entry #2)
      const nameInput = page.getByTestId("agent-config-name-input");
      await expect(nameInput).toBeVisible({ timeout: 15_000 });
      await nameInput.fill("Back-button dirty edit");
      // Press the real browser Back button.
      await page.goBack();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
      // Cancel keeps us on /configure with the edit intact.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(page).toHaveURL(new RegExp(`/agents/${ref}/configure`));
      await expect(nameInput).toHaveValue("Back-button dirty edit");
    });

    test("clean (no edits) + sidebar nav → no dialog, navigates immediately", async ({ page, request }) => {
      const company = await seedCompany(request, `E2E-Guard-${Date.now()}`);
      const agent = await seedWorkerAgent(request, company.id);
      const ref = agent.urlKey ?? agent.id;
      await page.goto(`/${company.issuePrefix}/agents/${ref}/configure`);
      await expect(page.getByTestId("agent-config-name-input")).toBeVisible({ timeout: 15_000 });
      // Do NOT edit anything — form is clean.
      await page.getByRole("link", { name: /^Tasks$/ }).click();
      await expect(page).toHaveURL(/\/issues(\b|\/|\?|$)/, { timeout: 5_000 });
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    });
  });
  ```
  > **Locator-grounding to re-verify during impl** (selectors taken from real source, but confirm against the running app):
  > - Sidebar "Tasks" → `/issues` (`Sidebar.tsx:139`). If the sidebar starts collapsed in the e2e viewport, the link is icon-only inside a Tooltip — either assert against the default-expanded sidebar or target the icon link by `aria-label`/Tooltip. Confirm the expanded `NavLink` exposes the accessible name "Tasks" in the running app; if not, fall back to `page.locator('a[href$="/issues"]')`. The click locators use an **anchored** name `/^Tasks$/` so they don't collide with the hero KPI link labelled "Tasks (wk)" — Playwright's `name` is a substring match by default, so an unanchored "Tasks" would strict-mode-fail on two matches (Codex P1).
  > - The Config tab trigger is a Radix `TabsTrigger` (`role="tab"`, name "Config"). The `/configure` deep-link also lands on the Config tab directly (used by the sidebar/clean tests to skip the tab click).
  > - If `seedWorkerAgent` with `adapterType: "claude_local"` is rejected at create, drop to the minimal accepted body; the Identity "Name" input is adapter-agnostic so the dirty handle still works.
- [ ] **Run the spec** (Linux/macOS or Windows-with-DATABASE_URL): `pnpm test:e2e agent-unsaved-guard`. Headed debugging: `pnpm test:e2e:headed agent-unsaved-guard`.
  > On the user's Windows dev box without `DATABASE_URL`, the config's `testMatch` self-skips the whole suite — that is EXPECTED. Do not treat the Windows self-skip as a failure; the required proof is the Linux CI `e2e` gate. For a hands-on local check, run the Task 1 `/browse` spike against the running dev app.
- [ ] **Confirm the spec is picked up** by the config (`testMatch: "**/*.spec.ts"`, `testDir: "."`) — a plain `*.spec.ts` under `tests/e2e/` is auto-collected; no config edit needed.
- [ ] **Commit:** `test(ui): e2e prove global unsaved-changes guard (sidebar <Link> + browser Back)`.

---

## Task 7 — Full verification + parity sweep

**Files:** none (verification only).

- [ ] Run the FULL UI suite green: `pnpm --filter @armyofagents/ui test:run`.
- [ ] Run typecheck clean: `pnpm --filter @armyofagents/ui typecheck`.
- [ ] Run build clean: `pnpm --filter @armyofagents/ui build`.
- [ ] **Run the new e2e spec green** (Linux/macOS, or Windows-with-`DATABASE_URL`): `pnpm test:e2e agent-unsaved-guard`. On the user's Windows box without `DATABASE_URL` the suite self-skips by design — that is expected, not a failure; the binding proof is the Linux CI `e2e` gate. (Optionally run the whole suite `pnpm test:e2e` to confirm no cross-spec regression.)
- [ ] Manually re-verify (gstack `/browse`, on the running app) the four parity behaviors end-to-end with the REAL provider (not the spike): (1) dirty + sidebar `<Link>` → dialog; (2) dirty + browser Back → dialog; (3) clean nav → no dialog; (4) dirty + agent tab switch / hero KPI deep-link → dialog. Confirm "Discard & leave" proceeds and "Cancel" stays.
- [ ] Confirm `useBeforeUnload` still fires on tab-close/refresh in both `AgentDetail` and `AoaAgentDetail` (the dialog won't show — the browser's native beforeunload prompt does).
- [ ] Grep to confirm the bespoke plumbing is gone: `pendingNav` and `onHeroNavigate` should no longer appear anywhere; `onNavigate` should no longer appear in `AgentHeroCard.tsx` **or its test** (`AgentHeroCard.test.tsx` — the stale `onNavigate`-fires assertion must be replaced, not left dangling). Note: `onNavigate` legitimately remains in UNRELATED components (`RoutineCard.tsx`, `LobbySidebar.tsx`, `LobbyShell.tsx`, `TaskOutputViewer.tsx`'s `onNavigateToTask`) — those are different props and must NOT be touched. `useUnsavedChanges` should appear in both detail pages.
- [ ] Grep to confirm the e2e dirty handle is wired: `data-testid="agent-config-name-input"` appears exactly once (`AgentConfigForm.tsx`) and is referenced by `tests/e2e/agent-unsaved-guard.spec.ts` (and, if used there, the Task 3 integration test).

---

## Definition of done

- [ ] **Spike documented as PASSED** (Task 1): a recorded line confirming both sidebar `<Link>` click and browser Back button trigger `useBlocker` on descendant-`<Routes>` navigation in a real browser. (If it failed, the plan stopped at Task 1 and was escalated.)
- [ ] `main.tsx` mounts `createBrowserRouter([{ path: "*", element: <RouterShell/> }])` + `<RouterProvider>`; `App.tsx`'s `<Routes>` tree is byte-unchanged.
- [ ] `UnsavedChangesProvider` (one `useBlocker` + centralized "Discard unsaved changes?" `ConfirmDialog`) is mounted inside the router; `useUnsavedChanges(isDirty)` hook exists.
- [ ] `AgentDetail` + `AoaAgentDetail` register via `useUnsavedChanges`; both KEEP `useBeforeUnload`.
- [ ] Bespoke guard DELETED from `AgentDetail` (`pendingNav` state, the `pendingNav`-setting `handleViewChange` branch, `onHeroNavigate` prop + handler, the `pendingNav` `<ConfirmDialog>`) and the now-dead props removed from `AgentDetailCore` (`onHeroNavigate`) and `AgentHeroCard` (`onNavigate`).
- [ ] **The stale `AgentHeroCard.test.tsx` `onNavigate`-fires test is replaced** (same task as the prop deletion, Task 3) with a plain-`<Link>` render test; no test still references the deleted `onNavigate` / `onHeroNavigate` / `pendingNav` / `handleViewChange` symbols.
- [ ] **The four parity behaviors are proven by tests at every layer** — unit/component (Task 2 provider/hook + Task 3 AgentDetail integration) AND real-browser e2e (Task 6): dirty + sidebar nav → dialog; dirty + Back → dialog; clean nav → no dialog; existing tab/hero-KPI guard still fires. Cancel-stays and Discard-leaves are SEPARATE assertions at each layer.
- [ ] **The unit/component suite explicitly covers** (Task 2 + Task 3): cancel-stays vs discard-leaves as distinct `it`s; guard does NOT fire when clean; guard fires for tab-switch, hero-KPI, AND shimmed sidebar `<Link>`; ref-count (one-of-two dirty fires, unmount drops a registrant); same-path nav does not block; Config-dirty and Instructions-dirty each arm the guard independently.
- [ ] **The Playwright e2e `tests/e2e/agent-unsaved-guard.spec.ts` is green on Linux CI** (required `e2e` gate) and proves the FOUR real-browser scenarios: (1) dirty + sidebar `<Link>` → dialog, Cancel STAYS (URL unchanged, edit intact); (2) dirty + sidebar `<Link>` → Discard PROCEEDS (URL changes, edit gone); (3) dirty + **browser Back (`page.goBack()`)** → dialog (the jsdom-impossible case); (4) clean + sidebar nav → NO dialog, navigates immediately. Self-skips on Windows-without-`DATABASE_URL` by config `testMatch` (expected, not a failure).
- [ ] **The e2e dirty handle `data-testid="agent-config-name-input"` exists** (one occurrence, `AgentConfigForm.tsx` Identity "Name" `DraftInput`) and is referenced by the e2e spec.
- [ ] **UI suite green**, **typecheck clean**, **build clean**, **e2e green on Linux CI**.
- [ ] Ships as its own PR off `main`; commit messages carry the `Co-Authored-By` trailer.

---

## Self-review

- **Codex review fix (2026-06-25, [P1] resolved):** the original plan deleted the `onNavigate` prop from `AgentHeroCard` but left the existing test (`AgentHeroCard.test.tsx` lines 65–78, `"routes KPI deep-link clicks through onNavigate"`) asserting that the now-removed callback fires — that test would fail to compile (unknown prop) and fail at runtime. Task 3 now carries an explicit, concrete step to **delete that `it(...)` block and replace it** with a plain-`<Link>` rendering/navigation test (KPI still renders an `<a>` whose `href` contains the route), with the unsaved-changes *blocking* coverage living in the provider/router tests (Task 2 `useUnsavedChanges.test.tsx` + the Task 3 `AgentDetailGuard` spec) where it belongs. Consistency pass: grepped all `ui/src` test files for `onHeroNavigate` / `onNavigate` / `pendingNav` / `handleViewChange` — `AgentHeroCard.test.tsx` was the ONLY test referencing a deleted symbol; the other `onNavigate` hits (`RoutineCard`, `LobbySidebar`, `LobbyShell`, `TaskOutputViewer`) are unrelated props and are explicitly left untouched.
- **The spike (Task 1) is the single gating risk.** Everything downstream assumes `useBlocker` fires for navigations that originate from a descendant `<Routes>` mounted under a `path: "*"` catch-all. This is the documented "incremental migration" bridge for react-router v7, and the design doc locked Option A on it — but it is explicitly the one thing not provable by reading, hence the manual `/browse` proof BEFORE any real code. If it fails, do not proceed; re-open the design.
- **Things I want the reviewer / Codex to scrutinize:**
  1. **`useBlocker` + catch-all nesting.** Confirm a single `useBlocker` in the provider (outside `<Routes>`, inside the router) actually intercepts navigations triggered from inside `<Routes>` and from the browser Back button under the `path: "*"` element. This is the spike's job; reviewers should still sanity-check the assumption.
  2. **`anyDirty` closure freshness in the blocker fn.** I pass a `useCallback(({…}) => anyDirty && …, [anyDirty])` to `useBlocker`. Verify v7 re-reads the latest function on each navigation attempt (it should, since the callback identity changes when `anyDirty` flips). If v7 snapshots the fn at first render, switch to a ref-read inside a stable callback.
  3. **Same-path guard.** The provider only blocks when `currentLocation.pathname !== nextLocation.pathname`. Verify every agent tab path is genuinely distinct (`/agents/<ref>` vs `/agents/<ref>/configure` vs `/instructions`) so dirty tab switches still block — they are, but confirm in the parity test.
  4. **Provider ordering in `main.tsx`.** `UnsavedChangesProvider` must be inside `RouterProvider` (uses `useBlocker`) and the `@/lib/router` `Link` override needs `CompanyProvider` above the router. Both hold in the proposed tree; double-check no provider that previously sat inside `<BrowserRouter>` got dropped.
  5. **Back-button test coverage.** The browser Back path is now proven by an AUTOMATED real-browser e2e — `tests/e2e/agent-unsaved-guard.spec.ts`'s `page.goBack()` case (Task 6) — plus the one-time manual `/browse` spike (Task 1). The jsdom unit suite intentionally `it.skip`s the Back case (popstate is unreliable in jsdom/MemoryRouter) and points at the e2e. Reviewers should verify the e2e Back case is real (it navigates Overview → Config to create a history entry, then `goBack()`), not a no-op.
  6. **`AoaAgentDetail` newly gains a tab-switch guard** it didn't have before (its `onViewChange` was unguarded). This is a behavior improvement, not a regression — but it's a behavior change worth calling out.
- **Maximal-coverage pass (2026-06-26):** added a real Playwright e2e (`tests/e2e/agent-unsaved-guard.spec.ts`, Task 6) on the existing harness (`pnpm test:e2e`, throwaway `local_trusted` :3199, chromium, workers:1) — four scenarios incl. the jsdom-impossible `page.goBack()` — and strengthened the vitest layer: Task 2 now has cancel-stays / discard-leaves / clean-no-dialog / same-path / ref-count / two-simultaneous-dirty as SEPARATE `it`s; Task 3 asserts the guard fires for tab-switch AND hero-KPI AND a shimmed sidebar `<Link>`, and that Config-dirty and Instructions-dirty each arm it independently. One new source `data-testid="agent-config-name-input"` (on the Config Identity "Name" `DraftInput`, which spreads `...props`) is the only source change beyond the guard itself; every other selector rides existing accessible roles/names (`role="tab"`, `role="link"`, Radix `role="alertdialog"`). Helper audit: `tests/e2e/helpers/seed-company.ts` (`seedCompany`/`cleanupTestCompanies`) covers company seeding; a worker-agent seed is inlined in the spec mirroring `commander-team-tab.spec.ts`'s `seedAoaAgent` (no agent-seed helper exists in `helpers/` — flagged, but inlining matches the suite's established convention). Windows self-skip (embedded-postgres / `runneradmin`) means the e2e binds on Linux CI; local hands-on proof stays the `/browse` spike.
