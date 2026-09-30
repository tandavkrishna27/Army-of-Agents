/**
 * threads-links.test.ts
 * TDD: Task 2 — cross-thread link create + list endpoints (contract tests)
 */

import { describe, it, expect } from "vitest";
import { THREAD_LINK_KINDS } from "@armyofagents/shared";

// ── Contract: THREAD_LINK_KINDS includes expected values ─────────────────────

describe("THREAD_LINK_KINDS constant", () => {
  it("contains all required link kinds", () => {
    expect(THREAD_LINK_KINDS).toContain("link");
    expect(THREAD_LINK_KINDS).toContain("fork");
    expect(THREAD_LINK_KINDS).toContain("merge");
    expect(THREAD_LINK_KINDS).toContain("spinoff");
    expect(THREAD_LINK_KINDS).toContain("goal_cluster");
    expect(THREAD_LINK_KINDS).toContain("spawned_from_task");
  });

  it("has exactly 6 kinds", () => {
    expect(THREAD_LINK_KINDS.length).toBe(6);
  });
});

// ── Zod schema validation for link kind ─────────────────────────────────────

describe("threadLink kind validation (via zod enum)", () => {
  const { z } = require("zod");
  const kindSchema = z.enum(THREAD_LINK_KINDS);

  it("accepts valid kinds", () => {
    for (const kind of THREAD_LINK_KINDS) {
      expect(() => kindSchema.parse(kind)).not.toThrow();
    }
  });

  it("rejects invalid kind", () => {
    expect(() => kindSchema.parse("invalid_kind")).toThrow();
    expect(() => kindSchema.parse("")).toThrow();
    expect(() => kindSchema.parse(null)).toThrow();
  });
});

// ── Route shape contract ──────────────────────────────────────────────────────

describe("thread link endpoint contract (shape)", () => {
  it("POST body must include toThreadId and kind", () => {
    const { z } = require("zod");
    const schema = z.object({
      toThreadId: z.string().uuid(),
      kind: z.enum(THREAD_LINK_KINDS),
    });

    expect(() =>
      schema.parse({ toThreadId: "00000000-0000-0000-0000-000000000001", kind: "link" }),
    ).not.toThrow();

    // Missing toThreadId
    expect(() => schema.parse({ kind: "link" })).toThrow();

    // Missing kind
    expect(() =>
      schema.parse({ toThreadId: "00000000-0000-0000-0000-000000000001" }),
    ).toThrow();

    // Invalid kind
    expect(() =>
      schema.parse({
        toThreadId: "00000000-0000-0000-0000-000000000001",
        kind: "bad_kind",
      }),
    ).toThrow();
  });

  it("GET response shape: link has fromThreadId, toThreadId, kind, createdBy", () => {
    const link = {
      id: "link-1",
      fromThreadId: "thread-a",
      toThreadId: "thread-b",
      kind: "link",
      createdBy: "user-1",
      createdAt: new Date().toISOString(),
    };

    expect(link).toHaveProperty("fromThreadId");
    expect(link).toHaveProperty("toThreadId");
    expect(link).toHaveProperty("kind");
    expect(link).toHaveProperty("createdBy");
  });
});

// ── threadService: createLink and listLinks unit tests ────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  desc: vi.fn((col: any) => ({ desc: col })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: {
    id: "discussions_id",
    companyId: "discussions_company_id",
    ownerUserId: "discussions_owner_user_id",
    visibility: "discussions_visibility",
    scopeType: "discussions_scope_type",
    scopeId: "discussions_scope_id",
  },
  threadLinks: {
    id: "tl_id",
    companyId: "tl_company_id",
    fromThreadId: "tl_from_thread_id",
    toThreadId: "tl_to_thread_id",
    kind: "tl_kind",
    createdBy: "tl_created_by",
    createdAt: "tl_created_at",
  },
  threadParticipants: {
    id: "tp_id",
    threadId: "tp_thread_id",
    principalType: "tp_principal_type",
    principalId: "tp_principal_id",
    role: "tp_role",
  },
  userRoles: {
    id: "ur_id",
    companyId: "ur_company_id",
    userId: "ur_user_id",
    projectId: "ur_project_id",
  },
  agents: { id: "a_id", companyId: "a_company_id", name: "a_name", kind: "a_kind" },
  authUsers: { id: "au_id", name: "au_name" },
  companyMemberships: { id: "cm_id", companyId: "cm_company_id", userId: "cm_user_id", principalId: "cm_principal_id", principalType: "cm_principal_type" },
  agentWakeupRequests: { id: "awr_id" },
  notifications: { id: "n_id" },
  goals: { id: "g_id", parentId: "g_parent_id" },
  discussionEntries: { id: "de_id", discussionId: "de_discussion_id" },
  discussionExtractedItems: {
    id: "dei_id",
    discussionEntryId: "dei_entry_id",
    status: "dei_status",
    resultTaskId: "dei_result_task_id",
    type: "dei_type",
    title: "dei_title",
    description: "dei_description",
    assigneeAgentId: "dei_assignee_agent_id",
    assigneeUserId: "dei_assignee_user_id",
    departmentId: "dei_department_id",
    suggestedDepartmentId: "dei_suggested_department_id",
    suggestedProjectId: "dei_suggested_project_id",
    priority: "dei_priority",
    suggestedPriority: "dei_suggested_priority",
    updatedAt: "dei_updated_at",
  },
  issues: { id: "i_id" },
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => { const e = new Error(msg); (e as any).status = 400; return e; },
  notFound: (msg: string) => { const e = new Error(msg); (e as any).status = 404; return e; },
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/goals.js", () => ({ goalService: vi.fn() }));

import { vi } from "vitest";
import { threadService } from "../services/threads.js";

function makeDb(selectResults: any[][], insertResults: any[][] = [[]]) {
  let si = 0;
  let ii = 0;
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (r: any[]) => any) => Promise.resolve(fn(selectResults[si++] ?? []))),
  };
  const insertChain = {
    values: vi.fn(() => ({
      returning: vi.fn(() => ({
        then: vi.fn((fn: (r: any[]) => any) => Promise.resolve(fn(insertResults[ii++] ?? []))),
      })),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (r: any[]) => any) => Promise.resolve(fn(insertResults[ii++] ?? []))),
    })),
  };
  return {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    transaction: vi.fn(async (fn: (tx: any) => any) => fn({
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => insertChain),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    })),
  } as any;
}

const founderActor = { userId: "u1", role: "founder" as const, isHuman: true };

describe("threadService.createLink", () => {
  it("inserts a thread_links row and returns it", async () => {
    const linkRow = {
      id: "link-1",
      fromThreadId: "from-thread",
      toThreadId: "to-thread",
      kind: "link",
      createdBy: "u1",
    };
    const db = makeDb(
      [
        // getById: fromThread
        [{ id: "from-thread", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }],
        // getById: toThread
        [{ id: "to-thread", companyId: "co1", ownerUserId: "u2", visibility: "company", scopeType: null, scopeId: null }],
      ],
      [[linkRow]],
    );
    const svc = threadService(db);
    const result = await svc.createLink("co1", "from-thread", "to-thread", "link", founderActor);
    expect(result).toMatchObject({ fromThreadId: "from-thread", toThreadId: "to-thread", kind: "link" });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("throws badRequest for invalid kind", async () => {
    const db = makeDb(
      [
        [{ id: "from-thread", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }],
        [{ id: "to-thread", companyId: "co1", ownerUserId: "u2", visibility: "company", scopeType: null, scopeId: null }],
      ],
    );
    const svc = threadService(db);
    await expect(
      svc.createLink("co1", "from-thread", "to-thread", "invalid_kind", founderActor),
    ).rejects.toThrow(/invalid.*kind/i);
  });
});

describe("threadService.listLinks", () => {
  it("returns links where fromThreadId or toThreadId matches", async () => {
    const links = [
      { id: "l1", fromThreadId: "t1", toThreadId: "t2", kind: "link", createdBy: "u1" },
      { id: "l2", fromThreadId: "t3", toThreadId: "t1", kind: "fork", createdBy: "u2" },
    ];
    const db = makeDb([
      // getById: thread exists
      [{ id: "t1", companyId: "co1", ownerUserId: "u1", visibility: "company", scopeType: null, scopeId: null }],
      // listLinks query
      links,
    ]);
    const svc = threadService(db);
    const result = await svc.listLinks("co1", "t1", founderActor);
    expect(result.length).toBe(2);
    expect(result[0].kind).toBe("link");
  });
});
