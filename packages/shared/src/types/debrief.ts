import type { DebriefInputType, DebriefStatus } from "../constants.js";

export interface Debrief {
  id: string;
  companyId: string;
  title: string | null;
  inputType: DebriefInputType;
  rawContent: string;
  artifactUrl: string | null;
  departmentId: string | null;
  projectId: string | null;
  goalId: string | null;
  sourceInfo: Record<string, unknown> | null;
  status: DebriefStatus;
  createdBy: string;
  createdAt: Date;
}
