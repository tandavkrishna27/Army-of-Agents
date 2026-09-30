import type { Rect, Ref } from "./panel-state";
export type ResizeLimits = {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
};
export function resizeLimits(
  kind: Ref["kind"],
  zoom: number,
  usable: { width: number; height: number }
): ResizeLimits {
  const maxWidth = Math.max(1, Math.min(8192, usable.width / zoom));
  const maxHeight = Math.max(1, Math.min(8192, usable.height / zoom));
  return {
    minWidth: Math.min(maxWidth, (kind === "browser" ? 400 : 320) / zoom),
    minHeight: Math.min(maxHeight, 240 / zoom),
    maxWidth,
    maxHeight,
  };
}
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
export function keyboardRect(
  rect: Rect,
  key: string,
  resize: boolean,
  zoom: number,
  limits: ResizeLimits
): Rect | null {
  const direction = (
    {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    } as Record<string, number[]>
  )[key];
  if (!direction || !Number.isFinite(zoom) || zoom < 0.25 || zoom > 2)
    return null;
  const [dx, dy] = direction.map((n) => (n * 10) / zoom);
  return resize
    ? {
        ...rect,
        width: clamp(rect.width + dx, limits.minWidth, limits.maxWidth),
        height: clamp(rect.height + dy, limits.minHeight, limits.maxHeight),
      }
    : {
        ...rect,
        x: clamp(rect.x + dx, -1e6, 1e6),
        y: clamp(rect.y + dy, -1e6, 1e6),
      };
}
