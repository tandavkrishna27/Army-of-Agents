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
          if (!cols[prop]) cols[prop] = Symbol(prop);
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
    // A-M9: confirm/dismiss now run inside db.transaction with a FOR NO KEY
    // UPDATE lock via execute(). Run the callback against the same db so the
    // select-sequence ordering is preserved; execute() resolves the lock.
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

describe("output detection company scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactSvc.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      title: "Other company artifact",
      versions: [],
    });
    mocks.artifactSvc.addVersion.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      artifactId: "11111111-1111-4111-8111-111111111111",
      versionNumber: 2,
    });
  });

  it("rejects confirming a company run output into another company's artifact", async () => {
    const db = makeDb([
      [
        {
          companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          contextSnapshot: { issueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
          detectedOutputs: [
            {
              path: "dist/report.pdf",
              filename: "report.pdf",
              byteSize: 123,
              contentType: "application/pdf",
              assetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              sha256: "abc123",
              source: "workspace_diff",
              status: "pending",
            },
          ],
        },
      ],
    ]);

    const response = await request(makeApp(db))
      .post("/api/heartbeat-runs/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/detected-outputs/0/confirm")
      .send({
        artifactId: "11111111-1111-4111-8111-111111111111",
        changelog: "Captured report",
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Artifact does not belong to this company/);
    expect(mocks.artifactSvc.addVersion).not.toHaveBeenCalled();
  });
});
