import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";
import { memoryRoutes } from "../routes/memory.js";

// Task W4: memory.ts now imports embeddingQueue from @armyofagents/db and
// helper functions from embeddings-backfill.js / memory-write.js.
// Mock these so this existing test doesn't break.
vi.mock("@armyofagents/db", () => ({
  embeddingQueue: makeTableProxy("embedding_queue"),
  memoryItems: makeTableProxy("memory_items"),
  ...new Proxy({}, {
    get: (_t, prop: string) => (typeof prop === "string" ? makeTableProxy(prop) : undefined),
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: (..._a: unknown[]) => ({}),
  and: (..._a: unknown[]) => ({}),
  inArray: (..._a: unknown[]) => ({}),
  isNull: (..._a: unknown[]) => ({}),
  notInArray: (..._a: unknown[]) => ({}),
  sql: (..._a: unknown[]) => ({}),
}));

vi.mock("../services/embeddings-backfill.js", () => ({
  reindexCompany: vi.fn().mockResolvedValue({ requeuedFailed: 0, enqueuedMissing: 0 }),
}));

vi.mock("../services/memory-write.js", () => ({
  enqueueMemoryEmbedding: vi.fn().mockResolvedValue(undefined),
  writeMemoryAndIndex: vi.fn(),
}));

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ userId: "u-1", actorType: "user" }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
  assertMemoryAccess: async () => undefined,
  assertMemoryApproval: async () => undefined,
}));

vi.mock("../services/index.js", () => {
  return {
    memoryService: () => ({
      moveItem: vi.fn(async (id: string, _companyId: string, folderPath: string) => {
        if (id === "missing") return null;
        return { id, companyId: _companyId, folderPath };
      }),
      setPinnedToTop: vi.fn(async (id: string, _companyId: string, pinned: boolean) => {
        if (id === "missing") return null;
        return { id, companyId: _companyId, founderPinnedToTop: pinned };
      }),
    }),
    companyBrainGraphService: () => ({}),
    logActivity: vi.fn(async () => undefined),
  };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(memoryRoutes({} as never));
  return app;
}

describe("memory routes — move + pin-to-top", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PATCH /companies/:cid/memory/items/:id/move updates folderPath", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/move")
      .send({ folderPath: "Engineering/Decisions" });
    expect(res.status).toBe(200);
    expect(res.body.folderPath).toBe("Engineering/Decisions");
  });

  it("PATCH /move returns 400 for invalid path", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/move")
      .send({ folderPath: "/leading/slash" });
    expect(res.status).toBe(400);
  });

  it("PATCH /move returns 404 if item missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/missing/move")
      .send({ folderPath: "Engineering" });
    expect(res.status).toBe(404);
  });

  it("PATCH /pin-to-top sets the flag", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/pin-to-top")
      .send({ pinned: true });
    expect(res.status).toBe(200);
    expect(res.body.founderPinnedToTop).toBe(true);
  });

  it("PATCH /pin-to-top returns 400 if pinned is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/companies/co-1/memory/items/i-1/pin-to-top")
      .send({});
    expect(res.status).toBe(400);
  });
});
