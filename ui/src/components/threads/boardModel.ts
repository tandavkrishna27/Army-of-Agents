import type { ThreadListItem } from "../../api/threads";

export interface BoardColumn {
  phase: string;
  threads: ThreadListItem[];
}

export function groupThreadsForBoard(threads: ThreadListItem[]): Record<string, ThreadListItem[]> {
  const groups: Record<string, ThreadListItem[]> = {
    discuss: [],
    scope: [],
    assign: [],
    done: [],
  };
  for (const t of threads) {
    if (t.phase && groups[t.phase]) {
      groups[t.phase].push(t);
    }
  }
  return groups;
}
