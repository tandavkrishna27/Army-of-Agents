import { describe, expect, it } from "vitest";
import { deriveWorkspacePermissions } from "../hooks/useWorkspacePermissions";

describe("deriveWorkspacePermissions", () => {
  it("allows founders and system admins to manage workspace and runtime settings", () => {
    expect(deriveWorkspacePermissions({
      role: "founder",
      isSystemAdmin: false,
      departmentId: null,
    }, "dept-1")).toMatchObject({
      canEditDepartmentWorkspaceSettings: true,
      canOverrideTaskWorkspace: true,
      canControlRuntimeServices: true,
      canConfigureRuntimeCommands: true,
      canMutateGit: true,
    });
  });

  it("allows scoped team leads to manage safe workspace operations but not runtime commands", () => {
    expect(deriveWorkspacePermissions({
      role: "team_lead",
      isSystemAdmin: false,
      departmentId: "dept-1",
    }, "dept-1")).toMatchObject({
      canEditDepartmentWorkspaceSettings: true,
      canOverrideTaskWorkspace: true,
      canControlRuntimeServices: true,
      canConfigureRuntimeCommands: false,
      canMutateGit: true,
    });
  });

  it("keeps team members read-only for workspace/runtime mutations", () => {
    expect(deriveWorkspacePermissions({
      role: "team_member",
      isSystemAdmin: false,
      departmentId: "dept-1",
    }, "dept-1")).toMatchObject({
      canEditDepartmentWorkspaceSettings: false,
      canOverrideTaskWorkspace: false,
      canControlRuntimeServices: false,
      canConfigureRuntimeCommands: false,
      canMutateGit: false,
    });
  });
});
