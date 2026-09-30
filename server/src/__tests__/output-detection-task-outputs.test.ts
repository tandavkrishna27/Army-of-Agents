import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    heartbeatRuns: makeTable("heartbeat_runs"),
    issues: makeTable("issues"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _type: "and", args }),
  eq: (col: unknown, value: unknown) => ({ _type: "eq", col, value }),
  isNotNull: (col: unknown) => ({ _type: "isNotNull", col }),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
      as: vi.fn().mockReturnValue({ strings, values }),
    })),
    { raw: vi.fn((value: string) => value) },
  ),
}));

const mocks = vi.hoisted(() => ({
  artifactSvc: {
    getById: vi.fn(),
    addVersion: vi.fn(),
    create: vi.fn(),
  },
  taskOutputSvc: {
    upsertForIssue: vi.fn(),
  },
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  artifactService: () => mocks.artifactSvc,
  taskOutputService: () => mocks.taskOutputSvc,
  logActivity: mocks.logActivity,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    getByIdentifier: vi.fn().mockResolvedValue(null),
  }),
}));

import { outputDetectionRoutes } from "../routes/output-detection.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const issueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const projectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const assetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(rows));
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve([]));
  return chain;
}

function makeDb(selectRows: unknown[][]) {
  let selectIndex = 0;
  const db: Record<string, unknown> = {
    select: vi.fn(() => makeSelectChain(selectRows[selectIndex++] ?? [])),
    update: vi.fn(() => makeUpdateChain()),
    // A-M9: the confirm/dismiss cores now wrap their read-modify-write in
    // db.transaction and take a `FOR NO KEY UPDATE` lock via execute(). The
    // mock runs the callback against the same db so the select-sequence
    // ordering is preserved, and execute() is a no-op resolving the lock.
    execute: vi.fn(() => Promise.resolve([])),
  };
  db.transaction = vi.fn((cb: (tx: unknown) => unknown) => Promise.resolve(cb(db)));
  return db;
}

function makeApp(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      companyIds: [],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", outputDetectionRoutes(db as never));
  return app;
}

function runRow() {
  return {
    companyId,
    agentId,
    contextSnapshot: { issueId },
    detectedOutputs: [
      {
        path: "dist/report.pdf",
        filename: "report.pdf",
        byteSize: 123,
        contentType: "application/pdf",
        assetId,
        sha256: "abc123",
        source: "workspace_diff",
        label: "Final report",
        status: "pending",
      },
    ],
  };
}

describe("output detection task output emitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactSvc.create.mockResolvedValue({
      id: "artifact-1",
      companyId,
      title: "report.pdf",
      versions: [{ id: "version-1", versionNumber: 1 }],
    });
    mocks.artifactSvc.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId,
      title: "Existing artifact",
      versions: [],
    });
    mocks.artifactSvc.addVersion.mockResolvedValue({
      id: "version-existing-2",
      artifactId: "11111111-1111-4111-8111-111111111111",
      versionNumber: 2,
    });
    mocks.taskOutputSvc.upsertForIssue.mockResolvedValue({ id: "task-output-1" });
  });

  it("creates a task output when a detected file becomes a new artifact", async () => {
    const db = makeDb([
      [runRow()],
      [{ artifactId: null, projectId }],
    ]);

    const response = await request(makeApp(db))
      .post(`/api/heartbeat-runs/${runId}/detected-outputs/0/confirm`)
      .send({ title: "Report" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      artifactId: "artifact-1",
      versionId: "version-1",
      status: "confirmed",
    });
    expect(mocks.taskOutputSvc.upsertForIssue).toHaveBeenCalledWith(companyId, issueId, expect.objectContaining({
      type: "artifact",
      provider: "aoa",
      externalId: `detected-output:${runId}:0`,
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      assetId,
      title: "report.pdf",
      reviewState: "needs_review",
      isPrimary: true,
      createdByRunId: runId,
      createdByAgentId: agentId,
    }));
  });

  it("creates an artifact version output when confirmed into an existing artifact", async () => {
    const db = makeDb([
      [runRow()],
      [{ artifactId: "primary-artifact", projectId }],
    ]);

    const response = await request(makeApp(db))
      .post(`/api/heartbeat-runs/${runId}/detected-outputs/0/confirm`)
      .send({ artifactId: "11111111-1111-4111-8111-111111111111" });

    expect(response.status).toBe(200);
    expect(mocks.taskOutputSvc.upsertForIssue).toHaveBeenCalledWith(companyId, issueId, expect.objectContaining({
      type: "artifact_version",
      artifactId: "11111111-1111-4111-8111-111111111111",
      artifactVersionId: "version-existing-2",
      isPrimary: false,
    }));
  });

  it("does not overwrite an existing task primary artifact link for additional new artifacts", async () => {
    const db = makeDb([
      [runRow()],
      [{ artifactId: "already-primary", projectId }],
    ]);

    const response = await request(makeApp(db))
      .post(`/api/heartbeat-runs/${runId}/detected-outputs/0/confirm`)
      .send({ title: "Another artifact" });

    expect(response.status).toBe(200);
    expect(mocks.taskOutputSvc.upsertForIssue).toHaveBeenCalledWith(companyId, issueId, expect.objectContaining({
      type: "artifact",
      isPrimary: false,
    }));
  });
});
