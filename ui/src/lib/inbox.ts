const COLLAPSED_KEY = "aoa:inbox:collapsed:set";

/** Read the set of collapsed parent-issue IDs from localStorage. */
export function getCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

/** Toggle a parent ID's collapsed state and persist; returns the new set. */
export function toggleCollapsed(parentId: string): Set<string> {
  const set = getCollapsedSet();
  if (set.has(parentId)) {
    set.delete(parentId);
  } else {
    set.add(parentId);
  }
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
  return set;
}

/** Compute the visible ordered list of issue IDs given a parent-grouped tree. */
export function computeVisibleOrderedIds(
  topLevel: Array<{ id: string }>,
  childrenByParent: Map<string, Array<{ id: string }>>,
  collapsed: Set<string>,
): string[] {
  const out: string[] = [];
  for (const parent of topLevel) {
    out.push(parent.id);
    if (!collapsed.has(parent.id)) {
      const children = childrenByParent.get(parent.id) ?? [];
      for (const child of children) out.push(child.id);
    }
  }
  return out;
}
