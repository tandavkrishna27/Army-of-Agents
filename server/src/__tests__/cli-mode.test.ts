import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";

// importOriginal keeps the real `execFile` export present: cli-mode.ts now
// transitively imports it (via the E2B one-shot provider-credential chain,
// U13.x), and the provider resolution it drives fails gracefully to host
// login in tests. We still override execSync/spawn (test-controlled).
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Simulate production layout: mcp-bridge.js exists → command = 'node' (not 'tsx').
// Without this, getBridgeEntrypoint() falls back to the .ts path in dev mode
// and the MCP spec would use 'tsx'. Tests assert the production contract.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn() }; // never throws → .js "exists"
});

// MX4: the chat writes the claude mcp-config JSON via fs/promises.writeFile
// and (for codex) provisions a managed CODEX_HOME via the MX3 codex helper.
// Mock both so the per-CLI wiring can be asserted without touching disk.
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

// MX-chatparse: the chat now also parses codex stdout via the REAL
// parseCodexJsonl / isCodexUnknownSessionError from this barrel (pure
// functions — we want their true behavior, not a stub). Only the disk
// writers are stubbed; the parsers come from importOriginal.
//
// MX-chatauth: the codex chat ALSO provisions auth.json into its
// per-session CODEX_HOME via ensureCodexAuthInHome (so `codex exec` is
// authenticated). Stub it too so the wiring can be asserted without
// touching the user's real ~/.codex/auth.json.
vi.mock("@armyofagents/adapter-codex-local/server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@armyofagents/adapter-codex-local/server")
  >();
  return {
    ...actual,
    writeCodexMcpConfigToml: vi.fn(async () => {}),
    ensureCodexAuthInHome: vi.fn(async () => true),
    // REVIEW FIX S3/C7: stub so argv tests never read the host's ~/.codex
    // and the resolved model is always deterministic (falls through to DEFAULT).
    readSharedCodexModel: vi.fn(async () => null),
  };
});

// Task 3 (MCP connectors → Commander): the claude_cli chat now resolves the
// company's active connectors via resolveAgentConnectors before spawning. Stub
// it so the DB-less cliModeService({} as any) tests never hit real DB I/O.
// DEFAULT = no connectors → the claude wiring stays byte-identical to pre-Task-3
// (the existing argv/writeFile/spawnEnv assertions below still hold). The
// connector-delivery test overrides this per-test with mockResolvedValue.
vi.mock("../services/mcp-connectors-loader.js", () => ({
  resolveAgentConnectors: vi.fn(async () => ({ extraMcpServers: {}, connectorEnv: {} })),
}));

// ── Session Store Tests ─────────────────────────────────────────────────────

describe("CLISessionStore", () => {
  let store: ReturnType<typeof import("../services/internal-agent/cli-session-store.js").createCLISessionStore>;

  beforeEach(async () => {
    const mod = await import("../services/internal-agent/cli-session-store.js");
    store = mod.createCLISessionStore();
  });

  afterEach(() => {
    store.shutdownAll();
  });

  it("creates and retrieves a session by key", () => {
    const mockSession = {
      cliProcess: { kill: vi.fn(), on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/aoa-mcp-comp1:user1.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    expect(store.get("comp1:user1")).toBe(mockSession);
  });

  it("returns undefined for non-existent key", () => {
    expect(store.get("no:such")).toBeUndefined();
  });

  it("deletes a session", () => {
    const mockSession = {
      cliProcess: { kill: vi.fn(), on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    store.delete("comp1:user1");
    expect(store.get("comp1:user1")).toBeUndefined();
  });

  it("has() returns correct boolean", () => {
    expect(store.has("comp1:user1")).toBe(false);
    const mockSession = {
      cliProcess: { kill: vi.fn(), on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "codex" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    expect(store.has("comp1:user1")).toBe(true);
  });

  it("getStale returns sessions older than threshold", () => {
    const old = new Date(Date.now() - 31 * 60 * 1000); // 31 min ago
    const mockSession = {
      cliProcess: { kill: vi.fn(), on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: old,
      lastMessageAt: old,
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    const stale = store.getStale(30 * 60 * 1000);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBe("comp1:user1");
  });

  it("getStale ignores recent sessions", () => {
    const mockSession = {
      cliProcess: { kill: vi.fn(), on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    const stale = store.getStale(30 * 60 * 1000);
    expect(stale).toHaveLength(0);
  });

  it("canEnqueue returns false when queue is full", () => {
    const mockSession = {
      cliProcess: { kill: vi.fn(), on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: Array.from({ length: 5 }, () => ({ resolve: vi.fn(), reject: vi.fn() })),
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    expect(store.canEnqueue("comp1:user1")).toBe(false);
  });

  it("canEnqueue returns true when queue has space", () => {
    const mockSession = {
      cliProcess: { kill: vi.fn(), on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    expect(store.canEnqueue("comp1:user1")).toBe(true);
  });

  it("cleanup kills process and removes session", () => {
    const kill1 = vi.fn();
    const mockSession = {
      cliProcess: { kill: kill1, on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    store.cleanup("comp1:user1");
    expect(kill1).toHaveBeenCalledWith("SIGTERM");
    expect(store.has("comp1:user1")).toBe(false);
  });

  it("shutdownAll kills all processes", () => {
    const kill1 = vi.fn();
    const mockSession = {
      cliProcess: { kill: kill1, on: vi.fn(), stdin: { write: vi.fn() }, stdout: { on: vi.fn() }, stderr: { on: vi.fn() } },
      mcpProcess: null,
      cliTool: "claude_cli" as const,
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      startedAt: new Date(),
      lastMessageAt: new Date(),
      mcpConfigPath: "/tmp/test.json",
      status: "active" as const,
      messageQueue: [],
      processing: false,
    };
    store.set("comp1:user1", mockSession);
    store.shutdownAll();
    expect(kill1).toHaveBeenCalled();
    expect(store.has("comp1:user1")).toBe(false);
  });
});

// ── CLI Detection Tests ───────────────────────────────────────────────────────

describe("detectCliTool", () => {
  let detectCliTool: typeof import("../services/internal-agent/cli-mode.js").detectCliTool;
  let mockExecSync: typeof execSync;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Re-acquire the mock reference after resetModules so it matches
    // the instance that the freshly-imported cli-mode.js receives.
    const cp = await import("node:child_process");
    mockExecSync = cp.execSync;
    const mod = await import("../services/internal-agent/cli-mode.js");
    detectCliTool = mod.detectCliTool;
  });

  it("detects claude_cli when claude binary is in PATH", async () => {
    vi.mocked(mockExecSync).mockReturnValue("/usr/local/bin/claude\n" as any);
    const result = await detectCliTool("claude_cli");
    expect(result.available).toBe(true);
    expect(result.path).toBe("/usr/local/bin/claude");
  });

  it("detects codex when binary is in PATH", async () => {
    vi.mocked(mockExecSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const result = await detectCliTool("codex");
    expect(result.available).toBe(true);
    expect(result.path).toBe("/usr/local/bin/codex");
  });

  it("detects opencode when binary is in PATH", async () => {
    vi.mocked(mockExecSync).mockReturnValue("/usr/local/bin/opencode\n" as any);
    const result = await detectCliTool("opencode");
    expect(result.available).toBe(true);
    expect(result.path).toBe("/usr/local/bin/opencode");
  });

  it("returns error when CLI tool not found", async () => {
    vi.mocked(mockExecSync).mockImplementation(() => {
      throw new Error("not found");
    });
    const result = await detectCliTool("claude_cli");
    expect(result.available).toBe(false);
    expect(result.error).toContain("not found in PATH");
    expect(result.error).toContain("Install the CLI");
  });

  it("returns error for unknown tool type", async () => {
    const result = await detectCliTool("unknown_tool" as any);
    expect(result.available).toBe(false);
    expect(result.error).toContain("Unsupported");
  });
});

// ── MCP Config Builder Tests ──────────────────────────────────────────────────

describe("buildMcpConfig", () => {
  let buildMcpConfig: typeof import("../services/internal-agent/cli-mode.js").buildMcpConfig;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("../services/internal-agent/cli-mode.js");
    buildMcpConfig = mod.buildMcpConfig;
  });

  it("produces valid JSON with mcpServers.aoa structure", () => {
    const config = buildMcpConfig({
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing", "system_actions"],
      bridgeEntrypoint: "/app/dist/mcp-bridge.js",
    });

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.aoa).toBeDefined();
    expect(config.mcpServers.aoa.command).toBe("node");
    expect(config.mcpServers.aoa.args).toContain("/app/dist/mcp-bridge.js");
    expect(config.mcpServers.aoa.env.AOA_SESSION_COMPANY_ID).toBe("comp1");
    expect(config.mcpServers.aoa.env.AOA_SESSION_USER_ID).toBe("user1");
    expect(config.mcpServers.aoa.env.AOA_SESSION_USER_ROLE).toBe("founder");
    expect(config.mcpServers.aoa.env.AOA_SESSION_ENABLED_CAPABILITIES).toBe(
      "discussion_processing,system_actions",
    );
  });

  it("inherits DATABASE_URL from process.env", () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:5432/db";
    const config = buildMcpConfig({
      companyId: "c",
      userId: "u",
      userRole: "founder",
      enabledCapabilities: [],
      bridgeEntrypoint: "/app/bridge.js",
    });
    expect(config.mcpServers.aoa.env.DATABASE_URL).toBe("postgres://test:5432/db");
    process.env.DATABASE_URL = original;
  });
});

// ── Tool Registry Tests ───────────────────────────────────────────────────────

describe("tool registry for MCP bridge", () => {
  it("createToolRegistry returns at least 25 tools", async () => {
    const { createToolRegistry } = await import(
      "../services/internal-agent/tool-registry.js"
    );
    const tools = createToolRegistry();
    expect(tools.length).toBeGreaterThanOrEqual(25);
  });

  it("all tools have required MCP fields (name, description, parameters)", async () => {
    const { createToolRegistry } = await import(
      "../services/internal-agent/tool-registry.js"
    );
    const tools = createToolRegistry();
    for (const tool of tools) {
      expect(tool.name, `tool missing name`).toBeTruthy();
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
      expect(tool.parameters, `${tool.name} missing parameters`).toBeDefined();
      expect(tool.parameters.type, `${tool.name} parameters.type should be 'object'`).toBe("object");
    }
  });

  it("all tool names are unique", async () => {
    const { createToolRegistry } = await import(
      "../services/internal-agent/tool-registry.js"
    );
    const tools = createToolRegistry();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("tools can be converted to MCP format", async () => {
    const { createToolRegistry } = await import(
      "../services/internal-agent/tool-registry.js"
    );
    const { toolToMcpFormat } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const tools = createToolRegistry();
    const mcpTools = tools.map(toolToMcpFormat);
    for (const mcp of mcpTools) {
      expect(mcp).toHaveProperty("name");
      expect(mcp).toHaveProperty("description");
      expect(mcp).toHaveProperty("inputSchema");
    }
  });
});

// ── Output Parsing Tests ──────────────────────────────────────────────────────

describe("parseCliOutput", () => {
  let parseCliOutput: typeof import("../services/internal-agent/cli-mode.js").parseCliOutput;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import("../services/internal-agent/cli-mode.js");
    parseCliOutput = mod.parseCliOutput;
  });

  it("converts text line to content chunk", () => {
    const chunks = parseCliOutput("Hello, I can help with that.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: "text", delta: "Hello, I can help with that." });
  });

  it("handles empty line as content", () => {
    const chunks = parseCliOutput("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ type: "text", delta: "" });
  });

  it("handles multi-byte characters", () => {
    const chunks = parseCliOutput("Tasks: create '\u30C7\u30E2' task");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("text");
  });
});

// ── MCP Bridge Tests ──────────────────────────────────────────────────────────

describe("MCP bridge tool handler", () => {
  it("handleToolCall routes to executeTool and returns result", async () => {
    const { createToolCallHandler } = await import(
      "../services/internal-agent/mcp-bridge.js"
    );

    const mockExecuteTool = vi.fn().mockResolvedValue({
      success: true,
      data: [{ id: "t1", title: "Test task" }],
      summary: "Found 1 task",
    });

    const handler = createToolCallHandler({
      tools: [
        {
          name: "query_tasks",
          description: "Query tasks",
          parameters: { type: "object" as const, properties: {} },
          category: "query" as const,
          requiredRole: "team_member" as const,
          requiresConfirmation: false,
          execute: vi.fn(),
        },
      ],
      executeTool: mockExecuteTool,
      toolContext: {
        companyId: "comp1",
        userId: "user1",
        userRole: "founder",
        enabledCapabilities: [],
        db: {} as any,
        services: {} as any,
      },
    });

    const result = await handler("query_tasks", { status: "todo" });
    expect(mockExecuteTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "query_tasks" }),
      { status: "todo" },
      expect.objectContaining({ companyId: "comp1" }),
    );
    expect(result.content).toBeDefined();
    expect(result.isError).toBeFalsy();
  });

  it("returns error for unknown tool name", async () => {
    const { createToolCallHandler } = await import(
      "../services/internal-agent/mcp-bridge.js"
    );

    const handler = createToolCallHandler({
      tools: [],
      executeTool: vi.fn(),
      toolContext: {
        companyId: "comp1",
        userId: "user1",
        userRole: "founder",
        enabledCapabilities: [],
        db: {} as any,
        services: {} as any,
      },
    });

    const result = await handler("nonexistent_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
  });

  it("returns error when executeTool throws", async () => {
    const { createToolCallHandler } = await import(
      "../services/internal-agent/mcp-bridge.js"
    );

    const mockExecuteTool = vi.fn().mockRejectedValue(new Error("DB connection failed"));

    const handler = createToolCallHandler({
      tools: [
        {
          name: "query_tasks",
          description: "Query tasks",
          parameters: { type: "object" as const, properties: {} },
          category: "query" as const,
          requiredRole: "team_member" as const,
          requiresConfirmation: false,
          execute: vi.fn(),
        },
      ],
      executeTool: mockExecuteTool,
      toolContext: {
        companyId: "comp1",
        userId: "user1",
        userRole: "founder",
        enabledCapabilities: [],
        db: {} as any,
        services: {} as any,
      },
    });

    const result = await handler("query_tasks", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DB connection failed");
  });
});

describe("buildToolListResponse", () => {
  it("converts AgentTool array to MCP tool list format", async () => {
    const { buildToolListResponse } = await import(
      "../services/internal-agent/mcp-bridge.js"
    );

    const tools = [
      {
        name: "query_tasks",
        description: "Query tasks",
        parameters: { type: "object" as const, properties: { status: { type: "string" } } },
        category: "query" as const,
        requiredRole: "team_member" as const,
        requiresConfirmation: false,
        execute: vi.fn(),
      },
    ];

    const result = buildToolListResponse(tools as any);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "query_tasks",
      description: "Query tasks",
      inputSchema: { type: "object", properties: { status: { type: "string" } } },
    });
  });
});

// ── CLI Mode Service Tests ──────────────────────────────────────────────────

describe("cliModeService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("yields error when CLI tool not in PATH", async () => {
    // Mock execSync to throw (tool not found)
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockImplementation(() => {
      throw new Error("not found");
    });

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );

    const service = cliModeService({} as any);
    const config = { cliTool: "claude_cli", executionMode: "cli" } as any;
    const params = {
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      content: "hello",
      // conversationId is required (W7.5d checks it before the host CLI probe).
      conversationId: "conv-a",
    };

    const chunks: any[] = [];
    for await (const chunk of service.chat(params, config)) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.type === "error")).toBe(true);
    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk.message).toContain("not found in PATH");
  });

  it("yields error when cliTool is not configured", async () => {
    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );

    const service = cliModeService({} as any);
    const config = { cliTool: null, executionMode: "cli" } as any;
    const params = {
      companyId: "comp1",
      userId: "user1",
      userRole: "founder",
      content: "hello",
    };

    const chunks: any[] = [];
    for await (const chunk of service.chat(params, config)) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.type === "error")).toBe(true);
    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk.message).toContain("No CLI tool configured");
  });

  it("exposes shutdown method", async () => {
    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    expect(typeof service.shutdown).toBe("function");
    // Should not throw
    service.shutdown();
  });

  it("exposes getSessionStore method", async () => {
    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    const store = service.getSessionStore();
    expect(typeof store.get).toBe("function");
    expect(typeof store.set).toBe("function");
    expect(typeof store.shutdownAll).toBe("function");
  });
});

// ── MX4: per-CLI chat wiring (F-codex-chat) ─────────────────────────────────
//
// The chat must give each CLI its OWN correct invocation:
//  - claude_cli  : write {mcpServers:{aoa}} JSON, spawn `claude` with
//                  ["--mcp-config", <json>, "-p", <content>, "--output-format",
//                  "text"] — BYTE-UNCHANGED from pre-MX4.
//  - codex       : provision a per-session managed CODEX_HOME via the MX3
//                  writeCodexMcpConfigToml(<dir>, <neutral spec>), spawn
//                  `codex` with argv starting ["exec","--json"], NO
//                  --mcp-config, NO -p, and spawn env CODEX_HOME=<dir>.
//  - opencode    : NO spawn — emit an explicit "not yet supported" error.

describe("cliModeService.chat — per-CLI wiring (MX4)", () => {
  function makeFakeProcess() {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // W1 stdin fix: claude writes the prompt to stdin then closes it, so the
    // fake stdin must expose both write + end.
    proc.stdin = { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    // Drive the stream helper to completion once the chat attaches its
    // stdout/exit listeners (streamProcessOutput registers them lazily).
    // Emitting on listener-attach avoids a race where a fixed-timer emit
    // fires before the chat subscribes and the for-await loop hangs.
    let driven = false;
    const drive = () => {
      if (driven) return;
      driven = true;
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from("ok"));
        proc.emit("exit", 0, null);
        proc.emit("close", 0, null);
      });
    };
    proc.stdout.on("newListener", drive);
    proc.on("newListener", (ev: string) => {
      if (ev === "exit") drive();
    });
    return proc;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function runChat(
    cliTool: string,
    configOverrides: Record<string, unknown> = {},
  ) {
    const cp = await import("node:child_process");
    // CLI detected as available (where/which succeeds).
    vi.mocked(cp.execSync).mockReturnValue(`/usr/local/bin/x\n` as any);
    const fake = makeFakeProcess();
    vi.mocked(cp.spawn).mockReturnValue(fake as any);

    const fsp = await import("node:fs/promises");
    const codexMod = await import("@armyofagents/adapter-codex-local/server");

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    const chunks: any[] = [];
    for await (const chunk of service.chat(
      {
        companyId: "comp1",
        userId: "user1",
        userRole: "founder",
        content: "hello world",
        enabledCapabilities: [],
        conversationId: "conversation-a",
      } as any,
      { cliTool, executionMode: "cli", ...configOverrides } as any,
    )) {
      chunks.push(chunk);
    }
    return {
      chunks,
      spawn: vi.mocked(cp.spawn),
      writeFile: vi.mocked(fsp.writeFile),
      writeCodexMcpConfigToml: vi.mocked(codexMod.writeCodexMcpConfigToml),
      ensureCodexAuthInHome: vi.mocked(codexMod.ensureCodexAuthInHome),
      fake,
    };
  }

  it("claude_cli: spawns `claude` with print-mode flags and delivers the prompt over stdin (W1 fix), no argv positional", async () => {
    const { spawn, writeFile, writeCodexMcpConfigToml, ensureCodexAuthInHome, fake } =
      await runChat("claude_cli");

    // claude path is byte-unchanged: no codex CODEX_HOME provisioning at
    // all — neither the config.toml writer nor the MX-chatauth auth copy.
    expect(writeCodexMcpConfigToml).not.toHaveBeenCalled();
    expect(ensureCodexAuthInHome).not.toHaveBeenCalled();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [binary, args] = spawn.mock.calls[0];
    expect(binary).toBe("claude");

    // W1 stdin fix: the argv ends at the flags — the prompt is NO LONGER an
    // argv positional. On Windows the positional rode through cmd.exe and was
    // silently dropped (the empty/garbage Commander turn). The prompt is
    // delivered over stdin instead (asserted below).
    expect(args[0]).toBe("--mcp-config");
    expect(typeof args[1]).toBe("string");
    expect(args[1]).toMatch(/\.json$/);
    // D2: --strict-mcp-config pairs with --mcp-config so the CLI does NOT also
    // load the host ~/.claude.json / project .mcp.json (and claude.ai connectors).
    expect(args[2]).toBe("--strict-mcp-config");
    expect(args[3]).toBe("--dangerously-skip-permissions");
    expect(args[4]).toBe("--print");
    expect(args[5]).toBe("--output-format");
    expect(args[6]).toBe("stream-json");
    expect(args[7]).toBe("--include-partial-messages");
    expect(args[8]).toBe("--verbose");
    // No content positional — argv stops at the flags.
    expect(args).toHaveLength(9);
    expect(args.join(" ")).not.toContain("hello world");
    expect(args).not.toContain("exec");

    // The RAW (unescaped) prompt is written to stdin, then stdin is closed
    // (claude --print is one-shot — reads to EOF, answers, exits).
    expect(fake.stdin.write).toHaveBeenCalledTimes(1);
    expect(String(fake.stdin.write.mock.calls[0][0])).toContain("hello world");
    // Raw, not the win32 cmd-escaped quoted form.
    expect(String(fake.stdin.write.mock.calls[0][0])).not.toContain('""');
    expect(fake.stdin.end).toHaveBeenCalledTimes(1);

    // claude path writes the {mcpServers:{aoa}} wrapper JSON to a tmp file.
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [jsonPath, jsonBody] = writeFile.mock.calls[0];
    expect(String(jsonPath)).toMatch(/\.json$/);
    const parsed = JSON.parse(String(jsonBody));
    expect(parsed.mcpServers.aoa.command).toBe("node");
  });

  it("claude_cli: omits vendor permission bypass flag when disabled", async () => {
    const { spawn } = await runChat("claude_cli", {
      vendorCliBypassEnabled: false,
    });

    const [, args] = spawn.mock.calls[0];
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("codex: provisions managed CODEX_HOME via MX3 helper and spawns `codex exec --json` (no --mcp-config/-p)", async () => {
    const { spawn, writeCodexMcpConfigToml, ensureCodexAuthInHome } =
      await runChat("codex");

    // MX3 helper invoked with (dir, neutral spec).
    expect(writeCodexMcpConfigToml).toHaveBeenCalledTimes(1);
    const [codexDir, spec] = writeCodexMcpConfigToml.mock.calls[0];
    expect(typeof codexDir).toBe("string");
    expect(String(codexDir).length).toBeGreaterThan(0);

    // MX-chatauth: codex auth is provisioned into the SAME per-session
    // CODEX_HOME dir that the config.toml was written into, so `codex
    // exec` is authenticated (no 401).
    expect(ensureCodexAuthInHome).toHaveBeenCalledTimes(1);
    expect(ensureCodexAuthInHome.mock.calls[0][0]).toBe(codexDir);
    // Neutral {command,args,env} bridge spec (NOT the claude wrapper).
    expect(spec).toEqual(
      expect.objectContaining({
        command: "node",
        args: expect.any(Array),
        env: expect.objectContaining({
          AOA_SESSION_COMPANY_ID: "comp1",
          AOA_SESSION_USER_ID: "user1",
          AOA_SESSION_USER_ROLE: "founder",
        }),
      }),
    );
    expect((spec as any).mcpServers).toBeUndefined();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [binary, args, opts] = spawn.mock.calls[0];
    expect(binary).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("--json");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("-p");

    // Spawn env carries CODEX_HOME = the managed dir, merged over process.env.
    expect((opts as any)?.env?.CODEX_HOME).toBe(codexDir);
  });

  it("codex: omits vendor approval bypass flag when disabled", async () => {
    const { spawn } = await runChat("codex", {
      vendorCliBypassEnabled: false,
    });

    const [, args] = spawn.mock.calls[0];
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("opencode: emits an explicit 'not yet supported' error and never spawns", async () => {
    const { chunks, spawn } = await runChat("opencode");

    expect(spawn).not.toHaveBeenCalled();
    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err.message).toContain("not yet supported");
  });
});

// ── MX-chatparse: per-CLI JSONL parsing + one-shot/resume session ───────────
//
// Live §17 verification found the codex Commander chat invoked correctly
// (MX4) but rendering NOTHING:
//  1. parseLine treated codex's `exec --json` JSONL events as raw text →
//     the SSE stream got garbage JSON, no assistant message.
//  2. The persistent-process session model broke codex's one-shot
//     `codex exec` on multi-turn (turn-2 found stdin closed).
//
// Required per-CLI behavior:
//  - claude_cli : UNCHANGED. Persistent process; turn-1 spawns with `-p`
//                 argv; subsequent turns pipe stdin to the SAME process;
//                 plain-text accumulation via the parseCliOutput stub;
//                 `done` event unchanged.
//  - codex      : parse the full turn stdout via parseCodexJsonl on process
//                 exit (codex exec is one-shot — exit = turn end). Yielded
//                 chat text == parsed `summary` (NOT raw JSON). Store the
//                 codex `sessionId`, NOT a long-lived process. Turn-N spawns
//                 a FRESH `codex exec --json [flags] resume <id> -`.
//                 isCodexUnknownSessionError on a resume → retry fresh (no
//                 `resume`). turn.failed/error → an {type:"error"} chunk.

describe("cliModeService.chat — codex JSONL parse + one-shot/resume (MX-chatparse)", () => {
  // A fake one-shot process: emits its preset stdout/stderr once the chat
  // attaches listeners, then exits with the preset code (mirrors `codex
  // exec`, which runs the turn and exits). Multiple spawns in a turn-chain
  // are served from a queue so turn-2 (resume) gets its own stdout fixture.
  function makeOneShotProcess(opts: {
    stdout: string;
    stderr?: string;
    exitCode?: number;
  }) {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    let driven = false;
    const drive = () => {
      if (driven) return;
      driven = true;
      setImmediate(() => {
        if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
        if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
        proc.emit("exit", opts.exitCode ?? 0, null);
        proc.emit("close", opts.exitCode ?? 0, null);
      });
    };
    proc.stdout.on("newListener", drive);
    proc.on("newListener", (ev: string) => {
      if (ev === "exit") drive();
    });
    return proc;
  }

  // A claude-style persistent process: never exits on its own; emits
  // plain-text stdout for whatever turn is currently streaming. Each
  // `feed(text)` schedules one stdout burst (no exit) so multi-turn
  // stdin-piping stays on the SAME process.
  function makePersistentProcess() {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // W1 stdin fix: claude writes the prompt to stdin then closes it.
    proc.stdin = { writable: true, write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    proc.feed = (text: string) => {
      setImmediate(() => proc.stdout.emit("data", Buffer.from(text)));
    };
    return proc;
  }

  const CODEX_TURN1_JSONL = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-sess-aaa" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello from codex turn one." },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n");

  const CODEX_TURN2_JSONL = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-sess-bbb" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Follow-up answer from codex." },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } }),
  ].join("\n");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // vi.clearAllMocks() clears mock.calls but NOT a queued
    // mockReturnValueOnce implementation chain. Reset spawn's
    // implementation so a prior test's per-turn process queue cannot
    // bleed into the next test (the codex resume/unknown-session tests
    // use mockReturnValueOnce).
    const cp = await import("node:child_process");
    vi.mocked(cp.spawn).mockReset();
    vi.mocked(cp.execSync).mockReset();
  });

  // REVIEW FIX S2: accept a configOverride so resume argv tests can inject model.
  async function drainChat(
    service: any,
    cliTool: string,
    content: string,
    configOverride: Record<string, unknown> = {},
    conversationId = "conversation-a",
  ): Promise<any[]> {
    const chunks: any[] = [];
    const config = { cliTool, executionMode: "cli", ...configOverride };
    for await (const chunk of service.chat(
      {
        companyId: "comp1",
        userId: "user1",
        userRole: "founder",
        content,
        enabledCapabilities: [],
        conversationId,
      } as any,
      config as any,
    )) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("codex turn-1: yields the parsed summary (NOT raw JSON), stores the sessionId, emits done after exit, and writes the per-session CODEX_HOME config.toml", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    const codexMod = await import("@armyofagents/adapter-codex-local/server");
    const expectedSummary = "Hello from codex turn one.";

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    const chunks = await drainChat(service, "codex", "hi codex");

    // Assistant text == parsed summary, NOT the raw JSONL.
    const text = chunks
      .filter((c) => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text).toContain(expectedSummary);
    expect(text).not.toContain("thread.started");
    expect(text).not.toContain("agent_message");
    expect(text).not.toContain('"type"');

    // done emitted (after the one-shot process exits).
    expect(chunks.some((c) => c.type === "done")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);

    // The MX4 per-session CODEX_HOME config.toml write still happens.
    expect(vi.mocked(codexMod.writeCodexMcpConfigToml)).toHaveBeenCalledTimes(1);

    // The codex sessionId from the fixture is stored on the session.
    const stored = service.getSessionStore().get("comp1:user1:conversation-a");
    expect(stored).toBeDefined();
    expect(stored.codexSessionId).toBe("codex-sess-aaa");
  });

  it("codex action_confirmation: yields approval chunks parsed from tool_result markers before assistant text", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const payload = {
      toolName: "create_task",
      params: { title: "Codex SSE approval UAT", priority: "low" },
      confirmId: "confirm-codex-sse-1",
    };
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-codex-sse" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "tool_result",
          tool_use_id: "tool_call_1",
          content: `⚡CONFIRM:${JSON.stringify(payload)}⚡ Requires approval.`,
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Awaiting your approval." },
      }),
    ].join("\n");
    const proc = makeOneShotProcess({ stdout });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    const chunks = await drainChat(service, "codex", "create a task");

    expect(chunks).toEqual(expect.arrayContaining([
      {
        type: "action_confirmation",
        toolName: "create_task",
        params: { title: "Codex SSE approval UAT", priority: "low" },
        runId: "confirm-codex-sse-1",
      },
      { type: "text", delta: "Awaiting your approval." },
    ]));
    const text = chunks
      .filter((c) => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text).not.toContain("CONFIRM:");
    expect(text).not.toContain("thread.started");
  });

  it("codex turn-2: a follow-up on the same session spawns a FRESH `codex exec --json … resume <storedId> -` and refreshes the stored sessionId", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc1 = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    const proc2 = makeOneShotProcess({ stdout: CODEX_TURN2_JSONL });
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(proc1 as any)
      .mockReturnValueOnce(proc2 as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);

    await drainChat(service, "codex", "first message");
    const afterT1 = service.getSessionStore().get("comp1:user1:conversation-a");
    expect(afterT1.codexSessionId).toBe("codex-sess-aaa");

    const chunks2 = await drainChat(service, "codex", "second message");

    // A fresh process was spawned for turn-2 (one-shot model).
    expect(vi.mocked(cp.spawn)).toHaveBeenCalledTimes(2);
    const [binary, args] = vi.mocked(cp.spawn).mock.calls[1];
    expect(binary).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("--json");
    // Continuation argv carries `resume <storedSessionId>` and the `-`
    // stdin-prompt sentinel.
    const resumeIdx = (args as string[]).indexOf("resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe("codex-sess-aaa");
    expect((args as string[])[args.length - 1]).toBe("-");

    // Turn-2 text == turn-2 summary; sessionId refreshed from the new parse.
    const text2 = chunks2
      .filter((c) => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text2).toContain("Follow-up answer from codex.");
    const afterT2 = service.getSessionStore().get("comp1:user1:conversation-a");
    expect(afterT2.codexSessionId).toBe("codex-sess-bbb");
  });

  it("isolates provider sessions when alternating Commander conversations A → B → A", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const conversationBTurn = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-sess-b" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Conversation B answer." },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }),
    ].join("\n");
    const conversationASecondTurn = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-sess-a2" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Conversation A continued." },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } }),
    ].join("\n");
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(makeOneShotProcess({ stdout: CODEX_TURN1_JSONL }) as any)
      .mockReturnValueOnce(makeOneShotProcess({ stdout: conversationBTurn }) as any)
      .mockReturnValueOnce(makeOneShotProcess({ stdout: conversationASecondTurn }) as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);

    await drainChat(service, "codex", "A first", {}, "conversation-a");
    await drainChat(service, "codex", "B first", {}, "conversation-b");
    await drainChat(service, "codex", "A second", {}, "conversation-a");

    expect(service.getSessionStore().get("comp1:user1:conversation-a")?.codexSessionId)
      .toBe("codex-sess-a2");
    expect(service.getSessionStore().get("comp1:user1:conversation-b")?.codexSessionId)
      .toBe("codex-sess-b");

    const secondTurnArgs = vi.mocked(cp.spawn).mock.calls[1][1] as string[];
    expect(secondTurnArgs).not.toContain("resume");

    const thirdTurnArgs = vi.mocked(cp.spawn).mock.calls[2][1] as string[];
    const resumeIdx = thirdTurnArgs.indexOf("resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(thirdTurnArgs[resumeIdx + 1]).toBe("codex-sess-aaa");
  });

  it("codex resume action_confirmation: resumed turns still surface approval chunks", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const payload = {
      toolName: "create_task",
      params: { title: "Codex resumed approval UAT", priority: "low" },
      confirmId: "confirm-codex-resume-1",
    };
    const resumedApprovalJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-sess-resumed" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "tool_result",
          tool_use_id: "tool_call_resume",
          content: `⚡CONFIRM:${JSON.stringify(payload)}⚡ Requires approval.`,
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Awaiting resumed approval." },
      }),
    ].join("\n");
    const proc1 = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    const proc2 = makeOneShotProcess({ stdout: resumedApprovalJsonl });
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(proc1 as any)
      .mockReturnValueOnce(proc2 as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);

    await drainChat(service, "codex", "first message");
    const chunks2 = await drainChat(service, "codex", "second message");

    const [, args] = vi.mocked(cp.spawn).mock.calls[1];
    const resumeIdx = (args as string[]).indexOf("resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect((args as string[])[resumeIdx + 1]).toBe("codex-sess-aaa");
    expect(chunks2).toEqual(expect.arrayContaining([
      {
        type: "action_confirmation",
        toolName: "create_task",
        params: { title: "Codex resumed approval UAT", priority: "low" },
        runId: "confirm-codex-resume-1",
      },
      { type: "text", delta: "Awaiting resumed approval." },
    ]));
  });

  it("codex unknown-session: a resume whose output matches isCodexUnknownSessionError retries FRESH (no `resume`), no hang, no 'CLI session ended'", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);

    const proc1 = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    // Turn-2 resume attempt fails with an unknown-session signal.
    const proc2 = makeOneShotProcess({
      stdout: "",
      stderr: "Error: unknown session codex-sess-aaa",
      exitCode: 1,
    });
    // Fresh retry succeeds.
    const proc3 = makeOneShotProcess({ stdout: CODEX_TURN2_JSONL });
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(proc1 as any)
      .mockReturnValueOnce(proc2 as any)
      .mockReturnValueOnce(proc3 as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);

    await drainChat(service, "codex", "first message");
    const chunks2 = await drainChat(service, "codex", "second message");

    // 3 spawns total: t1, failed resume, fresh retry.
    expect(vi.mocked(cp.spawn)).toHaveBeenCalledTimes(3);
    const retryArgs = vi.mocked(cp.spawn).mock.calls[2][1] as string[];
    expect(retryArgs).not.toContain("resume");
    expect(retryArgs[retryArgs.length - 1]).toBe("-");

    // No spurious "CLI session ended" error; the retry's summary is yielded.
    const errs = chunks2.filter((c) => c.type === "error");
    expect(errs.some((e) => /CLI session ended/i.test(e.message))).toBe(false);
    const text2 = chunks2
      .filter((c) => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text2).toContain("Follow-up answer from codex.");
    // sessionId refreshed from the successful fresh retry.
    expect(service.getSessionStore().get("comp1:user1:conversation-a").codexSessionId).toBe(
      "codex-sess-bbb",
    );
  });

  it("codex error: a turn.failed / error event yields an {type:'error'} chunk (not silent, not raw JSON)", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const failJsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-sess-err" }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "codex model exploded" },
      }),
    ].join("\n");
    const proc = makeOneShotProcess({ stdout: failJsonl, exitCode: 1 });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    const chunks = await drainChat(service, "codex", "make it fail");

    const err = chunks.find((c) => c.type === "error");
    expect(err).toBeDefined();
    expect(err.message).toContain("codex model exploded");
    // The error text is not raw JSONL leaking through as "text".
    const text = chunks
      .filter((c) => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text).not.toContain("turn.failed");
    expect(text).not.toContain('"type"');
  });

  it("codex argv: first-turn argv contains -c model_reasoning_summary=detailed before the trailing -", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    await drainChat(service, "codex", "hi");

    const [binary, args] = vi.mocked(cp.spawn).mock.calls[0];
    expect(binary).toBe("codex");
    const argArr = args as string[];
    // -c flag is present with the reasoning summary value (find by value, not first -c)
    const summaryIdx = argArr.indexOf("model_reasoning_summary=detailed");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(argArr[summaryIdx - 1]).toBe("-c");
    // The -c/value pair appears BEFORE the trailing -
    const trailingDashIdx = argArr.lastIndexOf("-");
    expect(summaryIdx).toBeLessThan(trailingDashIdx);
    // Trailing - is still the last positional
    expect(argArr[argArr.length - 1]).toBe("-");
  });

  it("codex argv: resumed-turn argv contains -c model_reasoning_summary=detailed before resume <id> -", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc1 = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    const proc2 = makeOneShotProcess({ stdout: CODEX_TURN2_JSONL });
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(proc1 as any)
      .mockReturnValueOnce(proc2 as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    await drainChat(service, "codex", "turn one");
    await drainChat(service, "codex", "turn two");

    const [, resumeArgs] = vi.mocked(cp.spawn).mock.calls[1];
    const argArr = resumeArgs as string[];
    // -c flag present with value before resume (find by value, not first -c)
    const summaryIdx = argArr.indexOf("model_reasoning_summary=detailed");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(argArr[summaryIdx - 1]).toBe("-c");
    const resumeIdx = argArr.indexOf("resume");
    expect(summaryIdx).toBeLessThan(resumeIdx);
    // Trailing - is still the last positional
    expect(argArr[argArr.length - 1]).toBe("-");
  });

  it("codex argv: fresh-retry after unknown-session also contains -c model_reasoning_summary=detailed before trailing -", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc1 = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    const proc2 = makeOneShotProcess({
      stdout: "",
      stderr: "Error: unknown session codex-sess-aaa",
      exitCode: 1,
    });
    const proc3 = makeOneShotProcess({ stdout: CODEX_TURN2_JSONL });
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(proc1 as any)
      .mockReturnValueOnce(proc2 as any)
      .mockReturnValueOnce(proc3 as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    await drainChat(service, "codex", "first message");
    await drainChat(service, "codex", "second message");

    // spawn call [2] is the fresh retry (no resume)
    const [, retryArgs] = vi.mocked(cp.spawn).mock.calls[2];
    const argArr = retryArgs as string[];
    // find by value, not first -c (effort flag now precedes summary flag)
    const summaryIdx = argArr.indexOf("model_reasoning_summary=detailed");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(argArr[summaryIdx - 1]).toBe("-c");
    expect(argArr).not.toContain("resume");
    expect(argArr[argArr.length - 1]).toBe("-");
  });

  it("claude_cli delivers the prompt over stdin (W1 fix) + stream-json accumulation + done shape; no codex sessionId", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/claude\n" as any);
    // claude process: streamProcessOutput attaches its listeners lazily; on
    // attach we feed stream-json text then emit exit so the turn's for-await
    // completes (claude's `--output-format stream-json` emits JSONL lines; the
    // StreamJsonParser extracts text from stream_event deltas). claude `--print`
    // is one-shot — the prompt rides stdin (raw) and stdin is closed.
    const persistent = makePersistentProcess();
    vi.mocked(cp.spawn).mockReturnValue(persistent as any);
    const fsp = await import("node:fs/promises");

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);

    // Feed stream-json format: a text_delta inside a stream_event line.
    // StreamJsonParser extracts "claude turn one text" from the delta field.
    const streamJsonLine = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "claude turn one text" },
      },
    });
    let attached = false;
    persistent.stdout.on("newListener", () => {
      if (attached) return;
      attached = true;
      setImmediate(() => {
        persistent.stdout.emit("data", Buffer.from(streamJsonLine + "\n"));
        persistent.emit("exit", 0, null);
        persistent.emit("close", 0, null);
      });
    });

    const chunks1 = await drainChat(service, "claude_cli", "first");

    // W1 stdin fix: claude's prompt is written to stdin (raw) then stdin is
    // closed — NOT passed as an argv positional.
    expect(persistent.stdin.write).toHaveBeenCalledTimes(1);
    expect(String(persistent.stdin.write.mock.calls[0][0])).toContain("first");
    expect(persistent.stdin.end).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cp.spawn)).toHaveBeenCalledTimes(1);
    const [binary, args] = vi.mocked(cp.spawn).mock.calls[0];
    expect(binary).toBe("claude");
    // argv ends at the flags — no content positional.
    expect(args).toEqual([
      "--mcp-config",
      expect.stringMatching(/\.json$/),
      // D2: strict flag pairs with --mcp-config (no host/project MCP inheritance).
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
    expect((args as string[]).join(" ")).not.toContain("first");
    // Stream-json accumulation: StreamJsonParser extracts text from stream_event
    // text_delta events (NOT plain-text parseCliOutput).
    const text1 = chunks1
      .filter((c) => c.type === "text")
      .map((c) => c.delta)
      .join("");
    expect(text1).toContain("claude turn one text");
    // done shape unchanged.
    const done1 = chunks1.find((c) => c.type === "done");
    expect(done1).toBeDefined();
    expect(done1.summary).toEqual({
      runId: "",
      toolsCalled: [],
      durationMs: 0,
      costCents: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    });

    // claude must NOT acquire a codex sessionId.
    expect(
      service.getSessionStore().get("comp1:user1:conversation-a")?.codexSessionId,
    ).toBeUndefined();

    // claude writes exactly the {mcpServers:{aoa}} wrapper JSON once.
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(vi.mocked(fsp.writeFile).mock.calls[0][1]));
    expect(parsed.mcpServers.aoa.command).toBe("node");

    // REVIEW FIX S6/C12: claude_cli argv must NOT carry codex model/reasoning flags.
    const captured = vi.mocked(cp.spawn).mock.calls[0][1] as string[];
    expect(captured).not.toContain("--model");
    expect(captured.join(" ")).not.toContain("model_reasoning_effort");
    expect(captured.join(" ")).not.toContain("model_reasoning_summary");

    // T1: claude_cli spawn env must carry MAX_THINKING_TOKENS — sole enabler of
    // extended thinking. Mirrors the codex CODEX_HOME assertion pattern.
    const [, , spawnOpts] = vi.mocked(cp.spawn).mock.calls[0];
    expect((spawnOpts as any)?.env?.MAX_THINKING_TOKENS).toBe("3000");
  });

  // ── Task 3: MCP connectors delivered to Commander (claude_cli) ──────────────
  //
  // Commander is per-USER, not per-agent → it receives EVERY active company
  // connector (D3), resolved with agentId: null. The spec (carrying only a
  // `${AOA_MCP_*_TOKEN}` placeholder) lands in the --mcp-config FILE alongside
  // aoa; the real secret rides ONLY in the spawn env (connectorEnv merged over
  // process.env + the existing spawnEnv), never on disk.

  // Drives a claude persistent process: emits one stream-json text delta then
  // exits, so the turn's for-await completes.
  function driveClaudeToCompletion(persistent: any) {
    let attached = false;
    persistent.stdout.on("newListener", () => {
      if (attached) return;
      attached = true;
      setImmediate(() => {
        persistent.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "ok" },
              },
            }) + "\n",
          ),
        );
        persistent.emit("exit", 0, null);
        persistent.emit("close", 0, null);
      });
    });
  }

  it("claude_cli: delivers active company connectors — spec (with ${AOA_MCP_*_TOKEN} placeholder) in the config FILE, real secret ONLY in spawn env (D3 all-active via agentId:null)", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/claude\n" as any);
    const persistent = makePersistentProcess();
    vi.mocked(cp.spawn).mockReturnValue(persistent as any);
    const fsp = await import("node:fs/promises");

    // Commander receives every ACTIVE connector (agentId:null). Secret is
    // plaintext in the resolved env but MUST never reach the config file.
    const loaderMod = await import("../services/mcp-connectors-loader.js");
    vi.mocked(loaderMod.resolveAgentConnectors).mockResolvedValue({
      extraMcpServers: {
        notion: {
          kind: "http",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
        },
      },
      connectorEnv: { AOA_MCP_NOTION_TOKEN: "sk-notion-PLAINTEXT-SECRET" },
    });

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    driveClaudeToCompletion(persistent);
    await drainChat(service, "claude_cli", "hello");

    // D3: Commander resolves ALL active connectors → agentId: null, company scoped.
    expect(vi.mocked(loaderMod.resolveAgentConnectors)).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(loaderMod.resolveAgentConnectors).mock.calls[0][1];
    expect(callArg.agentId).toBeNull();
    expect(callArg.companyId).toBe("comp1");

    // The written --mcp-config FILE carries notion (PLACEHOLDER header) alongside
    // aoa — and NEVER the plaintext secret.
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledTimes(1);
    const jsonBody = String(vi.mocked(fsp.writeFile).mock.calls[0][1]);
    const parsed = JSON.parse(jsonBody);
    expect(parsed.mcpServers.aoa).toBeDefined();
    expect(parsed.mcpServers.notion).toEqual({
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
    });
    expect(jsonBody).not.toContain("sk-notion-PLAINTEXT-SECRET");

    // The real secret rides ONLY in the spawn env (merged over process.env +
    // the existing spawnEnv). MAX_THINKING_TOKENS (pre-Task-3 spawnEnv) survives.
    const [, , spawnOpts] = vi.mocked(cp.spawn).mock.calls[0];
    expect((spawnOpts as any).env.AOA_MCP_NOTION_TOKEN).toBe("sk-notion-PLAINTEXT-SECRET");
    expect((spawnOpts as any).env.MAX_THINKING_TOKENS).toBe("3000");
  });

  it("claude_cli: NO connectors → config FILE has ONLY aoa and spawn env carries no connector token (byte-identity regression)", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/claude\n" as any);
    const persistent = makePersistentProcess();
    vi.mocked(cp.spawn).mockReturnValue(persistent as any);
    const fsp = await import("node:fs/promises");

    // Explicit empty resolution (hermetic: vi.clearAllMocks does not reset a
    // prior test's mockResolvedValue implementation).
    const loaderMod = await import("../services/mcp-connectors-loader.js");
    vi.mocked(loaderMod.resolveAgentConnectors).mockResolvedValue({
      extraMcpServers: {},
      connectorEnv: {},
    });

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    driveClaudeToCompletion(persistent);
    await drainChat(service, "claude_cli", "hi");

    const parsed = JSON.parse(String(vi.mocked(fsp.writeFile).mock.calls[0][1]));
    // aoa is the ONLY server — no connector splices in.
    expect(Object.keys(parsed.mcpServers)).toEqual(["aoa"]);
    const [, , spawnOpts] = vi.mocked(cp.spawn).mock.calls[0];
    // spawnEnv unchanged: MAX_THINKING_TOKENS present, no connector token added.
    expect((spawnOpts as any).env.MAX_THINKING_TOKENS).toBe("3000");
    expect((spawnOpts as any).env.AOA_MCP_NOTION_TOKEN).toBeUndefined();
  });

  it("codex argv (first-turn): full argv shape — model + effort + summary — claude default config → DEFAULT_CODEX_CHAT_MODEL", async () => {
    // readSharedCodexModel is stubbed to null (top-level vi.mock); config.model
    // is a claude default → resolver returns DEFAULT_CODEX_CHAT_MODEL ("gpt-5.5").
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);
    await drainChat(service, "codex", "hi codex", { model: "claude-sonnet-4-6" });

    const captured = vi.mocked(cp.spawn).mock.calls[0][1] as string[];
    expect(captured).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.5", // claude default rejected → readSharedCodexModel stubbed null → DEFAULT_CODEX_CHAT_MODEL
      "-c",
      "model_reasoning_effort=high", // F7: bare value, no JSON.stringify quoting
      "-c",
      "model_reasoning_summary=detailed",
      "-",
    ]);
  });

  it("codex argv (resumed-turn): codex-compatible config.model used as-is, resume <id> present", async () => {
    // REVIEW FIX S2: drainChat widened to accept configOverride — allows injecting model.
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc1 = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    const proc2 = makeOneShotProcess({ stdout: CODEX_TURN2_JSONL });
    vi.mocked(cp.spawn)
      .mockReturnValueOnce(proc1 as any)
      .mockReturnValueOnce(proc2 as any);

    const { cliModeService } = await import(
      "../services/internal-agent/cli-mode.js"
    );
    const service = cliModeService({} as any);

    // Turn 1 — store the codex session id.
    await drainChat(service, "codex", "first message", { model: "gpt-4.1" });
    const afterT1 = service.getSessionStore().get("comp1:user1:conversation-a");
    expect(afterT1.codexSessionId).toBe("codex-sess-aaa");

    // Turn 2 — resume with codex-compatible config.model.
    await drainChat(service, "codex", "second message", { model: "gpt-4.1" });

    const captured = vi.mocked(cp.spawn).mock.calls[1][1] as string[];
    expect(captured).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-4.1", // codex-compatible config.model → used as-is (no shared/default lookup)
      "-c",
      "model_reasoning_effort=high", // F7: bare value
      "-c",
      "model_reasoning_summary=detailed",
      "resume",
      "codex-sess-aaa",
      "-",
    ]);
  });

  // ── FU-8: MCP connectors delivered to Commander on the CODEX adapter ─────────
  //
  // Parity with the claude_cli connector tests above, adapted for codex's
  // delivery mechanism: connectors reach the per-session CODEX_HOME/config.toml
  // via writeCodexMcpConfigToml's `externalServers` (the SAME writer the codex
  // ADAPTER uses), and the real secret rides the SCRUBBED spawn env — never the
  // config file, never alongside AoA's own ambient secrets.

  it("codex: delivers active company connectors — specs passed as externalServers to the TOML writer, real secret in the SCRUBBED spawn env (D3 all-active via agentId:null); AoA's own secrets are stripped", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    const codexMod = await import("@armyofagents/adapter-codex-local/server");

    // Commander receives every ACTIVE connector (agentId:null). Secret is
    // plaintext in the resolved env but MUST never reach the config file.
    const loaderMod = await import("../services/mcp-connectors-loader.js");
    vi.mocked(loaderMod.resolveAgentConnectors).mockResolvedValue({
      extraMcpServers: {
        notion: {
          kind: "http",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
        },
      },
      connectorEnv: { AOA_MCP_NOTION_TOKEN: "sk-notion-PLAINTEXT-SECRET" },
    } as any);

    // An AoA-owned ambient secret that the scrub MUST strip from the codex spawn
    // env (and every stdio connector child it spawns). AOA_ prefix → denied.
    const savedSecret = process.env.AOA_SECRETS_MASTER_KEY;
    process.env.AOA_SECRETS_MASTER_KEY = "raw-master-key-should-not-leak";
    try {
      const { cliModeService } = await import(
        "../services/internal-agent/cli-mode.js"
      );
      const service = cliModeService({} as any);
      await drainChat(service, "codex", "hello");

      // D3: Commander resolves ALL active connectors → agentId:null, company scoped.
      expect(vi.mocked(loaderMod.resolveAgentConnectors)).toHaveBeenCalledTimes(1);
      const callArg = vi.mocked(loaderMod.resolveAgentConnectors).mock.calls[0][1];
      expect(callArg.agentId).toBeNull();
      expect(callArg.companyId).toBe("comp1");

      // The connector specs are handed to the codex TOML writer as
      // `externalServers` (the writer renders them into the fenced region and
      // filters codex-undeliverable ones — FU-5).
      expect(vi.mocked(codexMod.writeCodexMcpConfigToml)).toHaveBeenCalledTimes(1);
      const [codexDir, , options] = vi.mocked(codexMod.writeCodexMcpConfigToml).mock.calls[0];
      expect((options as any)?.externalServers).toEqual({
        notion: {
          kind: "http",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
        },
      });

      // The spawn env carries the connector's OWN token + CODEX_HOME, but the
      // scrub has removed AoA's ambient secret.
      const [, , spawnOpts] = vi.mocked(cp.spawn).mock.calls[0];
      const env = (spawnOpts as any).env;
      expect(env.AOA_MCP_NOTION_TOKEN).toBe("sk-notion-PLAINTEXT-SECRET");
      expect(env.CODEX_HOME).toBe(codexDir);
      expect(env.AOA_SECRETS_MASTER_KEY).toBeUndefined(); // scrubbed
      expect(env.PATH).toBeTruthy(); // base non-secrets survive
    } finally {
      if (savedSecret === undefined) delete process.env.AOA_SECRETS_MASTER_KEY;
      else process.env.AOA_SECRETS_MASTER_KEY = savedSecret;
    }
  });

  it("codex: NO connectors → externalServers is {} and the spawn env is byte-identical (full process.env + CODEX_HOME, no scrub, no connector token)", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    const codexMod = await import("@armyofagents/adapter-codex-local/server");

    // Explicit empty resolution (hermetic: vi.clearAllMocks does not reset a
    // prior test's mockResolvedValue implementation).
    const loaderMod = await import("../services/mcp-connectors-loader.js");
    vi.mocked(loaderMod.resolveAgentConnectors).mockResolvedValue({
      extraMcpServers: {},
      connectorEnv: {},
    } as any);

    // With NO connectors the codex spawn keeps the FULL process.env — an AoA
    // secret present here must SURVIVE (proves the no-scrub path is unchanged).
    const savedSecret = process.env.AOA_SECRETS_MASTER_KEY;
    process.env.AOA_SECRETS_MASTER_KEY = "present-when-no-connectors";
    try {
      const { cliModeService } = await import(
        "../services/internal-agent/cli-mode.js"
      );
      const service = cliModeService({} as any);
      await drainChat(service, "codex", "hi");

      // Writer still called (its fence strip is the connector-cleanup path), but
      // with an EMPTY externalServers map.
      expect(vi.mocked(codexMod.writeCodexMcpConfigToml)).toHaveBeenCalledTimes(1);
      const [codexDir, , options] = vi.mocked(codexMod.writeCodexMcpConfigToml).mock.calls[0];
      expect((options as any)?.externalServers).toEqual({});

      const [, , spawnOpts] = vi.mocked(cp.spawn).mock.calls[0];
      const env = (spawnOpts as any).env;
      expect(env.CODEX_HOME).toBe(codexDir);
      expect(env.AOA_MCP_NOTION_TOKEN).toBeUndefined(); // no connector token
      expect(env.AOA_SECRETS_MASTER_KEY).toBe("present-when-no-connectors"); // full env, no scrub
    } finally {
      if (savedSecret === undefined) delete process.env.AOA_SECRETS_MASTER_KEY;
      else process.env.AOA_SECRETS_MASTER_KEY = savedSecret;
    }
  });

  // P1 (Codex) regression — a SECRETLESS connector (stdio filesystem, unauth'd
  // http) resolves to a NONEMPTY spec map but an EMPTY connectorEnv. Gating the
  // FU-23 scrub on connectorEnv (the pre-fix bug) treated this as "no connectors"
  // and handed the full ambient env — DATABASE_URL, master key, GitHub PAT — to
  // the connector's stdio child. The gate now keys on the SPEC map, so the scrub
  // fires whenever any external connector is present, token or not.
  it("claude_cli: SECRETLESS connector (empty connectorEnv, nonempty specs) STILL scrubs AoA's ambient secrets", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/claude\n" as any);
    const persistent = makePersistentProcess();
    vi.mocked(cp.spawn).mockReturnValue(persistent as any);
    const fsp = await import("node:fs/promises");

    const loaderMod = await import("../services/mcp-connectors-loader.js");
    vi.mocked(loaderMod.resolveAgentConnectors).mockResolvedValue({
      extraMcpServers: {
        filesystem: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
      connectorEnv: {}, // secretless — nonempty specs, empty env
    } as any);

    const savedSecret = process.env.AOA_SECRETS_MASTER_KEY;
    process.env.AOA_SECRETS_MASTER_KEY = "raw-master-key-should-not-leak";
    try {
      const { cliModeService } = await import(
        "../services/internal-agent/cli-mode.js"
      );
      const service = cliModeService({} as any);
      driveClaudeToCompletion(persistent);
      await drainChat(service, "claude_cli", "hello");

      // The connector WAS delivered (config file carries it) → this is the
      // "present" state, not the no-connector path.
      const parsed = JSON.parse(String(vi.mocked(fsp.writeFile).mock.calls[0][1]));
      expect(parsed.mcpServers.filesystem).toBeDefined();

      // …and the ambient secret is SCRUBBED despite connectorEnv being empty.
      const [, , spawnOpts] = vi.mocked(cp.spawn).mock.calls[0];
      expect((spawnOpts as any).env.AOA_SECRETS_MASTER_KEY).toBeUndefined();
      expect((spawnOpts as any).env.PATH).toBeTruthy(); // base non-secrets survive
    } finally {
      if (savedSecret === undefined) delete process.env.AOA_SECRETS_MASTER_KEY;
      else process.env.AOA_SECRETS_MASTER_KEY = savedSecret;
    }
  });

  it("codex: SECRETLESS connector (empty connectorEnv, nonempty specs) STILL scrubs AoA's ambient secrets", async () => {
    const cp = await import("node:child_process");
    vi.mocked(cp.execSync).mockReturnValue("/usr/local/bin/codex\n" as any);
    const proc = makeOneShotProcess({ stdout: CODEX_TURN1_JSONL });
    vi.mocked(cp.spawn).mockReturnValue(proc as any);
    const codexMod = await import("@armyofagents/adapter-codex-local/server");

    const loaderMod = await import("../services/mcp-connectors-loader.js");
    vi.mocked(loaderMod.resolveAgentConnectors).mockResolvedValue({
      extraMcpServers: {
        filesystem: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
      connectorEnv: {}, // secretless — nonempty specs, empty env
    } as any);

    const savedSecret = process.env.AOA_SECRETS_MASTER_KEY;
    process.env.AOA_SECRETS_MASTER_KEY = "raw-master-key-should-not-leak";
    try {
      const { cliModeService } = await import(
        "../services/internal-agent/cli-mode.js"
      );
      const service = cliModeService({} as any);
      await drainChat(service, "codex", "hello");

      // The connector WAS delivered to the TOML writer → "present" state.
      expect(vi.mocked(codexMod.writeCodexMcpConfigToml)).toHaveBeenCalledTimes(1);
      const [, , options] = vi.mocked(codexMod.writeCodexMcpConfigToml).mock.calls[0];
      expect((options as any)?.externalServers.filesystem).toBeDefined();

      const [, , spawnOpts] = vi.mocked(cp.spawn).mock.calls[0];
      expect((spawnOpts as any).env.AOA_SECRETS_MASTER_KEY).toBeUndefined(); // scrubbed
      expect((spawnOpts as any).env.PATH).toBeTruthy();
    } finally {
      if (savedSecret === undefined) delete process.env.AOA_SECRETS_MASTER_KEY;
      else process.env.AOA_SECRETS_MASTER_KEY = savedSecret;
    }
  });
});

describe("cliModeService.chat — D1 multi-tenant unsandboxed gate", () => {
  const OPT_IN = "AOA_ALLOW_UNSANDBOXED_MULTITENANT";
  let savedOptIn: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    savedOptIn = process.env[OPT_IN];
    delete process.env[OPT_IN];
  });
  afterEach(() => {
    if (savedOptIn === undefined) delete process.env[OPT_IN];
    else process.env[OPT_IN] = savedOptIn;
  });

  // W7.5d — the D1 gate now runs AFTER the cliTool + conversationId early-returns
  // and the sandbox resolve (but BEFORE the host CLI probe). For the pass-through
  // cases cliTool:null makes the FIRST error the "No CLI tool configured" check
  // (the guard, reached only with a valid cliTool + conversationId, is a no-op /
  // permits and never fires OPT_IN). The "refuses" case passes a valid cliTool +
  // conversationId (and no runId → null target) so the guard IS reached and
  // refuses. No CLI detection, no spawn, no resolve on any of these paths.
  async function firstError(
    deploymentMode: "cloud_auth" | "local_trusted" | "authenticated",
    configOverride: Record<string, unknown> = {},
  ) {
    const { setDeploymentMode } = await import("../config/deployment-mode.js");
    setDeploymentMode(deploymentMode);
    const { cliModeService } = await import("../services/internal-agent/cli-mode.js");
    const service = cliModeService({} as any);
    const chunks: any[] = [];
    for await (const chunk of service.chat(
      {
        companyId: "comp1",
        userId: "user1",
        userRole: "founder",
        content: "hi",
        enabledCapabilities: [],
        conversationId: "conv-a",
      } as any,
      { cliTool: null, executionMode: "cli", ...configOverride } as any,
    )) {
      chunks.push(chunk);
      if (chunk.type === "error") break;
    }
    return chunks.find((c) => c.type === "error");
  }

  it("refuses a Commander turn on cloud_auth without the opt-in", async () => {
    // A valid cliTool + conversationId + no runId → the guard is reached with a
    // null (unsandboxed) target on cloud → refuses.
    const err = await firstError("cloud_auth", { cliTool: "claude_cli" });
    expect(err).toBeDefined();
    expect(err.message).toContain(OPT_IN);
    expect(err.message).toContain("Commander");
  });

  it("proceeds past the gate when the opt-in is set (falls through to the config check)", async () => {
    process.env[OPT_IN] = "1";
    const err = await firstError("cloud_auth");
    expect(err).toBeDefined();
    expect(err.message).not.toContain(OPT_IN);
    expect(err.message).toContain("No CLI tool configured");
  });

  it("is a no-op on a self-hosted (local_trusted) install", async () => {
    const err = await firstError("local_trusted");
    expect(err).toBeDefined();
    expect(err.message).not.toContain(OPT_IN);
    expect(err.message).toContain("No CLI tool configured");
  });

  it("is a no-op on a self-hosted authenticated (single-tenant) install", async () => {
    // ★ authenticated is NOT cloud_auth → tenantIsolationEnforced() false → no gate.
    const err = await firstError("authenticated");
    expect(err).toBeDefined();
    expect(err.message).not.toContain(OPT_IN);
    expect(err.message).toContain("No CLI tool configured");
  });
});
