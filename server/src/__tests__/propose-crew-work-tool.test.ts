// server/src/__tests__/propose-crew-work-tool.test.ts
//
// Task 2.4 — `propose_crew_work` tool tests.
//
// Test plan:
//   A. Param validation — missing/invalid threadId, summary, proposedTasks.
//   B. Happy path (await_human, L1): proposeWork called with resolved autonomy +
//      companyId + resolved proposedTasks; returns proposalId.
//   C. Happy path (auto-approved, L2): returns proposalId + createdIssueIds.
//   D. assigneeRole → assigneeAgentId resolution: DB lookup by name + kind='aoa'.
//   E. Unknown assigneeRole → task created unassigned (no error).
//   F. Allowlist gate — propose_crew_work IS in ADJUTANT_TOOL_ALLOWLIST;
//      NOT in any other crew role's allowlist (default-deny confirmed).
//   G. effectiveAutonomy fallback to 0 when ctx.effectiveAutonomy is absent.
//   H. existing proposal path (idempotency).
//   I. blockedReason path (budget blocked at L2).

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Drizzle + DB mocks ────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _tag: "eq", a, b })),
  and: vi.fn((...args: unknown[]) => ({ _tag: "and", args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _tag: "ne", a, b })),
  sql: vi.fn(),
  inArray: vi.fn(),
  notInArray: vi.fn(),
  lt: vi.fn(),
  gt: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
  discussions: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
  discussionEntries: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
  activityLog: new Proxy({} as Record<string, unknown>, { get: (_t, p) => p }),
}));

// ── crew-task-service mock ────────────────────────────────────────────────────
vi.mock("../services/crew-task-service.js", () => ({
  crewTaskService: vi.fn(() => ({
    proposeWork: vi.fn(),
  })),
}));

// ── live-events mock (pulled in transitively) ─────────────────────────────────
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { proposeCrewWorkTool } from "../services/internal-agent/tools/propose-crew-work.js";
import { crewTaskService } from "../services/crew-task-service.js";
import { ADJUTANT_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-adjutant.js";
import { authorizeToolInvocation } from "../services/internal-agent/authorize-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// ─── Constants ─────────────────────────────────────────────────────────────────
const CO_ID = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const THREAD_ID = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const PROPOSAL_ID = "cccccccc-0000-4000-8000-cccccccccccc";
const AGENT_ID = "dddddddd-0000-4000-8000-dddddddddddd";
const ENGINEER_AGENT_ID = "eeeeeeee-0000-4000-8000-eeeeeeeeeeee";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock db whose select chain returns different results per call.
 * The `responses` array maps [callIndex] → resolved value.
 * An undefined/absent entry returns [] (no rows).
 */
function makeSequenceDb(responses: Array<unknown[]>): any {
  let callCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      const idx = callCount++;
      const result = responses[idx] ?? [];
      // Build a chain where each method returns `this` for further chaining,
      // and the final `.limit()` call returns a Promise resolving to `result`.
      const chain: any = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockResolvedValue(result);
      chain.then = vi.fn((resolve: (r: unknown) => unknown) => Promise.resolve(resolve(result)));
      return chain;
    }),
  };
}

// DB that always returns the given agent row for role lookups.
function makeDbWithAgent(agentRow: { id: string } | null): any {
  const result = agentRow ? [agentRow] : [];
  return makeSequenceDb([result]);
}

// DB that never gets called for role lookups (no assigneeRole in params).
function makeEmptyDb(): any {
  return makeSequenceDb([]);
}

function makeCtx(
  db: any,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    companyId: CO_ID,
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: AGENT_ID,
    effectiveAutonomy: 1,
    db,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

// ─── Typed mock accessor ──────────────────────────────────────────────────────
let mockProposeWork: ReturnType<typeof vi.fn>;

// ═════════════════════════════════════════════════════════════════════════════
// A. Param validation
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — param validation", () => {
  it("metadata: name, category=action, requiredRole=team_member, no confirmation", () => {
    expect(proposeCrewWorkTool.name).toBe("propose_crew_work");
    expect(proposeCrewWorkTool.category).toBe("action");
    expect(proposeCrewWorkTool.requiredRole).toBe("team_member");
    expect(proposeCrewWorkTool.requiresConfirmation).toBe(false);
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const ctx = makeCtx(makeEmptyDb());
    const result = await proposeCrewWorkTool.execute(
      { summary: "Build auth", proposedTasks: [{ title: "Task A" }] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.summary).toContain("threadId");
  });

  it("returns INVALID_PARAMS when summary is missing", async () => {
    const ctx = makeCtx(makeEmptyDb());
    const result = await proposeCrewWorkTool.execute(
      { threadId: THREAD_ID, proposedTasks: [{ title: "Task A" }] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.summary).toContain("summary");
  });

  it("returns INVALID_PARAMS when proposedTasks is empty array", async () => {
    const ctx = makeCtx(makeEmptyDb());
    const result = await proposeCrewWorkTool.execute(
      { threadId: THREAD_ID, summary: "Build auth", proposedTasks: [] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.summary).toContain("non-empty");
  });

  it("returns INVALID_PARAMS when a task has an empty title", async () => {
    const ctx = makeCtx(makeEmptyDb());
    const result = await proposeCrewWorkTool.execute(
      { threadId: THREAD_ID, summary: "Build auth", proposedTasks: [{ title: "" }] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.summary).toContain("title");
  });

  it("returns INVALID_PARAMS when proposedTasks is not an array", async () => {
    const ctx = makeCtx(makeEmptyDb());
    const result = await proposeCrewWorkTool.execute(
      { threadId: THREAD_ID, summary: "Build auth", proposedTasks: "not an array" as any },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Happy path — await_human (effectiveAutonomy=1)
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — await_human path (L1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProposeWork = vi.fn().mockResolvedValue({
      proposalId: PROPOSAL_ID,
      autoApproved: false,
      existing: false,
    });
    vi.mocked(crewTaskService).mockReturnValue({
      proposeWork: mockProposeWork,
    } as any);
  });

  it("calls crewTaskService.proposeWork with correct args at L1 (no role)", async () => {
    const db = makeEmptyDb();
    const ctx = makeCtx(db, { effectiveAutonomy: 1 });

    const result = await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Build the auth flow",
        proposedTasks: [{ title: "Spec login UI" }, { title: "Implement JWT" }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).proposalId).toBe(PROPOSAL_ID);
    expect((result.data as any).autoApproved).toBe(false);
    expect(result.summary).toContain("awaiting human approval");

    expect(mockProposeWork).toHaveBeenCalledTimes(1);
    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        companyId: CO_ID,
        autonomy: 1,
        summary: "Build the auth flow",
        proposedTasks: [{ title: "Spec login UI" }, { title: "Implement JWT" }],
        createdBy: { agentId: AGENT_ID },
      }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Happy path — auto-approved (effectiveAutonomy=2)
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — auto-approved path (L2)", () => {
  const ISSUE_1 = "issue-1111";
  const ISSUE_2 = "issue-2222";

  beforeEach(() => {
    vi.clearAllMocks();
    mockProposeWork = vi.fn().mockResolvedValue({
      proposalId: PROPOSAL_ID,
      autoApproved: true,
      existing: false,
      createdIssueIds: [ISSUE_1, ISSUE_2],
    });
    vi.mocked(crewTaskService).mockReturnValue({
      proposeWork: mockProposeWork,
    } as any);
  });

  it("returns proposalId + createdIssueIds when auto-approved", async () => {
    const db = makeEmptyDb();
    const ctx = makeCtx(db, { effectiveAutonomy: 2 });

    const result = await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Ship the product",
        proposedTasks: [{ title: "Task A" }, { title: "Task B" }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).proposalId).toBe(PROPOSAL_ID);
    expect((result.data as any).autoApproved).toBe(true);
    expect((result.data as any).createdIssueIds).toEqual([ISSUE_1, ISSUE_2]);
    expect(result.summary).toContain("auto-approved");
    expect(result.summary).toContain("2");

    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({ autonomy: 2, threadId: THREAD_ID }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. assigneeRole → assigneeAgentId resolution
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — role → agentId resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProposeWork = vi.fn().mockResolvedValue({
      proposalId: PROPOSAL_ID,
      autoApproved: false,
      existing: false,
    });
    vi.mocked(crewTaskService).mockReturnValue({
      proposeWork: mockProposeWork,
    } as any);
  });

  it("resolves assigneeRole='engineer' to ENGINEER_AGENT_ID via DB lookup", async () => {
    // DB returns the Engineer agent on the first select call
    const db = makeDbWithAgent({ id: ENGINEER_AGENT_ID });
    const ctx = makeCtx(db, { effectiveAutonomy: 1 });

    await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Build the feature",
        proposedTasks: [{ title: "Code the endpoint", assigneeRole: "engineer" }],
      },
      ctx,
    );

    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedTasks: [{ title: "Code the endpoint", assigneeAgentId: ENGINEER_AGENT_ID }],
      }),
    );
  });

  it("resolves multiple tasks with different roles independently", async () => {
    const SCOUT_AGENT_ID = "ffffffff-0000-4000-8000-ffffffffffff";
    // First call → Engineer, second call → Scout
    const db = makeSequenceDb([[{ id: ENGINEER_AGENT_ID }], [{ id: SCOUT_AGENT_ID }]]);
    const ctx = makeCtx(db, { effectiveAutonomy: 1 });

    await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Research and build",
        proposedTasks: [
          { title: "Build it", assigneeRole: "engineer" },
          { title: "Research it", assigneeRole: "scout" },
        ],
      },
      ctx,
    );

    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedTasks: [
          { title: "Build it", assigneeAgentId: ENGINEER_AGENT_ID },
          { title: "Research it", assigneeAgentId: SCOUT_AGENT_ID },
        ],
      }),
    );
  });

  it("resolves assigneeRole='planner' to PLANNER_AGENT_ID via DB lookup (Planner is an assignable worker)", async () => {
    const PLANNER_AGENT_ID = "ffffffff-1111-4000-8000-ffffffffffff";
    // DB returns the Planner agent on the first select call
    const db = makeDbWithAgent({ id: PLANNER_AGENT_ID });
    const ctx = makeCtx(db, { effectiveAutonomy: 1 });

    await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Write a plan for the feature",
        proposedTasks: [{ title: "Write the plan", assigneeRole: "planner" }],
      },
      ctx,
    );

    // The Planner agent (name="Planner", kind="aoa") must be resolved and
    // assigned to the task — Planner is a normal crew worker in the work=task model.
    // ROLE_TO_AGENT_NAME["planner"] = "Planner"; DB lookup finds the seeded agent.
    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedTasks: [{ title: "Write the plan", assigneeAgentId: PLANNER_AGENT_ID }],
      }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. Unknown assigneeRole → unassigned task (no error)
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — unknown role → unassigned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProposeWork = vi.fn().mockResolvedValue({
      proposalId: PROPOSAL_ID,
      autoApproved: false,
      existing: false,
    });
    vi.mocked(crewTaskService).mockReturnValue({
      proposeWork: mockProposeWork,
    } as any);
  });

  it("unknown assigneeRole → task sent without assigneeAgentId", async () => {
    // DB returns empty (no agent found for the unknown role name)
    const db = makeDbWithAgent(null);
    const ctx = makeCtx(db, { effectiveAutonomy: 1 });

    const result = await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Do stuff",
        proposedTasks: [{ title: "Mystery task", assigneeRole: "unknown_role_xyz" }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    // Task should be created without assigneeAgentId
    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedTasks: [{ title: "Mystery task" }],
      }),
    );
  });

  it("task with no assigneeRole → task sent without assigneeAgentId (no DB call)", async () => {
    const db = makeEmptyDb();
    const ctx = makeCtx(db, { effectiveAutonomy: 1 });

    await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Do stuff",
        proposedTasks: [{ title: "Unassigned task" }],
      },
      ctx,
    );

    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        proposedTasks: [{ title: "Unassigned task" }],
      }),
    );
    // db.select should not have been called (no role to resolve)
    expect(db.select).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Allowlist gate — default-deny for non-Adjutant; IS in Adjutant allowlist
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work allowlist gate (D2 default-deny)", () => {
  it("propose_crew_work IS in ADJUTANT_TOOL_ALLOWLIST", () => {
    expect(ADJUTANT_TOOL_ALLOWLIST).toContain("propose_crew_work");
  });

  it("denied for AoA agent with empty allowlist (default-deny for non-Adjutant)", () => {
    const result = authorizeToolInvocation(
      proposeCrewWorkTool,
      "founder",
      ["system_actions"],
      { agentKind: "aoa", toolAllowlist: [] },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toBe("NOT_IN_ALLOWLIST");
    }
  });

  it("denied for AoA agent without toolAllowlist (default-deny)", () => {
    const result = authorizeToolInvocation(
      proposeCrewWorkTool,
      "founder",
      ["system_actions"],
      { agentKind: "aoa", toolAllowlist: undefined },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toBe("NOT_IN_ALLOWLIST");
    }
  });

  it("denied for AoA agent with a non-Adjutant allowlist (e.g. Engineer)", () => {
    // Simulate Engineer's allowlist (does not include propose_crew_work)
    const engineerLike = [
      "query_threads",
      "create_artifact_version",
      "query_artifacts",
      "request_thread_workspace",
      "post_entry",
    ];
    const result = authorizeToolInvocation(
      proposeCrewWorkTool,
      "founder",
      ["system_actions"],
      { agentKind: "aoa", toolAllowlist: engineerLike },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error).toBe("NOT_IN_ALLOWLIST");
    }
  });

  it("allowed when propose_crew_work is in the allowlist (Adjutant path)", () => {
    const result = authorizeToolInvocation(
      proposeCrewWorkTool,
      "founder",
      ["system_actions"],
      { agentKind: "aoa", toolAllowlist: ADJUTANT_TOOL_ALLOWLIST },
    );
    expect(result.allowed).toBe(true);
  });

  it("Commander path (agentKind!='aoa'): allowlist gate is skipped", () => {
    // Non-AoA agents bypass the allowlist gate entirely
    const result = authorizeToolInvocation(
      proposeCrewWorkTool,
      "team_member",
      ["system_actions"],
      { agentKind: "commander", toolAllowlist: [] },
    );
    // Gate is bypassed; since requiredRole=team_member and user is team_member → allowed
    expect(result.allowed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. effectiveAutonomy fallback to 0 when ctx.effectiveAutonomy is absent
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — effectiveAutonomy fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProposeWork = vi.fn().mockResolvedValue({
      proposalId: PROPOSAL_ID,
      autoApproved: false,
      existing: false,
    });
    vi.mocked(crewTaskService).mockReturnValue({
      proposeWork: mockProposeWork,
    } as any);
  });

  it("uses autonomy=0 (fail-closed) when ctx.effectiveAutonomy is undefined", async () => {
    const db = makeEmptyDb();
    const ctx = makeCtx(db, { effectiveAutonomy: undefined });

    await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Build something",
        proposedTasks: [{ title: "Task A" }],
      },
      ctx,
    );

    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({ autonomy: 0 }),
    );
  });

  it("uses autonomy=0 when ctx.effectiveAutonomy is null", async () => {
    const db = makeEmptyDb();
    const ctx = makeCtx(db, { effectiveAutonomy: null });

    await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Build something",
        proposedTasks: [{ title: "Task A" }],
      },
      ctx,
    );

    expect(mockProposeWork).toHaveBeenCalledWith(
      expect.objectContaining({ autonomy: 0 }),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// H. Existing proposal (idempotency path)
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — existing proposal idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProposeWork = vi.fn().mockResolvedValue({
      proposalId: PROPOSAL_ID,
      autoApproved: false,
      existing: true,
    });
    vi.mocked(crewTaskService).mockReturnValue({
      proposeWork: mockProposeWork,
    } as any);
  });

  it("returns existing:true and surfaces it in data when a proposal already exists", async () => {
    const db = makeEmptyDb();
    const ctx = makeCtx(db, { effectiveAutonomy: 2 });

    const result = await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Dup proposal",
        proposedTasks: [{ title: "Task A" }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).existing).toBe(true);
    expect((result.data as any).autoApproved).toBe(false);
    expect(result.summary).toContain("existing");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// I. Budget blocked path
// ═════════════════════════════════════════════════════════════════════════════

describe("propose_crew_work tool — budget blocked path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProposeWork = vi.fn().mockResolvedValue({
      proposalId: PROPOSAL_ID,
      autoApproved: false,
      existing: false,
      blockedReason: "budget_exhausted",
    });
    vi.mocked(crewTaskService).mockReturnValue({
      proposeWork: mockProposeWork,
    } as any);
  });

  it("surfaces blockedReason in data when budget blocks dispatch", async () => {
    const db = makeEmptyDb();
    const ctx = makeCtx(db, { effectiveAutonomy: 2 });

    const result = await proposeCrewWorkTool.execute(
      {
        threadId: THREAD_ID,
        summary: "Budget limited work",
        proposedTasks: [{ title: "Task A" }],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).blockedReason).toBe("budget_exhausted");
    expect((result.data as any).autoApproved).toBe(false);
    expect(result.summary).toContain("blocked");
  });
});
