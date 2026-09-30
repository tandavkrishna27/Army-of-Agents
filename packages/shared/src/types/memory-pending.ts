import type { MemoryItem } from "./memory.js";
import type { PendingMemoryVersionReview } from "./memory-version.js";
import type { Suggestion } from "./suggestion.js";

export interface PendingMemoryArchiveReview {
  item: MemoryItem;
  suggestion: Suggestion;
}

export interface PendingMemoryQueue {
  items: MemoryItem[];
  versions: PendingMemoryVersionReview[];
  archives: PendingMemoryArchiveReview[];
  totalCount: number;
}
