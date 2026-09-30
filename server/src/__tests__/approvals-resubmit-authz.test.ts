/**
 * @fileoverview FU-18 — the missing authorization gate on
 * `POST /approvals/:id/resubmit`.
 *
 * Before the fix the handler ran `assertCompanyAccess` plus ONE actor check that
 * fired only for `req.actor.type === "agent"`. A same-company `mcp` API-key actor
 * — not a board user at all — sailed past it and could rewrite `payload`
 * wholesale (the schema is `z.record(z.unknown())`). The sibling
 * approve/reject/request-revision routes all run `assertBoard`; resubmit did not,
 * and `boardMutationGuard` doesn't cover it (it only inspects `board` actors).
 *
 * The correct gate is NOT a blanket `assertBoard` — this route deliberately
 * supports an agent resubmitting its OWN approval
 * (`type === "agent" && agentId === requestedByAgentId`), and `assertBoard` would
 * 403 that legitimate path. The shape is "board OR the requesting agent".
 *
 * These are focused, minimal-mock characterizations of the five required cases.
 * The broader adversarial coverage lives in
 * `mcp-connector-approval-adversarial.test.ts` ([ESC-2]).
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getById = vi.fn();
const resubmit = vi.fn();

const { emitHubItem, buildApprovalHubEmit } = vi.hoisted(() => ({
  emitHubItem: vi.fn(),
  buildApprovalHubEmit: vi.fn((approval) => ({ sourceType: "approval", sourceId: approval.id })),
}));

vi.mock("../services/index.js", () => ({
  approvalService: () => ({
    getById,
    resubmit,
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
    list: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
    create: vi.fn(),
  }),
  issueApprovalService: () => ({ listIssuesForApproval: vi.fn().mockResolvedValue([]) }),
  trustScoreService: () => ({ updateOnReview: vi.fn() }),
  heartbeatService: () => ({ wakeup: vi.fn().mockResolvedValue(null) }),
  notifyHireApproved: vi.fn(),
  secretService: () => ({
    // Identity: forwards the payload untouched so we observe exactly what the
    // route hands the service.
    normalizeHireApprovalPayloadForPersistence: async (
      _companyId: string,
      payload: unknown,
    ) => payload,
  }),
  logActivity: vi.fn(),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  buildApprovalHubEmit,
  emitHubItem,
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({ reconcile: vi.fn() }),
}));

import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/error-handler.js";

const COMPANY = "company-A";
const APPROVAL_ID = "ap-1";
const REQUESTING_AGENT = "agent-1";

function makeApp(actor: unknown) {
  const app = express();
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ __tx: true })),
  };
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(db as never));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-A",
  companyIds: [COMPANY],
  isInstanceAdmin: false,
};
const mcpKeyActor = {
  type: "mcp" as const,
  source: "mcp_key" as const,
  companyId: COMPANY,
  userId: null,
};
const requestingAgentActor = {
  type: "agent" as const,
  source: "token" as const,
  companyId: COMPANY,
  agentId: REQUESTING_AGENT,
};
const foreignAgentActor = { ...requestingAgentActor, agentId: "agent-2" };

// A resubmittable approval (hire_agent is NOT on SYSTEM_INTERNAL_APPROVAL_TYPES),
// requested originally by REQUESTING_AGENT.
const pendingApproval = (overrides: Record<string, unknown> = {}) => ({
  id: APPROVAL_ID,
  companyId: COMPANY,
  status: "revision_requested",
  type: "hire_agent",
  payload: { agentId: "a1" },
  requestedByAgentId: REQUESTING_AGENT,
  requestedByUserId: null,
  ...overrides,
});

describe("FU-18 POST /approvals/:id/resubmit — board OR requesting agent only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getById.mockResolvedValue(pendingApproval());
    resubmit.mockResolvedValue(pendingApproval({ status: "pending" }));
    emitHubItem.mockResolvedValue({ id: "hub-1", version: 0 });
  });

  it("a board user CAN resubmit", async () => {
    const res = await request(makeApp(boardActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "a1" } });
    expect(res.status).toBe(200);
    expect(resubmit).toHaveBeenCalledWith(APPROVAL_ID, COMPANY, { agentId: "a1" });
  });

  it("the REQUESTING agent CAN resubmit its own approval", async () => {
    const res = await request(makeApp(requestingAgentActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "a1" } });
    expect(res.status).toBe(200);
    expect(resubmit).toHaveBeenCalledWith(APPROVAL_ID, COMPANY, { agentId: "a1" });
  });

  it("an MCP API-key actor is 403 and the service is never reached", async () => {
    const res = await request(makeApp(mcpKeyActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "evil" } });
    expect(res.status).toBe(403);
    expect(resubmit).not.toHaveBeenCalled();
  });

  it("a DIFFERENT agent (not the requester) is 403", async () => {
    const res = await request(makeApp(foreignAgentActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "evil" } });
    expect(res.status).toBe(403);
    expect(resubmit).not.toHaveBeenCalled();
  });

  it("REGRESSION FLOOR: the legitimate agent-resubmits-own path still works", async () => {
    // Pinned separately from the happy-path case above so a future 'board only'
    // over-correction (a blanket assertBoard) is caught here explicitly.
    getById.mockResolvedValue(pendingApproval({ requestedByAgentId: REQUESTING_AGENT }));
    const res = await request(makeApp(requestingAgentActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: {} });
    expect(res.status).toBe(200);
    expect(resubmit).toHaveBeenCalled();
  });

  it("an unauthenticated caller is 401 (assertCompanyAccess floor)", async () => {
    const res = await request(makeApp({ type: "none" }))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: {} });
    expect(res.status).toBe(401);
    expect(resubmit).not.toHaveBeenCalled();
  });
});
