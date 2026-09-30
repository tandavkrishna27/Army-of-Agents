export type MemoryTabKind = "home" | "memory_item" | "asset" | "graph" | "open" | "collection";

export const MEMORY_HOME_TAB: MemoryTab = {
  id: "memory-home",
  kind: "home",
  title: "Memory Home",
};

export const MEMORY_BRAIN_TAB: MemoryTab = {
  id: "company-graph",
  kind: "graph",
  title: "Map",
};

export const MEMORY_OPEN_TAB: MemoryTab = {
  id: "memory-open",
  kind: "open",
  title: "Open",
};

export const MEMORY_RECENT_TAB: MemoryTab = {
  id: "recent",
  kind: "collection",
  title: "Recent",
};

export const MEMORY_UNLINKED_TAB: MemoryTab = {
  id: "unlinked",
  kind: "collection",
  title: "Unlinked",
};

export const MEMORY_REVIEW_QUEUE_TAB: MemoryTab = {
  id: "review-queue",
  kind: "collection",
  title: "Review Queue",
};

export interface MemoryTab {
  id: string;
  kind: MemoryTabKind;
  title: string;
}

/**
 * Composite key identifying a tab. Two tabs with the same `id` but different
 * `kind` (e.g. a memory item and an asset that share a UUID by coincidence)
 * are distinct, so the active-tab reference must carry both fields.
 */
export interface TabKey {
  id: string;
  kind: MemoryTabKind;
}

export interface TabsState {
  tabs: MemoryTab[];
  activeKey: TabKey | null;
}

/** Two tabs are equal when both id AND kind match. */
function sameKey(a: TabKey, b: TabKey): boolean {
  return a.id === b.id && a.kind === b.kind;
}

function toKey(tab: MemoryTab): TabKey {
  return { id: tab.id, kind: tab.kind };
}

/**
 * Open-or-activate: if a tab matching {id, kind} already exists, mark it
 * active. Otherwise append a new tab and mark IT active.
 */
export function openOrActivate(state: TabsState, tab: MemoryTab): TabsState {
  const existing = state.tabs.findIndex((t) => sameKey(toKey(t), toKey(tab)));
  if (existing >= 0) {
    return { ...state, activeKey: toKey(state.tabs[existing]) };
  }
  return { tabs: [...state.tabs, tab], activeKey: toKey(tab) };
}

/**
 * Close a tab. If the closed tab was active, activate the previous tab in the
 * list (or the new first tab if the closed one was the first). When the last
 * tab closes, activeKey becomes null. Returns the same state reference when
 * the (id, kind) doesn't match any open tab.
 */
export function closeTab(
  state: TabsState,
  id: string,
  kind: MemoryTabKind,
): TabsState {
  const idx = state.tabs.findIndex((t) => sameKey(toKey(t), { id, kind }));
  if (idx < 0) return state;

  const tabs = state.tabs.filter((_, i) => i !== idx);

  const wasActive =
    state.activeKey != null && sameKey(state.activeKey, { id, kind });
  if (!wasActive) {
    // Reuse the same activeKey reference when the close doesn't affect it.
    return { tabs, activeKey: state.activeKey };
  }

  if (tabs.length === 0) return { tabs, activeKey: null };

  // Activate the previous tab (or the new first tab if we removed index 0).
  const newActiveIndex = idx > 0 ? idx - 1 : 0;
  return { tabs, activeKey: toKey(tabs[newActiveIndex]) };
}
