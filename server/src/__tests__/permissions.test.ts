import { describe, it, expect, vi } from "vitest";

// Mock drizzle-orm and @armyofagents/db to avoid ESM cycle issues
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (col: unknown, val: unknown) => ({ col, val, op: "eq" }),
  isNull: (col: unknown) => ({ col, op: "isNull" }),
}));

vi.mock("@armyofagents/db", () => ({
  userRoles: {
    companyId: "company_id",
    userId: "user_id",
    role: "role",
    projectId: "project_id",
    id: "id",
  },
}));

// Import after mocks are set up
const { permissionService } = await import("../services/permissions.js");

type PermService = ReturnType<typeof permissionService>;

// Mock DB that returns configurable role rows
function createMockDb(roleRows: Array<{ id: string; companyId: string; userId: string; role: string; projectId: string | null }>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (fn: (rows: typeof roleRows) => unknown) => Promise.resolve(fn(roleRows)),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => ({
          then: (fn: (rows: unknown[]) => unknown) =>
            Promise.resolve(fn([{ id: "new-role-id" }])),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => ({
            then: (fn: (rows: unknown[]) => unknown) =>
              Promise.resolve(fn([{ id: "updated-role-id" }])),
          }),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => ({
          then: (fn: (rows: unknown[]) => unknown) =>
            Promise.resolve(fn([{ id: "deleted-role-id" }])),
        }),
      }),
    }),
  } as Parameters<typeof permissionService>[0];
}

describe("permissionService", () => {
  describe("getEffectiveRole", () => {
    it("returns 'team_member' when user has no roles", async () => {
      const perms = permissionService(createMockDb([]));
      expect(await perms.getEffectiveRole("c1", "u1")).toBe("team_member");
    });

    it("returns 'founder' when user has founder role", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]));
      expect(await perms.getEffectiveRole("c1", "u1")).toBe("founder");
    });

    it("returns 'team_lead' when user has team_lead role", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.getEffectiveRole("c1", "u1")).toBe("team_lead");
    });

    it("returns highest privilege when user has multiple roles", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
        { id: "2", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.getEffectiveRole("c1", "u1")).toBe("team_lead");
    });

    it("founder > team_lead when user has both", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
        { id: "2", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.getEffectiveRole("c1", "u1")).toBe("founder");
    });
  });

  describe("isFounder", () => {
    it("returns true when user is founder", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]));
      expect(await perms.isFounder("c1", "u1")).toBe(true);
    });

    it("returns false when user is not founder", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.isFounder("c1", "u1")).toBe(false);
    });

    it("returns false when user has no roles", async () => {
      const perms = permissionService(createMockDb([]));
      expect(await perms.isFounder("c1", "u1")).toBe(false);
    });
  });

  describe("getTeamLeadDepartments", () => {
    it("returns department IDs where user is team_lead", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
        { id: "2", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-2" },
        { id: "3", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]));
      expect(await perms.getTeamLeadDepartments("c1", "u1")).toEqual(["dept-1", "dept-2"]);
    });

    it("returns empty array when user has no team_lead roles", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]));
      expect(await perms.getTeamLeadDepartments("c1", "u1")).toEqual([]);
    });
  });

  describe("canAccessMemory", () => {
    it("founder can access everything", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]));
      expect(await perms.canAccessMemory("c1", "u1", "create", { layer: "identity" })).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "update", { layer: "identity" })).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "delete", { layer: "identity" })).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "read")).toBe(true);
    });

    it("team_lead cannot touch identity layer", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canAccessMemory("c1", "u1", "create", { layer: "identity", departmentId: "dept-1" })).toBe(false);
      expect(await perms.canAccessMemory("c1", "u1", "update", { layer: "identity", departmentId: "dept-1" })).toBe(false);
      expect(await perms.canAccessMemory("c1", "u1", "delete", { layer: "identity", departmentId: "dept-1" })).toBe(false);
    });

    it("team_lead can CRUD domain items in their department", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canAccessMemory("c1", "u1", "create", { layer: "domain", departmentId: "dept-1" })).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "update", { layer: "domain", departmentId: "dept-1" })).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "delete", { layer: "domain", departmentId: "dept-1" })).toBe(true);
    });

    it("team_lead cannot CRUD domain items in other department", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canAccessMemory("c1", "u1", "create", { layer: "domain", departmentId: "dept-2" })).toBe(false);
      expect(await perms.canAccessMemory("c1", "u1", "update", { layer: "domain", departmentId: "dept-2" })).toBe(false);
    });

    it("team_lead can manage active_context in their department", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canAccessMemory("c1", "u1", "create", { layer: "active_context", departmentId: "dept-1" })).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "update", { layer: "active_context", departmentId: "dept-1" })).toBe(true);
    });

    it("all roles can read memory items", async () => {
      expect(await permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ])).canAccessMemory("c1", "u1", "read")).toBe(true);

      expect(await permissionService(createMockDb([])).canAccessMemory("c1", "u1", "read")).toBe(true);
    });

    it("team_member can only create pending items", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]));
      expect(await perms.canAccessMemory("c1", "u1", "create")).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "update", { layer: "domain", departmentId: "d" })).toBe(false);
      expect(await perms.canAccessMemory("c1", "u1", "delete", { layer: "domain", departmentId: "d" })).toBe(false);
    });

    it("shared items readable by all, writable by owning dept lead", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canAccessMemory("c1", "u1", "update", {
        layer: "domain", departmentId: "dept-1", visibility: "shared",
      })).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "update", {
        layer: "domain", departmentId: "dept-2", visibility: "shared",
      })).toBe(false);
    });

    it("user with no role treated as team_member", async () => {
      const perms = permissionService(createMockDb([]));
      expect(await perms.canAccessMemory("c1", "u1", "read")).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "create")).toBe(true);
      expect(await perms.canAccessMemory("c1", "u1", "update", { layer: "domain", departmentId: "d" })).toBe(false);
    });
  });

  describe("canApproveMemory", () => {
    it("founder can approve all", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]));
      expect(await perms.canApproveMemory("c1", "u1", { layer: "identity" })).toBe(true);
      expect(await perms.canApproveMemory("c1", "u1", { layer: "domain", departmentId: "d" })).toBe(true);
    });

    it("team_lead can approve active_context in their department, NOT domain/identity (founder-only, R5)", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canApproveMemory("c1", "u1", { layer: "active_context", departmentId: "dept-1" })).toBe(true);
      // R5: the founder is the sole gatekeeper for identity + domain (Decisions #15/#52).
      expect(await perms.canApproveMemory("c1", "u1", { layer: "domain", departmentId: "dept-1" })).toBe(false);
      expect(await perms.canApproveMemory("c1", "u1", { layer: "identity" })).toBe(false);
    });

    it("team_lead cannot approve identity layer", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canApproveMemory("c1", "u1", { layer: "identity" })).toBe(false);
    });

    it("team_lead cannot approve active_context in another department", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]));
      expect(await perms.canApproveMemory("c1", "u1", { layer: "active_context", departmentId: "dept-2" })).toBe(false);
    });

    it("team_member cannot approve", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]));
      expect(await perms.canApproveMemory("c1", "u1", { layer: "domain", departmentId: "d" })).toBe(false);
    });
  });

  describe("canAccessEntity", () => {
    it("founder can access all entity types", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]));
      expect(await perms.canAccessEntity("c1", "u1", "task", "create")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "goal", "update")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "agent", "update")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "brief", "approve")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "suggestion", "update")).toBe(true);
    });

    it("team_member can only read goals", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]));
      expect(await perms.canAccessEntity("c1", "u1", "goal", "read")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "goal", "create")).toBe(false);
    });

    it("agent config is founder-only (read allowed for all)", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "d" },
      ]));
      expect(await perms.canAccessEntity("c1", "u1", "agent", "read")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "agent", "create")).toBe(false);
    });

    it("brief approval is founder-only", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "d" },
      ]));
      expect(await perms.canAccessEntity("c1", "u1", "brief", "read")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "brief", "approve")).toBe(false);
    });

    it("team_member can create tasks and update assigned tasks", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]));
      expect(await perms.canAccessEntity("c1", "u1", "task", "create")).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "task", "update", { assigneeUserId: "u1" })).toBe(true);
      expect(await perms.canAccessEntity("c1", "u1", "task", "update", { assigneeUserId: "other" })).toBe(false);
    });
  });

  describe("multi-role user", () => {
    it("permissions combine correctly", async () => {
      const perms = permissionService(createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-a" },
        { id: "2", companyId: "c1", userId: "u1", role: "team_member", projectId: "dept-b" },
      ]));
      expect(await perms.getEffectiveRole("c1", "u1")).toBe("team_lead");
      expect(await perms.isTeamLeadForDepartment("c1", "u1", "dept-a")).toBe(true);
      expect(await perms.isTeamLeadForDepartment("c1", "u1", "dept-b")).toBe(false);
    });
  });
});
