import type { MemoryItemVersionStatus } from "../constants.js";

export interface MemoryItemVersion {
  id: string;
  memoryItemId: string;
  versionNumber: number;
  content: string;
  status: MemoryItemVersionStatus;
  createdBy: string;
  createdAt: Date;
}

export interface PendingMemoryVersionReview {
  itemId: string;
  itemTitle: string;
  itemLayer: string | null;
  itemCategory: string;
  itemSource: string;
  currentContent: string;
  currentVersionId: string | null;
  version: MemoryItemVersion;
}
