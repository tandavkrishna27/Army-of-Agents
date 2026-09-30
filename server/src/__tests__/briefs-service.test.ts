import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((value: any) => ({ desc: value })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({
      sql: strings,
      values,
      as: vi.fn().mockReturnValue("aliased"),
    })),
    { raw: vi.fn((input: any) => input) },
  ),
}));

vi.mock("@armyofagents/db", () => ({
  briefs: {
    id: "brief_id",
    companyId: "brief_company_id",
    debriefId: "brief_debrief_id",
    status: "brief_status",
    departmentId: "brief_department_id",
    projectId: "brief_project_id",
    goalId: "brief_goal_id",
    reviewedAt: "brief_reviewed_at",
    reviewedBy: "brief_reviewed_by",
    createdAt: "brief_created_at",
    updatedAt: "brief_updated_at",
  },
  briefItems: {
    id: "item_id",
    briefId: "item_brief_id",
    updatedAt: "item_updated_at",
  },
  debriefs: {
    id: "debrief_id",
    companyId: "debrief_company_id",
    inputType: "debrief_input_type",
  },
  memoryItems: {
    id: "memory_id",
    status: "memory_status",
  },
  memoryItemVersions: {
    memoryItemId: "memory_item_id",
    versionNumber: "memory_version_number",
  },
}));

const mockIssueCreate = vi.fn();
const mockMemoryCreate = vi.fn();
const mockFindSimilarItems = vi.fn();
const mockAddDependency = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ create: mockIssueCreate }),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({
    create: mockMemoryCreate,
    findSimilarItems: mockFindSimilarItems,
  }),
}));

vi.mock("../services/dependencies.js", () => ({
  dependencyService: () => ({ addDependency: mockAddDependency }),
}));

import { briefService } from "../services/briefs.js";

function makeSelectChain(queue: any[]) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn(queue.shift() ?? []))),
  };
}

function makeDb(selectQueue: any[], txSelectQueue: any[] = []) {
  const txUpdates: any[] = [];
  const txInserts: any[] = [];
  const txSelectResults = [...txSelectQueue];
  const tx = {
    select: vi.fn(() => makeSelectChain(txSelectResults)),
    update: vi.fn((table: any) => ({
      set: vi.fn((values: any) => {
        txUpdates.push({ table, values });
        return {
          where: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([values]),
        };
      }),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: any) => {
        txInserts.push({ table, values });
        return {
          returning: vi.fn().mockResolvedValue([
            { id: "version-1", ...(Array.isArray(values) ? values[0] : values) },
          ]),
        };
      }),
    })),
  } as any;

  const db = {
    select: vi.fn(() => makeSelectChain(selectQueue)),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(tx)),
  } as any;

  return { db, txUpdates, txInserts };
}

describe("briefService approveBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates reference and preference memory items with source context and active goal propagation", async () => {
    const brief = {
      id: "brief-1",
      companyId: "company-1",
      debriefId: "debrief-1",
      departmentId: null,
      projectId: null,
      goalId: "goal-1",
    };
    const debrief = {
      id: "debrief-1",
      companyId: "company-1",
      title: "Founder sync",
      createdAt: new Date("2026-03-20T10:00:00.000Z"),
      sourceInfo: { issueId: "task-42" },
    };
    const items = [
      {
        id: "item-ref",
        briefId: "brief-1",
        type: "reference",
        title: "Pricing sheet",
        description: "Keep the latest pricing link handy.",
        suggestedDepartmentId: null,
        suggestedProjectId: null,
        suggestedPriority: null,
        suggestedAssigneeId: null,
        suggestedLayer: "active_context",
        layer: "active_context",
        dedupAction: "create_separate",
        mergedContent: null,
        status: "approved",
      },
      {
        id: "item-pref",
        briefId: "brief-1",
        type: "preference",
        title: "Writing tone",
        description: "Use plain language and short paragraphs.",
        suggestedDepartmentId: null,
        suggestedProjectId: null,
        suggestedPriority: null,
        suggestedAssigneeId: null,
        suggestedLayer: "domain",
        layer: "domain",
        dedupAction: null,
        mergedContent: null,
        status: "edited",
      },
    ];
    const { db } = makeDb([[brief], [debrief], items]);
    mockMemoryCreate
      .mockResolvedValueOnce({ id: "mem-ref" })
      .mockResolvedValueOnce({ id: "mem-pref" });
    mockFindSimilarItems.mockResolvedValue([]);

    const result = await briefService(db).approveBrief("company-1", "brief-1", "user-1");

    expect(result?.createdMemoryIds).toEqual(["mem-ref", "mem-pref"]);
    expect(mockMemoryCreate).toHaveBeenNthCalledWith(
      1,
      "company-1",
      expect.objectContaining({
        category: "reference",
        layer: "active_context",
        goalId: "goal-1",
        sourceContext: "Created from brief 'Founder sync' (debrief: 2026-03-20)",
      }),
      expect.anything(),
    );
    expect(mockMemoryCreate).toHaveBeenNthCalledWith(
      2,
      "company-1",
      expect.objectContaining({
        category: "preference",
        layer: "domain",
        goalId: null,
        sourceContext: "Created from brief 'Founder sync' (debrief: 2026-03-20)",
      }),
      expect.anything(),
    );
  });

  it("creates a new version when founder chooses update existing", async () => {
    const brief = {
      id: "brief-1",
      companyId: "company-1",
      debriefId: "debrief-1",
      departmentId: null,
      projectId: null,
      goalId: "goal-1",
    };
    const debrief = {
      id: "debrief-1",
      companyId: "company-1",
      title: "Weekly debrief",
      createdAt: new Date("2026-03-21T10:00:00.000Z"),
      sourceInfo: { issueId: "task-99" },
    };
    const items = [{
      id: "item-1",
      briefId: "brief-1",
      type: "context",
      title: "Project status",
      description: "New milestone details.",
      suggestedDepartmentId: null,
      suggestedProjectId: null,
      suggestedPriority: null,
      suggestedAssigneeId: null,
      suggestedLayer: "working",
      layer: "working",
      dedupAction: "update_existing",
      selectedMemoryId: "mem-1",
      mergedContent: "Existing details.\n\nNew milestone details.",
      status: "approved",
    }];
    const { db, txUpdates, txInserts } = makeDb([[brief], [debrief], items], [[{ versionNumber: 2 }]]);
    mockFindSimilarItems.mockResolvedValue([
      {
        id: "mem-1",
        title: "Project status",
        content: "Existing details.",
        departmentId: null,
        layer: "working",
      },
    ]);

    const result = await briefService(db).approveBrief("company-1", "brief-1", "user-1");

    expect(result?.createdMemoryIds).toEqual(["mem-1"]);
    expect(mockMemoryCreate).not.toHaveBeenCalled();
    expect(txInserts[0]?.values).toEqual(
      expect.objectContaining({
        memoryItemId: "mem-1",
        versionNumber: 3,
        content: "Existing details.\n\nNew milestone details.",
        status: "approved",
      }),
    );
    expect(txUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({
            title: "Project status",
            content: "Existing details.\n\nNew milestone details.",
            taskId: "task-99",
            currentVersionId: "version-1",
          }),
        }),
      ]),
    );
  });

  it("creates a standalone item when founder chooses create separate", async () => {
    const brief = {
      id: "brief-1",
      companyId: "company-1",
      debriefId: "debrief-1",
      departmentId: null,
      projectId: null,
      goalId: null,
    };
    const debrief = {
      id: "debrief-1",
      companyId: "company-1",
      title: "Notes",
      createdAt: new Date("2026-03-19T10:00:00.000Z"),
      sourceInfo: null,
    };
    const items = [{
      id: "item-1",
      briefId: "brief-1",
      type: "insight",
      title: "Retention pattern",
      description: "Users keep coming back after the onboarding email.",
      suggestedDepartmentId: null,
      suggestedProjectId: null,
      suggestedPriority: null,
      suggestedAssigneeId: null,
      suggestedLayer: "domain",
      layer: "domain",
      dedupAction: "create_separate",
      selectedMemoryId: "mem-1",
      mergedContent: null,
      status: "approved",
    }];
    const { db } = makeDb([[brief], [debrief], items]);
    mockFindSimilarItems.mockResolvedValue([{ id: "mem-1", title: "Old insight", content: "Old" }]);
    mockMemoryCreate.mockResolvedValue({ id: "mem-new" });

    const result = await briefService(db).approveBrief("company-1", "brief-1", "user-1");

    expect(result?.createdMemoryIds).toEqual(["mem-new"]);
    expect(mockMemoryCreate).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        category: "insight",
        content: "Users keep coming back after the onboarding email.",
      }),
      expect.anything(),
    );
  });

  it("archives the matched item when founder chooses replace", async () => {
    const brief = {
      id: "brief-1",
      companyId: "company-1",
      debriefId: "debrief-1",
      departmentId: null,
      projectId: null,
      goalId: null,
    };
    const debrief = {
      id: "debrief-1",
      companyId: "company-1",
      title: "Notes",
      createdAt: new Date("2026-03-19T10:00:00.000Z"),
      sourceInfo: null,
    };
    const items = [{
      id: "item-1",
      briefId: "brief-1",
      type: "decision",
      title: "Use a new CRM",
      description: "We are replacing the old CRM decision.",
      suggestedDepartmentId: null,
      suggestedProjectId: null,
      suggestedPriority: null,
      suggestedAssigneeId: null,
      suggestedLayer: "domain",
      layer: "domain",
      dedupAction: "replace",
      selectedMemoryId: "mem-old",
      mergedContent: null,
      status: "approved",
    }];
    const { db, txUpdates } = makeDb([[brief], [debrief], items]);
    mockFindSimilarItems.mockResolvedValue([{ id: "mem-old", title: "Old CRM", content: "Old CRM" }]);
    mockMemoryCreate.mockResolvedValue({ id: "mem-new" });

    await briefService(db).approveBrief("company-1", "brief-1", "user-1");

    expect(txUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: expect.objectContaining({ status: "archived" }),
        }),
      ]),
    );
    expect(mockMemoryCreate).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ category: "decision" }),
      expect.anything(),
    );
  });
});
