export const VIEWER_CONTROL_LEVELS = ["manual", "own_output", "full"] as const;
export type ViewerControlLevel = (typeof VIEWER_CONTROL_LEVELS)[number];
export const DEFAULT_VIEWER_CONTROL_LEVEL: ViewerControlLevel = "own_output";
export function isViewerControlLevel(v: unknown): v is ViewerControlLevel {
  return typeof v === "string" && (VIEWER_CONTROL_LEVELS as readonly string[]).includes(v);
}
