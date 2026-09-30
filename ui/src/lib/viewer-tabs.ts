/**
 * Generic tab-collection helpers shared by tabbed viewers (thread viewer, hub viewer).
 *
 * These are PURE array operations only. Active-key re-selection is intentionally
 * NOT shared here — each hook re-activates a different tab after a close
 * (threads → next[0], hub → next.at(-1)), so that logic stays per-hook.
 */
export interface ViewerTabBase {
  key: string;
  closeable: boolean;
}

/** Append `tab` unless a tab with the same key already exists (dedupe by key). */
export function ensureTab<T extends ViewerTabBase>(tabs: T[], tab: T): T[] {
  return tabs.some((existing) => existing.key === tab.key) ? tabs : [...tabs, tab];
}

/** Remove the tab with `key`, but refuse to remove non-closeable tabs. */
export function closeTab<T extends ViewerTabBase>(tabs: T[], key: string): T[] {
  return tabs.filter((tab) => tab.key !== key || !tab.closeable);
}
