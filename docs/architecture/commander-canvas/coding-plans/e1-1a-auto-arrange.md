# E1.1a — Auto-arrange (tiled layout + Arrange/Fit commands)

**Status:** added during the first-batch demo review (2026-09-17) at TK's request.
Extends the E1.1 frame; it is not one of the original 31 slices and is recorded
here as an intentional scope addition. Companion to
[first-batch results](../first-canvas-batch-results.md) and the
[canvas interaction contract](../canvas-interaction-contract.md) ("automatic
arrangements avoid covering active content").

## Decided behavior (with TK)

- **Standard is tiled, not cascaded.** Opening panels lays them out side by side
  in a tidy responsive grid instead of the current 20px cascade overlap.
- **Manual overlap is respected.** Dragging (or resizing) a panel marks it
  *manually placed*; auto-tiling leaves it where the user put it until the next
  explicit Arrange.
- **Pinned panels are never moved** by any arrange.
- **Ship all three controls:** auto-tile-on-open (default **on**), an explicit
  **Arrange** command, and a **Fit** command (zoom to frame everything), plus a
  **toggle** to turn auto-tiling off. Commander uses the same engine.
- **Overflow = fit-to-readable-minimum, then scroll (TK deferred the call to us).**
  Tiles shrink only to a readable minimum; beyond that they keep that size and the
  grid overflows the viewport, reachable by panning. The explicit **Fit** command
  can additionally zoom-to-fit for a deliberate overview glance.
- Cursor-only resize edges and the smoother control hover (already shipped in
  `1bb9bd950`) are the interaction-polish companions to this work.

## Arrange engine (pure)

New pure helper beside `openingRect` (in `panel-state.ts`), fully unit-tested:

```
arrangeLayout(order: string[], usable: Bounds, view: Viewport, policy: TilePolicy)
  -> Record<string, Rect>
```

- `TilePolicy = { minWidth; minHeight; gap; }` (CSS px at zoom 1, converted once).
- **Grid shape:** aspect-aware. `cols = clamp(round(sqrt(N * usableW/usableH)), 1, N)`,
  `rows = ceil(N / cols)`. (Wide screens get more columns; near-square gets a
  square-ish grid.)
- **Tile size:** `tileW = max(minWidth, (usableW - gap*(cols+1)) / cols)`, likewise
  `tileH`. Clamping to the minimum is what makes the grid overflow the viewport for
  large N (hybrid overflow) rather than producing unreadable tiles.
- **Placement:** cell `(col, row)` → canvas-unit rect using the same
  `usable`/`view` conversion as `openingRect`, so tiling is correct at every zoom.
- Deterministic and side-effect free; the reducer/handle consume its output.

## State and actions (`panel-state.ts`)

- `Panel` gains `placement: "auto" | "manual"`. New panels open `"auto"`; a
  **human** `geometry` action flips the panel to `"manual"`; `arrange` resets the
  panels it touches back to `"auto"`.
- `State` gains `autoTile: boolean` (default `true`) — the toggle. (Later bound to
  an E8.1 Universe preference for its default; workspace/harness state for now.)
- New action `{ type: "arrange"; rects: Record<string, Rect> }` applied as one
  batch: writes each panel's rect (skipping pinned + minimized) and sets its
  `placement: "auto"`. The **caller** decides the set — the open path passes only
  the auto panels' rects (manual/pinned untouched), the explicit Arrange passes
  every non-pinned panel's rects (so manual ones rejoin the grid). Keeping the
  *computation* outside the reducer (the engine is pure) preserves the reducer as
  pure data.
- **Fit** is camera-only: `WorkspaceHandle.fit()` computes a viewport framing all
  visible panels; it changes no rects.

## Triggers / integration (`UniverseWorkspace.tsx`)

- `WorkspaceHandle` gains `arrange()`, `fit()`, `setAutoTile(on: boolean)`.
- **Open path:** when `autoTile`, after inserting the new panel the workspace
  computes `arrangeLayout` over the **auto, non-pinned, non-minimized** set and
  dispatches one `arrange` (`scope:"auto"`) — new + existing auto panels re-tile,
  manual/pinned stay put.
- **Explicit Arrange** re-tiles **everything** (`scope:"all"`, resetting manual
  panels back to auto), still skipping pinned.
- **Commander arrange** dispatches the same `arrange` (respects pins). This
  replaces the current harness stub that merely nudged the selected panel +50px.
- **Human drag/resize** (`geometry`, source `"human"`) sets `placement:"manual"`.

## Harness controls (`UniversePanelHarness.tsx`)

Add **Arrange**, **Fit**, and an **Auto-tile: on/off** toggle; wire the existing
"Commander arrange fixture" button to the real `arrange` path.

## Tests

- **Unit (`panel-layout` / arrange engine):** grid shape for N = 1..6, min-tile
  clamp + overflow beyond `usable`, gap, wide vs tall aspect, camera/zoom
  conversion, empty set.
- **Reducer:** `arrange` batch writes rects, skips pinned + minimized, sets
  placement; human geometry sets `manual`; open re-tiles when `autoTile`.
- **Browser (`canvas.spec.ts`):** open 2 → non-overlapping side by side; open 3/4 →
  grid; drag one → it stays on the next open while the others re-tile; explicit
  Arrange → re-tiles all incl. the moved one; toggle off → cascade returns; pinned
  excluded; Fit frames all; behaviour holds at zoom 0.5/1/2.

## Increments

1. ✅ **Arrange engine** (pure) + unit tests — `panel-state.ts` (`f31362c71`), then
   refined to cap tiles at the preferred size and center the grid.
2. ✅ **State**: `placement` flag, `arrange` action, human-geometry→manual + reducer tests.
3. ✅ **Workspace**: `arrange()`/`fit()`/`setAutoTile()` handle, auto-tile-on-open,
   `initialAutoTile` prop + `autoTile` state, `TILE_POLICY`.
4. ✅ **Harness**: Arrange / Fit / auto-tile-toggle controls. The existing
   "Commander arrange fixture" stub is **kept as-is** (three browser tests depend on
   its commander-geometry behaviour); the real engine is exercised through the new
   Arrange button — the same path Commander would call.
5. ✅ **Browser** regression: auto-tile layout + manual opt-out + explicit Arrange +
   pin exclusion + toggle-off + Fit.
6. ⏳ **Review + qualify**: full-repo Linux typecheck/tests/build runs with the batch
   before merge.

**Verified 2026-09-17:** panel-state 46 unit tests, 85 universe UI unit tests, 50
real-Chromium browser cases, and UI typecheck (`tsc -b`) all green.

## Post-review polish (2026-09-17)

Follow-ups from TK's live review of the tiled layout, all shipped on this branch:

- **Reflow on close/minimize/restore** — closing a panel no longer leaves a hole;
  the survivors re-flow and a lone panel grows back (this is also "how a panel
  becomes bigger" — close its siblings).
- **Light motion** — opt-in `.universe-motion` layer: geometry changes glide and
  panels fade in, suppressed during gestures and under reduced motion, off by
  default (the product enables it). Full lifecycle motion is still E1.6.
- **Stronger selection** — the active panel's header tint (20%) and title weight
  are more pronounced and inactive titles recede — still tint/brightness only.
- **Arrange around pinned** — Arrange routes free panels around pinned ones
  instead of sliding under them (`arrangeLayout` gained an optional `avoid` set).

## Out of scope (later slices)

- Persisting `autoTile` / `placement` (E1.2 layout persistence; E8.1 preference for
  the toggle default).
- Overview preview tiles at small scale (E1.4).
- Animated tile-transition motion timings (E1.6). This slice applies geometry
  directly; the smooth animated transition is E1.6's job.
