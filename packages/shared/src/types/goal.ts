import type { GoalLevel, GoalStatus } from "../constants.js";

export interface GoalProjectRef {
  id: string;
  name: string;
  type: string;
}

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  projects: GoalProjectRef[];
  projectIds: string[];
  createdAt: Date;
  updatedAt: Date;
}
