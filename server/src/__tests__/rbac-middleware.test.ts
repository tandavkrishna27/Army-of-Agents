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

const { assertHumanRole, assertRole, assertDepartmentAccess, assertMemoryAccess, assertMemoryApproval } =
  await import("../middleware/rbac.js");
const { HttpError } = await import("../errors.js");

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
  } as unknown as Parameters<typeof assertRole>[0];
}

function makeReq(overrides: Record<string, unknown>) {
  return { actor: overrides } as unknown as Parameters<typeof assertRole>[1];
}

describe("RBAC Middleware", () => {
  describe("assertHumanRole", () => {
    it("rejects agents even though the legacy assertRole helper permits mixed actor workflows", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "agent", agentId: "a1", companyId: "c1" });
      await expect(assertHumanRole(db, req, "c1", "founder")).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("assertRole", () => {
    it("allows local_implicit (local_trusted mode)", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "board", userId: "local-board", source: "local_implicit" });
      await expect(assertRole(db, req, "c1", "founder")).resolves.toBeUndefined();
    });

    it("allows instance admin", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "board", userId: "u1", source: "session", isInstanceAdmin: true });
      await expect(assertRole(db, req, "c1", "founder")).resolves.toBeUndefined();
    });

    it("allows agents (they bypass role checks)", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "agent", agentId: "a1", companyId: "c1" });
      await expect(assertRole(db, req, "c1", "founder")).resolves.toBeUndefined();
    });

    it("throws unauthorized for 'none' actor", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "none", source: "none" });
      await expect(assertRole(db, req, "c1", "founder")).rejects.toThrow(HttpError);
      try { await assertRole(db, req, "c1", "founder"); } catch (e) {
        expect((e as InstanceType<typeof HttpError>).status).toBe(401);
      }
    });

    it("allows founder when founder role required", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertRole(db, req, "c1", "founder")).resolves.toBeUndefined();
    });

    it("rejects team_member when founder required", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertRole(db, req, "c1", "founder")).rejects.toThrow(HttpError);
      try { await assertRole(db, req, "c1", "founder"); } catch (e) {
        expect((e as InstanceType<typeof HttpError>).status).toBe(403);
      }
    });

    it("allows team_lead when team_lead or founder required", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertRole(db, req, "c1", "founder", "team_lead")).resolves.toBeUndefined();
    });

    it("user with no roles is treated as team_member", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertRole(db, req, "c1", "team_member")).resolves.toBeUndefined();
      await expect(assertRole(db, req, "c1", "founder")).rejects.toThrow(HttpError);
    });
  });

  describe("assertDepartmentAccess", () => {
    it("allows founder", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertDepartmentAccess(db, req, "c1", "dept-1")).resolves.toBeUndefined();
    });

    it("allows team_lead for their department", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertDepartmentAccess(db, req, "c1", "dept-1")).resolves.toBeUndefined();
    });

    it("rejects team_lead for other department", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertDepartmentAccess(db, req, "c1", "dept-2")).rejects.toThrow(HttpError);
    });

    it("rejects team_member", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertDepartmentAccess(db, req, "c1", "dept-1")).rejects.toThrow(HttpError);
    });
  });

  describe("assertMemoryAccess", () => {
    it("allows agents to create items", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "agent", agentId: "a1", companyId: "c1" });
      await expect(assertMemoryAccess(db, req, "c1", "create")).resolves.toBeUndefined();
    });

    it("allows agents to read items", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "agent", agentId: "a1", companyId: "c1" });
      await expect(assertMemoryAccess(db, req, "c1", "read")).resolves.toBeUndefined();
    });

    it("rejects agents trying to update items", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "agent", agentId: "a1", companyId: "c1" });
      await expect(assertMemoryAccess(db, req, "c1", "update")).rejects.toThrow(HttpError);
    });

    it("rejects agents trying to delete items", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "agent", agentId: "a1", companyId: "c1" });
      await expect(assertMemoryAccess(db, req, "c1", "delete")).rejects.toThrow(HttpError);
    });

    it("allows local_implicit to do anything", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "board", userId: "local-board", source: "local_implicit" });
      await expect(assertMemoryAccess(db, req, "c1", "update", { layer: "identity" })).resolves.toBeUndefined();
    });

    it("rejects team_member updating memory", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertMemoryAccess(db, req, "c1", "update", {
        layer: "domain", departmentId: "dept-1",
      })).rejects.toThrow(HttpError);
    });
  });

  describe("assertMemoryApproval", () => {
    it("rejects agents", async () => {
      const db = createMockDb([]);
      const req = makeReq({ type: "agent", agentId: "a1", companyId: "c1" });
      await expect(assertMemoryApproval(db, req, "c1")).rejects.toThrow(HttpError);
    });

    it("allows founder", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "founder", projectId: null },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertMemoryApproval(db, req, "c1", { layer: "identity" })).resolves.toBeUndefined();
    });

    it("allows team_lead for active_context in their department", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertMemoryApproval(db, req, "c1", {
        layer: "active_context", departmentId: "dept-1",
      })).resolves.toBeUndefined();
    });

    it("rejects team_lead for domain layer (R5 — founder-only)", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertMemoryApproval(db, req, "c1", {
        layer: "domain", departmentId: "dept-1",
      })).rejects.toThrow(HttpError);
    });

    it("rejects team_lead for identity layer", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_lead", projectId: "dept-1" },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertMemoryApproval(db, req, "c1", {
        layer: "identity", departmentId: "dept-1",
      })).rejects.toThrow(HttpError);
    });

    it("rejects team_member", async () => {
      const db = createMockDb([
        { id: "1", companyId: "c1", userId: "u1", role: "team_member", projectId: null },
      ]);
      const req = makeReq({ type: "board", userId: "u1", source: "session" });
      await expect(assertMemoryApproval(db, req, "c1", {
        layer: "domain", departmentId: "dept-1",
      })).rejects.toThrow(HttpError);
    });
  });
});
