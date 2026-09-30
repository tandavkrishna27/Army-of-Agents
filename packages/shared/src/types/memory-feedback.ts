import type { MemoryFeedbackPatternType, MemoryFeedbackPatternStatus } from "../constants.js";

export interface MemoryFeedbackPattern {
  id: string;
  companyId: string;
  patternType: MemoryFeedbackPatternType;
  occurrenceCount: number;
  status: MemoryFeedbackPatternStatus;
  evidence: Record<string, unknown>[] | null;
  sourceAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
