export type Rect = { x: number; y: number; width: number; height: number };
export type Scope = {
  companyId: string;
  userId: string;
  conversationId: string;
};
export type Ref = {
  companyId: string;
  kind: "task" | "artifact" | "browser";
  id: string;
  version?: string;
};
export type Panel = {
  key: string;
  generation: number;
  openedOrdinal: number;
  ref: Ref;
  title: string;
  rect: Rect;
  minimized: boolean;
  pinned: boolean;
  /** Auto panels join the tiled grid; a human move marks the panel "manual" so
   * auto-tiling leaves it alone until an explicit Arrange. Absent = auto. */
  placement?: "auto" | "manual";
};
export type State = {
  /** Reconciliation watermark only; persistence authority remains with E1.2. */
  layoutRevision?: number;
  scope: Scope;
  nextGeneration: number;
  nextOpenedOrdinal: number;
  panels: Record<string, Panel>;
  order: string[];
  selected: string | null;
  maximized: string | null;
};
export type Action =
  | { type: "open"; ref: Ref; title: string; rect: Rect }
  | {
      type: "focus" | "minimize" | "restore" | "maximize" | "close";
      key: string;
      generation: number;
    }
  | { type: "pin"; key: string; generation: number; value: boolean }
  | {
      type: "geometry";
      key: string;
      generation: number;
      rect: Rect;
      source: "human" | "commander";
      expectedRect?: Rect;
    }
  | { type: "arrange"; rects: Record<string, Rect> }
  | { type: "deselect" };

export const panelKey = (scope: Scope, ref: Ref): string =>
  JSON.stringify([
    scope.companyId,
    scope.userId,
    scope.conversationId,
    ref.kind,
    ref.id,
    ref.version ?? null,
  ]);

export const initialState = (scope: Scope): State => ({
  scope: { ...scope },
  nextGeneration: 1,
  nextOpenedOrdinal: 1,
  panels: {},
  order: [],
  selected: null,
  maximized: null,
});

export const validRect = (r: Rect): boolean =>
  !!r &&
  [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
  Math.abs(r.x) <= 1e6 &&
  Math.abs(r.y) <= 1e6 &&
  r.width >= 1 &&
  r.height >= 1 &&
  r.width <= 8192 &&
  r.height <= 8192;

function foreground(s: State, key: string): State {
  return {
    ...s,
    selected: key,
    order: [...s.order.filter((k) => k !== key), key],
    maximized: s.maximized === key ? key : null,
  };
}
export function panelReducer(s: State, a: Action): State {
  if (a.type === "open") {
    if (
      !validRef(a.ref, s.scope) ||
      typeof a.title !== "string" ||
      !validRect(a.rect)
    )
      return s;
    const key = panelKey(s.scope, a.ref);
    const existing = Object.hasOwn(s.panels, key) ? s.panels[key] : undefined;
    if (
      !existing &&
      (!allocatable(s.nextOpenedOrdinal) || !allocatable(s.nextGeneration))
    )
      return s;
    const panel: Panel = existing
      ? { ...existing, minimized: false }
      : {
          key,
          generation: s.nextGeneration,
          openedOrdinal: s.nextOpenedOrdinal,
          ref: { ...a.ref },
          title: a.title,
          rect: { ...a.rect },
          minimized: false,
          pinned: false,
          placement: "auto",
        };
    return foreground(
      {
        ...s,
        nextGeneration: existing ? s.nextGeneration : s.nextGeneration + 1,
        nextOpenedOrdinal: existing
          ? s.nextOpenedOrdinal
          : s.nextOpenedOrdinal + 1,
        panels: { ...s.panels, [key]: panel },
      },
      key
    );
  }
  if (a.type === "arrange") {
    if (!a.rects || typeof a.rects !== "object") return s;
    let panels = s.panels;
    for (const [key, rect] of Object.entries(a.rects)) {
      const target = Object.hasOwn(s.panels, key) ? s.panels[key] : undefined;
      if (
        !target ||
        target.minimized ||
        target.pinned ||
        s.maximized === key ||
        !validRect(rect) ||
        (equalRect(target.rect, rect) && target.placement === "auto")
      )
        continue;
      if (panels === s.panels) panels = { ...s.panels };
      panels[key] = { ...target, rect: { ...rect }, placement: "auto" };
    }
    return panels === s.panels ? s : { ...s, panels };
  }
  if (a.type === "deselect")
    return s.selected === null ? s : { ...s, selected: null };
  const panel = Object.hasOwn(s.panels, a.key) ? s.panels[a.key] : undefined;
  if (
    !panel ||
    !positiveInteger(a.generation) ||
    panel.generation !== a.generation
  )
    return s;
  switch (a.type) {
    case "geometry":
      if (
        a.expectedRect !== undefined &&
        (!validRect(a.expectedRect) || !equalRect(panel.rect, a.expectedRect))
      )
        return s;
      if (
        (a.source !== "human" && a.source !== "commander") ||
        panel.minimized ||
        s.maximized === a.key ||
        (panel.pinned && a.source === "commander") ||
        !validRect(a.rect)
      )
        return s;
      return {
        ...s,
        panels: {
          ...s.panels,
          [a.key]: {
            ...panel,
            rect: { ...a.rect },
            // A human move opts the panel out of auto-tiling until an explicit
            // Arrange; a commander move leaves its placement as-is.
            ...(a.source === "human" ? { placement: "manual" as const } : {}),
          },
        },
      };
    case "pin":
      if (typeof a.value !== "boolean") return s;
      return {
        ...s,
        panels: { ...s.panels, [a.key]: { ...panel, pinned: a.value } },
      };
    case "focus":
      return panel.minimized ? s : foreground(s, a.key);
    case "maximize": {
      const next = foreground(
        {
          ...s,
          panels: { ...s.panels, [a.key]: { ...panel, minimized: false } },
        },
        a.key
      );
      return { ...next, maximized: a.key };
    }
    case "restore": {
      const next = foreground(
        {
          ...s,
          panels: { ...s.panels, [a.key]: { ...panel, minimized: false } },
        },
        a.key
      );
      return { ...next, maximized: null };
    }
    case "minimize": {
      const next: State = {
        ...s,
        panels: { ...s.panels, [a.key]: { ...panel, minimized: true } },
        maximized: s.maximized === a.key ? null : s.maximized,
      };
      return {
        ...next,
        selected: s.selected === a.key ? null : s.selected,
      };
    }
    case "close": {
      const panels = { ...s.panels };
      delete panels[a.key];
      const next: State = {
        ...s,
        panels,
        order: s.order.filter((k) => k !== a.key),
        maximized: s.maximized === a.key ? null : s.maximized,
      };
      return {
        ...next,
        selected: s.selected === a.key ? null : s.selected,
      };
    }
  }
  return s;
}

export type Viewport = { x: number; y: number; zoom: number };
export type Bounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};
function validateView(view: Viewport, usable: Bounds): void {
  if (
    ![
      view.x,
      view.y,
      view.zoom,
      usable.left,
      usable.top,
      usable.width,
      usable.height,
    ].every(Number.isFinite) ||
    view.zoom < 0.25 ||
    view.zoom > 2 ||
    usable.width <= 0 ||
    usable.height <= 0
  )
    throw new RangeError("Unavailable or invalid canvas viewport");
}
export function displayRect(
  panel: Panel,
  state: State,
  view: Viewport,
  usable: Bounds,
  restoredView?: Viewport
): Rect {
  validateView(view, usable);
  if (state.maximized !== panel.key) {
    if (!restoredView) return panel.rect;
    validateView(restoredView, usable);
    // Fit only restored preferred dimensions, in the saved camera's scale.
    // Subsequent camera zoom/pan must still transform the fitted panel normally.
    const width = Math.min(panel.rect.width, usable.width / restoredView.zoom);
    const height = Math.min(panel.rect.height, usable.height / restoredView.zoom);
    return {...panel.rect, width, height,
      x: width < panel.rect.width ? (usable.left - restoredView.x) / restoredView.zoom : panel.rect.x,
      y: height < panel.rect.height ? (usable.top - restoredView.y) / restoredView.zoom : panel.rect.y};
  }
  return {
    x: (usable.left - view.x) / view.zoom,
    y: (usable.top - view.y) / view.zoom,
    width: usable.width / view.zoom,
    height: usable.height / view.zoom,
  };
}
export type SizePolicy = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};
export function openingRect(
  policy: SizePolicy,
  usable: Bounds,
  view: Viewport,
  ordinal: number
): Rect {
  validateView(view, usable);
  if (
    ![policy.width, policy.height, policy.minWidth, policy.minHeight].every(
      (n) => Number.isFinite(n) && n > 0
    ) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  )
    throw new RangeError("Invalid opening policy");
  // Desired sizes are CSS pixels at the current zoom, converted to canvas units once.
  const width = Math.min(policy.width, usable.width);
  const height = Math.min(policy.height, usable.height);
  const dx = Math.min(
    (ordinal % 4) * 20,
    Math.max(0, (usable.width - width) / 2)
  );
  const dy = Math.min(
    (ordinal % 4) * 20,
    Math.max(0, (usable.height - height) / 2)
  );
  return {
    x: (usable.left + (usable.width - width) / 2 + dx - view.x) / view.zoom,
    y: (usable.top + (usable.height - height) / 2 + dy - view.y) / view.zoom,
    width: width / view.zoom,
    height: height / view.zoom,
  };
}

export type TilePolicy = {
  minWidth: number;
  minHeight: number;
  /** Optional preferred cap: tiles never grow past this, so a lone panel stays a
   * normal size and the grid centers in leftover space instead of ballooning. */
  maxWidth?: number;
  maxHeight?: number;
  gap: number;
};
/**
 * Pure tiling: place `order` into a responsive, non-overlapping grid within
 * `usable`. Grid shape is aspect-aware (wide canvases get more columns); tiles
 * clamp between the readable minimum and the optional preferred maximum, and the
 * grid is centered in leftover space. When tiles hit the minimum and still do not
 * fit, the grid overflows the viewport (reachable by panning) rather than
 * shrinking into unusable slivers. Screen-space geometry is converted to canvas
 * units the same way `openingRect` does, so tiling is correct at any zoom. The
 * caller filters to the arrangeable set (auto, non-pinned, non-minimized); this
 * function tiles exactly the keys it is given. `avoid` holds occupied rectangles
 * (e.g. pinned panels, in canvas units) the grid routes around: a colliding cell
 * is skipped and the grid grows downward, so free panels never land under a pin.
 */
export function arrangeLayout(
  order: string[],
  usable: Bounds,
  view: Viewport,
  policy: TilePolicy,
  avoid: Rect[] = []
): Record<string, Rect> {
  validateView(view, usable);
  const maxWidth = policy.maxWidth ?? Infinity;
  const maxHeight = policy.maxHeight ?? Infinity;
  if (
    ![policy.minWidth, policy.minHeight, policy.gap].every(Number.isFinite) ||
    policy.minWidth <= 0 ||
    policy.minHeight <= 0 ||
    policy.gap < 0 ||
    !(maxWidth >= policy.minWidth) ||
    !(maxHeight >= policy.minHeight)
  )
    throw new RangeError("Invalid tile policy");
  const count = order.length;
  if (count === 0) return {};
  const clamp = (value: number, low: number, high: number) =>
    Math.min(Math.max(value, low), high);
  const cols = Math.min(
    Math.max(Math.round(Math.sqrt((count * usable.width) / usable.height)), 1),
    count
  );
  const rows = Math.ceil(count / cols);
  const tileWidth = clamp(
    (usable.width - policy.gap * (cols + 1)) / cols,
    policy.minWidth,
    maxWidth
  );
  const tileHeight = clamp(
    (usable.height - policy.gap * (rows + 1)) / rows,
    policy.minHeight,
    maxHeight
  );
  const gridWidth = cols * tileWidth + policy.gap * (cols + 1);
  const gridHeight = rows * tileHeight + policy.gap * (rows + 1);
  const offsetX = Math.max(0, (usable.width - gridWidth) / 2);
  const offsetY = Math.max(0, (usable.height - gridHeight) / 2);
  const cellRect = (cell: number): Rect => {
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const screenX =
      usable.left + offsetX + policy.gap + col * (tileWidth + policy.gap);
    const screenY =
      usable.top + offsetY + policy.gap + row * (tileHeight + policy.gap);
    return {
      x: (screenX - view.x) / view.zoom,
      y: (screenY - view.y) / view.zoom,
      width: tileWidth / view.zoom,
      height: tileHeight / view.zoom,
    };
  };
  const hits = (rect: Rect) =>
    avoid.some(
      (a) =>
        rect.x < a.x + a.width &&
        a.x < rect.x + rect.width &&
        rect.y < a.y + a.height &&
        a.y < rect.y + rect.height
    );
  const result: Record<string, Rect> = {};
  const guard = order.length + (avoid.length + 1) * cols + 64;
  let cell = 0;
  for (const key of order) {
    let rect = cellRect(cell);
    for (let tries = 0; hits(rect) && tries < guard; tries++)
      rect = cellRect(++cell);
    result[key] = rect;
    cell++;
  }
  return result;
}

export const positiveInteger = (n: number): boolean =>
  Number.isSafeInteger(n) && n > 0;
export const equalRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const allocatable = (n: number): boolean =>
  positiveInteger(n) && n < Number.MAX_SAFE_INTEGER;
const nonempty = (s: unknown): s is string =>
  typeof s === "string" && s.trim().length > 0;
export const validScope = (s: Scope): boolean =>
  !!s &&
  nonempty(s.companyId) &&
  nonempty(s.userId) &&
  nonempty(s.conversationId);
export const sameScope = (a: Scope, b: Scope): boolean =>
  validScope(a) &&
  validScope(b) &&
  a.companyId === b.companyId &&
  a.userId === b.userId &&
  a.conversationId === b.conversationId;
export const validRef = (r: Ref, scope: Scope): boolean =>
  !!r &&
  r.companyId === scope.companyId &&
  ["task", "artifact", "browser"].includes(r.kind) &&
  nonempty(r.id) &&
  (r.version === undefined || nonempty(r.version));

export {
  hydrateLayout,
  viewportFromLayout,
  reconcileOpeningAck,
} from "./panel-layout";
export type {
  AuthorizedLayoutSnapshot,
  PendingOpen,
  OpeningAck,
} from "./panel-layout";
