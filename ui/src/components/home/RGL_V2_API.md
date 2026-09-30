# react-grid-layout@2.2.3 — native v2 API notes (Task A1 Step 3)

Recorded by reading the installed `.d.ts` files directly:
`ui/node_modules/react-grid-layout/dist/{index,react,ResponsiveGridLayout-*,types-*,position-*,responsive-*,calculate-*,legacy}.d.ts`

This is the **native v2 root API** (`import ... from "react-grid-layout"`), NOT the
`react-grid-layout/legacy` subpath. `legacy.d.ts` re-exposes the classic v1 flat
props (`compactType`, `isDraggable`, `isResizable`, `draggableHandle`,
`draggableCancel`, `WidthProvider`-style) for migration purposes — we intentionally
do **not** use it (per the Phase-0 spike decision to stay on the rewritten path).

## Root exports (`react-grid-layout`, i.e. `dist/index.d.ts`)

```ts
export {
  GridLayout,              // fixed-width grid (single breakpoint)
  ResponsiveGridLayout,     // alias: Responsive
  Responsive,               // <-- the component we use
  GridLayoutProps,
  ResponsiveGridLayoutProps, // alias: ResponsiveProps
  default,                  // NOTE: default export is GridLayout, NOT Responsive!
} from "./ResponsiveGridLayout-*.js";

export {
  useContainerWidth, useGridLayout, useResponsiveLayout,
  GridItem, GridItemProps,
  DragState, DropState, ResizeState,
  UseContainerWidthOptions, UseContainerWidthResult,
  UseGridLayoutOptions, UseGridLayoutResult,
  UseResponsiveLayoutOptions, UseResponsiveLayoutResult,
  DEFAULT_BREAKPOINTS, DEFAULT_COLS, DefaultBreakpoints,
} from "./react.js";

export {
  Breakpoint, Breakpoints, CompactType, Compactor, DroppingPosition,
  EventCallback, GridDragEvent, GridResizeEvent, Layout, LayoutItem,
  Position, ResizeHandleAxis, ResponsiveLayouts,
} from "./types-*.js";

export {
  collides, findOrGenerateResponsiveLayout, getAllCollisions,
  getBreakpointFromWidth, getColsFromBreakpoint, sortLayoutItems,
  sortLayoutItemsByColRow, sortLayoutItemsByRowCol,
} from "./responsive-*.js";

export {
  bottom, cloneLayout, cloneLayoutItem, getCompactor, getLayoutItem,
  horizontalCompactor, moveElement, noCompactor, setTopLeft, setTransform,
  validateLayout, verticalCompactor,
} from "./position-*.js";

export { calcGridItemPosition, calcWH, calcXY } from "./calculate-*.js";
```

**Import for our use case:** `import { Responsive, useContainerWidth, verticalCompactor } from "react-grid-layout";`
(named export, NOT default — `export default` resolves to `GridLayout`, the
non-responsive single-breakpoint component.)

## `useContainerWidth()` — no ref argument; it RETURNS a ref

```ts
interface UseContainerWidthOptions {
  measureBeforeMount?: boolean;
  initialWidth?: number; // default 1280
}
interface UseContainerWidthResult {
  width: number;
  mounted: boolean;
  containerRef: RefObject<HTMLDivElement | null>; // attach this to your wrapper div
  measureWidth: () => void;
}
declare function useContainerWidth(options?: UseContainerWidthOptions): UseContainerWidthResult;
```

Usage is the inverse of what you might expect from a "pass a ref" API:

```tsx
const { width, mounted, containerRef } = useContainerWidth();
return (
  <div ref={containerRef}>
    {mounted && <Responsive width={width} {...props} />}
  </div>
);
```

Replaces the old `WidthProvider(Responsive)` HOC from v1/legacy.

## `Responsive` component props (`ResponsiveGridLayoutProps<B>`)

`ResponsiveGridLayoutProps<B> extends Omit<GridLayoutProps, "gridConfig" | "layout" | "onLayoutChange">`
— so it inherits `dragConfig`, `resizeConfig`, `dropConfig`, `positionStrategy`,
`constraints`, `droppingItem`, `autoSize`, `innerRef`, `onDragStart/onDrag/onDragStop`,
`onResizeStart/onResize/onResizeStop`, `onDrop`, `onDropDragOver` from `GridLayoutProps`,
and adds/overrides:

```ts
interface ResponsiveGridLayoutProps<B extends Breakpoint = string> {
  children: React.ReactNode;
  width: number;                       // required — feed from useContainerWidth()
  breakpoint?: B;                       // optional; auto-detected from width if omitted
  breakpoints?: Breakpoints<B>;         // { lg: 1024, md: 640, sm: 0, ... }
  cols?: Breakpoints<B>;                // { lg: 4, md: 2, sm: 1 }
  layouts?: ResponsiveLayouts<B>;       // { lg: LayoutItem[], md: ..., sm: ... }
  rowHeight?: number;                   // default 150
  maxRows?: number;                     // default Infinity
  margin?: readonly [number, number] | Partial<Record<B, readonly [number, number]>>;
  containerPadding?: readonly [number, number] | Partial<Record<B, readonly [number, number] | null>> | null;
  compactor?: Compactor;                // pluggable compaction strategy (see below)
  dragConfig?: Partial<DragConfig>;     // { enabled, bounded, handle, cancel, threshold }
  resizeConfig?: Partial<ResizeConfig>; // { enabled, handles, handleComponent }
  dropConfig?: Partial<DropConfig>;     // external drag-and-drop-in (not used by us)
  onBreakpointChange?: (newBreakpoint: B, cols: number) => void;
  onLayoutChange?: (layout: Layout, layouts: ResponsiveLayouts<B>) => void;  // (current, all) — matches plan
  onWidthChange?: (containerWidth: number, margin, cols, containerPadding) => void;
  onResizeStop?: EventCallback;  // inherited from GridLayoutProps (NOT omitted)
  // ...onDragStart/onDrag/onDragStop/onResizeStart/onResize also inherited
}
```

`EventCallback` signature (used by `onDragStop`/`onResizeStop`/etc.):

```ts
type EventCallback = (
  layout: Layout,
  oldItem: LayoutItem | null,
  newItem: LayoutItem | null,
  placeholder: LayoutItem | null,
  event: Event,
  element: HTMLElement | null,
) => void;
```

## `dragConfig` / `resizeConfig` shapes

```ts
interface DragConfig {
  enabled: boolean;      // default true — set false to disable drag off-edit-mode
  bounded: boolean;      // default false
  handle?: string;       // CSS selector for a drag handle (we don't need one — whole
                         // tile header row is draggable via WidgetShell in edit mode)
  cancel?: string;       // CSS selector for elements that should NOT start a drag
  threshold: number;     // default 3 (px before drag starts)
}

interface ResizeConfig {
  enabled: boolean;                 // default true — gate on `editing`
  handles: readonly ResizeHandleAxis[]; // default ['se']
  handleComponent?: ReactNode | ((axis, ref) => ReactNode);
}
```

We wire `dragConfig={{ enabled: editing }}` / `resizeConfig={{ enabled: editing }}`
per the plan — no `handle`/`cancel` needed for our tile chrome.

## `compactor` (the vertical compactor)

```ts
interface Compactor {
  readonly type: CompactType;          // "horizontal" | "vertical" | "wrap" | null
  readonly allowOverlap: boolean;
  readonly preventCollision?: boolean;
  compact(layout: Layout, cols: number): Layout;
}
declare const verticalCompactor: Compactor;   // default recommended — what the plan wants
declare const horizontalCompactor: Compactor;
declare const noCompactor: Compactor;
```

Pass `compactor={verticalCompactor}` (imported from `"react-grid-layout"`) rather
than the legacy string `compactType="vertical"`.

## Layout item shape (`LayoutItem`)

```ts
interface LayoutItem {
  i: string;         // matches our HomeBoardLayoutItem.i (widget key)
  x: number; y: number; w: number; h: number;
  minW?: number; minH?: number; maxW?: number; maxH?: number;
  static?: boolean;
  isDraggable?: boolean;   // per-item override of grid-level dragConfig.enabled
  isResizable?: boolean;   // per-item override of grid-level resizeConfig.enabled
  resizeHandles?: ResizeHandleAxis[];
  isBounded?: boolean;
  moved?: boolean;         // internal
  constraints?: LayoutConstraint[];
}
type Layout = readonly LayoutItem[];
```

Our `HomeBoardLayoutItem` (`{ i, x, y, w, h }`, packages/shared + packages/db) is a
structural subset — assignable directly as a `Layout` item without adapting.

## Helpers available for later phases (not used in Phase A)

- **Task B3** (`gridLayout.ts` — `buildDefaultLg`/`reconcileLg`/`projectToBreakpoint`):
  `getBreakpointFromWidth`, `getColsFromBreakpoint`, `sortLayoutItemsByRowCol`,
  `verticalCompactor.compact(layout, cols)`, `collides(l1, l2)`, `getAllCollisions`,
  `getFirstCollision` are all exported and can be reused instead of hand-rolling
  the packing/collision logic.
- **Task D2** (keyboard a11y move/resize): `moveElement(layout, item, x, y,
  isUserAction, preventCollision, compactType, cols, allowOverlap?)` mutates `item`
  and returns the updated layout with collision handling — this is the "reuse RGL
  core move/compaction helpers" escape hatch the plan mentions. `validateLayout`
  is also available for a cheap sanity assert in dev.
- `react-grid-layout/extras` (`extras.d.ts`) exposes additional built-ins (e.g. a
  tree-shakeable `wrapCompactor`) — not needed for our vertical-only board.

## Peer / transitive dependency check (Task A1 Step 2)

`pnpm --filter @armyofagents/ui why react-draggable` resolves **4.7.1** for both
`react-grid-layout`'s own dependency and the transitive `react-resizable@3.2.0`
pulled in by react-grid-layout, and for our direct `react-resizable@4.0.2`. All
`>= 4.7.1` — no `pnpm.overrides` needed.
