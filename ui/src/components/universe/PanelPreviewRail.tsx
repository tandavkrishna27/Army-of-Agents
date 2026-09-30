import { useEffect, useRef, useState } from "react";
import type { Rect, Viewport } from "./panel-state";

export function isPanelOutOfView(rect: Rect, viewport: Viewport, bounds: { width: number; height: number }) {
  const left = rect.x * viewport.zoom + viewport.x;
  const top = rect.y * viewport.zoom + viewport.y;
  const right = left + rect.width * viewport.zoom;
  const bottom = top + rect.height * viewport.zoom;
  return right <= 0 || bottom <= 0 || left >= bounds.width || top >= bounds.height;
}

export interface PanelPreviewRailItem {
  key: string;
  title: string;
  kind: string;
  minimized: boolean;
}

export function PanelPreviewRail({ panels, onOpen }: {
  panels: PanelPreviewRailItem[];
  onOpen: (key: string) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  useEffect(() => () => clear(), []);
  if (!panels.length) return null;
  const show = (key: string, delayed: boolean) => {
    clear();
    if (delayed) openTimer.current = setTimeout(() => setPreview(key), 180);
    else setPreview(key);
  };
  const scheduleClose = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setPreview(null), 120);
  };
  const active = panels.find(item => item.key === preview);
  return <aside className="universe-preview-rail" aria-label="Tucked panels">
    <div className="universe-preview-rail-items">
      {panels.map(item => <button key={item.key} type="button" aria-label={`Preview ${item.title}`}
        onPointerEnter={() => show(item.key, true)} onPointerLeave={scheduleClose}
        onFocus={() => show(item.key, false)} onBlur={scheduleClose}
        onClick={() => onOpen(item.key)}><span>{item.title.slice(0, 1).toUpperCase()}</span></button>)}
    </div>
    {active && <div role="dialog" aria-label={`${active.title} preview`} className="universe-preview-card"
      onPointerEnter={() => show(active.key, false)} onPointerLeave={scheduleClose}>
      <div className="universe-preview-card-thumb" aria-hidden><i/><i/><i/></div>
      <strong>{active.title}</strong><span>{active.kind}{active.minimized ? " · minimized" : ""}</span>
      <button type="button" onClick={() => onOpen(active.key)} aria-label={`Open ${active.title}`}>Open</button>
    </div>}
  </aside>;
}
