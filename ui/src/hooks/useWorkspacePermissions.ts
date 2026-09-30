import type { UserRole } from "@armyofagents/shared";
import { useTeamAccess } from "./useTeamAccess";

export interface WorkspacePermissions {
  canEditDepartmentWorkspaceSettings: boolean;
  canOverrideTaskWorkspace: boolean;
  canControlRuntimeServices: boolean;
  canConfigureRuntimeCommands: boolean;
  canMutateGit: boolean;
}

interface WorkspacePermissionUser {
  role: UserRole | null;
  departmentId: string | null;
  isSystemAdmin: boolean;
}

const DENIED: WorkspacePermissions = {
  canEditDepartmentWorkspaceSettings: false,
  canOverrideTaskWorkspace: false,
  canControlRuntimeServices: false,
  canConfigureRuntimeCommands: false,
  canMutateGit: false,
};

export function deriveWorkspacePermissions(
  currentUser: WorkspacePermissionUser | null,
  projectId: string | null | undefined,
): WorkspacePermissions {
  if (!currentUser) return DENIED;

  const isFounder = currentUser.role === "founder" || currentUser.isSystemAdmin === true;
  const isScopedLead =
    currentUser.role === "team_lead" &&
    (currentUser.departmentId === null || (!!projectId && currentUser.departmentId === projectId));
  const canLeadWorkspace = isFounder || isScopedLead;

  return {
    canEditDepartmentWorkspaceSettings: canLeadWorkspace,
    canOverrideTaskWorkspace: canLeadWorkspace,
    canControlRuntimeServices: canLeadWorkspace,
    canConfigureRuntimeCommands: isFounder,
    canMutateGit: canLeadWorkspace,
  };
}

export function useWorkspacePermissions(
  companyId: string | null | undefined,
  projectId: string | null | undefined,
): WorkspacePermissions {
  const { currentUser } = useTeamAccess(companyId);
  return deriveWorkspacePermissions(currentUser, projectId);
}
