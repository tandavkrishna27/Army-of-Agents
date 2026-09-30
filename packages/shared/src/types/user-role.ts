import type { UserRole } from "../constants.js";

export interface UserRoleAssignment {
  id: string;
  companyId: string;
  userId: string;
  role: UserRole;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
