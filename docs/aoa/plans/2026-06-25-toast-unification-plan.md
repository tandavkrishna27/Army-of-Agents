# Toast Unification (Layer 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the app's three toast systems (`ToastContext`/`pushToast`, dead sonner, marketplace `InstallToastSlot`) into one — a single `pushToast` API, one glass renderer, one location (bottom-right) — and add a sticky `loading` state so marketplace installs fold in.

**Architecture:** Keep the existing `ToastContext` engine (queue, dedupe, per-tone TTL) and extend it with a sticky `loading` tone + `updateToast()`. Rewrite `ToastViewport` to the locked "Direction A" adaptive glass design, mounted once at app root. Migrate Secrets off sonner; reimplement marketplace's `useInstallToast` as a thin adapter over the unified system backed by a render-less operation tracker. Delete sonner and the marketplace renderer.

**Tech Stack:** React 19 + TypeScript, Tailwind v4 (CSS-variable tokens, OKLCH), lucide-react icons, vitest + @testing-library/react. UI-only — no server/schema.

**Design spec:** `docs/aoa/plans/2026-06-25-toast-unification-design.md`

**Conventions:**
- Run tests from repo root: `pnpm --filter @armyofagents/ui test:run -- <path>`
- Typecheck: `pnpm --filter @armyofagents/ui typecheck`
- Each task ends with a commit. Keep the app compiling + functional at every commit (task order is chosen to guarantee this).

---

## File map

| File | Responsibility | Action |
|------|----------------|--------|
| `ui/src/index.css` | Toast design tokens + glass/rail utility classes | Modify |
| `ui/src/context/ToastContext.tsx` | Engine: `loading` tone, `updateToast`, `meta` | Modify |
| `ui/src/context/__tests__/ToastContext.test.tsx` | Engine unit tests | Create |
| `ui/src/components/ToastViewport.tsx` | Unified glass renderer (adaptive) | Rewrite |
| `ui/src/components/__tests__/ToastViewport.test.tsx` | Renderer unit tests | Create |
| `ui/src/main.tsx` | Mount `ToastViewport` at root; drop sonner + InstallToastSlot; swap marketplace provider | Modify |
| `ui/src/components/Layout.tsx` | Remove the per-layout `ToastViewport` mount | Modify |
| `ui/src/components/secrets/SecretsWorkspace.tsx` | sonner → `pushToast` | Modify |
| `ui/src/pages/secrets/ImportFromVaultDialog.tsx` | sonner → `pushToast` | Modify |
| `ui/src/lib/toast.ts` | Dead sonner wrapper | Delete |
| `ui/src/components/ui/toaster.tsx` + its test | Dead sonner `<Toaster>` | Delete |
| `ui/src/components/marketplace/toast/ToastProvider.tsx` | Render-less install operation tracker + adapter context | Rewrite |
| `ui/src/components/marketplace/toast/useInstallToast.ts` | Adapter hook over unified system | Rewrite |
| `ui/src/components/marketplace/toast/InstallToastSlot.tsx` + its test | Bespoke marketplace renderer | Delete |
| `ui/src/components/marketplace/toast/__tests__/installToast.test.tsx` | Adapter tests | Create |
| `ui/src/context/LiveUpdatesProvider.tsx` | Populate `meta.ref` on agent/run/activity toasts | Modify |
| `ui/src/pages/Secrets.test.tsx`, `Secrets.render.test.tsx`, `secrets/ImportFromVaultDialog.test.tsx`, `components/secrets/__tests__/SecretImportFlow.test.tsx` | Swap `@/lib/toast` mock → `@/context/ToastContext` `useToast` mock | Modify |
| `ui/src/__tests__/MarketplaceDetail.test.tsx`, `marketplace/install/__tests__/{Package,Plugin,Snapshot}InstallModal.test.tsx` | Swap marketplace `ToastProvider` + `InstallToastSlot` → unified providers + `ToastViewport` | Modify |
| `ui/package.json` | Remove `sonner` dependency | Modify |

---

## Task 1: Toast design tokens + glass utility classes

**Files:**
- Modify: `ui/src/index.css` (light `:root` block ≈181–217, dark `.dark` block ≈274–308, and a utilities area)

- [ ] **Step 1: Add light-theme toast tokens**

In the light-theme block (near the other surface tokens like `--card-2`, after the status colors), add:

```css
  /* Toast (unified) */
  --toast-bg: color-mix(in oklch, var(--card-2) 80%, transparent);
  --toast-border: color-mix(in srgb, var(--text) 12%, transparent);
  --toast-highlight: rgba(255, 255, 255, 0.6);
  --toast-loading: #0e9bb3;
```

- [ ] **Step 2: Add dark-theme toast tokens**

In the `.dark` block (near the dark `--card-2`), add:

```css
  /* Toast (unified) */
  --toast-bg: color-mix(in oklch, var(--card-2) 55%, transparent);
  --toast-border: color-mix(in srgb, white 11%, transparent);
  --toast-highlight: rgba(255, 255, 255, 0.06);
  --toast-loading: #37c2d4;
```

- [ ] **Step 3: Add the glass + rail utility classes**

At the end of `index.css` (with the other plain CSS rules), add:

```css
/* Unified toast glass surface */
.toast-glass {
  background: var(--toast-bg);
  border: 1px solid var(--toast-border);
  -webkit-backdrop-filter: blur(17px) saturate(1.35);
  backdrop-filter: blur(17px) saturate(1.35);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3), inset 0 1px 0 var(--toast-highlight);
}
@media (prefers-reduced-transparency: reduce) {
  .toast-glass {
    background: var(--card-2);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

/* Indeterminate loading rail */
@keyframes toastRail {
  0% { left: -44%; }
  100% { left: 100%; }
}
.toast-rail {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 44%;
  border-radius: 2px;
  background: var(--toast-loading);
  animation: toastRail 1.25s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .toast-rail { animation: none; left: 0; width: 100%; opacity: 0.5; }
}
```

- [ ] **Step 4: Verify the app still builds**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS (CSS-only change; no type impact).

- [ ] **Step 5: Commit**

```bash
git add ui/src/index.css
git commit -m "feat(toast): add unified toast design tokens + glass/rail utilities"
```

---

## Task 2: Engine — `loading` tone, `updateToast`, `meta`

**Files:**
- Modify: `ui/src/context/ToastContext.tsx`
- Create: `ui/src/context/__tests__/ToastContext.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/context/__tests__/ToastContext.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider, useToast } from "../ToastContext";

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ToastContext engine", () => {
  it("loading toast is sticky and never auto-dismisses", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let id: string | null = null;
    act(() => { id = result.current.pushToast({ title: "Installing", tone: "loading" }); });
    expect(id).toEqual(expect.any(String));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].tone).toBe("loading");
  });

  it("loading skips dedupe and always returns a fresh id", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let a: string | null = null;
    let b: string | null = null;
    act(() => { a = result.current.pushToast({ title: "Installing X", tone: "loading" }); });
    act(() => { b = result.current.pushToast({ title: "Installing X", tone: "loading" }); });
    expect(a).toEqual(expect.any(String));
    expect(b).toEqual(expect.any(String));
    expect(a).not.toBe(b);
    expect(result.current.toasts).toHaveLength(2);
  });

  it("updateToast flips loading→success and arms the TTL so it auto-dismisses", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    let id = "";
    act(() => { id = result.current.pushToast({ title: "Installing", tone: "loading" })!; });
    act(() => { result.current.updateToast(id, { tone: "success", title: "Installed" }); });
    expect(result.current.toasts[0].tone).toBe("success");
    expect(result.current.toasts[0].title).toBe("Installed");
    act(() => { vi.advanceTimersByTime(3500); }); // success default TTL
    expect(result.current.toasts).toHaveLength(0);
  });

  it("updateToast works in the SAME tick as pushToast (no effect-lag race)", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => {
      const id = result.current.pushToast({ title: "Installing", tone: "loading" })!;
      result.current.updateToast(id, { tone: "success", title: "Installed" });
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].tone).toBe("success");
    expect(result.current.toasts[0].title).toBe("Installed");
  });

  it("updateToast on an unknown id is a no-op", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => { result.current.updateToast("missing", { title: "x" }); });
    expect(result.current.toasts).toHaveLength(0);
  });

  it("carries optional meta.ref through to the toast item", () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    act(() => { result.current.pushToast({ title: "Atlas run succeeded", tone: "success", meta: { ref: "TASK-128" } }); });
    expect(result.current.toasts[0].meta?.ref).toBe("TASK-128");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @armyofagents/ui test:run -- src/context/__tests__/ToastContext.test.tsx`
Expected: FAIL — `updateToast` is not a function / `loading` not handled.

- [ ] **Step 3: Implement the engine changes**

Replace the full contents of `ui/src/context/ToastContext.tsx` with:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "warn" | "error" | "loading";

export interface ToastAction {
  label: string;
  href: string;
}

export interface ToastMeta {
  /** Short mono reference shown in the rich row, e.g. "TASK-128". */
  ref?: string;
}

export interface ToastInput {
  id?: string;
  dedupeKey?: string;
  title: string;
  body?: string;
  tone?: ToastTone;
  ttlMs?: number;
  action?: ToastAction;
  meta?: ToastMeta;
}

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  tone: ToastTone;
  ttlMs: number;
  action?: ToastAction;
  meta?: ToastMeta;
  createdAt: number;
}

export type ToastPatch = Partial<Pick<ToastItem, "title" | "body" | "tone" | "action" | "ttlMs" | "meta">>;

interface ToastContextValue {
  toasts: ToastItem[];
  pushToast: (input: ToastInput) => string | null;
  updateToast: (id: string, patch: ToastPatch) => void;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const DEFAULT_TTL_BY_TONE: Record<Exclude<ToastTone, "loading">, number> = {
  info: 4000,
  success: 3500,
  warn: 8000,
  error: 10000,
};
const MIN_TTL_MS = 1500;
const MAX_TTL_MS = 15000;
const MAX_TOASTS = 5;
const DEDUPE_WINDOW_MS = 3500;
const DEDUPE_MAX_AGE_MS = 20000;

const ToastContext = createContext<ToastContextValue | null>(null);

function normalizeTtl(value: number | undefined, tone: ToastTone) {
  const fallback = tone === "loading" ? DEFAULT_TTL_BY_TONE.info : DEFAULT_TTL_BY_TONE[tone];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.floor(value)));
}

function generateToastId() {
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Authoritative, synchronously-updated mirror of `toasts`. Mutators read and
  // write THIS (not the `toasts` state) so a same-tick pushToast()->updateToast()
  // sees the just-created toast. `commit` writes the ref and the state together.
  const toastsRef = useRef<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, number>());
  const dedupeRef = useRef(new Map<string, number>());

  const commit = useCallback((next: ToastItem[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const clearTimer = useCallback((id: string) => {
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      commit(toastsRef.current.filter((toast) => toast.id !== id));
    },
    [clearTimer, commit],
  );

  const clearToasts = useCallback(() => {
    for (const handle of timersRef.current.values()) {
      window.clearTimeout(handle);
    }
    timersRef.current.clear();
    commit([]);
  }, [commit]);

  const armTimer = useCallback(
    (id: string, ttlMs: number) => {
      clearTimer(id);
      const timeout = window.setTimeout(() => dismissToast(id), ttlMs);
      timersRef.current.set(id, timeout);
    },
    [clearTimer, dismissToast],
  );

  const pushToast = useCallback(
    (input: ToastInput) => {
      const now = Date.now();
      const tone = input.tone ?? "info";
      const sticky = tone === "loading";
      const ttlMs = sticky ? Number.POSITIVE_INFINITY : normalizeTtl(input.ttlMs, tone);

      // Loading toasts are unique per operation — never deduped, always return an id.
      if (!sticky) {
        const dedupeKey =
          input.dedupeKey ??
          input.id ??
          `${tone}|${input.title}|${input.body ?? ""}|${input.action?.href ?? ""}`;

        for (const [key, ts] of dedupeRef.current.entries()) {
          if (now - ts > DEDUPE_MAX_AGE_MS) dedupeRef.current.delete(key);
        }
        const lastSeen = dedupeRef.current.get(dedupeKey);
        if (lastSeen && now - lastSeen < DEDUPE_WINDOW_MS) return null;
        dedupeRef.current.set(dedupeKey, now);
      }

      const id = input.id ?? generateToastId();
      clearTimer(id);

      const nextToast: ToastItem = {
        id,
        title: input.title,
        body: input.body,
        tone,
        ttlMs,
        action: input.action,
        meta: input.meta,
        createdAt: now,
      };
      const withoutCurrent = toastsRef.current.filter((toast) => toast.id !== id);
      commit([nextToast, ...withoutCurrent].slice(0, MAX_TOASTS));

      if (!sticky) armTimer(id, ttlMs);
      return id;
    },
    [armTimer, clearTimer, commit],
  );

  const updateToast = useCallback(
    (id: string, patch: ToastPatch) => {
      const current = toastsRef.current.find((t) => t.id === id);
      if (!current) return;

      const nextTone = patch.tone ?? current.tone;
      const enteringLoading = current.tone !== "loading" && nextTone === "loading";
      const leavingLoading = current.tone === "loading" && nextTone !== "loading";
      const nextTtl = enteringLoading
        ? Number.POSITIVE_INFINITY
        : leavingLoading || patch.ttlMs !== undefined
          ? normalizeTtl(patch.ttlMs, nextTone)
          : current.ttlMs;

      commit(
        toastsRef.current.map((t) =>
          t.id === id ? { ...t, ...patch, tone: nextTone, ttlMs: nextTtl } : t,
        ),
      );

      if (enteringLoading) {
        // Re-entering loading must become sticky again: cancel any pending auto-dismiss.
        clearTimer(id);
      } else if (leavingLoading) {
        // A sticky loading toast resolved: start its dismissal countdown.
        armTimer(id, nextTtl);
      }
    },
    [armTimer, clearTimer, commit],
  );

  useEffect(
    () => () => {
      for (const handle of timersRef.current.values()) {
        window.clearTimeout(handle);
      }
      timersRef.current.clear();
    },
    [],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, pushToast, updateToast, dismissToast, clearToasts }),
    [toasts, pushToast, updateToast, dismissToast, clearToasts],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @armyofagents/ui test:run -- src/context/__tests__/ToastContext.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/context/ToastContext.tsx ui/src/context/__tests__/ToastContext.test.tsx
git commit -m "feat(toast): add loading tone + updateToast + meta to the engine"
```

---

## Task 3: Renderer — Direction A adaptive glass

**Files:**
- Rewrite: `ui/src/components/ToastViewport.tsx`
- Create: `ui/src/components/__tests__/ToastViewport.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/__tests__/ToastViewport.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider, useToast } from "../../context/ToastContext";
import { ToastViewport } from "../ToastViewport";

let push: ReturnType<typeof useToast>["pushToast"];
function Capture() {
  push = useToast().pushToast;
  return null;
}

function setup() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Capture />
        <ToastViewport />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("ToastViewport", () => {
  it("renders the full form (mono ref + action link) for entity toasts", () => {
    setup();
    act(() => {
      push({
        title: "Atlas",
        body: "Wire provider-switching seam",
        tone: "success",
        meta: { ref: "TASK-128" },
        action: { label: "View run", href: "/agents/a/runs/r" },
      });
    });
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("TASK-128")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View run/ })).toBeInTheDocument();
  });

  it("renders a compact single-line toast when there is no body or ref", () => {
    setup();
    act(() => { push({ title: "Pinned to cockpit", tone: "success" }); });
    expect(screen.getByText("Pinned to cockpit")).toBeInTheDocument();
    expect(screen.queryByText("TASK-128")).not.toBeInTheDocument();
  });

  it("renders the loading rail for a loading toast", () => {
    setup();
    act(() => { push({ title: "Installing Kitchen Sink", tone: "loading" }); });
    expect(screen.getByText("Installing Kitchen Sink")).toBeInTheDocument();
    expect(screen.getByTestId("toast-loading-rail")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @armyofagents/ui test:run -- src/components/__tests__/ToastViewport.test.tsx`
Expected: FAIL — old viewport has no `meta`/`loading`/rail.

- [ ] **Step 3: Rewrite the renderer**

Replace the full contents of `ui/src/components/ToastViewport.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import {
  X,
  Check,
  CircleX,
  TriangleAlert,
  Info,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { useToast, type ToastItem, type ToastTone } from "../context/ToastContext";
import { cn } from "../lib/utils";

const TONE_COLOR_VAR: Record<ToastTone, string> = {
  info: "var(--info)",
  success: "var(--success)",
  warn: "var(--warning)",
  error: "var(--error)",
  loading: "var(--toast-loading)",
};

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  info: Info,
  success: Check,
  warn: TriangleAlert,
  error: CircleX,
  loading: LoaderCircle,
};

function formatRelative(createdAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (secs < 5) return "now";
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

function AnimatedToast({
  toast,
  onDismiss,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const color = TONE_COLOR_VAR[toast.tone];
  const Icon = TONE_ICON[toast.tone];
  const isLoading = toast.tone === "loading";
  // Full (two-line) form for loading toasts and entity-referencing events; compact otherwise.
  const isFull = isLoading || !!toast.meta?.ref;
  const ts = formatRelative(toast.createdAt);

  return (
    <li
      className={cn(
        "toast-glass pointer-events-auto relative overflow-hidden rounded-lg transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
      )}
    >
      {isFull ? (
        <div className="flex items-start gap-3 px-3 py-2.5">
          <span
            className="mt-0.5 grid size-[30px] shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
          >
            <Icon
              className={cn("size-4", isLoading && "animate-spin motion-reduce:animate-none")}
              style={{ color }}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="text-sm font-medium leading-5 text-text">{toast.title}</p>
              <span className="ml-auto shrink-0 text-[10.5px] text-very-dim">{ts}</span>
            </div>
            {(toast.meta?.ref || toast.body) && (
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-dim">
                {toast.meta?.ref && (
                  <span className="rounded bg-white/5 px-1.5 font-mono text-[10.5px] text-dim">
                    {toast.meta.ref}
                  </span>
                )}
                {toast.body && <span className="truncate">{toast.body}</span>}
              </div>
            )}
            {toast.action && (
              <Link
                to={toast.action.href}
                onClick={() => onDismiss(toast.id)}
                className="mt-1.5 inline-flex text-xs font-medium hover:opacity-90"
                style={{ color }}
              >
                {toast.action.label}
              </Link>
            )}
          </div>
          {!isLoading && (
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(toast.id)}
              className="-mr-0.5 mt-0.5 shrink-0 rounded p-1 text-dim opacity-60 hover:bg-white/10 hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          )}
          {isLoading && <span data-testid="toast-loading-rail" className="toast-rail" />}
        </div>
      ) : (
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="size-[7px] shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <p className="shrink-0 text-[13px] font-medium leading-5 text-text">{toast.title}</p>
          {toast.body && <span className="truncate text-xs text-dim">{toast.body}</span>}
          {toast.action && (
            <Link
              to={toast.action.href}
              onClick={() => onDismiss(toast.id)}
              className="ml-auto shrink-0 text-xs font-medium hover:opacity-90"
              style={{ color }}
            >
              {toast.action.label}
            </Link>
          )}
          <span className={cn("shrink-0 text-[10.5px] text-very-dim", !toast.action && "ml-auto")}>
            {ts}
          </span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 rounded p-0.5 text-dim opacity-60 hover:bg-white/10 hover:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();
  if (toasts.length === 0) return null;
  return (
    <aside
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-3 right-3 z-[120] w-full max-w-sm px-1"
    >
      <ol className="flex w-full flex-col-reverse gap-2">
        {toasts.map((toast) => (
          <AnimatedToast key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </ol>
    </aside>
  );
}
```

> Note: `text-very-dim` and `text-dim`/`text-text` are existing tokens used elsewhere in `ui/src` (e.g. PackageInstallModal uses `text-very-dim`). If `text-very-dim` is not resolvable, fall back to `text-dim`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @armyofagents/ui test:run -- src/components/__tests__/ToastViewport.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ToastViewport.tsx ui/src/components/__tests__/ToastViewport.test.tsx
git commit -m "feat(toast): redesign ToastViewport — Direction A adaptive glass, bottom-right"
```

---

## Task 4: Mount the viewport at app root

Move the single `ToastViewport` mount to the app root so it covers every route (lobby/settings/marketplace included), matching the coverage sonner/marketplace had. Leave the sonner `<Toaster>` and `<InstallToastSlot>` mounts in place **for now** (removed in Tasks 5–6) so nothing breaks mid-sequence.

**Files:**
- Modify: `ui/src/main.tsx`
- Modify: `ui/src/components/Layout.tsx`

- [ ] **Step 1: Remove the per-layout viewport mount**

In `ui/src/components/Layout.tsx`, delete the import (line ≈8) and the JSX (line ≈294):

```tsx
// delete this import line:
import { ToastViewport } from "./ToastViewport";
```
```tsx
// delete this JSX line (just above KeyboardShortcutsCheatsheet):
      <ToastViewport />
```

- [ ] **Step 2: Add the root viewport mount**

In `ui/src/main.tsx`, add the import near the other component imports:

```tsx
import { ToastViewport } from "@/components/ToastViewport";
```

Then in the JSX, add `<ToastViewport />` right after `<Toaster />` (inside `MarketplaceToastProvider`, within `BrowserRouter`):

```tsx
                          <InstallToastSlot />
                          <Toaster />
                          <ToastViewport />
```

- [ ] **Step 3: Verify typecheck + targeted run**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.tsx ui/src/components/Layout.tsx
git commit -m "refactor(toast): mount ToastViewport at app root for all-route coverage"
```

---

## Task 5: Migrate Secrets off sonner; delete the dead sonner system

**Files:**
- Modify: `ui/src/components/secrets/SecretsWorkspace.tsx`
- Modify: `ui/src/pages/secrets/ImportFromVaultDialog.tsx`
- Modify: `ui/src/main.tsx` (remove `<Toaster />`)
- Delete: `ui/src/lib/toast.ts`, `ui/src/components/ui/toaster.tsx`, `ui/src/components/ui/__tests__/toaster.test.tsx`
- Modify: `ui/package.json` (remove `sonner`)

- [ ] **Step 1: Migrate `SecretsWorkspace.tsx`**

Replace the import (line 16):

```tsx
// remove:
import { toast } from "@/lib/toast";
// add:
import { useToast } from "@/context/ToastContext";
```

Add the hook at the top of the `SecretsWorkspace` component body (near the other hooks, ≈line 47):

```tsx
  const { pushToast } = useToast();
```

Convert **every** call site in the file (lines 104, 107, 118, 121, 165, 173, 176, 185, 188, 196, 199, 208, 211, 224, 227, **416, 419, 432, 435**) using these exact replacements:

```tsx
toast.success("Vault saved");
// → pushToast({ title: "Vault saved", tone: "success" });

toast.error("Vault save failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Vault save failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Vault checked", { description: result.message ?? result.status });
// → pushToast({ title: "Vault checked", body: result.message ?? result.status, tone: "success" });

toast.error("Vault check failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Vault check failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Secret deleted");
// → pushToast({ title: "Secret deleted", tone: "success" });

toast.success("Provider key saved");
// → pushToast({ title: "Provider key saved", tone: "success" });

toast.error("Provider key save failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Provider key save failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Provider key updated");
// → pushToast({ title: "Provider key updated", tone: "success" });

toast.error("Provider key update failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Provider key update failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Provider key deleted");
// → pushToast({ title: "Provider key deleted", tone: "success" });

toast.error("Provider key delete failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Provider key delete failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Binding created");
// → pushToast({ title: "Binding created", tone: "success" });

toast.error("Create binding failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Create binding failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Binding removed");
// → pushToast({ title: "Binding removed", tone: "success" });

toast.error("Remove binding failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Remove binding failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Secret disabled");
// → pushToast({ title: "Secret disabled", tone: "success" });

toast.error("Disable failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Disable failed", body: err instanceof Error ? err.message : undefined, tone: "error" });

toast.success("Secret enabled");
// → pushToast({ title: "Secret enabled", tone: "success" });

toast.error("Enable failed", { description: err instanceof Error ? err.message : undefined });
// → pushToast({ title: "Enable failed", body: err instanceof Error ? err.message : undefined, tone: "error" });
```

> The disable/enable handlers are inline `mutate(..., { onSuccess, onError })` callbacks in the `SecretInventoryTab` render (≈lines 410–440). `pushToast` from the top-level `useToast()` hook is in scope there — no extra wiring needed.

- [ ] **Step 2: Migrate `ImportFromVaultDialog.tsx`**

Replace the sonner import with `import { useToast } from "@/context/ToastContext";`, add `const { pushToast } = useToast();` in the component body, and convert the three calls (lines ≈117, 140, 143):

```tsx
toast.error("Preview failed", { description: err instanceof Error ? err.message : "Could not list remote secrets." });
// → pushToast({ title: "Preview failed", body: err instanceof Error ? err.message : "Could not list remote secrets.", tone: "error" });

toast.success("Secrets imported");
// → pushToast({ title: "Secrets imported", tone: "success" });

toast.error("Import failed", { description: err instanceof Error ? err.message : "Could not import selected secrets." });
// → pushToast({ title: "Import failed", body: err instanceof Error ? err.message : "Could not import selected secrets.", tone: "error" });
```

- [ ] **Step 2b: Migrate the 4 Secrets test mocks off `@/lib/toast`**

These tests mock `@/lib/toast` purely to silence the real toast during render (verified: none of them *assert* on the mock). Deleting `@/lib/toast` would make the mock target a missing module. In each file, replace the `@/lib/toast` mock with a `@/context/ToastContext` mock that stubs `useToast`:

Files: `ui/src/pages/Secrets.test.tsx:14`, `ui/src/pages/Secrets.render.test.tsx:14`, `ui/src/pages/secrets/ImportFromVaultDialog.test.tsx:16`, `ui/src/components/secrets/__tests__/SecretImportFlow.test.tsx:19`.

Replace this (the `warning` line is absent in ImportFromVaultDialog — match what's there):

```tsx
vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));
```

with:

```tsx
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));
```

(This mirrors the existing pattern in `ui/src/components/commander/cockpit/*.test.tsx`. The stub makes `useToast()` safe without a real `<ToastProvider>` in the test tree.)

- [ ] **Step 3: Remove the sonner `<Toaster>` mount**

In `ui/src/main.tsx`, delete the import `import { Toaster } from "@/components/ui/toaster";` and the `<Toaster />` JSX line (leaving `<ToastViewport />`).

- [ ] **Step 4: Delete the dead sonner files + dependency**

```bash
git rm ui/src/lib/toast.ts ui/src/components/ui/toaster.tsx ui/src/components/ui/__tests__/toaster.test.tsx
```

In `ui/package.json`, remove the line `"sonner": "^2.0.7",` from `dependencies`, then refresh the lockfile:

Run: `pnpm install`
Expected: removes `sonner`, updates `pnpm-lock.yaml`.

- [ ] **Step 5: Verify no sonner references remain**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS (no remaining imports of `@/lib/toast`, `sonner`, or `@/components/ui/toaster`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(toast): migrate Secrets to pushToast and delete the dead sonner system"
```

---

## Task 6: Fold marketplace into the unified system

Reimplement `useInstallToast` as an adapter over `pushToast`/`updateToast`, backed by a render-less operation tracker. Delete the bespoke renderer. The methods consumers actually call (`show`/`update`/`trackOperation`/`dismiss`) keep their shapes, so the ~5 install/update call sites are untouched (only `toastId`'s type changes number → string, passed through opaquely). The unused `toast` field on the context is dropped — verified no source consumer reads `.toast` (only the old test did).

**Files:**
- Rewrite: `ui/src/components/marketplace/toast/ToastProvider.tsx`
- Rewrite: `ui/src/components/marketplace/toast/useInstallToast.ts`
- Delete: `ui/src/components/marketplace/toast/InstallToastSlot.tsx`
- Replace test: `ui/src/components/marketplace/toast/__tests__/ToastProvider.test.tsx` → `installToast.test.tsx`
- Modify: `ui/src/main.tsx`

- [ ] **Step 1: Rewrite the provider as a render-less tracker + adapter context**

Replace the full contents of `ui/src/components/marketplace/toast/ToastProvider.tsx` with:

```tsx
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { useOperationStatus } from "@/hooks/useOperationStatus";
import { useToast, type ToastTone } from "@/context/ToastContext";

export type InstallToastStatus = "installing" | "success" | "failure";

export interface InstallToastInput {
  status: InstallToastStatus;
  message: string;
  detail?: string;
  actionLabel?: string;
  actionTo?: string;
}

export interface InstallToastOperation {
  toastId: string;
  companyId: string;
  operationId: string;
  itemName: string;
  successMessage?: string;
  requestedMessage?: string;
  failureMessage?: string;
  invalidate?: "plugins" | "companySkills";
  startedAfter?: Date;
}

interface InstallToastContextValue {
  show: (input: InstallToastInput) => string;
  update: (id: string, patch: Partial<InstallToastInput>) => void;
  trackOperation: (operation: InstallToastOperation) => void;
  dismiss: () => void;
}

export const InstallToastContext = createContext<InstallToastContextValue | null>(null);

function statusToTone(status: InstallToastStatus): ToastTone {
  return status === "installing" ? "loading" : status === "success" ? "success" : "error";
}

function toAction(input: { actionLabel?: string; actionTo?: string }) {
  return input.actionLabel && input.actionTo
    ? { label: input.actionLabel, href: input.actionTo }
    : undefined;
}

/**
 * One tracker per active operation. Calling useOperationStatus inside a dedicated
 * child (keyed by toastId) lets N concurrent installs each poll and resolve their
 * OWN sticky loading toast. A single shared poll could only ever track one
 * operation, leaving the others' loading toasts spinning forever.
 */
function OperationTracker({
  operation,
  onResolve,
}: {
  operation: InstallToastOperation;
  onResolve: (operation: InstallToastOperation, patch: Partial<InstallToastInput>) => void;
}) {
  const { data } = useOperationStatus({
    companyId: operation.companyId,
    operationId: operation.operationId,
    startedAfter: operation.startedAfter,
  });
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (!data || resolvedRef.current) return;
    if (data.status === "success") {
      resolvedRef.current = true;
      onResolve(operation, {
        status: "success",
        message: operation.successMessage ?? `Installed ${operation.itemName}`,
      });
    } else if (data.status === "requested") {
      resolvedRef.current = true;
      onResolve(operation, {
        status: "success",
        message:
          operation.requestedMessage ??
          `Request submitted - a founder will review ${operation.itemName}`,
      });
    } else if (data.status === "failure") {
      resolvedRef.current = true;
      onResolve(operation, {
        status: "failure",
        message: operation.failureMessage ?? `Failed to install ${operation.itemName}`,
        detail: data.errorMessage ?? "Unknown error",
      });
    }
  }, [data, onResolve, operation]);

  return null;
}

export function InstallToastProvider({ children }: { children: ReactNode }) {
  const { pushToast, updateToast, dismissToast } = useToast();
  const [operations, setOperations] = useState<InstallToastOperation[]>([]);
  const lastIdRef = useRef<string | null>(null);
  const queryClient = useQueryClient();

  const show = useCallback(
    (input: InstallToastInput) => {
      const id =
        pushToast({
          tone: statusToTone(input.status),
          title: input.message,
          body: input.detail,
          action: toAction(input),
        }) ?? "";
      lastIdRef.current = id;
      return id;
    },
    [pushToast],
  );

  const update = useCallback(
    (id: string, patch: Partial<InstallToastInput>) => {
      updateToast(id, {
        ...(patch.status ? { tone: statusToTone(patch.status) } : {}),
        ...(patch.message !== undefined ? { title: patch.message } : {}),
        ...(patch.detail !== undefined ? { body: patch.detail } : {}),
        ...(patch.actionLabel && patch.actionTo ? { action: toAction(patch) } : {}),
      });
    },
    [updateToast],
  );

  const trackOperation = useCallback((operation: InstallToastOperation) => {
    setOperations((prev) => [
      ...prev.filter((o) => o.toastId !== operation.toastId),
      operation,
    ]);
  }, []);

  // Dismisses the most-recently shown install toast (matches the old single-toast
  // dismiss intent; each toast also carries its own close button).
  const dismiss = useCallback(() => {
    if (lastIdRef.current) dismissToast(lastIdRef.current);
  }, [dismissToast]);

  const handleResolve = useCallback(
    (operation: InstallToastOperation, patch: Partial<InstallToastInput>) => {
      update(operation.toastId, patch);
      if (operation.invalidate === "plugins") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      } else if (operation.invalidate === "companySkills") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.companySkills.list(operation.companyId),
        });
      }
      setOperations((prev) => prev.filter((o) => o.toastId !== operation.toastId));
    },
    [queryClient, update],
  );

  return (
    <InstallToastContext.Provider value={{ show, update, trackOperation, dismiss }}>
      {children}
      {operations.map((op) => (
        <OperationTracker key={op.toastId} operation={op} onResolve={handleResolve} />
      ))}
    </InstallToastContext.Provider>
  );
}
```

> Behavior notes (intentional): (1) a failed install now uses the `error` tone's
> 10s TTL instead of the old fixed 3s — errors lingering longer is desirable.
> (2) Concurrent installs each get their own sticky toast + tracker and resolve
> independently (the old single-`toast` provider could only show one at a time).

- [ ] **Step 2: Rewrite the hook**

Replace the full contents of `ui/src/components/marketplace/toast/useInstallToast.ts` with:

```tsx
import { useContext } from "react";
import { InstallToastContext } from "./ToastProvider";

// No-op fallback for modals rendered outside the provider (test-only path).
const NOOP = {
  show: () => "",
  update: () => {},
  trackOperation: () => {},
  dismiss: () => {},
};

export function useInstallToast() {
  return useContext(InstallToastContext) ?? NOOP;
}
```

- [ ] **Step 3: Delete the bespoke renderer**

```bash
git rm ui/src/components/marketplace/toast/InstallToastSlot.tsx
```

- [ ] **Step 4: Update `main.tsx` mounts**

In `ui/src/main.tsx`:
- Change the import `import { ToastProvider as MarketplaceToastProvider } from "@/components/marketplace/toast/ToastProvider";` → `import { InstallToastProvider } from "@/components/marketplace/toast/ToastProvider";`
- Delete the import `import { InstallToastSlot } from "@/components/marketplace/toast/InstallToastSlot";`
- In JSX: rename `<MarketplaceToastProvider>`/`</MarketplaceToastProvider>` → `<InstallToastProvider>`/`</InstallToastProvider>`, and delete the `<InstallToastSlot />` line.

The result of the inner block should read:

```tsx
                        <InstallToastProvider>
                          <ErrorBoundary>
                            <App />
                          </ErrorBoundary>
                          <ToastViewport />
                        </InstallToastProvider>
```

- [ ] **Step 4b: Migrate the install-modal test harnesses off `<InstallToastSlot>`**

Four existing tests import the deleted `InstallToastSlot` and the now-renamed marketplace `ToastProvider`. Each renders a harness shaped like `<ToastProvider>{ui}<InstallToastSlot /></ToastProvider>` (marketplace provider). Migrate each to the unified providers + viewport so install toasts still render (one test, `PluginInstallModal`, asserts the installing toast text).

Files + `<InstallToastSlot>` occurrences:
- `ui/src/__tests__/MarketplaceDetail.test.tsx` (import :12, render :58)
- `ui/src/components/marketplace/install/__tests__/PackageInstallModal.test.tsx` (import :11, render :62)
- `ui/src/components/marketplace/install/__tests__/SnapshotInstallModal.test.tsx` (import :10, render :57)
- `ui/src/components/marketplace/install/__tests__/PluginInstallModal.test.tsx` (import :10, renders :36, :152, :169)

In each file, change the imports:

```tsx
// remove:
import { ToastProvider } from "@/components/marketplace/toast/ToastProvider";
import { InstallToastSlot } from "@/components/marketplace/toast/InstallToastSlot";
// add:
import { ToastProvider } from "@/context/ToastContext";
import { InstallToastProvider } from "@/components/marketplace/toast/ToastProvider";
import { ToastViewport } from "@/components/ToastViewport";
```

And rewrite **every** harness/render that wrapped `<ToastProvider> … <InstallToastSlot /></ToastProvider>` to nest the install provider and render the unified viewport:

```tsx
<ToastProvider>
  <InstallToastProvider>
    {ui}
    <ToastViewport />
  </InstallToastProvider>
</ToastProvider>
```

(`PluginInstallModal.test.tsx` has three such sites — the `wrap()` helper plus two inline `render(...)` calls at ≈152 and ≈169; apply the swap to all three. The "shows installing toast" assertion keeps passing because `<ToastViewport>` renders the loading toast's title verbatim.)

- [ ] **Step 5: Replace the marketplace toast test**

Delete the old test and create `ui/src/components/marketplace/toast/__tests__/installToast.test.tsx`:

```bash
git rm ui/src/components/marketplace/toast/__tests__/ToastProvider.test.tsx
```

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { marketplaceApi } from "@/api/marketplace";
import { ToastProvider } from "../../../../context/ToastContext";
import { ToastViewport } from "../../../ToastViewport";
import { InstallToastProvider } from "../ToastProvider";
import { useInstallToast } from "../useInstallToast";

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>("@/api/marketplace");
  return {
    ...actual,
    marketplaceApi: { ...actual.marketplaceApi, getOperation: vi.fn() },
  };
});

let api: ReturnType<typeof useInstallToast>;
function Capture() {
  api = useInstallToast();
  return null;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <InstallToastProvider>
            <Capture />
            <ToastViewport />
          </InstallToastProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("install toast adapter", () => {
  it("show(installing) renders a sticky loading toast through the unified viewport", () => {
    setup();
    act(() => { api.show({ status: "installing", message: "Installing Slack" }); });
    expect(screen.getByText("Installing Slack")).toBeInTheDocument();
    expect(screen.getByTestId("toast-loading-rail")).toBeInTheDocument();
  });

  it("update flips the loading toast to success with an action link", () => {
    setup();
    let id = "";
    act(() => { id = api.show({ status: "installing", message: "Installing Slack" }); });
    act(() => {
      api.update(id, { status: "success", message: "Installed Slack", actionLabel: "View", actionTo: "/marketplace" });
    });
    expect(screen.getByText("Installed Slack")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View/ })).toBeInTheDocument();
  });

  it("update flips to a failure toast with detail", () => {
    setup();
    let id = "";
    act(() => { id = api.show({ status: "installing", message: "Installing Slack" }); });
    act(() => { api.update(id, { status: "failure", message: "Install failed", detail: "HTTP 500" }); });
    expect(screen.getByText("Install failed")).toBeInTheDocument();
    expect(screen.getByText("HTTP 500")).toBeInTheDocument();
  });

  it("trackOperation resolves the loading toast and invalidates queries on success", async () => {
    vi.mocked(marketplaceApi.getOperation).mockResolvedValue({ status: "success" } as any);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToastProvider>
            <InstallToastProvider>
              <Capture />
              <ToastViewport />
            </InstallToastProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    let id = "";
    act(() => { id = api.show({ status: "installing", message: "Installing Slack" }); });
    act(() => {
      api.trackOperation({
        toastId: id,
        companyId: "c1",
        operationId: "op-1",
        itemName: "Slack",
        invalidate: "plugins",
      });
    });
    await waitFor(() => expect(screen.getByText("Installed Slack")).toBeInTheDocument());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.plugins.all });
  });

  it("useInstallToast no-ops outside the provider", () => {
    function NoopConsumer() {
      const { show, update, dismiss } = useInstallToast();
      const id = show({ status: "installing", message: "test" });
      update(id, { message: "x" });
      dismiss();
      return null;
    }
    expect(() => render(<NoopConsumer />)).not.toThrow();
  });
});
```

- [ ] **Step 6: Run the marketplace tests**

Run: `pnpm --filter @armyofagents/ui test:run -- src/components/marketplace/toast/__tests__/installToast.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck the whole UI**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS — the install modals still typecheck against the unchanged `useInstallToast` shape (only `toastId` is now `string`, used opaquely).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(toast): fold marketplace install toasts into the unified system"
```

---

## Task 7: Enrich agent/run/activity toasts with `meta.ref`

Give the live agent toasts the rich (full) row by populating `meta.ref` with the entity reference. Scoped to the builders in `LiveUpdatesProvider.tsx`; cooldown/dedupe unchanged.

**Files:**
- Modify: `ui/src/context/LiveUpdatesProvider.tsx`

- [ ] **Step 1: Add `meta.ref` to the run-status toast**

In `buildRunStatusToast` (≈line 403), add `meta` to the returned object (the agent name is already the title; use the short run/agent ref):

```tsx
  return {
    title,
    body,
    tone,
    ttlMs: status === "succeeded" ? 5000 : 7000,
    action: { label: "View run", href: `/agents/${agentId}/runs/${runId}` },
    meta: { ref: `run ${shortId(runId)}` },
    dedupeKey: `run-status:${runId}:${status}`,
  };
```

- [ ] **Step 2: Add `meta.ref` to the issue activity toasts**

In `buildActivityToast` (≈lines 264, 286, 314), add `meta: { ref: issue.ref }` to each of the three returned toast objects (created/updated/comment), e.g.:

```tsx
    return {
      title: `${actor} created ${issue.ref}`,
      body: issue.title ? truncate(issue.title, 96) : undefined,
      tone: "success",
      action: { label: `View ${issue.ref}`, href: issue.href },
      meta: { ref: issue.ref },
      dedupeKey: `activity:${action}:${entityId}`,
    };
```

(Apply the same `meta: { ref: issue.ref }` addition to the `issue.updated` and comment returns.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS (`ToastInput.meta` exists from Task 2).

- [ ] **Step 4: Commit**

```bash
git add ui/src/context/LiveUpdatesProvider.tsx
git commit -m "feat(toast): show mono entity ref on live agent/activity toasts"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full UI test suite**

Run: `pnpm --filter @armyofagents/ui test:run`
Expected: PASS — all suites green, including the new toast/viewport/install tests and the existing `LiveUpdatesProvider` and cockpit toast tests (which mock `useToast`).

- [ ] **Step 2: Typecheck + build**

Run: `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS.

- [ ] **Step 3: Grep for orphans**

Run: `pnpm --filter @armyofagents/ui exec sh -c "grep -rn \"@/lib/toast\\|from \\\"sonner\\\"\\|InstallToastSlot\\|MarketplaceToastProvider\" src || echo CLEAN"`
Expected: `CLEAN` (no remaining references).

- [ ] **Step 4: Manual smoke (dev server)**

Start the app and verify, in dark theme:
1. A simple action (e.g. pin in cockpit) → compact glass toast bottom-right.
2. An agent run completing → full glass toast with mono ref + "View run" link.
3. A marketplace install → sticky loading toast with spinner + rail, flipping to success/failure.
4. A Secrets save/error → glass toast bottom-right (no longer top-right).
5. Several agent toasts at once → they stack bottom-right, newest on top, capped at 5.

Expected: every toast is one consistent glass design in the bottom-right corner.

- [ ] **Step 5: Final commit (if any smoke fixups were needed)**

```bash
git add -A
git commit -m "test(toast): verify unified toast system end-to-end"
```

---

## Self-review notes

- **Spec coverage:** engine (`loading`+`updateToast`+`meta`) → Task 2; glass renderer/adaptive/bottom-right/tokens → Tasks 1, 3; root coverage move → Task 4; Secrets migration + deletions + sonner removal → Task 5; marketplace fold + InstallToastSlot deletion → Task 6; a11y (reduced-transparency/motion) → Task 1 CSS + Task 3 `motion-reduce`; agent `meta.ref` → Task 7; testing + verification → all tasks + Task 8. All design-doc §11 rows are covered.
- **Order safety:** every commit leaves the app compiling and toasts rendering — sonner/InstallToastSlot stay mounted until their consumers are migrated (Tasks 5–6).
- **Type consistency:** `pushToast`/`updateToast`/`ToastInput`/`ToastItem`/`ToastPatch`/`ToastTone`/`ToastMeta` defined in Task 2 are used unchanged in Tasks 3, 6, 7. `InstallToastOperation.toastId` is `string` everywhere after Task 6.

---

## Codex review (round 1) — resolutions

Codex reviewed this plan (read-only, against the live source) and raised 4 P1 + 4 P2. All verified against the codebase and resolved:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | P1 | `updateToast` reads an effect-lagged `toastsRef`; a same-tick `pushToast()→updateToast()` could miss | Engine rewritten so `toastsRef` is the authoritative, synchronously-updated mirror via a `commit()` helper (Task 2). Added a same-tick regression test. |
| 2 | P1 | Task 5 listed only SecretsWorkspace calls through line 227 — 416/419/432/435 (disable/enable) were missed → deleting `@/lib/toast` breaks compile | Added the 4 missing conversions (Task 5 Step 1). |
| 3 | P1 | 4 install tests import/render `<InstallToastSlot>` → suite breaks on `git rm` | Added Task 6 Step 4b migrating all 4 harnesses to the unified providers + `ToastViewport`. |
| 4 | P1 | Single-operation tracker + sticky loading toasts → concurrent installs strand a forever-spinning toast | Rewrote the provider to track a list of operations with one `useOperationStatus` poller per op (`OperationTracker`), each resolving its own toast (Task 6 Step 1). |
| 5 | P2 | "Signature preserved" claim contradicts dropping the `toast` field | Wording corrected; verified no source consumer reads `.toast` (Task 6 intro). |
| 6 | P2 | Replacement marketplace test skipped `trackOperation`/polling/invalidation | Added a test mocking `getOperation` that asserts the toast resolves and `queryKeys.plugins.all` is invalidated (Task 6 Step 5). |
| 7 | P2 | Orphan-grep would fail: 4 Secrets tests still mock `@/lib/toast` | Added Task 5 Step 2b migrating those mocks to a `@/context/ToastContext` stub. |
| 8 | P2 | Renderer dropped `role="status"` (design requires it) | Restored `role="status"` on the viewport (Task 3). |

Also verified (not a finding): `meta.ref` (Task 7) is additive and the only LiveUpdates test (`threadLiveUpdates.test.ts`) covers `threadEventToInvalidations`, not the private toast builders — no breakage.

### Round 2 — clean

Codex re-reviewed the revised plan: **no P1 blockers**, and it confirmed each round-1 fix is correct (synchronous `toastsRef` commit, batched-update safety, per-op tracker hook-safety + safe unmount-on-remove, harness + mock migrations aligned). Two P2 nits, both fixed:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 9 | P2 | `updateToast` didn't handle the reverse transition (terminal → `loading`): an existing auto-dismiss timer wasn't cleared, so a re-opened loading toast could still expire | Added an `enteringLoading` branch that sets `ttl = ∞` and clears the pending timer (Task 2). |
| 10 | P2 | Stale verification text said "PASS (4 tests)" but the install test now has 5 | Corrected to "PASS (5 tests)" (Task 6 Step 6). |
