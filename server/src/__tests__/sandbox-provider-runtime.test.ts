import { describe, expect, it, vi } from "vitest";
import { createGvisorSandboxRuntimeProvider } from "../services/gvisor-sandbox-provider.js";
import {
  createE2bSandboxRuntimeProvider,
  createFakeSandboxRuntimeProvider,
  sandboxProviderRuntime,
} from "../services/sandbox-provider-runtime.js";

describe("sandboxProviderRuntime", () => {
  it("registers and resolves sandbox providers by key", () => {
    const provider = createFakeSandboxRuntimeProvider();
    const runtime = sandboxProviderRuntime({ providers: [provider] });

    expect(runtime.getProvider("fake")).toBe(provider);
    expect(runtime.getProvider("missing")).toBeNull();
  });

  it("acquires fake provider leases with remote execution metadata", async () => {
    const runtime = sandboxProviderRuntime({
      providers: [createFakeSandboxRuntimeProvider()],
    });

    const lease = await runtime.acquireLease("fake", {
      companyId: "company-1",
      environmentId: "env-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      config: {
        remoteCwd: "/workspace/run-1",
        shellCommand: "bash",
        timeoutMs: 60_000,
      },
      workspaceMode: "per_task",
    });

    expect(lease.providerLeaseId).toMatch(/^fake-sandbox-/);
    expect(lease.metadata).toEqual({
      provider: "fake",
      remoteCwd: "/workspace/run-1",
      shellCommand: "bash",
      timeoutMs: 60_000,
      workspaceMode: "per_task",
    });
  });

  it("executes commands through the fake provider contract", async () => {
    const provider = createFakeSandboxRuntimeProvider();
    const result = await provider.execute({
      providerLeaseId: "fake-sandbox-1",
      leaseMetadata: { remoteCwd: "/workspace/run-1" },
      command: "printf",
      args: ["hello"],
      cwd: "/workspace/run-1",
      env: { AOA: "1" },
      stdin: null,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "fake: printf hello",
      stderr: "",
      metadata: {
        cwd: "/workspace/run-1",
        envKeys: ["AOA"],
        providerLeaseId: "fake-sandbox-1",
      },
    });
  });

  it("releases fake provider leases idempotently", async () => {
    const provider = createFakeSandboxRuntimeProvider();

    await expect(provider.releaseLease({
      providerLeaseId: "fake-sandbox-1",
      leaseMetadata: { remoteCwd: "/workspace/run-1" },
    })).resolves.toEqual({
      cleanupStatus: "success",
      metadata: {
        releasedProviderLeaseId: "fake-sandbox-1",
      },
    });
  });

  it("acquires E2B leases through an injected E2B SDK importer", async () => {
    const commandsRun = vi.fn(async (command: string) => ({
      exitCode: 0,
      stdout: command === "pwd" ? "/home/user\n" : "",
      stderr: "",
    }));
    const setTimeout = vi.fn(async () => undefined);
    const sandbox = {
      sandboxId: "e2b-sandbox-1",
      sandboxDomain: "sandbox.example",
      commands: { run: commandsRun },
      setTimeout,
      kill: vi.fn(async () => undefined),
    };
    const create = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create, connect: vi.fn() } }),
      env: { E2B_API_KEY: "key-from-env" },
    });

    const lease = await provider.acquireLease({
      companyId: "company-1",
      environmentId: "env-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      config: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: true },
      workspaceMode: "per_task",
    });

    expect(create).toHaveBeenCalledWith("base", {
      apiKey: "key-from-env",
      timeoutMs: 60_000,
      metadata: { aoaProvider: "e2b", companyId: "company-1", environmentId: "env-1" },
    });
    expect(setTimeout).toHaveBeenCalledWith(60_000);
    expect(commandsRun).toHaveBeenCalledWith("pwd");
    expect(commandsRun).toHaveBeenCalledWith("mkdir -p '/home/user/aoa-workspace'");
    expect(lease).toEqual({
      providerLeaseId: "e2b-sandbox-1",
      metadata: {
        provider: "e2b",
        template: "base",
        timeoutMs: 60_000,
        reuseLease: true,
        sandboxId: "e2b-sandbox-1",
        sandboxDomain: "sandbox.example",
        remoteCwd: "/home/user/aoa-workspace",
        shellCommand: "bash",
        workspaceMode: "per_task",
      },
    });
  });

  it("threads E2B_DOMAIN into create for self-hosted", async () => {
    const commandsRun = vi.fn(async (command: string) => ({
      exitCode: 0,
      stdout: command === "pwd" ? "/home/user\n" : "",
      stderr: "",
    }));
    const sandbox = {
      sandboxId: "e2b-sandbox-1",
      sandboxDomain: "sandbox.example",
      commands: { run: commandsRun },
      setTimeout: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };
    const create = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create, connect: vi.fn() } }),
      env: { E2B_API_KEY: "key-from-env", E2B_DOMAIN: "e2b.aoa.internal" },
    });

    await provider.acquireLease({
      companyId: "company-1",
      environmentId: "env-1",
      issueId: null,
      heartbeatRunId: "run-1",
      config: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: true },
      workspaceMode: null,
    });

    expect(create).toHaveBeenCalledWith("base", expect.objectContaining({ domain: "e2b.aoa.internal" }));
  });

  it("prefers config.domain over env.E2B_DOMAIN via resolveE2bDomain precedence", async () => {
    const commandsRun = vi.fn(async (command: string) => ({
      exitCode: 0,
      stdout: command === "pwd" ? "/home/user\n" : "",
      stderr: "",
    }));
    const sandbox = {
      sandboxId: "e2b-sandbox-1",
      sandboxDomain: "sandbox.example",
      commands: { run: commandsRun },
      setTimeout: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };
    const create = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create, connect: vi.fn() } }),
      env: { E2B_API_KEY: "key-from-env", E2B_DOMAIN: "env-domain.example" },
    });

    await provider.acquireLease({
      companyId: "company-1",
      environmentId: "env-1",
      issueId: null,
      heartbeatRunId: "run-1",
      config: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: true, domain: "config-domain.example" },
      workspaceMode: null,
    });

    expect(create).toHaveBeenCalledWith("base", expect.objectContaining({ domain: "config-domain.example" }));
  });

  it("re-uses the lease-persisted domain on connect() for release", async () => {
    const sandbox = {
      commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
      setTimeout: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect }, SandboxNotFoundError: class extends Error {} }),
      env: { E2B_API_KEY: "key-from-env" },
    });

    await provider.releaseLease({
      providerLeaseId: "e2b-sandbox-1",
      leaseMetadata: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: false, domain: "e2b.aoa.internal" },
    });

    expect(connect).toHaveBeenCalledWith("e2b-sandbox-1", expect.objectContaining({ domain: "e2b.aoa.internal" }));
  });

  // U7.4 — provider warm-resume op.
  it("resumes a paused E2B sandbox by connecting to its id", async () => {
    const connect = vi.fn(async () => ({
      sandboxId: "e2b-1",
      sandboxDomain: "d",
      commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "/home/user\n", stderr: "" })) },
      setTimeout: vi.fn(),
    }));
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "k" },
    });

    const r = await provider.resumeLease!({
      providerLeaseId: "e2b-1",
      leaseMetadata: { template: "base", timeoutMs: 60_000, reuseLease: true },
      config: null,
    });

    expect(r.resumed).toBe(true);
    expect(connect).toHaveBeenCalledWith("e2b-1", { apiKey: "k", timeoutMs: 60_000 });
  });

  it("reports resumed:false (create-fresh) when the paused sandbox is gone — never throws", async () => {
    class SandboxNotFoundError extends Error {}
    const connect = vi.fn(async () => {
      throw new SandboxNotFoundError("gone");
    });
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect }, SandboxNotFoundError }),
      env: { E2B_API_KEY: "k" },
    });

    await expect(
      provider.resumeLease!({ providerLeaseId: "dead", leaseMetadata: { reuseLease: true }, config: null }),
    ).resolves.toMatchObject({ resumed: false });
  });

  it("reports resumed:false and never throws when connect fails for a reason OTHER than SandboxNotFoundError", async () => {
    const connect = vi.fn(async () => {
      throw new Error("network timeout");
    });
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect }, SandboxNotFoundError: class extends Error {} }),
      env: { E2B_API_KEY: "k" },
    });

    await expect(
      provider.resumeLease!({ providerLeaseId: "dead", leaseMetadata: { reuseLease: true }, config: null }),
    ).resolves.toEqual({ resumed: false, providerLeaseId: "dead", metadata: { deadOnResume: true } });
  });

  it("pauses (not kills) on release when reuseLease is true", async () => {
    const pause = vi.fn(async () => undefined);
    const kill = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({ commands: { run: vi.fn() }, pause, kill }));
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "k" },
    });

    await provider.releaseLease({
      providerLeaseId: "e2b-1",
      leaseMetadata: { reuseLease: true },
      config: { reuseLease: true },
    });

    expect(pause).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills (not pauses) on release when reuseLease is false", async () => {
    const pause = vi.fn(async () => undefined);
    const kill = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({ commands: { run: vi.fn() }, pause, kill }));
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "k" },
    });

    await provider.releaseLease({
      providerLeaseId: "e2b-1",
      leaseMetadata: { reuseLease: false },
      config: { reuseLease: false },
    });

    expect(kill).toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("fake provider resumeLease echoes resumed:true unless leaseMetadata.__dead is true", async () => {
    const provider = createFakeSandboxRuntimeProvider();

    await expect(
      provider.resumeLease!({ providerLeaseId: "fake-sandbox-1", leaseMetadata: { remoteCwd: "/workspace" }, config: null }),
    ).resolves.toMatchObject({ resumed: true, providerLeaseId: "fake-sandbox-1" });

    await expect(
      provider.resumeLease!({ providerLeaseId: "fake-sandbox-1", leaseMetadata: { __dead: true }, config: null }),
    ).resolves.toMatchObject({ resumed: false, providerLeaseId: "fake-sandbox-1" });
  });

  it("resumeLease passthrough throws a clear error for a provider that does not implement it", () => {
    const runtime = sandboxProviderRuntime({ providers: [createGvisorSandboxRuntimeProvider()] });

    expect(() => runtime.resumeLease("gvisor", { providerLeaseId: "x", leaseMetadata: null })).toThrow(
      /does not support resume/,
    );
  });

  it("validates E2B config without exposing API keys", async () => {
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect: vi.fn() } }),
      env: {},
    });

    await expect(provider.validateConfig?.({
      provider: "e2b",
      template: "base",
      apiKey: "secret-key",
      timeoutMs: 60_000,
    })).resolves.toEqual({
      ok: true,
      provider: "e2b",
      sanitizedConfig: {
        provider: "e2b",
        template: "base",
        timeoutMs: 60_000,
        reuseLease: false,
        hasApiKey: true,
        selfHosted: false,
      },
    });
  });

  it("accepts internally resolved E2B API keys without exposing them", async () => {
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect: vi.fn() } }),
      env: {},
    });

    await expect(provider.validateConfig?.({
      provider: "e2b",
      template: "base",
      resolvedApiKey: "resolved-secret-key",
      timeoutMs: 60_000,
    })).resolves.toEqual({
      ok: true,
      provider: "e2b",
      sanitizedConfig: {
        provider: "e2b",
        template: "base",
        timeoutMs: 60_000,
        reuseLease: false,
        hasApiKey: true,
        selfHosted: false,
      },
    });
  });

  it("rejects E2B config that has no API key source", async () => {
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect: vi.fn() } }),
      env: {},
    });

    await expect(provider.validateConfig?.({
      provider: "e2b",
      template: "base",
    })).resolves.toEqual({
      ok: false,
      provider: "e2b",
      errors: ["E2B sandbox environments require an API key in config or E2B_API_KEY."],
      sanitizedConfig: {
        provider: "e2b",
        template: "base",
        timeoutMs: 3_600_000,
        reuseLease: false,
        hasApiKey: false,
        selfHosted: false,
      },
    });
  });

  it("probes E2B by creating and cleaning up a sandbox", async () => {
    const commandsRun = vi.fn(async (command: string) => ({
      exitCode: 0,
      stdout: command === "pwd" ? "/home/user\n" : "",
      stderr: "",
    }));
    const sandbox = {
      sandboxId: "e2b-probe-1",
      sandboxDomain: "probe.example",
      commands: { run: commandsRun },
      setTimeout: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    };
    const create = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create, connect: vi.fn() } }),
      env: {},
    });

    const result = await provider.probe?.({
      companyId: "company-1",
      environmentId: "probe",
      config: { provider: "e2b", template: "base", apiKey: "secret-key", timeoutMs: 60_000 },
    });

    expect(create).toHaveBeenCalledWith("base", {
      apiKey: "secret-key",
      timeoutMs: 60_000,
      metadata: { aoaProvider: "e2b", companyId: "company-1", environmentId: "probe" },
    });
    expect(sandbox.kill).toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      provider: "e2b",
      summary: "E2B sandbox created and workspace directory prepared.",
      metadata: {
        template: "base",
        timeoutMs: 60_000,
        sandboxId: "e2b-probe-1",
        sandboxDomain: "probe.example",
        remoteCwd: "/home/user/aoa-workspace",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("executes E2B commands through a login shell with staged stdin", async () => {
    const commandsRun = vi.fn(async (command: string, options?: Record<string, unknown>) => ({
      exitCode: 0,
      stdout: `ran:${command}`,
      stderr: JSON.stringify(options ?? {}),
    }));
    const sandbox = {
      commands: { run: commandsRun },
      files: {
        write: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
      setTimeout: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "key-from-env" },
      randomId: () => "stdin-1",
    });

    const result = await provider.execute({
      providerLeaseId: "e2b-sandbox-1",
      leaseMetadata: { template: "base", timeoutMs: 30_000, remoteCwd: "/workspace" },
      config: { template: "base", apiKey: "key-from-config", timeoutMs: 30_000 },
      command: "codex",
      args: ["--json"],
      cwd: "/workspace",
      env: { AOA: "1" },
      stdin: "hello",
      timeoutMs: 5_000,
    });

    expect(connect).toHaveBeenCalledWith("e2b-sandbox-1", {
      apiKey: "key-from-config",
      timeoutMs: 30_000,
    });
    expect(sandbox.files.write).toHaveBeenCalledWith("/tmp/aoa-stdin-stdin-1", "hello");
    expect(commandsRun).toHaveBeenCalledWith(
      expect.stringContaining("exec env AOA='1' 'codex' '--json' < '/tmp/aoa-stdin-stdin-1'"),
      { cwd: "/workspace", timeoutMs: 5_000 },
    );
    expect(sandbox.files.remove).toHaveBeenCalledWith("/tmp/aoa-stdin-stdin-1");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("codex");
  });

  it("executes E2B commands with a staged file (U13.5): writes it into the VM at the caller-supplied path BEFORE running the command, and redirects it into the CLI's stdin", async () => {
    const writeOrder: string[] = [];
    const commandsRun = vi.fn(async (command: string, options?: Record<string, unknown>) => {
      // The write must already have happened by the time the command runs —
      // proves the write-before-execute ordering, not just that both happened.
      writeOrder.push("run");
      return { exitCode: 0, stdout: `ran:${command}`, stderr: JSON.stringify(options ?? {}) };
    });
    const sandbox = {
      commands: { run: commandsRun },
      files: {
        write: vi.fn(async () => {
          writeOrder.push("write");
        }),
        remove: vi.fn(async () => undefined),
      },
      setTimeout: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "key-from-env" },
    });

    const result = await provider.execute({
      providerLeaseId: "e2b-sandbox-1",
      leaseMetadata: { template: "base", timeoutMs: 30_000, remoteCwd: "/workspace" },
      config: { template: "base", apiKey: "key-from-config", timeoutMs: 30_000 },
      command: "claude",
      args: ["--print", "--system-prompt", "sys"],
      cwd: "/workspace",
      env: { AOA: "1" },
      stdin: undefined,
      stagedFile: { remotePath: "/tmp/aoa-file-import-xyz.txt", content: "uploaded file text" },
      timeoutMs: 5_000,
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/tmp/aoa-file-import-xyz.txt",
      "uploaded file text",
    );
    expect(writeOrder).toEqual(["write", "run"]);
    expect(commandsRun).toHaveBeenCalledWith(
      expect.stringContaining("< '/tmp/aoa-file-import-xyz.txt'"),
      { cwd: "/workspace", timeoutMs: 5_000 },
    );
    expect(sandbox.files.remove).toHaveBeenCalledWith("/tmp/aoa-file-import-xyz.txt");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("stagedFile takes priority over stdin when both are somehow present (defensive)", async () => {
    const commandsRun = vi.fn(async (command: string) => ({ exitCode: 0, stdout: command, stderr: "" }));
    const sandbox = {
      commands: { run: commandsRun },
      files: { write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
      setTimeout: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "key-from-env" },
      randomId: () => "should-not-be-used",
    });

    await provider.execute({
      providerLeaseId: "e2b-sandbox-1",
      leaseMetadata: { template: "base", timeoutMs: 30_000, remoteCwd: "/workspace" },
      config: { template: "base", apiKey: "key-from-config", timeoutMs: 30_000 },
      command: "codex",
      args: ["exec"],
      env: {},
      stdin: "should be ignored",
      stagedFile: { remotePath: "/tmp/aoa-priority.txt", content: "wins" },
      timeoutMs: 5_000,
    });

    expect(sandbox.files.write).toHaveBeenCalledTimes(1);
    expect(sandbox.files.write).toHaveBeenCalledWith("/tmp/aoa-priority.txt", "wins");
  });

  it("creates CODEX_HOME before executing E2B commands that need it", async () => {
    const commandsRun = vi.fn(async (command: string, options?: Record<string, unknown>) => ({
      exitCode: 0,
      stdout: `ran:${command}`,
      stderr: JSON.stringify(options ?? {}),
    }));
    const sandbox = {
      commands: { run: commandsRun },
      setTimeout: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: { E2B_API_KEY: "key-from-env" },
    });

    await provider.execute({
      providerLeaseId: "e2b-sandbox-1",
      leaseMetadata: { template: "base", timeoutMs: 30_000, remoteCwd: "/workspace" },
      config: { template: "base", apiKey: "key-from-config", timeoutMs: 30_000 },
      command: "codex",
      args: ["exec", "-"],
      cwd: "/workspace",
      env: { CODEX_HOME: "/tmp/aoa-codex-home", OPENAI_API_KEY: "redacted" },
      stdin: null,
      timeoutMs: 5_000,
    });

    expect(commandsRun).toHaveBeenCalledWith(
      expect.stringContaining("mkdir -p '/tmp/aoa-codex-home' && exec env"),
      { cwd: "/workspace", timeoutMs: 5_000 },
    );
  });

  it("connects to E2B using internally resolved credentials", async () => {
    const commandsRun = vi.fn(async (command: string, options?: Record<string, unknown>) => ({
      exitCode: 0,
      stdout: `ran:${command}`,
      stderr: JSON.stringify(options ?? {}),
    }));
    const sandbox = {
      commands: { run: commandsRun },
      setTimeout: vi.fn(async () => undefined),
    };
    const connect = vi.fn(async () => sandbox);
    const provider = createE2bSandboxRuntimeProvider({
      importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
      env: {},
    });

    await provider.execute({
      providerLeaseId: "e2b-sandbox-1",
      leaseMetadata: { template: "base", timeoutMs: 30_000, remoteCwd: "/workspace" },
      config: { template: "base", resolvedApiKey: "resolved-secret-key", timeoutMs: 30_000 },
      command: "pwd",
      args: [],
      cwd: "/workspace",
      env: {},
      stdin: null,
      timeoutMs: 5_000,
    });

    expect(connect).toHaveBeenCalledWith("e2b-sandbox-1", {
      apiKey: "resolved-secret-key",
      timeoutMs: 30_000,
    });
  });

  describe("E2B readFiles/writeFiles binary round-trip (RW4)", () => {
    // The real E2B SDK's `sandbox.files.read` returns a UTF-8-**decoded
    // string** by default (or with `format: "text"`) — lossy for non-UTF-8
    // bytes, each such byte substituted with U+FFFD — and only returns the
    // raw `Uint8Array` when called with `{ format: "bytes" }` (verified
    // against `node_modules/e2b/dist/index.d.ts` read overloads ~4185/4199).
    // This mock reproduces that exact behavior. The fake in-memory provider
    // used elsewhere in this suite round-trips a stored `Buffer` verbatim
    // regardless of format, so it CANNOT catch this class of bug — only a
    // mock that performs the real lossy UTF-8 decode on the non-bytes path
    // can prove the provider actually requests bytes.
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

    function makeRealisticReadMock(bytes: Buffer) {
      return vi.fn(async (_path: string, opts?: { format?: string }) => {
        if (opts?.format === "bytes") {
          return new Uint8Array(bytes);
        }
        // Real SDK behavior: UTF-8-decode server-side. `TextDecoder`
        // without `fatal: true` substitutes U+FFFD for invalid byte
        // sequences — lossy, does not round-trip.
        return new TextDecoder("utf-8").decode(bytes);
      });
    }

    it('requests { format: "bytes" } and returns the exact original bytes for a binary fixture', async () => {
      const read = makeRealisticReadMock(PNG_HEADER);
      const sandbox = {
        commands: { run: vi.fn() },
        files: { write: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), read },
        setTimeout: vi.fn(async () => undefined),
      };
      const connect = vi.fn(async () => sandbox);
      const provider = createE2bSandboxRuntimeProvider({
        importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
        env: { E2B_API_KEY: "key-from-env" },
      });

      const results = await provider.readFiles!({
        providerLeaseId: "e2b-sandbox-1",
        leaseMetadata: { template: "base", timeoutMs: 30_000 },
        paths: ["/workspace/logo.png"],
      });

      // The crux of RW4: without `{ format: "bytes" }` this call returns a
      // lossy UTF-8 string and the assertion below fails.
      expect(read).toHaveBeenCalledWith("/workspace/logo.png", { format: "bytes" });
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("/workspace/logo.png");
      expect(Buffer.compare(results[0].content, PNG_HEADER)).toBe(0);
    });

    it("writeFiles never passes a raw Node Buffer to sandbox.files.write (SDK-accepted ArrayBuffer only)", async () => {
      const write = vi.fn(async () => undefined);
      const sandbox = {
        commands: { run: vi.fn() },
        files: { write, remove: vi.fn(async () => undefined) },
        setTimeout: vi.fn(async () => undefined),
      };
      const connect = vi.fn(async () => sandbox);
      const provider = createE2bSandboxRuntimeProvider({
        importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }),
        env: { E2B_API_KEY: "key-from-env" },
      });

      await provider.writeFiles!({
        providerLeaseId: "e2b-sandbox-1",
        leaseMetadata: { template: "base", timeoutMs: 30_000 },
        files: [{ path: "/workspace/logo.png", content: PNG_HEADER }],
      });

      expect(write).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenContent] = write.mock.calls[0] as [string, unknown];
      expect(writtenPath).toBe("/workspace/logo.png");
      expect(Buffer.isBuffer(writtenContent)).toBe(false);
      expect(writtenContent).toBeInstanceOf(ArrayBuffer);
      expect(Buffer.compare(Buffer.from(writtenContent as ArrayBuffer), PNG_HEADER)).toBe(0);
    });
  });

  it("registers fake and E2B providers by default", () => {
    const runtime = sandboxProviderRuntime();
    expect(runtime.getProvider("fake")).not.toBeNull();
    expect(runtime.getProvider("e2b")).not.toBeNull();
  });
});
