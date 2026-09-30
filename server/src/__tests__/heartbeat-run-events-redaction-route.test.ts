import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// BRW-003d-2 — the BINDING test.
//
// ★ WHY THIS FILE EXISTS. In BRW-003d-1 a mutant survived because a constant was
// covered by unit tests while its WIRING into the app was not — deleting the
// binding left every assertion green. The unit tier here proves that
// `redactRunEventPayload` strips URLs; only this file proves the events ROUTE
// actually calls it. Swapping the route back to `redactEventPayload` must turn
// something red, and this is that something.

const RUN_ID = "run-1";
const COMPANY = "11111111-1111-4111-8111-111111111111";

const mockHeartbeat = vi.hoisted(() => ({
  getRun: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({}),
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  heartbeatService: () => mockHeartbeat,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn(
    (_agent: unknown, config: Record<string, unknown>) => config,
  ),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));
vi.mock("@armyofagents/adapter-claude-local/server", () => ({ runClaudeLogin: vi.fn() }));
vi.mock("@armyofagents/adapter-codex-local", () => ({
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX: false,
  DEFAULT_CODEX_LOCAL_MODEL: "gpt-4.1",
}));
vi.mock("@armyofagents/adapter-cursor-local", () => ({
  DEFAULT_CURSOR_LOCAL_MODEL: "claude-sonnet-4-20250514",
}));
vi.mock("@armyofagents/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

const { agentRoutes } = await import("../routes/agents.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as never));
  return app;
}

describe("BRW-003d-2 — GET /heartbeat-runs/:runId/events redacts URL secrets", () => {
  it("strips a query string from an event payload served over HTTP", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: COMPANY });
    mockHeartbeat.listEvents.mockResolvedValue([
      {
        id: "e1",
        seq: 1,
        payload: {
          // An unrecognisable token: it matches no secret pattern, so ONLY the
          // structural pass can remove it.
          url: "https://ex.com/callback?access_token=abc123",
          message: "navigated to https://ex.com/x?sid=leakme",
        },
      },
    ]);

    const response = await request(createApp()).get(`/api/heartbeat-runs/${RUN_ID}/events`);

    expect(response.status).toBe(200);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain("abc123");
    expect(body).not.toContain("leakme");
    // Still diagnostically useful — the host and path survive.
    expect(body).toContain("https://ex.com/callback");
  });

  it("keeps the pattern-based redaction it composes with", async () => {
    mockHeartbeat.getRun.mockResolvedValue({ id: RUN_ID, companyId: COMPANY });
    mockHeartbeat.listEvents.mockResolvedValue([
      { id: "e1", seq: 1, payload: { args: ["--token", "sk-ant-abcdefghijklmnop123456"] } },
    ]);

    const response = await request(createApp()).get(`/api/heartbeat-runs/${RUN_ID}/events`);

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("sk-ant-");
  });
});
