import type { Rect, Viewport } from "./panel-state";

export type ScreenRect = { left: number; top: number; width: number; height: number };
export type NavigationIntent = {
  id: string;
  panelKey: string;
  generation: number;
  cause: "user-reference" | "commander-reference" | "background";
  highlight: boolean;
};

export function visibleWorld(rect: ScreenRect, camera: Viewport) {
  if (![rect.left, rect.top, rect.width, rect.height, camera.x, camera.y, camera.zoom].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || camera.zoom <= 0) return null;
  return {
    x: (rect.left - camera.x) / camera.zoom,
    y: (rect.top - camera.y) / camera.zoom,
    width: rect.width / camera.zoom,
    height: rect.height / camera.zoom,
  };
}

export function readableCamera(usable: ScreenRect, target: Rect): Viewport | null {
  if (!visibleWorld(usable, { x: 0, y: 0, zoom: 1 }) ||
    ![target.x, target.y, target.width, target.height].every(Number.isFinite) ||
    target.width <= 0 || target.height <= 0) return null;
  const padding = 32;
  const zoom = Math.max(0.25, Math.min(1, usable.width / (target.width + padding * 2), usable.height / (target.height + padding * 2)));
  return {
    x: usable.left + (usable.width - target.width * zoom) / 2 - target.x * zoom,
    y: usable.top + (usable.height - target.height * zoom) / 2 - target.y * zoom,
    zoom,
  };
}

export function targetIsEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable='true']");
}
