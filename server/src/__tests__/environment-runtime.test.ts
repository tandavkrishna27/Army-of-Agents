import { describe, expect, it, vi } from "vitest";
import type { Environment, EnvironmentLease } from "@armyofagents/shared";
import {
  buildEnvironmentLeaseContext,
  environmentRuntimeService,
  resolveRuntimeProviderConfig,
} from "../services/environment-runtime.js";

const COMPANY = "00000000-0000-0000-0000-000000000001";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    companyId: COMPANY,
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    metadata: null,
    envVars: {},
    connectionTarget: null,
    target: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function makeLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "00000000-0000-0000-0000-000000000020",
    companyId: COMPANY,
    environmentId: "00000000-0000-0000-0000-000000000010",
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: "00000000-0000-0000-0000-000000000030",
    agentId: null,
    status: "active",
    leasePolicy: "ephemeral",
    provider: "local",
    providerLeaseId: null,
    acquiredAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    lastUsedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    expiresAt: null,
    releasedAt: null,
    pausedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: { driver: "local" },
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("buildEnvironmentLeaseContext", () => {
  it("captures execution workspace id and mode for lease metadata", () => {
    expect(buildEnvironmentLeaseContext({
      persistedExecutionWorkspace: {
        id: "workspace-1",
        mode: "per_task",
      },
    })).toEqual({
      executionWorkspaceId: "workspace-1",
      executionWorkspaceMode: "per_task",
    });
  });
});

describe("environmentRuntimeService", () => {
  it("acquires local run leases through the environment service", async () => {
    const lease = makeLease({ executionWorkspaceId: "workspace-1", issueId: "issue-1" });
    const acquireLease = vi.fn(async () => lease);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease,
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
    });

    const result = await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeEnvironment(),
      issueId: "issue-1",
      heartbeatRunId: "00000000-0000-0000-0000-000000000030",
      persistedExecutionWorkspace: { id: "workspace-1", mode: "per_task" },
    });

    expect(result).toEqual({
      environment: makeEnvironment(),
      lease,
      leaseContext: {
        executionWorkspaceId: "workspace-1",
        executionWorkspaceMode: "per_task",
      },
    });
    expect(acquireLease).toHaveBeenCalledWith({
      companyId: COMPANY,
      environmentId: "00000000-0000-0000-0000-000000000010",
      executionWorkspaceId: "workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "00000000-0000-0000-0000-000000000030",
      leasePolicy: "ephemeral",
      provider: "local",
      metadata: {
        driver: "local",
        executionWorkspaceMode: "per_task",
      },
    });
  });

  it("releases leases through the owning driver", async () => {
    const lease = makeLease();
    const released = makeLease({ status: "released" });
    const releaseLease = vi.fn(async () => released);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease,
        releaseLeasesForRun: vi.fn(),
      },
    });

    const result = await runtime.releaseRunLease({
      environment: makeEnvironment(),
      lease,
      status: "released",
    });

    expect(result).toEqual(released);
    expect(releaseLease).toHaveBeenCalledWith(lease.id, "released");
  });

  it("acquires Docker sandbox leases with sandbox-docker provider metadata", async () => {
    const lease = makeLease({
      provider: "sandbox-docker",
      metadata: {
        driver: "sandbox",
        executionWorkspaceMode: "per_task",
        provider: "sandbox-docker",
        image: "node:22-bookworm",
      },
    });
    const acquireLease = vi.fn(async () => lease);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease,
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
    });

    const result = await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeEnvironment({
        driver: "sandbox",
        config: { provider: "sandbox-docker", image: "node:22-bookworm" },
      }),
      issueId: "issue-1",
      heartbeatRunId: "00000000-0000-0000-0000-000000000030",
      persistedExecutionWorkspace: { id: "workspace-1", mode: "per_task" },
    });

    expect(result.lease).toEqual(lease);
    expect(acquireLease).toHaveBeenCalledWith({
      companyId: COMPANY,
      environmentId: "00000000-0000-0000-0000-000000000010",
      executionWorkspaceId: "workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "00000000-0000-0000-0000-000000000030",
      leasePolicy: "ephemeral",
      provider: "sandbox-docker",
      metadata: {
        driver: "sandbox",
        executionWorkspaceMode: "per_task",
        provider: "sandbox-docker",
        image: "node:22-bookworm",
      },
    });
  });

  it("acquires fake provider sandbox leases through provider runtime", async () => {
    const lease = makeLease({
      provider: "fake",
      providerLeaseId: "fake-sandbox-env-1-run-1",
      metadata: {
        driver: "sandbox",
        executionWorkspaceMode: null,
        provider: "fake",
        providerMetadata: {
          provider: "fake",
          remoteCwd: "/workspace/fake",
          shellCommand: "bash",
          timeoutMs: 30000,
          workspaceMode: null,
        },
      },
    });
    const acquireLease = vi.fn(async () => lease);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease,
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
    });

    const result = await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeEnvironment({
        driver: "sandbox",
        config: {
          provider: "fake",
          remoteCwd: "/workspace/fake",
          shellCommand: "bash",
          timeoutMs: 30000,
        },
      }),
      issueId: null,
      heartbeatRunId: "run-1",
      persistedExecutionWorkspace: null,
    });

    expect(result.lease).toEqual(lease);
    expect(acquireLease).toHaveBeenCalledWith(expect.objectContaining({
      provider: "fake",
      providerLeaseId: expect.stringMatching(/^fake-sandbox-/),
      metadata: expect.objectContaining({
        driver: "sandbox",
        provider: "fake",
        providerMetadata: expect.objectContaining({
          remoteCwd: "/workspace/fake",
          shellCommand: "bash",
          timeoutMs: 30000,
        }),
      }),
    }));
  });

  it("resolves E2B provider keys before acquiring provider leases", async () => {
    const acquireLease = vi.fn(async () => makeLease({
      provider: "e2b",
      providerLeaseId: "e2b-lease-1",
      metadata: {
        driver: "sandbox",
        provider: "e2b",
        providerMetadata: {
          provider: "e2b",
          remoteCwd: "/workspace",
        },
      },
    }));
    const providerAcquireLease = vi.fn(async () => ({
      providerLeaseId: "e2b-lease-1",
      metadata: {
        provider: "e2b",
        remoteCwd: "/workspace",
        resolvedApiKey: "must-not-persist",
      },
    }));
    const runtimeProviderKeys = {
      resolveCredential: vi.fn(async () => "sk-e2b"),
    };
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease,
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: [{
        provider: "e2b",
        acquireLease: providerAcquireLease,
        releaseLease: vi.fn(),
        execute: vi.fn(),
      }],
      runtimeProviderKeys: runtimeProviderKeys as never,
    } as never);

    await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeEnvironment({
        driver: "sandbox",
        config: { provider: "e2b", credentialRef: "default", template: "base" },
      }),
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      persistedExecutionWorkspace: null,
    });

    expect(runtimeProviderKeys.resolveCredential).toHaveBeenCalledWith(
      COMPANY,
      "e2b",
      expect.objectContaining({ credentialRef: "default" }),
      expect.objectContaining({
        consumerType: "system",
        consumerId: "runtime-provider-key:e2b",
        actorType: "system",
        configPath: "runtimeProviderKeys.e2b.default",
        issueId: "issue-1",
        heartbeatRunId: "run-1",
      }),
    );
    expect(providerAcquireLease).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ resolvedApiKey: "sk-e2b" }),
    }));
    expect(acquireLease).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ resolvedApiKey: expect.any(String) }),
    }));
    expect(JSON.stringify(acquireLease.mock.calls[0]?.[0]?.metadata)).not.toContain("sk-e2b");
  });

  it("resolveRuntimeProviderConfig falls back to env.E2B_API_KEY (config unchanged) when no default key row exists (notFound 404)", async () => {
    // Platform-default E2B env carries no runtime_provider_keys row → resolveCredential
    // throws notFound(404). The operator env.E2B_API_KEY is the intended default (read
    // by the E2B provider from env at acquire), so the config is returned UNCHANGED
    // (no resolvedApiKey), NOT thrown — otherwise every sandboxed run fails with
    // "No default e2b provider key configured" (live cloud_auth regression).
    const runtimeProviderKeys = {
      resolveCredential: vi.fn(async () => {
        throw Object.assign(new Error("No default e2b provider key configured."), { status: 404 });
      }),
    };
    const config = { provider: "e2b", template: "base" };
    const result = await resolveRuntimeProviderConfig({
      companyId: COMPANY,
      provider: "e2b",
      config,
      runtimeProviderKeys: runtimeProviderKeys as never,
    });
    expect(result).toEqual(config);
    expect(result).not.toHaveProperty("resolvedApiKey");
  });

  it("resolveRuntimeProviderConfig still throws on a non-404 resolveCredential error (e.g. badRequest 400)", async () => {
    const runtimeProviderKeys = {
      resolveCredential: vi.fn(async () => {
        throw Object.assign(new Error('Unsupported credentialRef "weird"'), { status: 400 });
      }),
    };
    await expect(
      resolveRuntimeProviderConfig({
        companyId: COMPANY,
        provider: "e2b",
        config: { provider: "e2b", credentialRef: "weird" },
        runtimeProviderKeys: runtimeProviderKeys as never,
      }),
    ).rejects.toThrow("Unsupported credentialRef");
  });

  it("resolveRuntimeProviderConfig injects resolvedApiKey (dropping apiKey) when a default key IS configured", async () => {
    const runtimeProviderKeys = { resolveCredential: vi.fn(async () => "sk-real") };
    const result = await resolveRuntimeProviderConfig({
      companyId: COMPANY,
      provider: "e2b",
      config: { provider: "e2b", apiKey: "stale", template: "base" },
      runtimeProviderKeys: runtimeProviderKeys as never,
    });
    expect(result).toMatchObject({ resolvedApiKey: "sk-real" });
    expect(result).not.toHaveProperty("apiKey");
  });

  it("releases all active run leases through their owning provider drivers", async () => {
    const providerRelease = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn(async () => makeLease({
      provider: "e2b",
      providerLeaseId: "e2b-lease-1",
      status: "released",
      cleanupStatus: "success",
    }));
    const runtimeProviderKeys = {
      resolveCredential: vi.fn(async () => "sk-e2b"),
    };
    const environment = makeEnvironment({
      driver: "sandbox",
      config: { provider: "e2b", credentialRef: "default", template: "base" },
    });
    const lease = makeLease({
      provider: "e2b",
      providerLeaseId: "e2b-lease-1",
      metadata: {
        providerMetadata: {
          remoteCwd: "/workspace",
        },
      },
    });
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        get: vi.fn(async () => environment),
        listActiveLeasesForRun: vi.fn(async () => [lease]),
        acquireLease: vi.fn(),
        releaseLease,
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: [{
        provider: "e2b",
        acquireLease: vi.fn(),
        releaseLease: providerRelease,
        execute: vi.fn(),
      }],
      runtimeProviderKeys: runtimeProviderKeys as never,
    } as never);

    const released = await runtime.releaseRunLeases("run-1");

    expect(providerRelease).toHaveBeenCalledWith(expect.objectContaining({
      providerLeaseId: "e2b-lease-1",
      config: expect.objectContaining({ resolvedApiKey: "sk-e2b" }),
    }));
    expect(releaseLease).toHaveBeenCalledWith(lease.id, "released", {
      cleanupStatus: "success",
    });
    expect(released).toHaveLength(1);
    expect(released[0]?.status).toBe("released");
  });

  it("cleans up provider leases when DB lease persistence fails after provider acquire", async () => {
    const providerAcquireLease = vi.fn(async () => ({
      providerLeaseId: "e2b-lease-orphan-risk",
      metadata: {
        provider: "e2b",
        remoteCwd: "/workspace",
      },
    }));
    const providerRelease = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(async () => {
          throw new Error("db insert failed");
        }),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: [{
        provider: "e2b",
        acquireLease: providerAcquireLease,
        releaseLease: providerRelease,
        execute: vi.fn(),
      }],
      runtimeProviderKeys: {
        resolveCredential: vi.fn(async () => "sk-e2b"),
      } as never,
    } as never);

    await expect(runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeEnvironment({
        driver: "sandbox",
        config: { provider: "e2b", credentialRef: "default", template: "base" },
      }),
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      persistedExecutionWorkspace: null,
    })).rejects.toThrow("db insert failed");

    expect(providerAcquireLease).toHaveBeenCalled();
    expect(providerRelease).toHaveBeenCalledWith(expect.objectContaining({
      providerLeaseId: "e2b-lease-orphan-risk",
      config: expect.objectContaining({ resolvedApiKey: "sk-e2b" }),
    }));
  });

  it("resolves E2B provider keys before execute and release", async () => {
    const providerExecute = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok",
      stderr: "",
    }));
    const providerRelease = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn(async () => makeLease({ status: "released" }));
    const runtimeProviderKeys = {
      resolveCredential: vi.fn(async () => "sk-e2b"),
    };
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease,
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: [{
        provider: "e2b",
        acquireLease: vi.fn(),
        releaseLease: providerRelease,
        execute: providerExecute,
      }],
      runtimeProviderKeys: runtimeProviderKeys as never,
    } as never);
    const environment = makeEnvironment({
      driver: "sandbox",
      config: { provider: "e2b", credentialRef: "default", template: "base" },
    });
    const lease = makeLease({
      provider: "e2b",
      providerLeaseId: "e2b-lease-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      metadata: {
        providerMetadata: {
          remoteCwd: "/workspace",
        },
      },
    });

    await runtime.executeRunLeaseCommand({
      lease,
      environment,
      command: "codex",
      args: ["--json"],
      cwd: "/workspace",
      env: {},
      stdin: null,
      timeoutSec: 30,
    });
    await runtime.releaseRunLease({ environment, lease, status: "released" });

    expect(providerExecute).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ resolvedApiKey: "sk-e2b" }),
    }));
    expect(providerRelease).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ resolvedApiKey: "sk-e2b" }),
    }));
  });

  it("executeRunLeaseCommand forwards onStdout/onStderr to the provider and returns the buffered result", async () => {
    const captured: any[] = [];
    const streamed: string[] = [];
    const providerExecute = vi.fn(async (input: any) => {
      captured.push(input);
      input.onStdout?.("live-chunk");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "buffered", stderr: "" };
    });
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
      sandboxProviders: [{
        provider: "e2b",
        acquireLease: vi.fn(),
        releaseLease: vi.fn(),
        execute: providerExecute,
      }],
      runtimeProviderKeys: { resolveCredential: vi.fn(async () => "sk-e2b") } as never,
    } as never);
    const environment = makeEnvironment({
      driver: "sandbox",
      config: { provider: "e2b", credentialRef: "default", template: "base" },
    });
    const lease = makeLease({
      provider: "e2b",
      providerLeaseId: "e2b-lease-1",
      metadata: { providerMetadata: { remoteCwd: "/home/user" } },
    });

    const result = await runtime.executeRunLeaseCommand({
      environment,
      lease,
      command: "claude",
      args: ["--print"],
      cwd: "/home/user",
      env: {},
      timeoutSec: 60,
      onStdout: (c: string) => streamed.push(c),
      onStderr: () => {},
    });

    expect(captured[0].onStdout).toBeTypeOf("function");
    expect(captured[0].onStderr).toBeTypeOf("function");
    expect(streamed).toEqual(["live-chunk"]);
    expect(result.stdout).toBe("buffered"); // buffered result still returned
  });

  it("executes commands through fake provider sandbox leases", async () => {
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
    });

    const result = await runtime.executeRunLeaseCommand({
      lease: makeLease({
        provider: "fake",
        providerLeaseId: "fake-lease-1",
        metadata: {
          providerMetadata: {
            remoteCwd: "/workspace/fake",
          },
        },
      }),
      environment: makeEnvironment({ driver: "sandbox", config: { provider: "fake" } }),
      command: "codex",
      args: ["--json"],
      cwd: "/workspace/fake",
      env: { A: "1" },
      stdin: "prompt",
      timeoutSec: 30,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "fake: codex --json",
      stderr: "",
    });
  });

  it("rejects unknown sandbox providers until provider runtime exists", async () => {
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
    });

    await expect(runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeEnvironment({
        driver: "sandbox",
        config: { provider: "daytona", image: "node:22-bookworm" },
      }),
      issueId: null,
      heartbeatRunId: "00000000-0000-0000-0000-000000000030",
      persistedExecutionWorkspace: null,
    })).rejects.toThrow('Unsupported sandbox provider "daytona"');
  });

  it("fails fast for non-local non-sandbox drivers until their runtime drivers are implemented", async () => {
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
      },
    });

    await expect(runtime.acquireRunLease({
      companyId: COMPANY,
      environment: makeEnvironment({ driver: "ssh" }),
      issueId: null,
      heartbeatRunId: "00000000-0000-0000-0000-000000000030",
      persistedExecutionWorkspace: null,
    })).rejects.toThrow(/unsupported environment driver/i);
  });

  // ── U7.5 — warm acquire/release ─────────────────────────────────────────
  const warmSandboxEnv = () =>
    makeEnvironment({ driver: "sandbox", config: { provider: "e2b", template: "base" } });
  const warmRuntimeProviderKeys = () => ({ resolveCredential: vi.fn(async () => "sk-e2b") });

  it("U7.5: resumes an existing paused lease for a warm agent instead of creating", async () => {
    const pausedLease = makeLease({
      id: "paused-1",
      provider: "e2b",
      providerLeaseId: "e2b-paused-1",
      status: "paused",
      leasePolicy: "reuse_by_agent",
      agentId: "agent-1",
      metadata: { provider: "e2b", providerMetadata: { remoteCwd: "/workspace", reuseLease: true } },
    });
    const reactivatedLease = makeLease({
      id: "paused-1",
      provider: "e2b",
      providerLeaseId: "e2b-paused-1",
      status: "active",
      leasePolicy: "reuse_by_agent",
      agentId: "agent-1",
      pausedAt: null,
    });
    const createSpy = vi.fn(); // provider.acquireLease — must NOT run
    const dbAcquireSpy = vi.fn(); // env DB create — must NOT run
    const resumeSpy = vi.fn(async () => ({ resumed: true, providerLeaseId: "e2b-paused-1", metadata: { provider: "e2b" } }));
    const findResumablePausedLease = vi.fn(async () => pausedLease);
    const reactivatePausedLease = vi.fn(async () => reactivatedLease);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: dbAcquireSpy,
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
        findResumablePausedLease,
        reactivatePausedLease,
        markLeasePaused: vi.fn(),
        listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      },
      sandboxProviders: [{ provider: "e2b", acquireLease: createSpy, releaseLease: vi.fn(), resumeLease: resumeSpy, execute: vi.fn() }],
      runtimeProviderKeys: warmRuntimeProviderKeys() as never,
    } as never);

    const rec = await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: warmSandboxEnv(),
      issueId: "i1",
      heartbeatRunId: "r2",
      persistedExecutionWorkspace: null,
      warmPreference: true,
      agentId: "agent-1",
    });

    expect(findResumablePausedLease).toHaveBeenCalledWith({
      companyId: COMPANY,
      agentId: "agent-1",
      environmentId: makeEnvironment().id,
    });
    expect(resumeSpy).toHaveBeenCalled();
    expect(reactivatePausedLease).toHaveBeenCalledWith("paused-1", expect.objectContaining({ heartbeatRunId: "r2", issueId: "i1" }));
    expect(createSpy).not.toHaveBeenCalled();
    expect(dbAcquireSpy).not.toHaveBeenCalled();
    expect(rec.lease.leasePolicy).toBe("reuse_by_agent");
    expect(rec.lease.status).toBe("active");
  });

  it("U7.5: falls back to create-fresh when resume finds a dead sandbox — run does not error", async () => {
    const pausedLease = makeLease({
      id: "paused-2",
      provider: "e2b",
      providerLeaseId: "dead-lease",
      status: "paused",
      leasePolicy: "reuse_by_agent",
      agentId: "agent-1",
      metadata: { provider: "e2b", providerMetadata: { __dead: true } },
    });
    const resumeSpy = vi.fn(async () => ({ resumed: false, providerLeaseId: "dead-lease", metadata: { deadOnResume: true } }));
    const findResumablePausedLease = vi.fn(async () => pausedLease);
    const reactivatePausedLease = vi.fn();
    const releaseLease = vi.fn(async () => makeLease({ id: "paused-2", status: "expired", provider: "e2b" }));
    const createSpy = vi.fn(async () => ({ providerLeaseId: "e2b-fresh", metadata: { provider: "e2b", remoteCwd: "/workspace", reuseLease: true } }));
    const freshLease = makeLease({ id: "fresh-1", provider: "e2b", providerLeaseId: "e2b-fresh", status: "active", leasePolicy: "reuse_by_agent", agentId: "agent-1" });
    const dbAcquireSpy = vi.fn(async () => freshLease);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: dbAcquireSpy,
        releaseLease,
        releaseLeasesForRun: vi.fn(),
        findResumablePausedLease,
        reactivatePausedLease,
        markLeasePaused: vi.fn(),
        listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      },
      sandboxProviders: [{ provider: "e2b", acquireLease: createSpy, releaseLease: vi.fn(), resumeLease: resumeSpy, execute: vi.fn() }],
      runtimeProviderKeys: warmRuntimeProviderKeys() as never,
    } as never);

    const rec = await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: warmSandboxEnv(),
      issueId: "i1",
      heartbeatRunId: "r3",
      persistedExecutionWorkspace: null,
      warmPreference: true,
      agentId: "agent-1",
    });

    expect(resumeSpy).toHaveBeenCalled();
    expect(reactivatePausedLease).not.toHaveBeenCalled();
    // dead paused row retired (expired) before creating a fresh one
    expect(releaseLease).toHaveBeenCalledWith("paused-2", "expired", expect.objectContaining({ cleanupStatus: "success" }));
    expect(createSpy).toHaveBeenCalled();
    expect(dbAcquireSpy).toHaveBeenCalledWith(expect.objectContaining({ leasePolicy: "reuse_by_agent", agentId: "agent-1", provider: "e2b" }));
    expect(rec.lease.status).toBe("active");
  });

  it("U7.5: pauses (status=paused, releasedAt null) on release of a reuse_by_agent lease", async () => {
    const warmLease = makeLease({
      provider: "e2b",
      providerLeaseId: "e2b-warm",
      leasePolicy: "reuse_by_agent",
      agentId: "agent-1",
      metadata: { provider: "e2b", providerMetadata: { remoteCwd: "/workspace" } },
    });
    const pauseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const markLeasePaused = vi.fn(async () =>
      makeLease({ id: warmLease.id, status: "paused", leasePolicy: "reuse_by_agent", provider: "e2b", providerLeaseId: "e2b-warm", pausedAt: new Date().toISOString(), releasedAt: null }),
    );
    const releaseLease = vi.fn(); // must NOT run for a reuse lease
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease,
        releaseLeasesForRun: vi.fn(),
        markLeasePaused,
        findResumablePausedLease: vi.fn(),
        reactivatePausedLease: vi.fn(),
        listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      },
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: pauseProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: warmRuntimeProviderKeys() as never,
    } as never);

    const released = await runtime.releaseRunLease({ environment: warmSandboxEnv(), lease: warmLease, status: "released" });

    // MUST force reuseLease:true into config or the provider kills instead of pauses.
    expect(pauseProviderSpy).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ reuseLease: true }) }));
    expect(markLeasePaused).toHaveBeenCalledWith(warmLease.id, expect.objectContaining({ cleanupStatus: "success" }));
    expect(releaseLease).not.toHaveBeenCalled();
    expect(released?.status).toBe("paused");
    expect(released?.releasedAt).toBeNull();
  });

  it("U7.5: kills (status=released) on release of an ephemeral lease", async () => {
    const ephemeralLease = makeLease({
      provider: "e2b",
      providerLeaseId: "e2b-eph",
      leasePolicy: "ephemeral",
      metadata: { provider: "e2b", providerMetadata: { remoteCwd: "/workspace" } },
    });
    const killProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn(async () => makeLease({ id: ephemeralLease.id, status: "released", provider: "e2b" }));
    const markLeasePaused = vi.fn(); // must NOT run for an ephemeral lease
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: vi.fn(),
        releaseLease,
        releaseLeasesForRun: vi.fn(),
        markLeasePaused,
        findResumablePausedLease: vi.fn(),
        reactivatePausedLease: vi.fn(),
        listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      },
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: killProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: warmRuntimeProviderKeys() as never,
    } as never);

    const released = await runtime.releaseRunLease({ environment: warmSandboxEnv(), lease: ephemeralLease, status: "released" });

    expect(killProviderSpy).toHaveBeenCalled();
    expect(markLeasePaused).not.toHaveBeenCalled();
    expect(released?.status).toBe("released");
  });

  // ── W7.5c — warm reuse keyed on the Commander conversation ───────────────
  it("W7.5c: resumes a Commander conversation's paused lease when warmPreference + commanderConversationId are set", async () => {
    const pausedLease = makeLease({
      id: "conv-paused-1",
      provider: "e2b",
      providerLeaseId: "e2b-conv-paused-1",
      status: "paused",
      leasePolicy: "reuse_by_agent", // shared policy literal — resume KEY is the conversation column
      agentId: null,
      metadata: { provider: "e2b", providerMetadata: { remoteCwd: "/workspace", reuseLease: true } },
    });
    const reactivatedLease = makeLease({
      id: "conv-paused-1",
      provider: "e2b",
      providerLeaseId: "e2b-conv-paused-1",
      status: "active",
      leasePolicy: "reuse_by_agent",
      agentId: null,
      pausedAt: null,
    });
    const createSpy = vi.fn(); // provider.acquireLease — must NOT run
    const dbAcquireSpy = vi.fn(); // env DB create — must NOT run
    const resumeSpy = vi.fn(async () => ({ resumed: true, providerLeaseId: "e2b-conv-paused-1", metadata: { provider: "e2b" } }));
    const findResumableCommanderPausedLease = vi.fn(async () => pausedLease);
    const reactivatePausedLease = vi.fn(async () => reactivatedLease);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: dbAcquireSpy,
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
        findResumablePausedLease: vi.fn(), // agent path — must NOT match (agentId null)
        findResumableCommanderPausedLease,
        reactivatePausedLease,
        markLeasePaused: vi.fn(),
        listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      },
      sandboxProviders: [{ provider: "e2b", acquireLease: createSpy, releaseLease: vi.fn(), resumeLease: resumeSpy, execute: vi.fn() }],
      runtimeProviderKeys: warmRuntimeProviderKeys() as never,
    } as never);

    const rec = await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: warmSandboxEnv(),
      issueId: null,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
      warmPreference: true,
      agentId: null, // Commander has no agent row
      commanderConversationId: "conv1",
    });

    expect(findResumableCommanderPausedLease).toHaveBeenCalledWith({
      companyId: COMPANY,
      conversationId: "conv1",
      environmentId: makeEnvironment().id,
    });
    expect(resumeSpy).toHaveBeenCalled();
    expect(reactivatePausedLease).toHaveBeenCalledWith("conv-paused-1", expect.any(Object));
    expect(createSpy).not.toHaveBeenCalled();
    expect(dbAcquireSpy).not.toHaveBeenCalled();
    expect(rec.lease.leasePolicy).toBe("reuse_by_agent");
    expect(rec.lease.status).toBe("active");
  });

  it("W7.5c: crew (agentId null, no commanderConversationId, warmPreference false) never resumes — creates ephemeral", async () => {
    const resumeSpy = vi.fn();
    const findResumablePausedLease = vi.fn();
    const findResumableCommanderPausedLease = vi.fn();
    const createSpy = vi.fn(async () => ({ providerLeaseId: "e2b-eph-fresh", metadata: { provider: "e2b", remoteCwd: "/workspace" } }));
    const ephemeralLease = makeLease({ id: "eph-1", provider: "e2b", providerLeaseId: "e2b-eph-fresh", status: "active", leasePolicy: "ephemeral", agentId: null });
    const dbAcquireSpy = vi.fn(async () => ephemeralLease);
    const runtime = environmentRuntimeService({} as never, {
      environments: {
        acquireLease: dbAcquireSpy,
        releaseLease: vi.fn(),
        releaseLeasesForRun: vi.fn(),
        findResumablePausedLease,
        findResumableCommanderPausedLease,
        reactivatePausedLease: vi.fn(),
        markLeasePaused: vi.fn(),
        listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      },
      sandboxProviders: [{ provider: "e2b", acquireLease: createSpy, releaseLease: vi.fn(), resumeLease: resumeSpy, execute: vi.fn() }],
      runtimeProviderKeys: warmRuntimeProviderKeys() as never,
    } as never);

    const rec = await runtime.acquireRunLease({
      companyId: COMPANY,
      environment: warmSandboxEnv(),
      issueId: null,
      heartbeatRunId: null,
      persistedExecutionWorkspace: null,
      warmPreference: false,
      agentId: null,
    });

    expect(resumeSpy).not.toHaveBeenCalled();
    expect(findResumablePausedLease).not.toHaveBeenCalled();
    expect(findResumableCommanderPausedLease).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalled();
    expect(dbAcquireSpy).toHaveBeenCalledWith(expect.objectContaining({ leasePolicy: "ephemeral" }));
    expect(rec.lease.leasePolicy).toBe("ephemeral");
  });
});
