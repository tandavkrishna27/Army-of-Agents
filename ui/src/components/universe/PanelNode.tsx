import type { CSSProperties, Dispatch, ReactNode } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { PanelFrame } from "./PanelFrame";
import { keyboardRect, type ResizeLimits } from "./panel-gestures";
import type { Action, Panel } from "./panel-state";
export type PanelNodeData = Record<string, unknown> & {
  panel: Panel;
  selected: boolean;
  maximized: boolean;
  limits: ResizeLimits;
  zoom: number;
  dispatch: Dispatch<Action>;
  headerReady: (panel: Panel, header: HTMLElement) => boolean;
  gestureDispatch: Dispatch<Action>;
  content: ReactNode;
  shielded: boolean;
  referenceHighlighted: boolean;
  beginGesture: (panel: Panel) => void;
  endGesture: () => void;
};
export type PanelFlowNode = Node<PanelNodeData, "universe-panel">;
export function PanelNode({ data }: NodeProps<PanelFlowNode>) {
  const { panel, dispatch } = data;
  const geometry = (
    _event: unknown,
    rect: { x: number; y: number; width: number; height: number }
  ) =>
    data.gestureDispatch({
      type: "geometry",
      key: panel.key,
      generation: panel.generation,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      source: "human",
    });
  return (
    <>
      {!panel.minimized && !data.maximized && (
        <NodeResizer
          {...data.limits}
          autoScale={false}
          handleStyle={
            {
              "--universe-hit-size": `${8 / data.zoom}px`,
              "--universe-touch-hit-size": `${24 / data.zoom}px`,
            } as CSSProperties
          }
          lineStyle={
            {
              "--universe-hit-size": `${8 / data.zoom}px`,
              "--universe-touch-hit-size": `${24 / data.zoom}px`,
            } as CSSProperties
          }
          handleClassName="universe-resize-corner"
          lineClassName="universe-resize-edge"
          onResizeStart={() => data.beginGesture(panel)}
          onResize={geometry}
          onResizeEnd={(event, rect) => {
            geometry(event, rect);
            data.endGesture();
          }}
        />
      )}
      <PanelFrame
        key={`${panel.key}:${panel.generation}`}
        panel={panel}
        selected={data.selected}
        maximized={data.maximized}
        dispatch={dispatch}
        shielded={data.shielded}
        referenceHighlighted={data.referenceHighlighted}
        onHeaderReady={(header) => data.headerReady(panel, header)}
        onHeaderKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            !event.altKey ||
            panel.minimized ||
            data.maximized
          )
            return;
          const rect = keyboardRect(
            panel.rect,
            event.key,
            event.shiftKey,
            data.zoom,
            data.limits
          );
          if (!rect) return;
          event.preventDefault();
          data.beginGesture(panel);
          geometry(event, rect);
          data.endGesture();
        }}
      >
        {data.content}
      </PanelFrame>
    </>
  );
}
