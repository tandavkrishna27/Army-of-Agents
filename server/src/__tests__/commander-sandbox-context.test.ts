import { describe, it, expect, vi, beforeEach } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

const acquireMock = vi.fn();
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: acquireMock,
}));

async function load() {
  return import("../services/internal-agent/commander-sandbox.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AOA_AGENT_JWT_SECRET = "test-secret";
});

describe("resolveCommanderSandboxContext", () => {
  it("desktop (tenant isolation NOT enforced): returns null and never acquires", async () => {
    setDeploymentMode("local_trusted");
    const { resolveCommanderSandboxContext } = await load();
    const ctx = await resolveCommanderSandboxContext({} as any, {
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
      apiBaseUrl: "http://api",
      adapterType: "claude_local",
      getExperimental: async () => ({ warmCommanderConversations: true }),
    });
    expect(ctx).toBeNull();
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("cloud: acquires a warm conversation lease and mints a commander JWT", async () => {
    setDeploymentMode("cloud_auth");
    acquireMock.mockResolvedValue({
      sandbox: {
        environment: { id: "env1", companyId: "c1", driver: "sandbox" },
        lease: { id: "l1", companyId: "c1", environmentId: "env1", provider: "e2b", providerLeaseId: "e2b-1", leasePolicy: "reuse_by_agent" },
        configPatch: {
          executionTarget: {
            type: "provider-sandbox",
            provider: "e2b",
            providerLeaseId: "e2b-1",
            remoteCwd: "/workspace",
            runner: { execute: vi.fn() },
          },
        },
      },
      lease: { id: "l1", companyId: "c1", environmentId: "env1", provider: "e2b", providerLeaseId: "e2b-1" },
      warmResolved: true,
    });
    const { resolveCommanderSandboxContext } = await load();
    const ctx = await resolveCommanderSandboxContext({} as any, {
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
      apiBaseUrl: "http://api",
      adapterType: "claude_local",
      getExperimental: async () => ({ warmCommanderConversations: true }),
    });
    expect(acquireMock).toHaveBeenCalledTimes(1);
    const call = acquireMock.mock.calls[0][1];
    expect(call.runIdentity).toMatchObject({ companyId: "c1", agentId: null, runId: "run1" });
    expect(call.functionType).toBeNull();
    expect(call.environmentId).toBeNull();
    expect(call.warmPreference).toBe(true);
    expect(call.commanderConversationId).toBe("conv1");
    expect(ctx).not.toBeNull();
    expect(ctx!.executionTarget.type).toBe("provider-sandbox");
    expect(typeof ctx!.authToken).toBe("string"); // commander JWT minted → AOA_API_KEY
    expect(ctx!.apiBaseUrl).toBe("http://api");
    expect(ctx!.release).toBeTypeOf("function");
  });

  it("cloud but acquire returns no sandbox (no platform default): returns null (host fallback)", async () => {
    setDeploymentMode("cloud_auth");
    acquireMock.mockResolvedValue({ sandbox: null, lease: null, warmResolved: false });
    const { resolveCommanderSandboxContext } = await load();
    const ctx = await resolveCommanderSandboxContext({} as any, {
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
      apiBaseUrl: "http://api",
      adapterType: "claude_local",
      getExperimental: async () => ({ warmCommanderConversations: true }),
    });
    expect(ctx).toBeNull();
  });

  it("cloud with a sandbox but NO JWT secret: releases the lease and throws (never leaks)", async () => {
    setDeploymentMode("cloud_auth");
    const release = vi.fn(async () => {});
    acquireMock.mockResolvedValue({
      sandbox: {
        environment: { id: "env1", companyId: "c1", driver: "sandbox" },
        lease: { id: "l1", companyId: "c1", environmentId: "env1", provider: "e2b", leasePolicy: "reuse_by_agent" },
        configPatch: {
          executionTarget: {
            type: "provider-sandbox",
            provider: "e2b",
            providerLeaseId: "e2b-1",
            remoteCwd: "/workspace",
            runner: { execute: vi.fn() },
          },
        },
      },
      lease: { id: "l1", companyId: "c1", environmentId: "env1", provider: "e2b" },
      warmResolved: true,
    });
    const prev = process.env.AOA_AGENT_JWT_SECRET;
    const prevAuth = process.env.BETTER_AUTH_SECRET;
    delete process.env.AOA_AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      const { resolveCommanderSandboxContext } = await load();
      await expect(
        resolveCommanderSandboxContext({} as any, {
          companyId: "c1",
          userId: "u1",
          userRole: "founder",
          conversationId: "conv1",
          turnId: "run1",
          apiBaseUrl: "http://api",
          adapterType: "claude_local",
          getExperimental: async () => ({ warmCommanderConversations: true }),
          releaseLeaseOverride: release,
        } as any),
      ).rejects.toThrow(/run-JWT secret/);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      process.env.AOA_AGENT_JWT_SECRET = prev;
      if (prevAuth) process.env.BETTER_AUTH_SECRET = prevAuth;
    }
  });

  it("cloud with an acquired lease but NO execution target: releases the lease and returns null (W7.5d review F1)", async () => {
    setDeploymentMode("cloud_auth");
    const release = vi.fn(async () => {});
    // A lease WAS acquired (sandbox truthy) but the configPatch yielded no
    // executionTarget (malformed platform-default env) — must NOT leak the VM.
    acquireMock.mockResolvedValue({
      sandbox: {
        environment: { id: "env1", companyId: "c1", driver: "sandbox" },
        lease: { id: "l1", companyId: "c1", environmentId: "env1", provider: "e2b", leasePolicy: "reuse_by_agent" },
        configPatch: { executionTarget: null },
      },
      lease: { id: "l1", companyId: "c1", environmentId: "env1", provider: "e2b" },
      warmResolved: true,
    });
    const { resolveCommanderSandboxContext } = await load();
    const ctx = await resolveCommanderSandboxContext({} as any, {
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
      turnId: "run1",
      apiBaseUrl: "http://api",
      adapterType: "claude_local",
      getExperimental: async () => ({ warmCommanderConversations: true }),
      releaseLeaseOverride: release,
    } as any);
    expect(ctx).toBeNull();
    expect(release).toHaveBeenCalledTimes(1); // released, not leaked
  });
});
