import {
  Component,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { Pin, PinOff, Maximize2, Minimize2, Minus, X } from "lucide-react";
import type { Action, Panel } from "./panel-state";

class ContentBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="status">
        This view is unavailable. You can close and reopen it.
      </p>
    ) : (
      this.props.children
    );
  }
}
export type PanelFrameProps = {
  panel: Panel;
  selected: boolean;
  maximized: boolean;
  dispatch: Dispatch<Action>;
  children: ReactNode;
  onHeaderKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  shielded: boolean;
  referenceHighlighted?: boolean;
  onHeaderReady?: (header: HTMLElement) => boolean;
};
export function PanelFrame({
  panel,
  selected,
  maximized,
  dispatch,
  children,
  onHeaderKeyDown,
  shielded,
  referenceHighlighted,
  onHeaderReady,
}: PanelFrameProps) {
  const header = useRef<HTMLElement>(null);
  // React Flow installs controlled nodes in its own commit. Signal readiness from
  // the actual child after inert/visibility and initial measurement have updated.
  useLayoutEffect(() => {
    const element = header.current;
    if (panel.minimized || !element || !onHeaderReady) return;
    const wrapper = element.closest(".react-flow__node");
    const observer = new MutationObserver(() => {
      if (onHeaderReady(element)) observer.disconnect();
    });
    if (wrapper)
      observer.observe(wrapper, {
        attributes: true,
        subtree: true,
        attributeFilter: ["style", "inert"],
      });
    if (onHeaderReady(element)) observer.disconnect();
    return () => observer.disconnect();
  });
  const act = (type: "focus" | "minimize" | "restore" | "maximize" | "close") =>
    dispatch({ type, key: panel.key, generation: panel.generation });
  return (
    <section
      className="universe-panel"
      data-selected={selected}
      data-panel-key={panel.key}
      data-generation={panel.generation}
      data-reference-highlight={referenceHighlighted || undefined}
      aria-label={panel.title}
      inert={panel.minimized}
      onPointerDownCapture={(event) => {
        // Selecting on pointer-down is for body/header interaction; a control
        // button (close/minimize/maximize/pin) must not flash the panel to the
        // selected state on its way to acting.
        if (!(event.target as HTMLElement).closest(".universe-panel-actions"))
          act("focus");
      }}
    >
      <header
        ref={header}
        className="universe-drag-handle"
        tabIndex={0}
        aria-label={`${panel.title} panel controls`}
        onKeyDown={onHeaderKeyDown}
      >
        <span className="universe-panel-title">{panel.title}</span>
        <div className="nodrag nopan universe-panel-actions">
          <button
            type="button"
            aria-label={panel.pinned ? "Unpin panel" : "Pin panel"}
            aria-pressed={panel.pinned}
            onClick={() =>
              dispatch({
                type: "pin",
                key: panel.key,
                generation: panel.generation,
                value: !panel.pinned,
              })
            }
          >
            {panel.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          <button
            type="button"
            aria-label={maximized ? "Restore panel" : "Maximize panel"}
            onClick={() => act(maximized ? "restore" : "maximize")}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            aria-label="Minimize panel"
            onClick={() => act("minimize")}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            aria-label="Close panel"
            onClick={() => act("close")}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="nodrag nopan nowheel universe-panel-body">
        <ContentBoundary>{children}</ContentBoundary>
      </div>
      {shielded && (
        <div
          className="universe-iframe-shield nodrag nopan"
          data-testid="iframe-shield"
        />
      )}
    </section>
  );
}
