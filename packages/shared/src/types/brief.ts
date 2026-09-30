import type {
  BriefStatus,
  BriefItemType,
  BriefItemStatus,
  MemoryItemLayer,
  BriefDedupAction,
} from "../constants.js";

export interface Brief {
  id: string;
  companyId: string;
  debriefId: string;
  status: BriefStatus;
  departmentId: string | null;
  projectId: string | null;
  goalId: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BriefItem {
  id: string;
  briefId: string;
  type: BriefItemType;
  title: string;
  description: string | null;
  suggestedAssigneeId: string | null;
  suggestedPriority: string | null;
  suggestedDepartmentId: string | null;
  suggestedProjectId: string | null;
  suggestedLayer: MemoryItemLayer | null;
  layer: MemoryItemLayer | null;
  dedupAction: BriefDedupAction | null;
  selectedMemoryId: string | null;
  mergedContent: string | null;
  status: BriefItemStatus;
  resultTaskId: string | null;
  resultMemoryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
