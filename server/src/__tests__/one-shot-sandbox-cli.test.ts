/**
 * U13.1 — `runOneShotCliInSandbox` is the single seam all three one-shot
 * CLI families (extraction, Commander compaction, readiness probes) route
 * through: acquire a fresh sandbox via `acquireExecutionContext` (U4) —
 * or reuse a pre-acquired batch lease via `sandboxHandle` (U13.3) — inject
 * ONLY the company's own provider key via `buildSandboxEnvAllowlist` (U5,
 * S2), resolve provider config EXACTLY the way `executeRunLeaseCommand`
 * does (S6: `lease.provider` / `lease.providerLeaseId` /
 * `lease.metadata.providerMetadata` + `resolveRuntimeProviderConfig`),
 * run one command, and tear the sandbox down (`releaseLease` with
 * `reuseLease:false`) ONLY when this call acquired its own lease.
 *
 * Real-shape note: `acquireExecutionContext`'s actual return type is
 * `{ sandbox: EnvironmentAcquisitionResult | null, lease, warmResolved }`
 * (see acquire-execution-context.ts + acquire-execution-context.test.ts) —
 * NOT a bare `EnvironmentAcquisitionResult`. The fakes below mirror that
 * real shape, not the plan doc's simplified sketch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runOneShotCliInSandbox,
  OneShotSandboxError,
  type OneShotSandboxHandle,
} from "../services/one-shot-sandbox-cli.js";
import { setDistributedShadowPort } from "../services/distributed-shadow-port.js";

const COMPANY_ID = "co-1";

function fakeCredential() {
  return { envName: "ANTHROPIC_API_KEY", value: "sk-co-key", provider: "anthropic", model: "claude-sonnet-4-6" };
}

function fakeAcquiredSandbox(overrides: Record<string, unknown> = {}) {
  return {
    sandbox: {
      environment: { id: "env-plat", companyId: COMPANY_ID, driver: "sandbox", config: { provider: "e2b" } },
      lease: {
        id: "lease-1",
        companyId: COMPANY_ID,
        environmentId: "env-plat",
        executionWorkspaceId: null,
        issueId: null,
        heartbeatRunId: null,
        status: "active",
        leasePolicy: "ephemeral",
        provider: "e2b",
        providerLeaseId: "plid-1",
        acquiredAt: new Date(0).toISOString(),
        lastUsedAt: new Date(0).toISOString(),
        expiresAt: null,
        releasedAt: null,
        failureReason: null,
        cleanupStatus: null,
        metadata: { providerMetadata: { sandboxId: "sbx-1" } },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      leaseContext: { executionWorkspaceId: null, executionWorkspaceMode: null },
      adapterType: "claude_local",
      configPatch: {},
      ...overrides,
    },
    lease: null,
    warmResolved: false,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    db: {} as never,
    companyId: COMPANY_ID,
    cliTool: "claude",
    command: "claude",
    args: ["-p", "extract"],
    stdinContent: "user content to extract",
    timeoutMs: 30_000,
    source: "extraction",
    ...overrides,
  };
}

describe("runOneShotCliInSandbox (U13.1)", () => {
  let acquireExecutionContext: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.fn>;
  let releaseLease: ReturnType<typeof vi.fn>;
  let sandboxProviderRuntime: ReturnType<typeof vi.fn>;
  let resolveRuntimeProviderConfig: ReturnType<typeof vi.fn>;
  let resolveCompanyProviderCredential: ReturnType<typeof vi.fn>;
  let runtimeProviderKeyService: ReturnType<typeof vi.fn>;
  let preflightOneShotCliSpend: ReturnType<typeof vi.fn>;
  let recordOneShotCliCost: ReturnType<typeof vi.fn>;
  // Wave 3 review (FIX 1): teardown now flips the DB row via
  // environmentRuntimeService(db).releaseRunLease — NOT the raw provider
  // releaseLease directly (that only kills the VM, it never flips
  // `environment_leases` to 'released'). `releaseLease` above stays as a
  // spy to PROVE it is never called directly by this module anymore.
  let releaseRunLease: ReturnType<typeof vi.fn>;
  let environmentRuntimeService: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    acquireExecutionContext = vi.fn().mockResolvedValue(fakeAcquiredSandbox());
    execute = vi.fn().mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" });
    releaseLease = vi.fn().mockResolvedValue({ cleanupStatus: "success" });
    sandboxProviderRuntime = vi.fn(() => ({ execute, releaseLease }));
    resolveRuntimeProviderConfig = vi.fn().mockResolvedValue({ provider: "e2b", resolvedApiKey: "e2b-key" });
    resolveCompanyProviderCredential = vi.fn().mockResolvedValue(fakeCredential());
    runtimeProviderKeyService = vi.fn(() => ({ resolveCredential: vi.fn() }));
    // U13.4: default green path for both budget deps — most tests below
    // aren't about budget/cost at all, so they should never observe these.
    preflightOneShotCliSpend = vi.fn().mockResolvedValue({ allowed: true });
    recordOneShotCliCost = vi.fn().mockResolvedValue({ id: "cost-1" });
    releaseRunLease = vi.fn().mockResolvedValue(null);
    environmentRuntimeService = vi.fn(() => ({ releaseRunLease }));
  });

  function deps() {
    return {
      acquireExecutionContext,
      sandboxProviderRuntime,
      resolveRuntimeProviderConfig,
      resolveCompanyProviderCredential,
      runtimeProviderKeyService,
      preflightOneShotCliSpend,
      recordOneShotCliCost,
      environmentRuntimeService,
    };
  }

  it("acquires once with environmentId:null, resolves config once, executes once, then releases once via environmentRuntimeService(db).releaseRunLease (Wave 3 review, FIX 1) — NOT the raw provider releaseLease", async () => {
    const input = baseInput({ deps: deps() });
    const result = await runOneShotCliInSandbox(input);

    expect(acquireExecutionContext).toHaveBeenCalledTimes(1);
    const [, acquireInput] = acquireExecutionContext.mock.calls[0];
    expect(acquireInput.environmentId).toBeNull();
    expect(acquireInput.runIdentity.companyId).toBe(COMPANY_ID);

    expect(resolveRuntimeProviderConfig).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);

    // FIX 1: the DB-flip path, not the raw provider kill-only call.
    expect(environmentRuntimeService).toHaveBeenCalledTimes(1);
    expect(environmentRuntimeService).toHaveBeenCalledWith(input.db);
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    const [releaseInput] = releaseRunLease.mock.calls[0];
    expect(releaseInput.status).toBe("released");
    expect(releaseInput.lease.id).toBe("lease-1");
    expect(releaseInput.environment.id).toBe("env-plat");
    expect(releaseLease).not.toHaveBeenCalled();

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0, durationMs: expect.any(Number) });
  });

  it("gates on environment.driver === 'sandbox'; a 'local' driver throws sandbox_unavailable and never calls execute", async () => {
    acquireExecutionContext.mockResolvedValue(
      fakeAcquiredSandbox({ environment: { id: "env-local", companyId: COMPANY_ID, driver: "local", config: {} } }),
    );

    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "sandbox_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves provider config the SAME way executeRunLeaseCommand does: lease.provider, lease.providerLeaseId, metadata.providerMetadata — never providerKey/leaseMetadata, never config:undefined", async () => {
    await runOneShotCliInSandbox(baseInput({ deps: deps() }));

    const [resolveArgs] = resolveRuntimeProviderConfig.mock.calls[0];
    expect(resolveArgs).toMatchObject({
      companyId: COMPANY_ID,
      provider: "e2b", // read from lease.provider
      config: { provider: "e2b" }, // environment.config
    });
    expect(resolveArgs.runtimeProviderKeys).toBeTruthy();

    const [execProvider, execInput] = execute.mock.calls[0];
    expect(execProvider).toBe("e2b"); // first positional arg = lease.provider
    expect(execInput.providerLeaseId).toBe("plid-1"); // from lease.providerLeaseId
    expect(execInput.leaseMetadata).toEqual({ sandboxId: "sbx-1" }); // metadata.providerMetadata
    expect(execInput.config).toEqual({ provider: "e2b", resolvedApiKey: "e2b-key" }); // resolveRuntimeProviderConfig output
    expect(execInput.config).not.toBeUndefined();
    expect(execInput).not.toHaveProperty("providerKey");
  });

  it("env passed to execute is exactly buildSandboxEnvAllowlist output — operator/infra secrets absent, company key present under its envName", async () => {
    await runOneShotCliInSandbox(baseInput({ deps: deps() }));

    const [, execInput] = execute.mock.calls[0];
    expect(execInput.env).toEqual({ ANTHROPIC_API_KEY: "sk-co-key" });
    for (const secret of [
      "DATABASE_URL",
      "DIRECT_DATABASE_URL",
      "GITHUB_PAT",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "BETTER_AUTH_SECRET",
      "AOA_AGENT_JWT_SECRET",
      "OPENAI_API_KEY",
    ]) {
      expect(execInput.env).not.toHaveProperty(secret);
    }
    expect(execInput.env.ANTHROPIC_API_KEY).toBe("sk-co-key");
  });

  it("forwards stdinContent to execute({ stdin })", async () => {
    await runOneShotCliInSandbox(baseInput({ deps: deps(), stdinContent: "extraction prompt content" }));
    const [, execInput] = execute.mock.calls[0];
    expect(execInput.stdin).toBe("extraction prompt content");
  });

  it("when stagedFile is passed instead of stdinContent, execute receives stdin:undefined AND stagedFile verbatim (U13.5)", async () => {
    const stagedFile = { remotePath: "/tmp/x.txt", content: "file content" };
    await runOneShotCliInSandbox(
      baseInput({ deps: deps(), stdinContent: undefined, stagedFile }),
    );
    const [, execInput] = execute.mock.calls[0];
    expect(execInput.stdin).toBeUndefined();
    // U13.5: the sandbox provider's execute() is the seam that actually
    // stages the file into the VM (mirrors how it already stages `stdin`
    // internally) — runOneShotCliInSandbox must forward stagedFile through,
    // not just null out stdin.
    expect(execInput.stagedFile).toEqual(stagedFile);
  });

  it("when stdinContent is passed (no stagedFile), execute receives stagedFile:undefined", async () => {
    await runOneShotCliInSandbox(baseInput({ deps: deps(), stdinContent: "plain stdin" }));
    const [, execInput] = execute.mock.calls[0];
    expect(execInput.stdin).toBe("plain stdin");
    expect(execInput.stagedFile).toBeUndefined();
  });

  it("maps execute {timedOut:true} to OneShotSandboxError kind:timeout", async () => {
    execute.mockResolvedValue({ exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "" });
    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "timeout",
    });
    // still tears the sandbox down even on failure — via releaseRunLease
    // (Wave 3 review, FIX 1), never the raw provider releaseLease.
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("maps a nonzero exitCode to OneShotSandboxError kind:nonzero_exit carrying exitCode + stderr, and still releases the self-acquired lease", async () => {
    execute.mockResolvedValue({ exitCode: 2, signal: null, timedOut: false, stdout: "", stderr: "boom" });
    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "nonzero_exit",
      exitCode: 2,
      stderr: "boom",
    });
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    const [releaseInput] = releaseRunLease.mock.calls[0];
    expect(releaseInput.status).toBe("released");
  });

  it("Wave 3 review (FIX 1): a THROWN execute() (not just a bad result) still releases the self-acquired lease via releaseRunLease, not the raw provider releaseLease", async () => {
    execute.mockRejectedValue(new Error("sandbox execute transport failure"));

    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toThrow(
      "sandbox execute transport failure",
    );

    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    const [releaseInput] = releaseRunLease.mock.calls[0];
    expect(releaseInput.status).toBe("released");
    expect(releaseLease).not.toHaveBeenCalled();
  });

  // ── Wave 3 review, FIX 1: orphan-safety ────────────────────────────────
  // A throw ANYWHERE between the lease being acquired and `execute` running
  // must still release the self-acquired VM+lease — otherwise it orphans
  // (a real e2b VM keeps running, and its `environment_leases` row stays
  // 'active' forever, since heartbeatRunId is always null for a one-shot
  // CLI and the org-only reaper can never find it).

  it("Wave 3 review (FIX 1, orphan-safety): a lease missing `provider` throws BEFORE execute but STILL releases the self-acquired lease", async () => {
    const acquired = fakeAcquiredSandbox();
    acquired.sandbox.lease.provider = null as never;
    acquireExecutionContext.mockResolvedValue(acquired);

    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "sandbox_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    const [releaseInput] = releaseRunLease.mock.calls[0];
    expect(releaseInput.status).toBe("released");
    expect(releaseInput.lease.id).toBe("lease-1");
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("Wave 3 review (FIX 1, orphan-safety): a lease missing `providerLeaseId` throws BEFORE execute but STILL releases the self-acquired lease", async () => {
    const acquired = fakeAcquiredSandbox();
    acquired.sandbox.lease.providerLeaseId = null as never;
    acquireExecutionContext.mockResolvedValue(acquired);

    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "sandbox_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
  });

  it("Wave 3 review (FIX 1, orphan-safety): resolveRuntimeProviderConfig throwing BEFORE execute STILL releases the self-acquired lease", async () => {
    resolveRuntimeProviderConfig.mockRejectedValue(new Error("provider config resolve boom"));

    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toThrow(
      "provider config resolve boom",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    const [releaseInput] = releaseRunLease.mock.calls[0];
    expect(releaseInput.status).toBe("released");
  });

  // ── Wave 3 review, FIX 1: the release is best-effort ───────────────────

  it("Wave 3 review (FIX 1): a releaseRunLease failure is best-effort — a successful run still returns its result", async () => {
    releaseRunLease.mockRejectedValue(new Error("release boom"));
    const result = await runOneShotCliInSandbox(baseInput({ deps: deps() }));
    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0, durationMs: expect.any(Number) });
  });

  it("Wave 3 review (FIX 1): a releaseRunLease failure is best-effort — it never masks the REAL thrown error from a failed run", async () => {
    releaseRunLease.mockRejectedValue(new Error("release boom"));
    execute.mockResolvedValue({ exitCode: 2, signal: null, timedOut: false, stdout: "", stderr: "boom" });
    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "nonzero_exit",
    });
  });

  it("when acquireExecutionContext throws, wraps as sandbox_unavailable and never calls execute", async () => {
    acquireExecutionContext.mockRejectedValue(new Error("lease_acquire_failed: boom"));
    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "sandbox_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    // Nothing was ever acquired here — no lease exists to release.
    expect(releaseRunLease).not.toHaveBeenCalled();
  });

  it("when acquireExecutionContext resolves {sandbox:null} (desktop/local_trusted signal), throws sandbox_unavailable and never calls execute", async () => {
    acquireExecutionContext.mockResolvedValue({ sandbox: null, lease: null, warmResolved: false });
    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "sandbox_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(releaseRunLease).not.toHaveBeenCalled();
  });

  it("when sandboxHandle is supplied, SKIPS acquireExecutionContext AND skips releaseLease (batch reuse, U13.3)", async () => {
    const handle: OneShotSandboxHandle = {
      environment: { id: "env-plat", companyId: COMPANY_ID, driver: "sandbox", config: { provider: "e2b" } } as never,
      lease: {
        id: "lease-batch",
        companyId: COMPANY_ID,
        environmentId: "env-plat",
        executionWorkspaceId: null,
        issueId: null,
        heartbeatRunId: null,
        status: "active",
        leasePolicy: "ephemeral",
        provider: "e2b",
        providerLeaseId: "plid-batch",
        acquiredAt: new Date(0).toISOString(),
        lastUsedAt: new Date(0).toISOString(),
        expiresAt: null,
        releasedAt: null,
        failureReason: null,
        cleanupStatus: null,
        metadata: { providerMetadata: { sandboxId: "sbx-batch" } },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      providerConfig: { provider: "e2b", resolvedApiKey: "batch-key" },
    };

    const result = await runOneShotCliInSandbox(baseInput({ deps: deps(), sandboxHandle: handle }));

    expect(acquireExecutionContext).not.toHaveBeenCalled();
    expect(resolveRuntimeProviderConfig).not.toHaveBeenCalled(); // handle.providerConfig short-circuits resolution
    expect(execute).toHaveBeenCalledTimes(1);
    const [execProvider, execInput] = execute.mock.calls[0];
    expect(execProvider).toBe("e2b");
    expect(execInput.providerLeaseId).toBe("plid-batch");
    expect(execInput.config).toEqual({ provider: "e2b", resolvedApiKey: "batch-key" });
    // A `sandboxHandle`-reuse run must NOT release — the batch caller owns
    // teardown, not this call (neither the raw provider path nor the
    // Wave 3 review FIX 1 DB-flip path).
    expect(releaseLease).not.toHaveBeenCalled();
    expect(environmentRuntimeService).not.toHaveBeenCalled();
    expect(releaseRunLease).not.toHaveBeenCalled();
    expect(result.stdout).toBe("ok");
  });

  // ── U13.4: budget preflight + cost recording ──────────────────────────────

  it("U13.4: throws sandbox_unavailable WITHOUT calling acquireExecutionContext, resolveCompanyProviderCredential, or execute when preflight blocks (fail-before-spend)", async () => {
    preflightOneShotCliSpend.mockResolvedValue({
      allowed: false,
      reason: "One-shot CLI budget reached for company co-1 (spend: 10500, cap: 10000)",
      reasonCode: "budget_exhausted",
    });

    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      name: "OneShotSandboxError",
      kind: "sandbox_unavailable",
    });

    expect(preflightOneShotCliSpend).toHaveBeenCalledTimes(1);
    expect(preflightOneShotCliSpend).toHaveBeenCalledWith({}, { companyId: COMPANY_ID });
    expect(resolveCompanyProviderCredential).not.toHaveBeenCalled();
    expect(acquireExecutionContext).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(recordOneShotCliCost).not.toHaveBeenCalled();
  });

  it("U13.4: preflight still runs (and can still block) when a sandboxHandle is supplied — there's no acquire to gate, but the call itself still spends", async () => {
    preflightOneShotCliSpend.mockResolvedValue({
      allowed: false,
      reason: "over budget",
      reasonCode: "budget_exhausted",
    });
    const handle: OneShotSandboxHandle = {
      environment: { id: "env-plat", companyId: COMPANY_ID, driver: "sandbox", config: { provider: "e2b" } } as never,
      lease: { id: "lease-batch", provider: "e2b", providerLeaseId: "plid-batch", metadata: {} } as never,
      providerConfig: { provider: "e2b" },
    };

    await expect(
      runOneShotCliInSandbox(baseInput({ deps: deps(), sandboxHandle: handle })),
    ).rejects.toMatchObject({ name: "OneShotSandboxError", kind: "sandbox_unavailable" });

    expect(preflightOneShotCliSpend).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("U13.4: on a successful run, records cost priced against the resolved credential's OWN provider+model, with estimated tokens and the input's source as billingType", async () => {
    execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "0123456789", stderr: "" });

    await runOneShotCliInSandbox(
      baseInput({ deps: deps(), stdinContent: "0123456789012345", source: "compaction" }),
    );

    expect(recordOneShotCliCost).toHaveBeenCalledTimes(1);
    const [, recordInput] = recordOneShotCliCost.mock.calls[0];
    expect(recordInput).toEqual({
      companyId: COMPANY_ID,
      provider: "anthropic", // credential.provider — fakeCredential(), not a generic cliTool rate table
      model: "claude-sonnet-4-6", // credential.model
      inputTokens: Math.ceil("0123456789012345".length / 4), // 4
      outputTokens: Math.ceil("0123456789".length / 4), // 3
      source: "compaction",
    });
  });

  it("U13.4: recordOneShotCliCost is called with source:'extraction' for baseInput's default", async () => {
    await runOneShotCliInSandbox(baseInput({ deps: deps() }));
    expect(recordOneShotCliCost).toHaveBeenCalledTimes(1);
    const [, recordInput] = recordOneShotCliCost.mock.calls[0];
    expect(recordInput.source).toBe("extraction");
  });

  it("U13.4: a recordOneShotCliCost failure is best-effort — the call still succeeds and returns the CLI result", async () => {
    recordOneShotCliCost.mockRejectedValue(new Error("insert failed"));

    const result = await runOneShotCliInSandbox(baseInput({ deps: deps() }));

    expect(result).toEqual({ stdout: "ok", stderr: "", exitCode: 0, durationMs: expect.any(Number) });
  });

  it("U13.4: cost is NOT recorded on a failed run (nonzero exit)", async () => {
    execute.mockResolvedValue({ exitCode: 2, signal: null, timedOut: false, stdout: "", stderr: "boom" });

    await expect(runOneShotCliInSandbox(baseInput({ deps: deps() }))).rejects.toMatchObject({
      kind: "nonzero_exit",
    });

    expect(recordOneShotCliCost).not.toHaveBeenCalled();
  });
  // ─── MIG-007 ───────────────────────────────────────────────────────────────
  // This helper is the ONE seam all three one-shot operation kinds route through, so
  // wiring it once covers extraction, compaction and readiness probes.
  describe("MIG-007 — the shadow observation", () => {
    afterEach(() => setDistributedShadowPort(null));

    it("records nothing when no port is registered, and the result is unchanged", async () => {
      const result = await runOneShotCliInSandbox(baseInput({ deps: deps() }));
      expect(result.stdout).toBe("ok");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("records exactly one observation, with the operation's own identity", async () => {
      const record = vi.fn(async () => {});
      setDistributedShadowPort({ record });
      await runOneShotCliInSandbox(baseInput({ deps: deps() }));

      expect(record).toHaveBeenCalledTimes(1);
      const observed = record.mock.calls[0]?.[0] as {
        companyId: string;
        source: { kind: string; operationKind: string; operationId: string };
        routing: { executionTargetType: string };
        principal: { kind: string };
        workloadCharacterization: { command: string; maxRuntimeSeconds: number };
      };
      expect(observed.companyId).toBe(COMPANY_ID);
      expect(observed.source.kind).toBe("one_shot");
      expect(observed.source.operationKind).toBe("extraction");
      // No fabricated run or issue: a one_shot carries its own operation identity, and
      // the FROZEN .strict() variant refuses anything else.
      expect(observed.source).not.toHaveProperty("runId");
      expect(observed.source).not.toHaveProperty("issueId");
      // The REAL resolved provider, not a constant.
      expect(observed.routing.executionTargetType).toBe("e2b");
      expect(observed.principal.kind).toBe("system");
      expect(observed.workloadCharacterization.command).toBe("claude");
      expect(observed.workloadCharacterization.maxRuntimeSeconds).toBe(30);
    });

    it.each([
      ["extraction", "extraction"],
      ["compaction", "compaction"],
      ["readiness", "readiness_probe"],
    ] as const)("maps the %s cost source to the frozen %s operation kind", async (source, kind) => {
      const record = vi.fn(async () => {});
      setDistributedShadowPort({ record });
      await runOneShotCliInSandbox(baseInput({ source, deps: deps() }));
      const observed = record.mock.calls[0]?.[0] as { source: { operationKind: string } };
      expect(observed.source.operationKind).toBe(kind);
    });

    it("observes BEFORE the command runs — the record is the intent, not the outcome", async () => {
      const order: string[] = [];
      setDistributedShadowPort({
        record: async () => {
          order.push("shadow");
        },
      });
      execute.mockImplementation(async () => {
        order.push("execute");
        return { exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" };
      });
      await runOneShotCliInSandbox(baseInput({ deps: deps() }));
      expect(order).toEqual(["shadow", "execute"]);
    });

    it("a port that throws never fails the operation", async () => {
      setDistributedShadowPort({
        record: async () => {
          throw new Error("shadow exploded");
        },
      });
      const result = await runOneShotCliInSandbox(baseInput({ deps: deps() }));
      expect(result.stdout).toBe("ok");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
