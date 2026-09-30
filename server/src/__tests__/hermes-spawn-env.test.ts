/**
 * Integration test: Hermes adapter env injection flows through to hermesExecute ctx.
 *
 * Phase B audit found that T14's existing tests verify the wrapper builds
 * the env object correctly but don't prove the env actually flows through
 * to hermesExecute's ctx.agent.adapterConfig.env. A subtle bug where the
 * wrapper writes the field but the call to hermesExecute strips it would
 * slip through the existing suite.
 *
 * This test mocks hermesExecute (via the `execute` export of
 * hermes-paperclip-adapter/server), captures the full ctx passed to it,
 * and asserts PAPERCLIP_API_KEY + PAPERCLIP_RUN_ID appear on
 * ctx.agent.adapterConfig.env in all three expected scenarios.
 *
 * Refs: docs/superpowers/plans/2026-04-27-resync-verification.md (Task 2)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@armyofagents/adapter-utils";

// ---------------------------------------------------------------------------
// Capture slot — populated by the mock below.
// ---------------------------------------------------------------------------
const capturedExecuteCall: { ctx: AdapterExecutionContext | null } = { ctx: null };

// ---------------------------------------------------------------------------
// Mock hermes-paperclip-adapter/server BEFORE importing the registry.
// vi.mock is hoisted by vitest so this always runs before all imports.
// The registry imports `execute as hermesExecute` from this path.
// ---------------------------------------------------------------------------
vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: vi.fn(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    capturedExecuteCall.ctx = ctx;
    return { exitCode: 0, transcript: "" } as unknown as AdapterExecutionResult;
  }),
  testEnvironment: vi.fn(),
  sessionCodec: { serialize: vi.fn(), deserialize: vi.fn() },
}));

vi.mock("hermes-paperclip-adapter", () => ({
  agentConfigurationDoc: "",
  models: [],
}));

// Mock dependent modules to prevent import side-effects
vi.mock("../services/adapter-plugin-store.js", () => ({
  getDisabledAdapterTypes: vi.fn(() => []),
  isAdapterDisabled: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Import registry AFTER mocks are set up (mirrors hermes-local-adapter.test.ts)
// ---------------------------------------------------------------------------
const { findServerAdapter } = await import("../adapters/registry.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "r-default",
    agent: {
      id: "a-1",
      companyId: "company-1",
      name: "Hermes Spawn Env Test Agent",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Hermes adapter env injection — spawn captures PAPERCLIP_*", () => {
  beforeEach(() => {
    capturedExecuteCall.ctx = null;
    vi.clearAllMocks();
  });

  it("injects PAPERCLIP_API_KEY from ctx.authToken when adapter env is empty", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    await hermes!.execute(buildCtx({ runId: "r-1", authToken: "agent-jwt-xyz" }));

    const cfg = capturedExecuteCall.ctx?.agent?.adapterConfig as any;
    expect(cfg?.env?.PAPERCLIP_API_KEY).toBe("agent-jwt-xyz");
    expect(cfg?.env?.PAPERCLIP_RUN_ID).toBe("r-1");
  });

  it("always injects PAPERCLIP_RUN_ID regardless of authToken state", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    await hermes!.execute(buildCtx({ runId: "r-2", authToken: undefined }));

    const cfg = capturedExecuteCall.ctx?.agent?.adapterConfig as any;
    expect(cfg?.env?.PAPERCLIP_RUN_ID).toBe("r-2");
    expect(cfg?.env?.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it("preserves explicit PAPERCLIP_API_KEY from adapter config", async () => {
    const hermes = findServerAdapter("hermes_local");
    expect(hermes).not.toBeNull();

    const ctx = buildCtx({ runId: "r-3", authToken: "would-be-injected" });
    (ctx.agent as any).adapterConfig = { env: { PAPERCLIP_API_KEY: "explicit-key" } };

    await hermes!.execute(ctx);

    const cfg = capturedExecuteCall.ctx?.agent?.adapterConfig as any;
    expect(cfg?.env?.PAPERCLIP_API_KEY).toBe("explicit-key");
    expect(cfg?.env?.PAPERCLIP_RUN_ID).toBe("r-3");
  });
});
