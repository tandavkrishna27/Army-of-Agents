import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  orgForCompany: vi.fn().mockResolvedValue([]),
  listConfigRevisions: vi.fn().mockResolvedValue([]),
  getConfigRevision: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  backfillParentFields: vi.fn().mockResolvedValue(0),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  // Called by PATCH /instructions-path after the agent write.
  syncEnvBindingsForTarget: vi.fn().mockResolvedValue(undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: Record<string, unknown>) => config),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

vi.mock("@armyofagents/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: null,
    updatedAt: new Date(),
  };
}

describe("agent instructions bundle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [{
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      }],
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Agent\n",
    });
    mockAgentInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "AGENTS.md",
        size: 18,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
        content: "# Updated Agent\n",
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
  });

  it("returns bundle metadata", async () => {
    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
    });
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
  });

  it("writes a bundle file and persists compatibility config", async () => {
    const res = await request(createApp())
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({
        path: "AGENTS.md",
        content: "# Updated Agent\n",
        clearLegacyPromptTemplate: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AGENTS.md",
      "# Updated Agent\n",
      { clearLegacyPromptTemplate: true },
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("returns 404 when agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1");

    expect(res.status).toBe(404);
  });

  it("reads a single bundle file", async () => {
    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1&path=AGENTS.md");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      path: "AGENTS.md",
      content: "# Agent\n",
    });
    expect(mockAgentInstructionsService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AGENTS.md",
    );
  });

  it("returns 422 when path query parameter is missing on file read", async () => {
    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1");

    expect(res.status).toBe(422);
  });

  it("deletes a bundle file", async () => {
    mockAgentInstructionsService.deleteFile.mockResolvedValue({
      bundle: {
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        mode: "managed",
        rootPath: "/tmp/agent-1",
        managedRootPath: "/tmp/agent-1",
        entryFile: "AGENTS.md",
        resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
        editable: true,
        warnings: [],
        legacyPromptTemplateActive: false,
        legacyBootstrapPromptTemplateActive: false,
        files: [],
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });

    const res = await request(createApp())
      .delete("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1&path=docs/TOOLS.md");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "docs/TOOLS.md",
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("patches bundle config", async () => {
    mockAgentInstructionsService.updateBundle.mockResolvedValue({
      bundle: {
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        mode: "external",
        rootPath: "/tmp/external",
        managedRootPath: "/tmp/agent-1",
        entryFile: "AGENTS.md",
        resolvedEntryPath: "/tmp/external/AGENTS.md",
        editable: true,
        warnings: [],
        legacyPromptTemplateActive: false,
        legacyBootstrapPromptTemplateActive: false,
        files: [],
      },
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/tmp/external",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/external/AGENTS.md",
      },
    });

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1")
      .send({ mode: "external", rootPath: "/tmp/external" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ mode: "external", rootPath: "/tmp/external" });
    expect(mockAgentInstructionsService.updateBundle).toHaveBeenCalled();
    expect(mockAgentService.update).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalled();
  });

  // ── D22: instruction edits are customizations, not app code ──────────────
  // Every route that can change what an agent's instructions SAY must stamp
  // `instructionsCustomized: true`, or `crew-updater` will full-replace the edit
  // on the next catalog bump.

  it("marks the agent customized when a bundle file is written", async () => {
    const res = await request(createApp())
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({ path: "AGENTS.md", content: "# Founder edit\n" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { instructionsCustomized: true },
    );
  });

  it("marks the agent customized when a bundle file is deleted", async () => {
    mockAgentInstructionsService.deleteFile.mockResolvedValue({
      bundle: { files: [] },
      adapterConfig: { instructionsBundleMode: "managed" },
    });

    const res = await request(createApp())
      .delete("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1&path=docs/TOOLS.md");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { instructionsCustomized: true },
    );
  });

  it("marks the agent customized when the bundle config is repointed", async () => {
    mockAgentInstructionsService.updateBundle.mockResolvedValue({
      bundle: { mode: "external", rootPath: "/tmp/external", files: [] },
      adapterConfig: { instructionsBundleMode: "external", instructionsRootPath: "/tmp/external" },
    });

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1")
      .send({ mode: "external", rootPath: "/tmp/external" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { instructionsCustomized: true },
    );
  });

  // ── F1: PATCH /agents/:id is the FIFTH instruction-changing write path ────
  //
  // The generic agent PATCH accepts a free-form `adapterConfig`, and several of
  // its keys are read (or destroyed) by the instructions bundle. The route
  // already recognises two of them as instruction changes — it gates them on
  // `assertCanManageInstructionsPath`, the same authz check the dedicated
  // instructions routes use — but it did not stamp the D22 flag, so a founder's
  // Prompt Template was full-replaced on the next catalog bump.

  const PATCH_URL =
    "/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1";

  it.each([
    ["promptTemplate", { promptTemplate: "# my custom heartbeat prompt" }],
    ["bootstrapPromptTemplate", { bootstrapPromptTemplate: "# first-run prompt" }],
    ["instructionsFilePath", { instructionsFilePath: "/tmp/mine/AGENTS.md" }],
    ["agentsMdPath", { agentsMdPath: "/tmp/mine/AGENTS.md" }],
    ["instructionsRootPath", { instructionsRootPath: "/tmp/mine" }],
    ["instructionsEntryFile", { instructionsEntryFile: "PLAYBOOK.md" }],
    ["instructionsBundleMode", { instructionsBundleMode: "external" }],
  ])("marks the agent customized when PATCH /agents/:id changes %s", async (_key, adapterConfig) => {
    const res = await request(createApp()).patch(PATCH_URL).send({ adapterConfig });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ instructionsCustomized: true }),
      expect.any(Object),
    );
  });

  // THE DISCRIMINATOR for F1. Without it, "stamp on every PATCH that carries an
  // adapterConfig" would pass every case above — and that would mark an agent
  // customized for a model change, freezing it out of catalog updates forever.
  it("does NOT mark the agent customized for a non-instruction adapterConfig change", async () => {
    const res = await request(createApp())
      .patch(PATCH_URL)
      .send({ adapterConfig: { model: "gpt-4.1", cwd: "/tmp/work" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("instructionsCustomized");
  });

  it("does NOT mark the agent customized for a PATCH that carries no adapterConfig", async () => {
    const res = await request(createApp()).patch(PATCH_URL).send({ title: "Chief of Staff" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("instructionsCustomized");
  });

  // ── F3: the flag must be stamped BEFORE founder content reaches disk ─────
  //
  // Writing the file first and stamping second leaves a window in which an
  // edited bundle sits on disk with `instructions_customized = false` — which
  // the updater will full-replace. Over-stamping a write that then fails costs
  // one spurious notification; under-stamping costs the founder's work.

  it("stamps the flag before writing the file to disk (PUT)", async () => {
    const order: string[] = [];
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      if (patch.instructionsCustomized === true) order.push("stamp");
      return { ...makeAgent(), adapterConfig: patch.adapterConfig ?? {} };
    });
    mockAgentInstructionsService.writeFile.mockImplementation(async () => {
      order.push("disk");
      return {
        bundle: null,
        file: { path: "AGENTS.md", size: 1, language: "markdown", markdown: true, isEntryFile: true, editable: true, deprecated: false, virtual: false, content: "x" },
        adapterConfig: { instructionsBundleMode: "managed" },
      };
    });

    const res = await request(createApp())
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({ path: "AGENTS.md", content: "# edit\n" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(order).toEqual(["stamp", "disk"]);
  });

  it("stamps the flag before deleting the file from disk (DELETE)", async () => {
    const order: string[] = [];
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      if (patch.instructionsCustomized === true) order.push("stamp");
      return { ...makeAgent(), adapterConfig: patch.adapterConfig ?? {} };
    });
    mockAgentInstructionsService.deleteFile.mockImplementation(async () => {
      order.push("disk");
      return { bundle: { files: [] }, adapterConfig: { instructionsBundleMode: "managed" } };
    });

    const res = await request(createApp())
      .delete("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1&path=docs/TOOLS.md");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(order).toEqual(["stamp", "disk"]);
  });

  it("stamps the flag before repointing the bundle on disk (PATCH bundle)", async () => {
    const order: string[] = [];
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      if (patch.instructionsCustomized === true) order.push("stamp");
      return { ...makeAgent(), adapterConfig: patch.adapterConfig ?? {} };
    });
    mockAgentInstructionsService.updateBundle.mockImplementation(async () => {
      order.push("disk");
      return {
        bundle: { mode: "external", rootPath: "/tmp/external", files: [] },
        adapterConfig: { instructionsBundleMode: "external" },
      };
    });

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1")
      .send({ mode: "external", rootPath: "/tmp/external" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(order).toEqual(["stamp", "disk"]);
  });

  it("marks the agent customized when the legacy instructions path is repointed", async () => {
    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-path?companyId=company-1")
      .send({ path: "/tmp/external/AGENTS.md" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ instructionsCustomized: true }),
      expect.any(Object),
    );
  });
});
