import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const assigneeAgentId = "33333333-3333-4333-8333-333333333333";
const mentionedAgentId = "44444444-4444-4444-8444-444444444444";
const leadAgentId = "55555555-5555-4555-8555-555555555555";
const otherLeadAgentId = "66666666-6666-4666-8666-666666666666";
const parentIssueId = "77777777-7777-4777-8777-777777777777";

// A real PNG magic-byte header so the round-3 byte-sniff guard accepts these
// image/png uploads (the endpoint no longer trusts the multipart mimetype).
const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    identifier: "ARM-1",
    companyId,
    title: "Inspect upload context",
    status: "todo",
    workMode: "standard",
    assigneeAgentId,
    executionRunId: null,
    ...overrides,
  };
}

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getByIdentifierInCompany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  listLabels: vi.fn(),
  getLabelById: vi.fn(),
  createLabel: vi.fn(),
  deleteLabel: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  getComment: vi.fn(),
  createAttachment: vi.fn(),
  completeMissingCommentAttachments: vi.fn(),
  listAttachments: vi.fn(),
  getAttachmentById: vi.fn(),
  removeAttachment: vi.fn(),
  findMentionedAgents: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  notifyMentionedHumans: vi.fn(),
  getAncestors: vi.fn(),
  staleCount: vi.fn(),
  countUnreadTouchedByUser: vi.fn(),
  markRead: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  resolveAgentKinds: vi.fn(),
  enqueueAoaMentionWakeup: vi.fn(),
  getCommentByClientSubmissionId: vi.fn(),
  markCommentControlEffectsCompleted: vi.fn(),
  // Round-16: the route enqueues per-target wakeups here (durable outbox). In the
  // real system a background worker drains + dispatches them; the beforeEach mock
  // (below) inlines that drain — resolving each target's kind and calling
  // heartbeat.wakeup / enqueueAoaMentionWakeup — so the existing "waked agent X"
  // assertions keep exercising the same dispatch surface.
  enqueueCommentWakeups: vi.fn(),
  // Round-18 #2/#3: the route flips DEFERRED wakeup rows ready once attachment
  // rows / control effects are durable.
  markCommentWakeupsReady: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockProjectService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockGoalService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
}));
const mockRoutineService = vi.hoisted(() => ({}));
const mockMemoryLifecycleService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockCreateEagerWorkspaceForIssue = vi.hoisted(() => vi.fn());
// CREATE-path assignment dispatch now routes through the kind-aware chokepoint
// (crew → AoA dispatcher, org → heartbeat). We assert on this mock for the
// POST /issues delegation tests. Comment-path dispatch is ALSO kind-aware
// (crew arc review #1): org assignees → heartbeat.wakeup, crew (kind='aoa')
// assignees → svc.enqueueAoaMentionWakeup.
const mockEnqueueAssignee = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  memoryLifecycleService: () => mockMemoryLifecycleService,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
}));

vi.mock("../services/documents.js", () => ({
  documentService: () => mockDocumentService,
}));

vi.mock("../services/eager-workspace.js", () => ({
  createEagerWorkspaceForIssue: mockCreateEagerWorkspaceForIssue,
}));

vi.mock("../services/issue-assignee-wakeup.js", () => ({
  enqueueIssueAssigneeWakeup: mockEnqueueAssignee,
}));

const { issueRoutes } = await import("../routes/issues.js");

function createApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
      ...actorOverride,
    };
    next();
  });
  app.use(
    "/api",
    issueRoutes({
      // Round-12 #2: the keyed comment+reassign PATCH commits svc.update +
      // addComment in ONE db.transaction. The mocked issueService ignores its db
      // arg (issueService: () => mockIssueService), so running the callback with a
      // stub tx routes txSvc.update / txSvc.addComment back to the same mocks.
      transaction: async (cb: (tx: unknown) => unknown) => cb({}),
    } as any, {
      putFile: vi.fn(async (input: { originalFilename: string | null; contentType: string; body: Buffer }) => ({
        provider: "memory",
        objectKey: `stored/${input.originalFilename ?? "file"}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "sha256",
        originalFilename: input.originalFilename,
      })),
      getObject: vi.fn(),
      deleteObject: vi.fn(),
    } as any),
  );
  app.use(errorHandler);
  return app;
}

// Round-16: models the comment_wakeup_outbox (comment, agent) unique index so the
// mocked inline drain (enqueueCommentWakeups impl) delivers each target once.
const dispatchedWakeups = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  setDeploymentMode("local_trusted");
  mockAccessService.canUser.mockResolvedValue(true);
  mockAccessService.hasPermission.mockResolvedValue(true);
  mockIssueService.getById.mockResolvedValue(makeIssue());
  // Default: no crew assignees → comment wakeups route to heartbeat (org path).
  mockIssueService.resolveAgentKinds.mockResolvedValue(new Map());
  mockIssueService.enqueueAoaMentionWakeup.mockResolvedValue(undefined);
  // Default: no prior submission with this key → the create path runs.
  mockIssueService.getCommentByClientSubmissionId.mockResolvedValue(null);
  mockIssueService.markCommentControlEffectsCompleted.mockResolvedValue(undefined);
  mockIssueService.markCommentWakeupsReady.mockResolvedValue(undefined);
  // Round-16: enqueueCommentWakeups persists per-target rows to the durable outbox;
  // a background worker drains + dispatches them. This mock INLINES that drain —
  // resolving each target's kind and routing aoa → enqueueAoaMentionWakeup, org →
  // heartbeat.wakeup — so the existing dispatch assertions (heartbeat.wakeup /
  // enqueueAoaMentionWakeup called with agent X + reason Y) still hold end-to-end.
  dispatchedWakeups.clear();
  mockIssueService.enqueueCommentWakeups.mockImplementation(
    async (input: {
      companyId: string;
      commentId: string;
      targets: Array<{ agentId: string; wakeup: any }>;
    }) => {
      const kinds: Map<string, string> = await mockIssueService.resolveAgentKinds(
        input.targets.map((t) => t.agentId),
      );
      for (const t of input.targets) {
        // Model the (comment, agent) unique index + onConflictDoNothing: a target
        // already enqueued+delivered for this comment is a no-op on re-enqueue
        // (so a keyed retry / replay never re-wakes a succeeded target).
        const key = `${input.commentId}:${t.agentId}`;
        if (dispatchedWakeups.has(key)) continue;
        dispatchedWakeups.add(key);
        if (kinds.get(t.agentId) === "aoa") {
          const w = t.wakeup ?? {};
          await mockIssueService.enqueueAoaMentionWakeup(input.companyId, t.agentId, {
            source: w.source,
            reason: w.reason,
            payload: w.payload,
          });
        } else {
          await mockHeartbeatService.wakeup(t.agentId, t.wakeup);
        }
      }
    },
  );
  // Round-17 #1: addComment now enqueues the comment's wakeups IN ITS TX via the
  // buildWakeupTargets callback. The mock INVOKES that callback on a fresh insert
  // and routes the built targets to enqueueCommentWakeups (whose inline-drain mock
  // above then dispatches), so the existing "waked agent X" assertions still hold
  // end-to-end. Tests that override addComment with a `replayed` return skip this
  // (a replay never re-builds/enqueues — its rows already exist).
  mockIssueService.addComment.mockImplementation(
    async (
      issueIdArg: string,
      body: string,
      actor: {
        agentId?: string;
        userId?: string;
        buildWakeupTargets?: (comment: {
          id: string;
          authorAgentId: string | null;
        }) => Promise<Array<{ agentId: string; wakeup: unknown }>>;
      },
    ) => {
      const comment = {
        id: "comment-1",
        issueId: issueIdArg,
        companyId,
        body,
        authorAgentId: actor?.agentId ?? null,
        authorUserId: actor?.userId ?? "board-user",
      };
      if (actor?.buildWakeupTargets) {
        const targets = await actor.buildWakeupTargets({
          id: comment.id,
          authorAgentId: comment.authorAgentId,
        });
        await mockIssueService.enqueueCommentWakeups({
          companyId,
          issueId: issueIdArg,
          commentId: comment.id,
          targets,
        });
      }
      return comment;
    },
  );
  mockIssueService.createAttachment.mockImplementation(async (input: Record<string, unknown>) => ({
    id: `attachment-${mockIssueService.createAttachment.mock.calls.length}`,
    companyId,
    issueId,
    issueCommentId: input.issueCommentId,
    provider: input.provider,
    objectKey: input.objectKey,
    contentType: input.contentType,
    byteSize: input.byteSize,
    sha256: input.sha256,
    originalFilename: input.originalFilename,
  }));
  // Replay-completion (C6) delegates to the serialized service method. Default:
  // nothing missing → create nothing, no attachments. Tests that exercise the
  // replay-completion path override this per scenario.
  mockIssueService.completeMissingCommentAttachments.mockResolvedValue({ created: [], all: [] });
  mockIssueService.findMentionedAgents.mockResolvedValue([]);
  mockIssueService.notifyMentionedHumans.mockResolvedValue([]);
  mockHeartbeatService.wakeup.mockResolvedValue({ id: "run-1" });
  mockEnqueueAssignee.mockResolvedValue(undefined);
  mockCreateEagerWorkspaceForIssue.mockResolvedValue(null);
  mockProjectService.getById.mockResolvedValue({ id: "99999999-9999-4999-8999-999999999999", companyId });
  mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
    id: "new-issue",
    identifier: "ARM-2",
    companyId,
    title: input.title,
    status: input.status ?? "todo",
    workMode: input.workMode ?? "standard",
    projectId: input.projectId ?? null,
    parentId: input.parentId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    executionWorkspaceId: null,
  }));
  mockAgentService.getById.mockImplementation(async (id: string) => {
    const rows: Record<string, unknown> = {
      [leadAgentId]: {
        id: leadAgentId,
        companyId,
        role: "lead",
        status: "idle",
        reportsTo: null,
        permissions: {},
      },
      [assigneeAgentId]: {
        id: assigneeAgentId,
        companyId,
        role: "general",
        status: "idle",
        reportsTo: leadAgentId,
        permissions: {},
      },
      [mentionedAgentId]: {
        id: mentionedAgentId,
        companyId,
        role: "general",
        status: "idle",
        reportsTo: otherLeadAgentId,
        permissions: {},
      },
    };
    return rows[id] ?? null;
  });
});

describe("POST /companies/:companyId/issues/:issueId/attachments authorization ordering", () => {
  it.each([
    [
      "anonymous",
      {
        type: "none",
        source: "none",
        userId: undefined,
        isInstanceAdmin: false,
        companyIds: [],
      },
      401,
    ],
    [
      "cross-tenant board",
      {
        userId: "other-user",
        isInstanceAdmin: false,
        companyIds: [],
      },
      403,
    ],
  ])(
    "rejects %s before a company-scoped identifier lookup",
    async (_label, actor, expectedStatus) => {
      mockIssueService.getByIdentifierInCompany.mockResolvedValue(makeIssue());

      for (const identifier of ["ARM-1", "ARM-999", issueId]) {
        const res = await request(createApp(actor)).post(
          `/api/companies/${companyId}/issues/${identifier}/attachments`,
        );
        expect(res.status, `${identifier}: ${JSON.stringify(res.body)}`).toBe(expectedStatus);
      }

      expect(mockIssueService.getByIdentifierInCompany).not.toHaveBeenCalled();
      expect(mockIssueService.getById).not.toHaveBeenCalled();
      expect(mockIssueService.createAttachment).not.toHaveBeenCalled();
    },
  );
});

describe("POST /issues/:id/comments-with-attachments", () => {
  it("creates a comment, links attachments, then wakes the assignee once with attachment metadata", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Please inspect these screenshots")
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.comment.body).toBe("Please inspect these screenshots");
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].issueCommentId).toBe("comment-1");
    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(expect.objectContaining({
      issueId,
      issueCommentId: "comment-1",
      originalFilename: "proof.png",
      contentType: "image/png",
    }));

    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId,
          commentId: "comment-1",
          attachmentCount: 1,
          attachments: [
            expect.objectContaining({
              // Round-17 #1: the wake is built + enqueued IN addComment's tx from
              // a PRE-generated attachment id (the same id later threaded into
              // createAttachment), so it is a fresh UUID, not the mock's row id.
              id: expect.any(String),
              filename: "proof.png",
              contentType: "image/png",
            }),
          ],
        }),
        contextSnapshot: expect.objectContaining({
          issueId,
          taskId: issueId,
          wakeCommentId: "comment-1",
          attachmentCount: 1,
        }),
      }),
    );
  });

  it("routes a crew (kind='aoa') assignee's comment wakeup to the AoA dispatcher, NOT heartbeat (crew arc review #1)", async () => {
    // The task assignee is a crew agent → heartbeat.wakeup would be silently
    // refused (Decision #100, heartbeat.ts:4355) and the crew agent would never
    // run. The comment route must enqueue an AoA dispatcher wakeup instead.
    mockIssueService.resolveAgentKinds.mockResolvedValue(new Map([[assigneeAgentId, "aoa"]]));

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Please take a look")
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    await vi.waitFor(() =>
      expect(mockIssueService.enqueueAoaMentionWakeup).toHaveBeenCalledTimes(1),
    );
    expect(mockIssueService.enqueueAoaMentionWakeup).toHaveBeenCalledWith(
      companyId,
      assigneeAgentId,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({ issueId, commentId: "comment-1" }),
      }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("honors reopen=true for attachment comments and wakes with reopen context", async () => {
    const closedIssue = makeIssue({ status: "done" });
    const reopenedIssue = makeIssue({ status: "todo" });
    mockIssueService.getById.mockResolvedValue(closedIssue);
    mockIssueService.update.mockResolvedValue(reopenedIssue);

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Reopen with evidence")
      .field("reopen", "true")
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, { status: "todo" });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        entityId: issueId,
        details: expect.objectContaining({
          status: "todo",
          reopened: true,
          reopenedFrom: "done",
          source: "comment",
        }),
      }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({
          issueId,
          commentId: "comment-1",
          reopenedFrom: "done",
          attachmentCount: 1,
        }),
        contextSnapshot: expect.objectContaining({
          issueId,
          taskId: issueId,
          wakeCommentId: "comment-1",
          wakeReason: "issue_reopened_via_comment",
          reopenedFrom: "done",
          attachmentCount: 1,
        }),
      }),
    );
  });

  it("does NOT wake on reopen-via-comment when the task is in planning mode (D8 gate)", async () => {
    // A-M11: reopening a planning-mode task via comment must honor the D8
    // planning-mode dispatch gate. heartbeat.wakeup has no planning gate, so the
    // route's shared helper must suppress the reopen wakeup for planning tasks.
    const closedPlanningIssue = makeIssue({ status: "done", workMode: "planning" });
    const reopenedPlanningIssue = makeIssue({ status: "todo", workMode: "planning" });
    mockIssueService.getById.mockResolvedValue(closedPlanningIssue);
    mockIssueService.update.mockResolvedValue(reopenedPlanningIssue);

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Reopen this planning task")
      .field("reopen", "true")
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, { status: "todo" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockIssueService.enqueueAoaMentionWakeup).not.toHaveBeenCalled();
  });

  it("honors interrupt=true for board attachment comments and includes interruptedRunId in wake context", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionRunId: "run-active" }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-active",
      companyId,
      agentId: assigneeAgentId,
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-active",
      companyId,
      agentId: assigneeAgentId,
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Stop and inspect this")
      .field("interrupt", "true")
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-active");
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-active");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: "run-active",
        details: expect.objectContaining({
          agentId: assigneeAgentId,
          source: "issue_comment_interrupt",
          issueId,
        }),
      }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId,
          commentId: "comment-1",
          interruptedRunId: "run-active",
          attachmentCount: 1,
        }),
        contextSnapshot: expect.objectContaining({
          issueId,
          taskId: issueId,
          wakeCommentId: "comment-1",
          interruptedRunId: "run-active",
          attachmentCount: 1,
        }),
      }),
    );
  });

  it("rejects interrupt=true for non-board attachment comments before creating comments or attachments", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: assigneeAgentId,
      companyId,
      runId: "agent-run-1",
    }))
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Try to interrupt with evidence")
      .field("interrupt", "true")
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "Only board users can interrupt active runs from issue comments",
    });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.createAttachment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("accepts common context document attachments, not only images", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Use this repro log")
      .attach("files", Buffer.from("steps: reproduce"), { filename: "repro.md", contentType: "text/markdown" });

    expect(res.status).toBe(201);
    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(expect.objectContaining({
      originalFilename: "repro.md",
      contentType: "text/markdown",
    }));
  });

  it("does not wake the assigned agent for planning-mode comments with attachments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ workMode: "planning" }));

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Here is context for planning")
      .attach("files", validPng, { filename: "context.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("still wakes explicitly mentioned agents in planning mode", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ workMode: "planning" }));
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "@Beta please inspect this")
      .attach("files", validPng, { filename: "context.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      mentionedAgentId,
      expect.objectContaining({
        reason: "issue_comment_mentioned",
        payload: expect.objectContaining({
          issueId,
          commentId: "comment-1",
          attachmentCount: 1,
        }),
      }),
    );
  });

  it("rejects unsupported files without creating a comment or waking", async () => {
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Please inspect")
      .attach("files", Buffer.from("echo hi"), { filename: "run.sh", contentType: "application/x-sh" });

    expect(res.status).toBe(422);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.createAttachment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects a comment attachment whose bytes do not match the declared type (round-3 #5)", async () => {
    // The endpoint must sniff the real bytes, not trust the multipart mimetype:
    // arbitrary content labeled as an allowed image is rejected before any
    // comment or attachment is created.
    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Spoofed screenshot")
      .attach("files", Buffer.from("this is not a real png"), { filename: "evil.png", contentType: "image/png" });

    expect(res.status).toBe(422);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.createAttachment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("skips re-storing attachments and re-waking when addComment loses the insert race (round-3 #4)", async () => {
    // Two same-key requests both pass the route-level replay pre-check (neither
    // committed yet). The loser's insert is swallowed; addComment returns the
    // winner's row flagged `replayed`. The loser must NOT re-store files or
    // re-fire wakeups — it completes through the serialized (advisory-locked)
    // path, which finds nothing missing.
    const submissionId = "sub-race-loser";
    // A completed winner → the loser's idempotent re-enqueue is deduped by the
    // winner's already-delivered rows (round-16). Pre-seed the winner's delivery.
    dispatchedWakeups.add(`comment-1:${assigneeAgentId}`);
    const winner = {
      id: "comment-1",
      issueId,
      companyId,
      body: "Please inspect these screenshots",
      authorAgentId: null,
      authorUserId: "board-user",
      clientSubmissionId: submissionId,
      controlEffectsCompletedAt: new Date(0),
    };
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue(null); // pre-check missed it
    mockIssueService.addComment.mockResolvedValue({ ...winner, replayed: true });
    const winnerAttachment = {
      id: "attachment-1", issueId, issueCommentId: "comment-1", originalFilename: "proof.png", contentType: "image/png",
    };
    mockIssueService.listAttachments.mockResolvedValue([winnerAttachment]);
    mockIssueService.completeMissingCommentAttachments.mockResolvedValue({
      created: [],
      all: [winnerAttachment],
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Please inspect these screenshots")
      .field("clientSubmissionId", submissionId)
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body.comment.id).toBe("comment-1");
    // No direct re-store, no re-wake; only the serialized completion runs.
    expect(mockIssueService.createAttachment).not.toHaveBeenCalled();
    expect(mockIssueService.completeMissingCommentAttachments).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does NOT apply control effects (reopen/interrupt) when addComment loses the insert race (round-4 #3)", async () => {
    // A race loser must not reopen the task or cancel a run — only the insert
    // winner applies control effects. The reopen flag is set, but because
    // addComment reports `replayed`, applyIssueCommentControlEffects must be
    // skipped (svc.update / cancelRun never called).
    const submissionId = "sub-race-control";
    const closedIssue = makeIssue({ status: "done", executionRunId: "run-active" });
    mockIssueService.getById.mockResolvedValue(closedIssue);
    const winner = {
      id: "comment-1", issueId, companyId, body: "Reopen with evidence",
      authorAgentId: null, authorUserId: "board-user", clientSubmissionId: submissionId,
      controlEffectsCompletedAt: new Date(0), wakeupsEnqueuedAt: new Date(0),
    };
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({ ...winner, replayed: true });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.completeMissingCommentAttachments.mockResolvedValue({ created: [], all: [] });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments-with-attachments`)
      .field("body", "Reopen with evidence")
      .field("reopen", "true")
      .field("interrupt", "true")
      .field("clientSubmissionId", submissionId)
      .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    // Control effects were NOT applied by the loser.
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("replays the original comment+attachments and does not re-persist or re-wake on a retried key", async () => {
    const submissionId = "sub-att-1";
    const existing = {
      id: "comment-1",
      issueId,
      companyId,
      body: "Please inspect these screenshots",
      authorAgentId: null,
      authorUserId: "board-user",
      clientSubmissionId: submissionId,
      // Completed original → replay resumes no control effects / wakeups.
      controlEffectsCompletedAt: new Date(0),
      wakeupsEnqueuedAt: new Date(0),
    };
    mockIssueService.getCommentByClientSubmissionId
      .mockResolvedValueOnce(null) // first send creates
      .mockResolvedValueOnce(existing); // retry replays
    const existingAttachment = {
      id: "attachment-1", issueId, issueCommentId: "comment-1", originalFilename: "proof.png", contentType: "image/png",
    };
    mockIssueService.listAttachments.mockResolvedValue([existingAttachment]);
    // Nothing is missing on the retry → the serialized completion creates nothing
    // and returns the existing attachment.
    mockIssueService.completeMissingCommentAttachments.mockResolvedValue({
      created: [],
      all: [existingAttachment],
    });

    const app = createApp();
    const send = () =>
      request(app)
        .post(`/api/issues/${issueId}/comments-with-attachments`)
        .field("body", "Please inspect these screenshots")
        .field("clientSubmissionId", submissionId)
        .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    const first = await send();
    const retry = await send();

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.comment.id).toBe("comment-1");
    expect(retry.body.attachments).toHaveLength(1);

    // The retry must not persist a second comment, and the completion is
    // serialized through the dedicated service method (advisory-locked).
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.completeMissingCommentAttachments).toHaveBeenCalledTimes(1);
    // First send used createAttachment once (create path); the retry does NOT
    // touch createAttachment directly (it goes through the serialized method).
    expect(mockIssueService.createAttachment).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
  });

  it("completes missing attachments on a retried key after a partial failure (PR #291: no silent drop)", async () => {
    // The comment commits BEFORE the files are stored. If attachment
    // persistence dies after that point, the client's idempotent retry finds
    // the comment via the replay check — it must then store + record the
    // files the original send lost, not report success with a partial set. The
    // completion runs through the serialized (advisory-locked) service method.
    const submissionId = "sub-att-2";
    const existing = {
      id: "comment-1",
      issueId,
      companyId,
      body: "Please inspect these screenshots",
      authorAgentId: null,
      authorUserId: "board-user",
      clientSubmissionId: submissionId,
    };
    mockIssueService.getCommentByClientSubmissionId
      .mockResolvedValueOnce(null) // first send creates…
      .mockResolvedValueOnce(existing); // …retry replays
    // First send: the attachment row insert dies after the comment committed.
    mockIssueService.createAttachment.mockRejectedValueOnce(new Error("db blip"));
    // Nothing landed for this comment; the retry's serialized completion stores
    // + records the missing file.
    mockIssueService.listAttachments.mockResolvedValue([]);
    const completedAttachment = {
      id: "attachment-2", issueId, issueCommentId: "comment-1", originalFilename: "proof.png", contentType: "image/png",
    };
    mockIssueService.completeMissingCommentAttachments.mockResolvedValue({
      created: [completedAttachment],
      all: [completedAttachment],
    });

    const app = createApp();
    const send = () =>
      request(app)
        .post(`/api/issues/${issueId}/comments-with-attachments`)
        .field("body", "Please inspect these screenshots")
        .field("clientSubmissionId", submissionId)
        .attach("files", validPng, { filename: "proof.png", contentType: "image/png" });

    const first = await send();
    expect(first.status).toBe(500); // partial failure surfaced, retry offered

    const retry = await send();
    expect(retry.status).toBe(200);
    expect(retry.body.comment.id).toBe("comment-1");
    // The retry completed the missing attachment against the replayed comment.
    expect(retry.body.attachments).toHaveLength(1);
    expect(retry.body.attachments[0]).toMatchObject({
      issueCommentId: "comment-1",
      originalFilename: "proof.png",
    });
    // The retry delegated completion to the serialized method with the file.
    expect(mockIssueService.completeMissingCommentAttachments).toHaveBeenCalledTimes(1);
    expect(mockIssueService.completeMissingCommentAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId,
        commentId: "comment-1",
        files: expect.arrayContaining([
          expect.objectContaining({ originalFilename: "proof.png", contentType: "image/png" }),
        ]),
      }),
    );
    // An activity row is logged for the completed-on-retry attachment.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.attachment_added",
        details: expect.objectContaining({ completedOnRetry: true, commentId: "comment-1" }),
      }),
    );
    // Still exactly one durable comment (the fresh insert on the first send).
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);

    // Round-17 #1: the wake is enqueued IN addComment's transaction on the first
    // send, carrying attachment PREVIEWS built from the multipart files (before
    // external storage), so the woken agent receives attachment metadata even
    // though the files are stored after the comment tx. The worker delivers it
    // exactly once ((comment, agent) idempotency dedups the retry's re-enqueue).
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        payload: expect.objectContaining({ attachmentCount: 1 }),
      }),
    );
  });
});

describe("POST /issues/:id/comments (no attachments) — D8 reopen gate", () => {
  // A-M11: the plain comment route funnels through the SAME shared
  // enqueueIssueCommentWakeups helper as the attachments route, so the D8
  // planning-mode gate on reopen must cover this path too.
  it("does NOT wake on reopen-via-comment when the task is in planning mode", async () => {
    const closedPlanningIssue = makeIssue({ status: "done", workMode: "planning" });
    const reopenedPlanningIssue = makeIssue({ status: "todo", workMode: "planning" });
    mockIssueService.getById.mockResolvedValue(closedPlanningIssue);
    mockIssueService.update.mockResolvedValue(reopenedPlanningIssue);

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Reopen this planning task", reopen: true });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, { status: "todo" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockIssueService.enqueueAoaMentionWakeup).not.toHaveBeenCalled();
  });

  it("DOES wake on reopen-via-comment for a standard task (regression)", async () => {
    const closedIssue = makeIssue({ status: "done", workMode: "standard" });
    const reopenedIssue = makeIssue({ status: "todo", workMode: "standard" });
    mockIssueService.getById.mockResolvedValue(closedIssue);
    mockIssueService.update.mockResolvedValue(reopenedIssue);

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Reopen this standard task", reopen: true });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        reason: "issue_reopened_via_comment",
        payload: expect.objectContaining({ issueId, reopenedFrom: "done" }),
      }),
    );
  });
});

describe("POST /issues/:id/comments — idempotent retry (clientSubmissionId)", () => {
  // A retried Send (same clientSubmissionId, e.g. after a lost 201 response)
  // must not create a second durable comment and must not re-fire task
  // side-effects (wakeup/interrupt). The whole handler is gated, not just the
  // row insert — otherwise a retry could re-interrupt a run while the row dedups.
  const submissionId = "sub-1111-2222";
  // A fully-completed original: BOTH side-effect markers set, so a replay/
  // race-loser resumes nothing (round-7 #2/#3 completion tracking).
  const doneMarker = new Date("2026-07-17T00:00:00Z");
  const existingComment = {
    id: "comment-1",
    issueId,
    companyId,
    body: "Please inspect the logs",
    authorAgentId: null,
    authorUserId: "board-user",
    clientSubmissionId: submissionId,
    controlEffectsCompletedAt: doneMarker,
    wakeupsEnqueuedAt: doneMarker,
  };

  it("replays the same comment (200) and wakes at most once on a retried key", async () => {
    mockIssueService.getCommentByClientSubmissionId
      .mockResolvedValueOnce(null) // first attempt: not seen yet → create
      .mockResolvedValueOnce(existingComment); // retry: key already recorded → replay
    mockIssueService.addComment.mockResolvedValue(existingComment);

    const app = createApp();
    const first = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please inspect the logs", clientSubmissionId: submissionId });
    const retry = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please inspect the logs", clientSubmissionId: submissionId });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200); // replay is a read, not a new creation
    expect(retry.body.id).toBe("comment-1");

    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
  });

  it("resumes an incomplete reopen on the replay fast-path when the completion marker is NULL (round-6 #2)", async () => {
    // The original send committed the comment but died before reopening the task
    // (post-insert failure), so control_effects_completed_at is NULL. A same-key
    // Retry hits the replay fast-path — which must RESUME the reopen, then stamp.
    const stillClosed = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(stillClosed);
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "todo" }));
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue({
      ...existingComment,
      controlEffectsCompletedAt: null,
    }); // replay, effects never completed

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please inspect the logs", reopen: true, clientSubmissionId: submissionId });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("comment-1");
    // The reopen was resumed and the completion marker stamped.
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, { status: "todo" });
    expect(mockIssueService.markCommentControlEffectsCompleted).toHaveBeenCalledWith("comment-1");
    // addComment is NOT called on the replay path (no duplicate comment).
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("does NOT re-reopen on the replay fast-path when the completion marker is SET, even if the task was re-closed (round-6 #2)", async () => {
    // Deterministic: the original send's control effects completed
    // (control_effects_completed_at SET). The founder later legitimately
    // re-closed the task. A stale retry must NOT re-reopen it — the marker, not
    // the current task state, decides.
    const reClosed = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(reClosed);
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue({
      ...existingComment,
      controlEffectsCompletedAt: new Date("2026-07-17T00:00:00Z"),
    }); // replay, effects already completed

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please inspect the logs", reopen: true, clientSubmissionId: submissionId });

    expect(res.status).toBe(200);
    // Marker set → control effects skipped entirely; the re-closed task stays closed.
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.markCommentControlEffectsCompleted).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("returns the winner's comment without re-firing wakeups when addComment loses the insert race (round-3 #4)", async () => {
    // Both same-key requests pass the pre-check; the loser's insert is swallowed
    // and addComment returns the winner's row flagged `replayed`. Round-16: the
    // loser re-enqueues the SAME (comment, agent) targets — idempotent, so the
    // winner's already-delivered wakeup is NOT re-fired. Pre-seed the winner's
    // delivery to model the (comment, agent) unique index + worker dedup.
    dispatchedWakeups.add(`comment-1:${assigneeAgentId}`);
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({ ...existingComment, replayed: true });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please inspect the logs", clientSubmissionId: submissionId });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("comment-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No DOUBLE wake — the winner already delivered (idempotency dedups the loser).
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does NOT apply control effects when the race loser's winner already completed them (marker set, round-4 #3 / round-7 #2)", async () => {
    // Same-key race loser on the plain route: reopen requested, but the winner
    // already completed its control effects (existingComment markers set), so the
    // loser resumes nothing (svc.update never called).
    const closedIssue = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(closedIssue);
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({ ...existingComment, replayed: true });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please inspect the logs", reopen: true, clientSubmissionId: submissionId });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("RESUMES control effects + wakeups for a race loser when the winner's markers are NULL (round-7 #2/#3)", async () => {
    // The winner committed the comment then crashed BEFORE reopening or waking
    // (markers null). The loser is the client's success response, so it must
    // finish those side effects — else they are lost forever.
    const closedIssue = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(closedIssue);
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "todo" }));
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue(null); // pre-check missed it
    mockIssueService.addComment.mockResolvedValue({
      ...existingComment,
      controlEffectsCompletedAt: null,
      wakeupsEnqueuedAt: null,
      replayed: true,
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Please inspect the logs", reopen: true, clientSubmissionId: submissionId });

    expect(res.status).toBe(200);
    // Control effects resumed (task was still closed) and stamped.
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, { status: "todo" });
    expect(mockIssueService.markCommentControlEffectsCompleted).toHaveBeenCalledWith("comment-1");
    // Round-16: wakeups resumed by RE-ENQUEUEING the per-target rows (idempotent);
    // the inline-drain mock then delivers the assignee's reopen wake once.
    expect(mockIssueService.enqueueCommentWakeups).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "comment-1" }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
  });

  it("RESUMES only the wakeups on replay when control effects are done but wakeups are NULL (round-7 #3)", async () => {
    // The original completed control effects (marker set) but died during
    // activity logging before enqueuing wakeups (marker null). The @mention must
    // still wake — resume ONLY the wakeups, not the control effects.
    // No assignee → only the @mention wakes (isolates the wakeup-resume path).
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: null }));
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue({
      ...existingComment,
      body: "@Beta please take a look",
      controlEffectsCompletedAt: new Date("2026-07-17T00:00:00Z"),
      wakeupsEnqueuedAt: null,
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "@Beta please take a look", clientSubmissionId: submissionId });

    expect(res.status).toBe(200);
    // Control effects NOT re-applied (already done).
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.markCommentControlEffectsCompleted).not.toHaveBeenCalled();
    // Round-16: the mentioned agent's wakeup is resumed via idempotent re-enqueue.
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockIssueService.enqueueCommentWakeups).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "comment-1" }),
    );
  });

  it("enqueues the comment's wakeups into the durable per-target outbox (round-16)", async () => {
    // Round-16: the wakeups_enqueued_at marker + claim/release CAS are gone. The
    // route now persists per-target wakeup rows via svc.enqueueCommentWakeups; the
    // background worker delivers each exactly once. (Crash recovery + per-target
    // no-double-wake are proven against real Postgres in the outbox integration
    // suite; here we assert the route hands the targets to the durable outbox.)
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: null }));
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "@Beta please take a look", clientSubmissionId: submissionId });

    expect(res.status).toBe(201);
    expect(mockIssueService.enqueueCommentWakeups).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        issueId,
        commentId: "comment-1",
        targets: expect.arrayContaining([expect.objectContaining({ agentId: mentionedAgentId })]),
      }),
    );
  });

  it("a keyed retry re-enqueues idempotently and wakes the agent at most once (round-16)", async () => {
    // The send + retry both hand the SAME (comment, agent) target to the outbox;
    // the (comment, agent) unique index + worker dedup deliver it once. Modeled by
    // the inline-drain mock's dedup set — so the mentioned agent is woken once.
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: null }));
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);
    mockIssueService.getCommentByClientSubmissionId
      .mockResolvedValueOnce(null) // first send: fresh
      .mockResolvedValue({
        ...existingComment,
        body: "@Beta please take a look",
        controlEffectsCompletedAt: new Date("2026-07-17T00:00:00Z"),
      });

    const app = createApp();
    const first = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "@Beta please take a look", clientSubmissionId: submissionId });
    const retry = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "@Beta please take a look", clientSubmissionId: submissionId });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    // Both enqueue the same target; the outbox idempotency delivers it once.
    expect(mockIssueService.enqueueCommentWakeups).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
  });

  it("passes the clientSubmissionId through to addComment on the create path", async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "First send", clientSubmissionId: submissionId });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "First send",
      expect.objectContaining({ clientSubmissionId: submissionId }),
    );
  });
});

describe("PATCH /issues/:id — comment+reassign idempotency (round-10 #2)", () => {
  it("threads clientSubmissionId into addComment on the combined comment+reassign PATCH path", async () => {
    // The composer's comment+reassign combined mutation posts the comment via
    // the issue PATCH path. That comment insert must carry the submission key so
    // a retry replays it (server dedup) instead of duplicating the comment.
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: leadAgentId }));
    mockIssueService.update.mockResolvedValue(makeIssue({ assigneeAgentId: assigneeAgentId }));
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-9",
      issueId,
      companyId,
      body: "please take this over",
      authorAgentId: null,
      authorUserId: "board-user",
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        comment: "please take this over",
        assigneeAgentId,
        clientSubmissionId: "reassign-key-1",
      });

    expect(res.status).toBe(200);
    // The submission key reached addComment (idempotent insert)…
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "please take this over",
      expect.objectContaining({ clientSubmissionId: "reassign-key-1" }),
    );
    // …and it was NOT leaked into svc.update's issue-field payload.
    const updateArgs = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updateArgs).not.toHaveProperty("clientSubmissionId");
    expect(updateArgs).not.toHaveProperty("comment");
  });

  it("does NOT re-PATCH the task or re-log on a same-key comment+reassign Retry (round-11 #2)", async () => {
    // A completed original: the keyed comment already exists and the original
    // already delivered its wakeup. The Retry must be detected EARLY (before
    // svc.update) and short-circuit — no second svc.update, no duplicate
    // issue.updated activity, no duplicate comment. Round-16: the retry
    // re-enqueues the same target idempotently; the original's delivery dedups it
    // (pre-seed the winner's delivery to model the (comment, agent) unique index).
    dispatchedWakeups.add(`comment-9:${assigneeAgentId}`);
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId }));
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue({
      id: "comment-9",
      issueId,
      companyId,
      body: "please take this over",
      authorAgentId: null,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "please take this over", assigneeAgentId, clientSubmissionId: "reassign-key-2" });

    expect(res.status).toBe(200);
    expect(res.body.comment.id).toBe("comment-9");
    // The task is NOT re-mutated and nothing re-logged / re-inserted.
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.updated" }),
    );
    // Marker already set → wakeups are not resumed (no double-wake).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("RESUMES the comment's wakeups on a Retry when the marker is NULL — no re-PATCH (round-11 #1)", async () => {
    // The original committed the comment but died before durably enqueuing its
    // wakeups (marker null). The Retry resumes them (awaited before stamping) and
    // never re-mutates the task. No assignee on the issue → isolate the @mention.
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: null }));
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue({
      id: "comment-9",
      issueId,
      companyId,
      body: "@Beta please take a look",
      authorAgentId: null,
      wakeupsEnqueuedAt: null,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "@Beta please take a look", clientSubmissionId: "reassign-key-3" });

    expect(res.status).toBe(200);
    expect(res.body.comment.id).toBe("comment-9");
    // The task is NOT re-mutated.
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    // Round-16: the keyed-PATCH replay RE-ENQUEUES the comment's wakeup targets
    // (idempotent); the inline-drain mock then delivers the @mention wake once.
    expect(mockIssueService.enqueueCommentWakeups).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: "comment-9",
        targets: expect.arrayContaining([expect.objectContaining({ agentId: mentionedAgentId })]),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      mentionedAgentId,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
  });
});

describe("POST /companies/:companyId/issues agent delegation", () => {
  function agentActor(agentId = leadAgentId) {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    };
  }

  it("lets a lead create and assign a child task to a direct report", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === parentIssueId ? makeIssue({ id: parentIssueId }) : makeIssue({ id }),
    );

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Child task",
        status: "todo",
        parentId: parentIssueId,
        assigneeAgentId,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Child task",
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: leadAgentId,
      }),
    );
    await vi.waitFor(() => expect(mockEnqueueAssignee).toHaveBeenCalledTimes(1));
    expect(mockEnqueueAssignee).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: assigneeAgentId, issueId: "new-issue", reason: "issue_assigned", source: "assignment" }),
    );
  });

  it("rejects non-empty agent-authored acceptance criteria", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: parentIssueId }));

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Child task with self-authored criteria",
        status: "todo",
        parentId: parentIssueId,
        assigneeAgentId,
        acceptanceCriteria: ["Agent decides when the work is complete"],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agents cannot define their own task acceptance criteria");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("blocks a lead assigning a child task outside direct reports", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: parentIssueId }));

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Out of scope child task",
        status: "todo",
        parentId: parentIssueId,
        assigneeAgentId: mentionedAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "Cannot assign target agent",
      reason: "target_not_direct_report",
      allowedActions: ["create_unassigned", "assign_to_self", "request_routing_from_lead"],
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockEnqueueAssignee).not.toHaveBeenCalled();
  });

  it("queues assignment to a paused direct report without waking it", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: parentIssueId }));
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === leadAgentId) {
        return { id: leadAgentId, companyId, role: "lead", status: "idle", reportsTo: null, permissions: {} };
      }
      if (id === assigneeAgentId) {
        return { id: assigneeAgentId, companyId, role: "general", status: "paused", reportsTo: leadAgentId, permissions: {} };
      }
      return null;
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Paused child task",
        status: "todo",
        parentId: parentIssueId,
        assigneeAgentId,
      });

    expect(res.status).toBe(201);
    expect(res.body.wakeSkippedReason).toBe("assignee_paused");
    expect(mockIssueService.create).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockEnqueueAssignee).not.toHaveBeenCalled();
  });

  it("ensures project workspace before waking an assigned agent", async () => {
    const projectId = "99999999-9999-4999-8999-999999999999";
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: parentIssueId }));

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Workspace child task",
        status: "todo",
        projectId,
        parentId: parentIssueId,
        assigneeAgentId,
      });

    expect(res.status).toBe(201);
    expect(mockCreateEagerWorkspaceForIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        issueId: "new-issue",
        issueIdentifier: "ARM-2",
        issueTitle: "Workspace child task",
        projectId,
      }),
    );
    await vi.waitFor(() => expect(mockEnqueueAssignee).toHaveBeenCalledTimes(1));
    expect(mockCreateEagerWorkspaceForIssue.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnqueueAssignee.mock.invocationCallOrder[0],
    );
  });

  it("does not wake assigned agent when workspace ensure fails", async () => {
    const projectId = "99999999-9999-4999-8999-999999999999";
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: parentIssueId }));
    mockCreateEagerWorkspaceForIssue.mockRejectedValueOnce(new Error("worktree exists"));

    const res = await request(createApp(agentActor()))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Workspace failed child task",
        status: "todo",
        projectId,
        parentId: parentIssueId,
        assigneeAgentId,
      });

    expect(res.status).toBe(201);
    expect(res.body.wakeSkippedReason).toBe("workspace_setup_failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockEnqueueAssignee).not.toHaveBeenCalled();
  });
});
