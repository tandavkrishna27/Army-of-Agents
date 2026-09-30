import type {
  MemoryItemCategory,
  MemoryItemSource,
  MemoryItemStatus,
  MemoryItemLayer,
  MemoryItemVisibility,
} from "../constants.js";

/**
 * Per-item embedding index status (Task W5).
 *
 * - "indexed"     — a stored vector is present (wins regardless of key/queue state)
 * - "pending"     — embedding_queue row is pending or processing
 * - "failed"      — embedding_queue row is failed (no stored vector)
 * - "not_indexed" — no vector and no active queue row
 */
export type MemoryIndexStatus = "indexed" | "pending" | "failed" | "not_indexed";

export interface MemoryItem {
  id: string;
  companyId: string;
  title: string;
  content: string;
  category: MemoryItemCategory;
  source: MemoryItemSource;
  status: MemoryItemStatus;
  tags: string[] | null;
  departmentId: string | null;
  projectId: string | null;
  createdBy: string;
  // Extended memory fields.
  layer: MemoryItemLayer | null;
  priority: number;
  visibility: MemoryItemVisibility;
  expiresAt: Date | null;
  goalId: string | null;
  taskId: string | null;
  sourceArtifactId: string | null;
  sourceContext: string | null;
  accessedAt: Date | null;
  currentVersionId: string | null;
  embeddingRetries: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Per-item embedding index status (Task W5). Optional: only present on list
   * and getById responses enriched by the memory service. Undefined when the
   * field is not yet included in the query projection.
   */
  indexStatus?: MemoryIndexStatus;
}
