import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { workQuestionRoutes } from "../routes/work-questions.js";

const service = vi.hoisted(() => ({
  listForUser: vi.fn(),
  listDetailsForUser: vi.fn(),
  getForUser: vi.fn(),
  getDetailForUser: vi.fn(),
  answer: vi.fn(),
  reassign: vi.fn(),
  takeOver: vi.fn(),
  retryContinuation: vi.fn(),
  cancelByUser: vi.fn(),
}));
vi.mock("../services/index.js", () => ({
  workQuestionService: () => service,
}));

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const QUESTION = "33333333-3333-4333-8333-333333333333";
const ISSUE = "44444444-4444-4444-8444-444444444444";
const row = {
  id: QUESTION,
  companyId: COMPANY,
  status: "answered",
  currentRecipientUserId: "user-1",
  continuationStatus: "pending",
  version: 1,
};

function app(actor: unknown = {
  type: "board",
  source: "session",
  userId: "user-1",
  companyIds: [COMPANY],
  isInstanceAdmin: false,
}) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  instance.use("/api", workQuestionRoutes({} as never));
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  service.listForUser.mockResolvedValue([row]);
  service.listDetailsForUser.mockResolvedValue([{ question: row, capabilities: { read: true } }]);
  service.getForUser.mockResolvedValue(row);
  service.getDetailForUser.mockResolvedValue({ question: row, capabilities: { read: true } });
  service.answer.mockResolvedValue(row);
  service.reassign.mockResolvedValue({ ...row, status: "open", currentRecipientUserId: "user-2" });
  service.takeOver.mockResolvedValue({ ...row, status: "open" });
  service.retryContinuation.mockResolvedValue(row);
  service.cancelByUser.mockResolvedValue({ ...row, status: "cancelled" });
});

describe("work question routes", () => {
  it("defaults the list to the signed-in recipient", async () => {
    const response = await request(app()).get(`/api/companies/${COMPANY}/work-questions?status=open`);
    expect(response.status).toBe(200);
    expect(service.listForUser).toHaveBeenCalledWith(
      COMPANY,
      { userId: "user-1", instanceAdmin: false },
      expect.objectContaining({ status: "open", currentRecipientUserId: "user-1" }),
    );
  });

  it("does not force recipient filtering for a task mirror query", async () => {
    const response = await request(app()).get(`/api/companies/${COMPANY}/work-questions?issueId=${ISSUE}`);
    expect(response.status).toBe(200);
    expect(service.listForUser.mock.calls[0][2].currentRecipientUserId).toBeUndefined();
    expect(service.listForUser.mock.calls[0][2].issueId).toBe(ISSUE);
  });

  it("returns batched inline details without narrowing a source timeline to the current recipient", async () => {
    const response = await request(app()).get(`/api/companies/${COMPANY}/work-questions/inline?issueId=${ISSUE}`);
    expect(response.status).toBe(200);
    expect(service.listDetailsForUser).toHaveBeenCalledWith(
      COMPANY,
      { userId: "user-1", instanceAdmin: false },
      expect.objectContaining({ issueId: ISSUE, currentRecipientUserId: undefined }),
    );
  });

  it("answers with optimistic versioning through the transactional service", async () => {
    const response = await request(app())
      .post(`/api/companies/${COMPANY}/work-questions/${QUESTION}/answer`)
      .send({ answer: { selectedValues: ["yes"] }, expectedVersion: 0, idempotencyKey: "answer-1" });
    expect(response.status).toBe(200);
    expect(service.answer).toHaveBeenCalledWith(
      COMPANY,
      QUESTION,
      { userId: "user-1", instanceAdmin: false },
      { answer: { selectedValues: ["yes"] }, expectedVersion: 0, idempotencyKey: "answer-1" },
    );
  });

  it("wires reassign, takeover, retry, and cancel mutations", async () => {
    const reassign = await request(app())
      .post(`/api/companies/${COMPANY}/work-questions/${QUESTION}/reassign`)
      .send({ userId: "user-2", expectedVersion: 0 });
    const takeOver = await request(app())
      .post(`/api/companies/${COMPANY}/work-questions/${QUESTION}/take-over`)
      .send({ expectedVersion: 0 });
    const retry = await request(app())
      .post(`/api/companies/${COMPANY}/work-questions/${QUESTION}/retry-continuation`)
      .send({ expectedVersion: 1 });
    const cancel = await request(app())
      .post(`/api/companies/${COMPANY}/work-questions/${QUESTION}/cancel`)
      .send({ expectedVersion: 0 });
    expect([reassign.status, takeOver.status, retry.status, cancel.status]).toEqual([200, 200, 200, 200]);
    expect(service.reassign).toHaveBeenCalled();
    expect(service.takeOver).toHaveBeenCalled();
    expect(service.retryContinuation).toHaveBeenCalled();
    expect(service.cancelByUser).toHaveBeenCalled();
  });

  it("rejects cross-company and non-board access before service calls", async () => {
    const crossCompany = await request(app()).get(`/api/companies/${OTHER_COMPANY}/work-questions`);
    const agent = await request(app({ type: "agent", companyId: COMPANY, agentId: "agent-1" }))
      .get(`/api/companies/${COMPANY}/work-questions`);
    expect(crossCompany.status).toBe(403);
    expect(agent.status).toBe(401);
    expect(service.listForUser).not.toHaveBeenCalled();
  });
});
