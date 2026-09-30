# Toast Unification (Layer 1) — Design

**Status:** Draft (pending user review)
**Date:** 2026-06-25
**Branch:** one feature branch, one PR, scoped commits
**Target:** UI-only (`ui/src/`). No server, no schema, no API changes.

---

## 1. Goal

Collapse the **three independent toast systems** in the app down to **one** —
one API (`pushToast`), one renderer, one location (bottom-right), one
design-token skin. The unified toast adopts the **Direction A "status-native"**
look with a subtle **glassmorphism** card, and gains a **sticky `loading`
state** so marketplace installs fold in instead of needing their own renderer.

This is **Layer 1** of the broader notifications/toasts review. Layers 2
(registry-driven persistent notifications) and 3 (realtime delivery + toast↔
notification bridge) are **out of scope** here (§10).

## 2. Why

- **Visible fragmentation.** Identical-purpose toasts pop in **three different
  corners with three different looks** depending on the feature (saves →
  bottom-left, installs → bottom-right, Secrets → top-right). This is the
  user-reported "different design and location."
- **An abandoned migration.** The sonner path (`lib/toast.ts` + `ui/toaster.tsx`)
  was a half-finished standardization wired to only **2 files**; it is dead
  weight that still ships the `sonner` dependency and a second `<Toaster>` mount.
- **Off-system styling.** The dominant renderer (`ToastViewport`) uses hardcoded
  tailwind full-color backgrounds (`bg-sky-50`, `bg-emerald-950/60`) that ignore
  the design tokens — the *dead* sonner path was actually the token-correct one.
- **Agent toasts are already here.** The live agent/run toasts (the richest,
  highest-volume case) already flow through `pushToast`; unifying + restyling the
  one renderer upgrades them for free.

## 3. Current state (verified)

### 3.1 The three systems

| System | API | Mount | Corner | Reach | Skin |
|--------|-----|-------|--------|-------|------|
| **ToastContext** (dominant) | `useToast().pushToast` | `main.tsx:51` provider; `Layout.tsx:294` viewport | bottom-left | **71 files / 346 refs** | hardcoded tailwind full-color |
| **Sonner** (dead) | `toast.*` via `lib/toast.ts` | `main.tsx:63` `<Toaster>` | top-right | **2 files** (Secrets) | token-correct (card + accent) |
| **Marketplace** | `useInstallToast()` | `main.tsx:58` provider + `:62` `<InstallToastSlot>` | bottom-right | ~6 install/update call sites | bespoke (lucide icons + spinner) |

### 3.2 Key files

| Concern | File |
|---------|------|
| Engine (queue, dedupe, TTL) | `ui/src/context/ToastContext.tsx` |
| Renderer | `ui/src/components/ToastViewport.tsx` |
| Dead sonner wrapper / mount / test | `ui/src/lib/toast.ts`, `ui/src/components/ui/toaster.tsx`, `ui/src/components/ui/__tests__/toaster.test.tsx` |
| Sonner consumers | `ui/src/components/secrets/SecretsWorkspace.tsx`, `ui/src/pages/secrets/ImportFromVaultDialog.tsx` |
| Marketplace toast | `ui/src/components/marketplace/toast/ToastProvider.tsx`, `InstallToastSlot.tsx`, `useInstallToast.ts`, `__tests__/ToastProvider.test.tsx` |
| Agent/live toasts | `ui/src/context/LiveUpdatesProvider.tsx` (`buildRunStatusToast:376`, `buildAgentStatusToast:346`, `buildActivityToast:244`, cooldown gate `:519`) |
| Design tokens | `ui/src/index.css` (`--card`, `--card-2`, `--border`, `--text`, `--dim`, `--success`, `--warning`, `--error`, `--info`, `--brand`) |

### 3.3 Engine capabilities today

`ToastInput = { id?, dedupeKey?, title, body?, tone?: "info"|"success"|"warn"|"error", ttlMs?, action?: {label, href} }`.
`pushToast` returns `string | null` (null when deduped within a 3.5s window).
Constants: `MAX_TOASTS = 5`, per-tone default TTL, `createdAt` already tracked per toast.

**Gaps vs. what marketplace needs:** no sticky/non-expiring state, and no clean
in-place update (re-pushing the same id inside the dedupe window returns `null`).

### 3.4 Coverage gap to fix

The dominant `ToastViewport` is mounted in `Layout.tsx` (company routes only),
whereas sonner's `<Toaster>` and marketplace's `<InstallToastSlot>` are at app
**root** (`main.tsx`) and therefore cover pre-company pages (Lobby, Settings,
Marketplace, Secrets). Consolidating onto `ToastViewport` **requires moving its
mount to root** or those pages lose toasts. (See §4.4.)

## 4. Target architecture

### 4.1 One system — keep the ToastContext engine

`ToastContext`'s engine (dedupe, 5-item queue, per-tone TTL, `createdAt`) is
good and stays. Sonner and the marketplace renderer are deleted; their callers
route through `pushToast`. No competing providers remain.

### 4.2 Engine changes (`ToastContext.tsx`)

Additions only — existing fields and behavior unchanged, so the 71 simple call
sites need **zero edits**.

1. **`loading` tone.** `ToastTone` gains `"loading"`. A loading toast is
   **sticky** (no auto-dismiss timer, effectively `ttl = ∞`) and **skips the
   dedupe window** (each operation is distinct) so it always returns a real id.
2. **`updateToast(id, patch)`** added to the context value, where
   `patch: Partial<Pick<ToastItem, "title"|"body"|"tone"|"action"|"ttlMs"|"meta">>`.
   Merges into the live toast. When tone transitions `loading → terminal`
   (success/error/warn/info), it **arms the normal TTL timer** (patch `ttlMs` or
   the new tone's default) so the toast then auto-dismisses.
3. **Optional `meta?: { ref?: string }`** on `ToastInput`/`ToastItem` — a short
   mono reference (e.g. `TASK-128`) for the rich row. Optional; bare toasts omit
   it. Only the LiveUpdates builders (§5.3) populate it.
4. **Relative timestamp** is derived from the existing `createdAt` at render time
   ("now", "1m", …) — free for every toast, no call-site change.

### 4.3 Renderer — Direction A, adaptive, glass (`ToastViewport.tsx`)

**Adaptive layout — deterministic switch:** the form is **full** when
`tone === "loading"` **OR** `meta.ref` is set; **compact** otherwise.
- **Full (two-line):** status chip (rounded-full, tone-tinted, lucide icon) +
  title row (`text-sm font-medium`, optional muted suffix, right-aligned
  timestamp) + secondary line (mono `meta.ref` chip + `text-xs` detail/`body`) +
  quiet action link below. Used by loading toasts and entity-referencing events
  (agent runs, task activity).
- **Compact (single line):** 7px tone dot + title + optional inline truncated
  `body` + inline action link + timestamp. Used by everything else — "Pinned",
  "Saved", "Scout run failed · timeout after 600s".

This matches the locked mock exactly: agent-run success (has `meta.ref`) → full;
install (loading) → full; "Pinned" (neither) → compact; "Scout run failed" (no
ref) → compact with inline detail.

**Glass card (locked visual):**
- Surface: translucent `--card-2` (≈55% opacity via `color-mix`) +
  `backdrop-filter: blur(17px) saturate(1.35)` (the locked level; tunable).
- Border: 1px hairline highlight; `box-shadow: 0 2px 10px rgba(0,0,0,.30)` +
  `inset 0 1px 0` top highlight. (A deliberate, light exception to the
  "shadows sm-only" rule, justified by a floating overlay layer.)
- Radius `rounded-lg` (~11px).
- Introduce a small set of **toast tokens in `index.css`** (light + dark) so the
  glass is themeable, e.g. `--toast-bg`, `--toast-border`, `--toast-highlight`.

**Tone → color + icon, reusing the status vocabulary** (design-guide §5):

| Tone | Token / color | Icon |
|------|---------------|------|
| `success` | `--success` (green) | Check / CheckCircle |
| `error` | `--error` (red) | XCircle |
| `warn` | `--warning` (amber) | AlertTriangle |
| `info` | `--info` (blue) | Info |
| `loading` | status "running" **cyan** (same as a running-agent dot) | Loader2 (spin) + 2px indeterminate rail along the card bottom |

Keep the existing slide+fade animation, the action `<Link>`, and the dismiss-X.

### 4.4 Location + mounting

- All toasts anchor **bottom-right**, newest on top, `max-w-sm`, `z-[120]`.
- **Move `<ToastViewport/>` to app root** in `main.tsx` (inside `BrowserRouter`
  so the action `<Link>` resolves), replacing the old `<Toaster/>`/
  `<InstallToastSlot/>` mounts; **remove it from `Layout.tsx:294`**. This gives
  universal route coverage (matching what sonner/marketplace had) and avoids a
  double-mount.

## 5. Migrations

### 5.1 Secrets (sonner → pushToast) — mechanical

2 files. `toast.success(t)` → `pushToast({ title: t, tone: "success" })`;
`toast.error(t, { description })` → `pushToast({ title: t, body: description, tone: "error" })`.

### 5.2 Marketplace fold — keep orchestration, drop the renderer

- `useInstallToast()` becomes a **thin adapter** over `useToast()`:
  `show({status:"installing", message, detail})` → `pushToast({tone:"loading", title:message, body:detail})` (returns id);
  `update(id, {status:"success"|"failure", message, detail, actionLabel, actionTo})` → `updateToast(id, {tone, title, body, action})`.
  Its **public signature is unchanged**, so the ~6 modal/button call sites are
  **not touched**.
- The operation-status polling (`useOperationStatus` + `trackOperation` + query
  invalidation) currently lives in the always-mounted marketplace provider so it
  survives modal unmount. Keep it as a **render-less tracker**
  (`InstallOperationTracker`) mounted once at root that drives the unified toast
  via `updateToast`. Delete the **renderer** (`InstallToastSlot`) and the bespoke
  `ToastState` UI.

### 5.3 LiveUpdates enrichment (optional, isolated)

The ~5 toast builders in `LiveUpdatesProvider.tsx` already pack everything into
`title`/`body` strings and keep working as-is. As a small polish, populate
`meta.ref` (e.g. the issue identifier / agent ref) on the agent/run/activity
builders so the rich row shows the mono chip. Scoped to those builders only; the
cooldown gate and dedupe keys are unchanged.

## 6. Deletions

- `ui/src/lib/toast.ts`
- `ui/src/components/ui/toaster.tsx` + `ui/src/components/ui/__tests__/toaster.test.tsx`
- `ui/src/components/marketplace/toast/InstallToastSlot.tsx`
- The bespoke marketplace `ToastState` renderer/UI (provider slimmed to the tracker)
- `sonner` from `ui/package.json`
- `main.tsx`: `<Toaster/>` + `<InstallToastSlot/>` imports and mounts
- `Layout.tsx:294`: `<ToastViewport/>` (moved to root)

## 7. Accessibility & performance

- Keep `aria-live="polite"` / `role="status"` on the viewport.
- **`prefers-reduced-transparency`** → solid `var(--card-2)`, drop the blur.
- **`prefers-reduced-motion`** → no spinner rotation, no indeterminate rail
  animation, no slide-in.
- `backdrop-filter` cost is bounded by the existing `MAX_TOASTS = 5` cap.

## 8. Testing

- **`ToastContext`:** `loading` is sticky (no auto-dismiss); `loading` skips
  dedupe and returns an id; `updateToast` merges and, on `loading → terminal`,
  arms the TTL; existing dedupe/queue/TTL behavior preserved.
- **`ToastViewport`:** compact vs. full rendering by content; tone→icon/color
  mapping; reduced-transparency + reduced-motion fallbacks.
- **Marketplace adapter:** `show` opens a loading toast; a tracked operation
  success/failure flips it via `updateToast` and runs the query invalidation
  (port/replace `ToastProvider.test.tsx`).
- **Delete** `toaster.test.tsx`.
- **LiveUpdates:** existing builder tests still pass; assert `meta.ref` when added.
- Full `ui` vitest suite stays green.

## 9. Risk & rollout

- **Highest risk: the marketplace fold** (don't break install progress or query
  invalidation). Mitigated by preserving `useInstallToast`'s signature and the
  render-less tracker.
- **Position move** (bottom-left → bottom-right) affects 71 callers' output
  location but is a single viewport change, purely visual.
- **Coverage move** (ToastViewport → root): verify no double-mount and that
  pre-company pages now show toasts.
- One feature branch; commits scoped as: engine → renderer/glass → secrets →
  marketplace fold → deletions → tests.

## 10. Out of scope (later layers)

- **Layer 2:** registry-driven persistent `notifications` (type → icon/title/
  render/surface), single emit path, removing dead notification types.
- **Layer 3:** realtime notification delivery (replace polling) + optional
  rule bridging selected notifications to toasts + per-user preferences.
- No server, schema, or `notifications`-table changes in Layer 1.

## 11. File-by-file change list

| File | Change |
|------|--------|
| `ui/src/context/ToastContext.tsx` | add `loading` tone, `updateToast`, optional `meta`, sticky + dedupe-skip handling |
| `ui/src/components/ToastViewport.tsx` | rewrite to Direction A adaptive + glass + bottom-right + tokens + reduced-motion/transparency |
| `ui/src/index.css` | add `--toast-bg` / `--toast-border` / `--toast-highlight` (light + dark) |
| `ui/src/main.tsx` | mount `<ToastViewport/>` at root; remove `<Toaster/>` + `<InstallToastSlot/>`; swap marketplace provider for render-less tracker |
| `ui/src/components/Layout.tsx` | remove `<ToastViewport/>` (moved to root) |
| `ui/src/components/secrets/SecretsWorkspace.tsx` | sonner → `pushToast` |
| `ui/src/pages/secrets/ImportFromVaultDialog.tsx` | sonner → `pushToast` |
| `ui/src/components/marketplace/toast/useInstallToast.ts` | reimplement as adapter over `useToast` |
| `ui/src/components/marketplace/toast/ToastProvider.tsx` | slim to render-less `InstallOperationTracker` |
| `ui/src/context/LiveUpdatesProvider.tsx` | optional: populate `meta.ref` on agent/run/activity builders |
| _deletions_ | `lib/toast.ts`, `ui/toaster.tsx` (+test), `marketplace/toast/InstallToastSlot.tsx`, `sonner` dep |
