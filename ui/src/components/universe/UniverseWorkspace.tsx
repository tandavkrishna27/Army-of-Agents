import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { PanelNode, type PanelFlowNode } from "./PanelNode";
import {
  arrangeLayout,
  displayRect,
  equalRect,
  hydrateLayout,
  reconcileOpeningAck,
  type OpeningAck,
  type PendingOpen,
  initialState,
  openingRect,
  panelKey,
  panelReducer,
  validRef,
  viewportFromLayout,
  type Action,
  type AuthorizedLayoutSnapshot,
  type Panel,
  type Ref,
  type Scope,
  type State,
  type SizePolicy,
  type TilePolicy,
  type Viewport,
} from "./panel-state";
import {
  commitGesture,
  initialHistory,
  redoGeometry,
  scopeKey,
  undoGeometry,
  type GestureEntry,
} from "./panel-history";
import { resizeLimits } from "./panel-gestures";
import { readableCamera, targetIsEditable, type NavigationIntent } from "./viewport-controller";
import { resolveMotionTokens, type MotionMode } from "./motion-tokens";
import "@xyflow/react/dist/style.css";
import "./universe-panels.css";

export type ContentEntry = {
  ref: Ref;
  title: string;
  render: (onClose: () => void) => ReactNode;
};
export type WorkspaceProps = {
  scope: Scope;
  initialLayout: AuthorizedLayoutSnapshot;
  content: Record<string, ContentEntry>;
  /** Resolve restored references through an authorization-enforcing content boundary. */
  resolveContent?: (panel: Panel) => ContentEntry | undefined;
  onStateChange?: (state: State) => void;
  /** Read-only projection, including hydration; never a persistence signal. */
  onStateObserved?: (state: State) => void;
  /** Accepted edits only: drag samples and cancelled gestures are not saves. */
  editsBlocked?: boolean;
  beforeViewportCommit?: (next: Viewport) => boolean;
  beforeStateCommit?: (before: State, after: State) => boolean;
  onStateCommit?: (before: State, after: State) => void;
  onInteractionEnd?: () => void;
  onViewportCommit?: (viewport: Viewport) => void;
  /** Read-only camera projection, including hydration; never a persistence signal. */
  onViewportObserved?: (viewport: Viewport) => void;
  /** When true, opening a panel re-tiles the auto (non-pinned, non-manual) set.
   * Defaults off so the frame's built-in behaviour stays cascade; the product
   * turns this on via the Universe preference. */
  initialAutoTile?: boolean;
  /** Enables the opt-in motion layer (glide on geometry change, fade on open).
   * Off by default; the product enables it, still respecting reduced motion. */
  motion?: boolean;
  motionMode?: MotionMode;
};
/** Commands require caller authorization. The reducer's source field is not an authorization grant. */
export type WorkspaceHandle = {
  dispatch: (action: Action) => void;
  open: (
    entry: Pick<ContentEntry, "ref" | "title">,
    policy?: SizePolicy
  ) => void;
  getState: () => State;
  isInteracting: () => boolean;
  hydrate: (snapshot: AuthorizedLayoutSnapshot) => void;
  refresh: (snapshot: AuthorizedLayoutSnapshot) => void;
  reconcile: (ack: OpeningAck, pending: PendingOpen[]) => void;
  getViewport: () => Viewport;
  setViewport: (viewport: Viewport) => void;
  undo: () => void;
  redo: () => void;
  /** Re-tile every non-pinned panel into the grid (manual panels rejoin). */
  arrange: () => void;
  /** Zoom/pan the camera to frame all visible panels. Changes no geometry. */
  fit: () => void;
  /** Toggle auto-tile-on-open; enabling it re-tiles immediately. */
  setAutoTile: (on: boolean) => void;
  requestNavigation: (intent: NavigationIntent) => "moved" | "deferred" | "ignored" | "stale";
};
const nodeTypes = { "universe-panel": PanelNode };
// Tiles never grow past the preferred size, so a lone panel opens at a normal
// size and the grid centers instead of ballooning; they shrink only to the
// readable minimum before the grid overflows and pans.
const TILE_POLICY: TilePolicy = {
  minWidth: 320,
  minHeight: 240,
  maxWidth: 520,
  maxHeight: 360,
  gap: 16,
};
const validViewport = (v: Viewport) =>
  [v.x, v.y, v.zoom].every(Number.isFinite) &&
  Math.abs(v.x) <= 1e6 &&
  Math.abs(v.y) <= 1e6 &&
  v.zoom >= 0.25 &&
  v.zoom <= 2;
function Content({
  entry,
  close,
}: {
  entry: ContentEntry | undefined;
  close: () => void;
}) {
  return entry ? (
    entry.render(close)
  ) : (
    <p role="status">Content is unavailable or still loading.</p>
  );
}

const ScopedWorkspace = forwardRef<WorkspaceHandle, WorkspaceProps>(
  function ScopedWorkspace(props, forwardedRef) {
    const [state, setState] = useState(() =>
      hydrateLayout(initialState(props.scope), props.initialLayout)
    );
    const current = useRef(state);
    const [viewport, setCamera] = useState(() =>
      viewportFromLayout(props.initialLayout)
    );
    const camera = useRef(viewport);
    const restoredLayout = useRef(props.initialLayout);
    const callbacks = useRef(props);
    callbacks.current = props;
    useEffect(() => {callbacks.current.onStateObserved?.(state);}, [state]);
    useEffect(() => {callbacks.current.onViewportObserved?.(viewport);}, [viewport]);
    const alive = useRef(true);
    const root = useRef<HTMLDivElement>(null);
    const recovery = useRef<HTMLDivElement>(null);
    const triggers = useRef(new Map<string, HTMLElement>());
    const pendingFocus = useRef<{ key: string; generation: number } | null>(
      null
    );
    const history = useRef(initialHistory(state.scope));
    const gesture = useRef<GestureEntry | null>(null);
    const cameraActive = useRef(false);
    const cameraStart = useRef<Viewport | null>(null);
    const serial = useRef(0);
    const [shielded, setShielded] = useState(false);
    const [referenceHighlight, setReferenceHighlight] = useState<string | null>(null);
    const [minimizeProxy, setMinimizeProxy] = useState<{title:string;x:number;y:number;width:number;height:number}|null>(null);
    const pendingNavigation = useRef<NavigationIntent | null>(null);
    const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cameraAnimation = useRef<number | null>(null);
    const flushNavigationRef = useRef<(() => void) | null>(null);
    const [autoTile, setAutoTileState] = useState(
      props.initialAutoTile ?? false
    );
    const autoTileRef = useRef(autoTile);
    autoTileRef.current = autoTile;
    const [usable, setUsable] = useState({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });

    const finishGesture = useCallback((cancelled = false, notify = true) => {
      const entry = gesture.current;
      gesture.current = null;
      if (!alive.current) return;
      setShielded(false);
      if (!entry) return;
      callbacks.current.onInteractionEnd?.();
      const panel = current.current.panels[entry.key];
      if (panel?.generation !== entry.generation) return;
      if (cancelled) {
        // Roll back only this gesture's last accepted rectangle; a concurrent edit wins.
        const next = panelReducer(current.current, {
          type: "geometry",
          key: entry.key,
          generation: entry.generation,
          rect: entry.before,
          expectedRect: entry.after,
          source: "human",
        });
        if (next !== current.current) {
          current.current = next;
          setState(next);
          if (notify) callbacks.current.onStateChange?.(structuredClone(next));
        }
        return;
      }
      // A synchronous observer may have superseded the last accepted sample.
      // Only a still-owned result can become human history or clear prior redo.
      if (equalRect(panel.rect, entry.after)) {
        if (!equalRect(entry.before, entry.after)) {
          const after = current.current;
          const before = {...after, panels: {...after.panels, [entry.key]: {...panel, rect: {...entry.before}}}};
          if (callbacks.current.beforeStateCommit?.(structuredClone(before), structuredClone(after)) === false) {
            current.current = before;
            setState(before);
            callbacks.current.onStateChange?.(structuredClone(before));
            return;
          }
          history.current = commitGesture(history.current, entry);
          callbacks.current.onStateCommit?.(structuredClone(before), structuredClone(after));
        }
      }
      queueMicrotask(() => flushNavigationRef.current?.());
    }, []);
    useEffect(() => {
      if (!props.editsBlocked) return;
      finishGesture(true);
      if (cameraActive.current) {
        if (cameraStart.current) {
          camera.current = {...cameraStart.current};
          setCamera({...camera.current});
        }
        cameraActive.current = false;
        cameraStart.current = null;
        callbacks.current.onInteractionEnd?.();
      }
    }, [props.editsBlocked, finishGesture]);
    const applyAction = useCallback(
      (action: Action, owner?: GestureEntry) => {
        if (!alive.current) return;
        const before = current.current;
        if (action.type === "minimize" && props.motion && props.motionMode !== "reduced") {
          const panel = before.panels[action.key];
          if (panel && panel.generation === action.generation) {
            setMinimizeProxy({title:panel.title,x:panel.rect.x*camera.current.zoom+camera.current.x,y:panel.rect.y*camera.current.zoom+camera.current.y,width:panel.rect.width*camera.current.zoom,height:panel.rect.height*camera.current.zoom});
            setTimeout(() => { if (alive.current) setMinimizeProxy(null); }, 240);
          }
        }
        const next = panelReducer(before, action);
        if (next === before) return;
        if (!owner && callbacks.current.beforeStateCommit?.(structuredClone(before), structuredClone(next)) === false) return;
        if (action.type === "open") {
          const element = document.activeElement;
          if (
            element instanceof HTMLElement &&
            !element.closest(".universe-panel")
          )
            triggers.current.set(panelKey(before.scope, action.ref), element);
          const key = panelKey(before.scope, action.ref);
          pendingFocus.current = {
            key,
            generation: next.panels[key].generation,
          };
        }
        if (action.type === "restore")
          pendingFocus.current = {
            key: action.key,
            generation: action.generation,
          };
        if (
          action.type === "close" ||
          action.type === "minimize" ||
          action.type === "focus"
        )
          pendingFocus.current = null;
        current.current = next;
        // Capture this accepted sample before an observer can issue another command.
        if (owner && owner === gesture.current && action.type === "geometry") {
          owner.after = { ...next.panels[action.key].rect };
        }
        setState(next);
        if (action.type === "minimize" || action.type === "close") {
          // Publish lifecycle and any rollback together, after both are accepted.
          finishGesture(true, false);
          const trigger = triggers.current.get(action.key);
          (trigger?.isConnected ? trigger : recovery.current)?.focus();
          if (action.type === "close") triggers.current.delete(action.key);
        }
        if (!owner && JSON.stringify(before) !== JSON.stringify(current.current))
          callbacks.current.onStateCommit?.(structuredClone(before), structuredClone(current.current));
        // A defensive snapshot prevents observers from mutating the sole registry.
        callbacks.current.onStateChange?.(structuredClone(current.current));
        // Auto-tile reflows the remaining panels when the visible set changes, so
        // closing/minimizing never leaves a hole and a lone survivor grows back to a
        // centered, full size (restore rejoins the grid). Arrange itself is exempt.
        if (
          (action.type === "close" ||
            action.type === "minimize" ||
            action.type === "restore") &&
          autoTileRef.current
        )
          retileRef.current?.("auto");
      },
      [finishGesture]
    );

    const dispatch = useCallback(
      (action: Action) => applyAction(action),
      [applyAction]
    );

    const beginGesture = useCallback(
      (panel: Panel) => {
        if (!alive.current || gesture.current) return;
        dispatch({
          type: "focus",
          key: panel.key,
          generation: panel.generation,
        });
        // Focus observers may issue commands too; capture the still-current incarnation.
        const actual = current.current.panels[panel.key];
        if (
          !alive.current ||
          gesture.current ||
          actual?.generation !== panel.generation ||
          actual.minimized ||
          current.current.maximized === panel.key
        )
          return;
        gesture.current = {
          scopeKey: scopeKey(current.current.scope),
          gestureId: String(++serial.current),
          key: panel.key,
          generation: panel.generation,
          before: { ...actual.rect },
          after: { ...actual.rect },
          source: "human",
        };
        setShielded(true);
      },
      [dispatch]
    );

    // Library callbacks are valid only while their captured incarnation owns a gesture.
    // Public dispatch remains independent for authorized external commands.
    const gestureDispatch = useCallback(
      (action: Action) => {
        const active = gesture.current;
        if (
          action.type !== "geometry" ||
          !active ||
          active.key !== action.key ||
          active.generation !== action.generation
        )
          return;
        applyAction(action, active);
      },
      [applyAction]
    );

    useLayoutEffect(() => {
      alive.current = true;
      const observer = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        if (
          Number.isFinite(width) &&
          Number.isFinite(height) &&
          width > 0 &&
          height > 0
        )
          setUsable({ left: 0, top: 0, width, height });
      });
      if (root.current) observer.observe(root.current);
      const release = () => finishGesture();
      const cancel = () => finishGesture(true);
      window.addEventListener("pointerup", release);
      window.addEventListener("mouseup", release);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
      window.addEventListener("lostpointercapture", cancel);
      return () => {
        alive.current = false;
        gesture.current = null;
        observer.disconnect();
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        if (cameraAnimation.current !== null) cancelAnimationFrame(cameraAnimation.current);
        window.removeEventListener("pointerup", release);
        window.removeEventListener("mouseup", release);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("blur", cancel);
        window.removeEventListener("lostpointercapture", cancel);
      };
    }, [finishGesture]);
    const headerReady = useCallback((panel: Panel, header: HTMLElement) => {
      const pending = pendingFocus.current;
      const actual = current.current.panels[panel.key];
      if (
        !alive.current ||
        !pending ||
        pending.key !== panel.key ||
        pending.generation !== panel.generation ||
        actual?.generation !== panel.generation ||
        actual.minimized ||
        current.current.selected !== panel.key
      )
        return true;
      if (
        !header.isConnected ||
        header.closest("[inert]") ||
        getComputedStyle(header).visibility === "hidden"
      )
        return false;
      header.focus({ preventScroll: true });
      // Consume only confirmed focus; wrapper attribute changes signal readiness.
      if (document.activeElement !== header) return false;
      pendingFocus.current = null;
      return true;
    }, []);
    const updateViewport = (next: Viewport, commit = false) => {
      if (!alive.current || current.current.maximized || !validViewport(next)) return;
      if (callbacks.current.editsBlocked || (commit && callbacks.current.beforeViewportCommit?.({...next}) === false)) {
        if (commit && cameraStart.current) {
          camera.current = {...cameraStart.current};
          setCamera({...camera.current});
        }
        return;
      }
      camera.current = { ...next };
      setCamera({ ...next });
      if (commit) callbacks.current.onViewportCommit?.({ ...next });
    };
    const performNavigation = (intent: NavigationIntent) => {
      if (intent.cause === "background") return "ignored" as const;
      const panel = current.current.panels[intent.panelKey];
      if (!panel || panel.generation !== intent.generation || panel.minimized) return "stale" as const;
      if (gesture.current || cameraActive.current || targetIsEditable(document.activeElement)) {
        pendingNavigation.current = intent;
        return "deferred" as const;
      }
      const next = readableCamera(usable, panel.rect);
      if (!next) return "deferred" as const;
      pendingNavigation.current = null;
      dispatch({ type: "focus", key: panel.key, generation: panel.generation });
      if (cameraAnimation.current !== null) cancelAnimationFrame(cameraAnimation.current);
      const reducedMotionQuery = typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : undefined;
      const osReduced = reducedMotionQuery?.matches === true;
      const tokens = resolveMotionTokens(props.motionMode ?? (props.motion ? "subtle" : "reduced"), osReduced);
      const finish = () => {
        cameraAnimation.current = null;
        updateViewport(next, true);
        const actual = current.current.panels[intent.panelKey];
        if (!intent.highlight || actual?.generation !== intent.generation) return;
        setReferenceHighlight(panel.key);
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = setTimeout(() => setReferenceHighlight(current => current === panel.key ? null : current), tokens.glow);
      };
      if (!tokens.camera) finish();
      else {
        const from = { ...camera.current };
        const started = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - started) / tokens.camera);
          const eased = 1 - (1 - progress) ** 3;
          updateViewport({x:from.x+(next.x-from.x)*eased,y:from.y+(next.y-from.y)*eased,zoom:from.zoom+(next.zoom-from.zoom)*eased});
          if (progress < 1) cameraAnimation.current = requestAnimationFrame(tick); else finish();
        };
        cameraAnimation.current = requestAnimationFrame(tick);
      }
      return "moved" as const;
    };
    flushNavigationRef.current = () => {
      const pending = pendingNavigation.current;
      if (pending) performNavigation(pending);
    };
    const retileRef = useRef<((mode: "auto" | "all") => void) | null>(null);
    const retile = (mode: "auto" | "all") => {
      if (!alive.current || usable.width <= 0 || usable.height <= 0) return;
      const s = current.current;
      if (s.maximized) return;
      const order = s.order.filter((key) => {
        const panel = s.panels[key];
        return (
          panel &&
          !panel.minimized &&
          !panel.pinned &&
          (mode === "all" || panel.placement !== "manual")
        );
      });
      if (order.length === 0) return;
      const avoid = s.order
        .filter((key) => s.panels[key].pinned && !s.panels[key].minimized)
        .map((key) => s.panels[key].rect);
      dispatch({
        type: "arrange",
        rects: arrangeLayout(order, usable, camera.current, TILE_POLICY, avoid),
      });
    };
    retileRef.current = retile;
    const fit = () => {
      if (!alive.current || usable.width <= 0 || usable.height <= 0) return;
      const s = current.current;
      if (s.maximized) return;
      const visible = s.order
        .map((key) => s.panels[key])
        .filter((panel): panel is Panel => !!panel && !panel.minimized);
      if (visible.length === 0) return;
      const pad = 24;
      const minX = Math.min(...visible.map((p) => p.rect.x)) - pad;
      const minY = Math.min(...visible.map((p) => p.rect.y)) - pad;
      const maxX =
        Math.max(...visible.map((p) => p.rect.x + p.rect.width)) + pad;
      const maxY =
        Math.max(...visible.map((p) => p.rect.y + p.rect.height)) + pad;
      const zoom = Math.max(
        0.25,
        Math.min(2, usable.width / (maxX - minX), usable.height / (maxY - minY))
      );
      updateViewport(
        {
          x:
            usable.left +
            (usable.width - (maxX - minX) * zoom) / 2 -
            minX * zoom,
          y:
            usable.top +
            (usable.height - (maxY - minY) * zoom) / 2 -
            minY * zoom,
          zoom,
        },
        true
      );
    };
    useImperativeHandle(forwardedRef, () => ({
      dispatch,
      open: (
        entry,
        policy = {
          width: 520,
          height: 360,
          minWidth: entry.ref.kind === "browser" ? 400 : 320,
          minHeight: 240,
        }
      ) => {
        if (!alive.current || usable.width <= 0 || usable.height <= 0) return;
        const existing =
          current.current.panels[panelKey(current.current.scope, entry.ref)];
        const rect =
          existing?.rect ??
          openingRect(
            policy,
            usable,
            camera.current,
            current.current.nextOpenedOrdinal
          );
        dispatch({ type: "open", ...entry, rect });
        if (autoTile) retile("auto");
      },
      getState: () => structuredClone(current.current),
      isInteracting: () => !!gesture.current || cameraActive.current,
      hydrate: snapshot => {
        if (!alive.current) return;
        restoredLayout.current = snapshot;
        const next = hydrateLayout(current.current, snapshot);
        gesture.current = null;
        cameraActive.current = false;
        setShielded(false);
        history.current = initialHistory(next.scope);
        pendingFocus.current = null;
        current.current = next;
        setState(next);
        camera.current = viewportFromLayout(snapshot);
        setCamera({...camera.current});
      },
      refresh: snapshot => {
        if (!alive.current || gesture.current || cameraActive.current) return;
        const previous = current.current;
        const next = hydrateLayout(previous, snapshot);
        // A canonical refresh is not a new opening. Keep renderer identity and
        // guarded Undo entries for surviving incarnations; a close/reopen gets
        // a new generation even when its canonical key is unchanged.
        for (const panel of Object.values(next.panels)) {
          const existing = previous.panels[panel.key];
          if (existing && existing.openedOrdinal === panel.openedOrdinal)
            panel.generation = existing.generation;
        }
        current.current = next;
        setState(next);
        camera.current = viewportFromLayout(snapshot);
        setCamera({...camera.current});
      },
      reconcile: (ack, pending) => {
        if (!alive.current) return;
        const next = reconcileOpeningAck(current.current, ack, pending);
        if (next !== current.current) {current.current = next; setState(next);}
      },
      getViewport: () => ({ ...camera.current }),
      setViewport: (next) => updateViewport(next, true),
      undo: () => replay("undo"),
      redo: () => replay("redo"),
      arrange: () => retile("all"),
      fit,
      setAutoTile: (on: boolean) => {
        setAutoTileState(on);
        if (on) retile("all");
      },
      requestNavigation: performNavigation,
    }));
    function replay(direction: "undo" | "redo") {
      if (!alive.current || gesture.current) return;
      const proposal = (direction === "undo" ? undoGeometry : redoGeometry)(
        current.current,
        history.current
      );
      if (!proposal.action) return;
      const before = current.current;
      dispatch(proposal.action);
      if (current.current !== before) history.current = proposal.history;
    }

    // Paint order (z-index) follows selection/stacking, but the rendered node order stays
    // stable across focus changes. React Flow stacks absolutely-positioned nodes by z-index
    // regardless of sibling order, so keeping the DOM order fixed means foregrounding a panel
    // never re-inserts its node mid-gesture and drops the pointer click landing on its header
    // controls. Only opening/closing (which changes the key set) alters the rendered order.
    const stacking = new Map(state.order.map((key, index) => [key, index]));
    const renderOrder = [...state.order].sort();
    const nodes: PanelFlowNode[] =
      usable.width && usable.height
        ? renderOrder.map((key) => {
            const panel = state.panels[key];
            const restored = restoredLayout.current.panels.find(p =>
              p.openedOrdinal === panel.openedOrdinal && panelKey(state.scope, p.ref) === key);
            // Explicit resizing replaces preferred dimensions; viewport fitting
            // alone never changes registry geometry or emits a persistence edit.
            const fitted = restored && restored.rect.width === panel.rect.width && restored.rect.height === panel.rect.height;
            const rect = displayRect(panel, state, viewport, usable,
              fitted ? viewportFromLayout(restoredLayout.current) : undefined);
            const entry = Object.hasOwn(props.content, key)
              ? props.content[key]
              : props.resolveContent?.(panel);
            const matchingEntry =
              entry &&
              validRef(entry.ref, state.scope) &&
              panelKey(state.scope, entry.ref) === key
                ? entry
                : undefined;
            return {
              id: key,
              type: "universe-panel",
              position: { x: rect.x, y: rect.y },
              selected: state.selected === key,
              width: rect.width,
              height: rect.height,
              zIndex: stacking.get(key) ?? 0,
              draggable: !panel.minimized && state.maximized === null,
              selectable: false,
              dragHandle: ".universe-drag-handle",
              style: {
                width: rect.width,
                height: rect.height,
                visibility: panel.minimized ? "hidden" : "visible",
                pointerEvents: panel.minimized ? "none" : "auto",
              },
              data: {
                panel,
                selected: state.selected === key,
                maximized: state.maximized === key,
                limits: resizeLimits(panel.ref.kind, viewport.zoom, usable),
                zoom: viewport.zoom,
                dispatch,
                headerReady,
                gestureDispatch,
                shielded,
                referenceHighlighted: referenceHighlight === key,
                beginGesture,
                endGesture: () => finishGesture(),
                content: (
                  <Content
                    key={`${key}:${panel.generation}`}
                    entry={matchingEntry}
                    close={() =>
                      dispatch({
                        type: "close",
                        key,
                        generation: panel.generation,
                      })
                    }
                  />
                ),
              },
            };
          })
        : [];
    const drag = (_event: unknown, node: PanelFlowNode) => {
      gestureDispatch({
        type: "geometry",
        key: node.id,
        generation: node.data.panel.generation,
        source: "human",
        rect: {
          ...node.data.panel.rect,
          x: node.position.x,
          y: node.position.y,
        },
      });
    };
    const maximized = state.maximized !== null;
    return (
      <div className="universe-workspace">
        {minimizeProxy && <div aria-hidden className="universe-minimize-proxy" style={{left:minimizeProxy.x,top:minimizeProxy.y,width:minimizeProxy.width,height:minimizeProxy.height}}><span>{minimizeProxy.title}</span></div>}
        <div
          className="universe-recovery"
          ref={recovery}
          role="group"
          aria-label="Workspace controls"
          tabIndex={-1}
        >
          <span>Workspace controls</span>
          {state.order
            .filter((key) => state.panels[key].minimized)
            .map((key) => (
              <button
                key={key}
                type="button"
                onClick={() =>
                  dispatch({
                    type: "restore",
                    key,
                    generation: state.panels[key].generation,
                  })
                }
              >
                Restore {state.panels[key].title}
              </button>
            ))}
        </div>
        <div
          className={`universe-canvas${props.motion ? " universe-motion" : ""}${
            shielded ? " universe-gesturing" : ""
          }`}
          ref={root}
          data-testid="universe-canvas"
          data-motion={props.motionMode ?? (props.motion ? "subtle" : "reduced")}
          onBlur={() => queueMicrotask(() => flushNavigationRef.current?.())}
        >
          {usable.width > 0 && usable.height > 0 && (
            <ReactFlow<PanelFlowNode>
              nodes={nodes}
              edges={[]}
              nodeTypes={nodeTypes}
              viewport={viewport}
              onViewportChange={(next) => updateViewport(next)}
              onMoveStart={event => {if (event instanceof Event) {pendingNavigation.current = null; if (cameraAnimation.current !== null) {cancelAnimationFrame(cameraAnimation.current); cameraAnimation.current=null;} setReferenceHighlight(null); cameraActive.current = true; cameraStart.current = {...camera.current};}}}
              onMoveEnd={(event, next) => {
                // Controlled viewport synchronization also emits a truthy { sync: true }
                // end event. A delayed native end can also predate a newer pan.
                // Completion commits only the live camera; it never replays old samples.
                if (
                  event instanceof Event && cameraActive.current &&
                  next.x === camera.current.x &&
                  next.y === camera.current.y &&
                  next.zoom === camera.current.zoom
                ) {
                  updateViewport(next, true);
                  cameraActive.current = false;
                  cameraStart.current = null;
                  callbacks.current.onInteractionEnd?.();
                }
              }}
              minZoom={0.25}
              maxZoom={2}
              nodeDragThreshold={0}
              onNodesChange={() => {}}
              onPaneClick={() => dispatch({ type: "deselect" })}
              onNodeDragStart={(_event, node) => beginGesture(node.data.panel)}
              onNodeDrag={drag}
              onNodeDragStop={(event, node) => {
                drag(event, node);
                finishGesture();
              }}
              nodesConnectable={false}
              nodesFocusable={false}
              panActivationKeyCode={null}
              zoomActivationKeyCode={null}
              elementsSelectable={false}
              elevateNodesOnSelect={false}
              selectionOnDrag={false}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              deleteKeyCode={null}
              panOnDrag={!maximized && !props.editsBlocked}
              panOnScroll={!maximized && !props.editsBlocked}
              zoomOnScroll={!maximized && !props.editsBlocked}
              zoomOnPinch={!maximized && !props.editsBlocked}
              zoomOnDoubleClick={false}
              autoPanOnNodeDrag={!maximized}
              autoPanOnNodeFocus={false}
              preventScrolling={!maximized}
            />
          )}
        </div>
      </div>
    );
  }
);
export const UniverseWorkspace = forwardRef<WorkspaceHandle, WorkspaceProps>(
  function UniverseWorkspace(props, ref) {
    return (
      <ReactFlowProvider key={scopeKey(props.scope)}>
        <ScopedWorkspace {...props} ref={ref} />
      </ReactFlowProvider>
    );
  }
);
