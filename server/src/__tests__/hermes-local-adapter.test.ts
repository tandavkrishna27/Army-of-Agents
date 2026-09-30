/**
 * Tests for the hermes_local adapter wrapper in the server adapter registry.
 *
 * The wrapper (registry.ts) wraps hermesExecute to:
 *   - Inject PAPERCLIP_API_KEY from ctx.authToken when not explicitly set in env
 *   - Always inject PAPERCLIP_RUN_ID from ctx.runId
 *   - Preserve an explicit PAPERCLIP_API_KEY in env (don't override with JWT)
 *   - Normalize hermesCommand from the legacy "command" field with back-compat
 *   - Default hermesCommand to "hermes" when neither field is set
 *
 * PAPERCLIP_API_KEY and PAPERCLIP_RUN_ID are wire-protocol contracts with the
 * external hermes-paperclip-adapter package — they must NOT be renamed to AOA_*.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@armyofagents/adapter-utils";

// ---------------------------------------------------------------------------
// Mock hermes-paperclip-adapter/server BEFORE importing the registry.
// vi.mock is hoisted by vitest so this runs before all imports.
// ---------------------------------------------------------------------------
const mockHermesExecute = vi.fn<[AdapterExecutionContext], Promise<AdapterExecutionResult>>();

vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: mockHermesExecute,
  testEnvironment: vi.fn(),
  sessionCodec: { serialize: vi.fn(), deserialize: vi.fn() },
}));

vi.mock("hermes-paperclip-adapter", () => ({
  agentConfigurationDoc: "",
  models: [],
}));

// Also mock dependent modules to prevent import side-effects
vi.mock("../services/adapter-plugin-store.js", () => ({
  getDisabledAdapterTypes: vi.fn(() => []),
  isAdapterDisabled: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Import registry AFTER mocks are set up
// ---------------------------------------------------------------------------
const { findServerAdapter } = await import("../adapters/registry.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBaseContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-test-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes Test Agent",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

const SUCCESS_RESULT: AdapterExecutionResult = {
  exitCode: 0,
  transcript: "",
} as unknown as AdapterExecutionResult;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hermes_local execute wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHermesExecute.mockResolvedValue(SUCCESS_RESULT);
  });

  it("injects PAPERCLIP_API_KEY from ctx.authToken when env is empty", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    await hermes!.execute(buildBaseContext({ authToken: "tok-xyz", runId: "r-1" }));

    expect(mockHermesExecute).toHaveBeenCalledOnce();
    const passedCtx = mockHermesExecute.mock.calls[0][0];
    const env = (passedCtx.agent.adapterConfig as any).env as Record<string, string>;
    expect(env.PAPERCLIP_API_KEY).toBe("tok-xyz");
    expect(env.PAPERCLIP_RUN_ID).toBe("r-1");
  });

  it("injects PAPERCLIP_RUN_ID even when authToken is absent", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    await hermes!.execute(buildBaseContext({ authToken: undefined, runId: "r-2" }));

    const passedCtx = mockHermesExecute.mock.calls[0][0];
    const env = (passedCtx.agent.adapterConfig as any).env as Record<string, string>;
    expect(env.PAPERCLIP_RUN_ID).toBe("r-2");
    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("preserves explicit PAPERCLIP_API_KEY from adapterConfig env (does not override with JWT)", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    const ctx = buildBaseContext({ authToken: "tok-xyz", runId: "r-3" });
    (ctx.agent as any).adapterConfig = { env: { PAPERCLIP_API_KEY: "explicit-key" } };

    await hermes!.execute(ctx);

    const passedCtx = mockHermesExecute.mock.calls[0][0];
    const env = (passedCtx.agent.adapterConfig as any).env as Record<string, string>;
    expect(env.PAPERCLIP_API_KEY).toBe("explicit-key");
    expect(env.PAPERCLIP_RUN_ID).toBe("r-3");
  });

  it("normalizes hermesCommand from legacy command field", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    const ctx = buildBaseContext({ authToken: undefined, runId: "r-4" });
    (ctx.agent as any).adapterConfig = { command: "/custom/hermes" };

    await hermes!.execute(ctx);

    const passedCtx = mockHermesExecute.mock.calls[0][0];
    expect((passedCtx.agent.adapterConfig as any).hermesCommand).toBe("/custom/hermes");
  });

  it("prefers hermesCommand over legacy command field", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    const ctx = buildBaseContext({ authToken: undefined, runId: "r-5" });
    (ctx.agent as any).adapterConfig = {
      hermesCommand: "/preferred/hermes",
      command: "/legacy/hermes",
    };

    await hermes!.execute(ctx);

    const passedCtx = mockHermesExecute.mock.calls[0][0];
    expect((passedCtx.agent.adapterConfig as any).hermesCommand).toBe("/preferred/hermes");
  });

  it("defaults hermesCommand to 'hermes' when neither command nor hermesCommand is set", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    await hermes!.execute(buildBaseContext({ authToken: undefined, runId: "r-6" }));

    const passedCtx = mockHermesExecute.mock.calls[0][0];
    expect((passedCtx.agent.adapterConfig as any).hermesCommand).toBe("hermes");
  });

  it("does not mutate the original ctx.agent object", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    const ctx = buildBaseContext({ authToken: "tok-xyz", runId: "r-7" });
    const originalConfig = ctx.agent.adapterConfig;

    await hermes!.execute(ctx);

    // The original agent config object should be unchanged
    expect(ctx.agent.adapterConfig).toBe(originalConfig);
    expect((ctx.agent.adapterConfig as any).env).toBeUndefined();
  });

  it("preserves other fields in adapterConfig env when injecting", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    const ctx = buildBaseContext({ authToken: "tok-xyz", runId: "r-8" });
    (ctx.agent as any).adapterConfig = {
      env: { CUSTOM_VAR: "custom-value" },
    };

    await hermes!.execute(ctx);

    const passedCtx = mockHermesExecute.mock.calls[0][0];
    const env = (passedCtx.agent.adapterConfig as any).env as Record<string, string>;
    expect(env.CUSTOM_VAR).toBe("custom-value");
    expect(env.PAPERCLIP_API_KEY).toBe("tok-xyz");
    expect(env.PAPERCLIP_RUN_ID).toBe("r-8");
  });

  it("has sessionCodec registered", () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();
    expect(hermes!.sessionCodec).toBeDefined();
  });

  it("has supportsLocalAgentJwt set to true", () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();
    expect(hermes!.supportsLocalAgentJwt).toBe(true);
  });
});
