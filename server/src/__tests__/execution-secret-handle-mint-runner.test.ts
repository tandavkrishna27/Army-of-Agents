// DAT-008 slice 1 — the impure half of the mint (input gathering + write).
//
// The repo surface is two functions, so this needs no drizzle mocking: the runner
// declares `ExecutionSecretMintRepo` precisely so it can be driven by a pair of
// stubs. What is under test here is NOT the decision (that is
// `execution-secret-handle-mint.test.ts`) but the gathering: which env binding is
// read, what is written, and what is deliberately NOT read.

import { describe, expect, it, vi } from "vitest";
import {
  mintExecutionSecretHandleForPlacement,
  mintRunJwtHandleForPlacement,
  providerBindingForEnvVar,
  type ExecutionSecretMintRepo,
} from "../services/execution-secret-handle-mint-runner.js";

function repo(agent: { adapterType: string; adapterConfig: Record<string, unknown> } | null) {
  const inserted: unknown[] = [];
  const stub: ExecutionSecretMintRepo = {
    loadAgentAdapterBinding: vi.fn(async () => agent),
    insertExecutionSecretHandle: vi.fn(async (values) => {
      inserted.push(values);
      return { handle: values.handle, minted: true };
    }),
  };
  return { stub, inserted };
}

const BASE = {
  organizationId: "org-1",
  companyId: "co-1",
  jobId: "job-1",
  executorPrincipalKind: "agent",
  executorPrincipalId: "agent-1",
  placementOwner: "managed_cloud",
  credentialKind: "company_api_key",
  targetGeneration: 4,
  deploymentMode: "cloud_auth",
  newHandleId: () => "11111111-2222-4333-8444-555555555555",
} as const;

describe("providerBindingForEnvVar", () => {
  it("returns null when the agent sets no value for that env var", () => {
    expect(providerBindingForEnvVar({ env: { OTHER: "x" } }, "ANTHROPIC_API_KEY")).toBeNull();
    expect(providerBindingForEnvVar({}, "ANTHROPIC_API_KEY")).toBeNull();
  });

  it("reads ONLY the requested env var", () => {
    const config = { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "other" } } };
    expect(providerBindingForEnvVar(config, "ANTHROPIC_API_KEY")).toBeNull();
  });

  it("classifies a secret_ref, defaulting an absent version to latest", () => {
    expect(providerBindingForEnvVar(
      { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec-9" } } },
      "ANTHROPIC_API_KEY",
    )).toEqual({ type: "secret_ref", secretId: "sec-9", version: "latest" });
  });

  it("classifies a bare legacy string as plain, not as absent", () => {
    // EnvBinding still accepts a bare string as legacy plaintext. Reading it as
    // "absent" would silently swap the agent's own key for the company key.
    expect(providerBindingForEnvVar({ env: { ANTHROPIC_API_KEY: "sk-literal" } }, "ANTHROPIC_API_KEY"))
      .toEqual({ type: "plain" });
  });

  it("classifies an explicitly EMPTY value as plain — an intentional override", () => {
    expect(providerBindingForEnvVar({ env: { ANTHROPIC_API_KEY: "" } }, "ANTHROPIC_API_KEY"))
      .toEqual({ type: "plain" });
    expect(providerBindingForEnvVar({ env: { ANTHROPIC_API_KEY: { type: "plain", value: "" } } }, "ANTHROPIC_API_KEY"))
      .toEqual({ type: "plain" });
  });

  it.each([
    ["a number", 42],
    ["an empty object", {}],
    ["an unknown discriminant", { type: "bogus" }],
    ["a secret_ref with no id", { type: "secret_ref" }],
    ["a secret_ref with an empty id", { type: "secret_ref", secretId: "" }],
    ["null", null],
  ])("refuses to mint on a malformed binding (%s) rather than substituting the company key", (_label, raw) => {
    // canonicalizeBinding does not VALIDATE: several of these reach its secret_ref
    // arm and produce `secretId: undefined`, which would mint a company_secret
    // handle pointing at nothing. An unusable override must refuse, never fall back.
    expect(providerBindingForEnvVar({ env: { ANTHROPIC_API_KEY: raw } }, "ANTHROPIC_API_KEY"))
      .toEqual({ type: "plain" });
  });

  it("treats a non-object env as no binding rather than throwing", () => {
    expect(providerBindingForEnvVar({ env: "nope" }, "ANTHROPIC_API_KEY")).toBeNull();
    expect(providerBindingForEnvVar({ env: ["a"] }, "ANTHROPIC_API_KEY")).toBeNull();
    expect(providerBindingForEnvVar({ env: null }, "ANTHROPIC_API_KEY")).toBeNull();
  });
});

describe("mintExecutionSecretHandleForPlacement", () => {
  it("writes a sandbox_local_only env handle with a null destination", async () => {
    const { stub, inserted } = repo({ adapterType: "claude_local", adapterConfig: {} });
    const outcome = await mintExecutionSecretHandleForPlacement(stub, BASE);

    expect(outcome).toEqual({
      minted: true,
      handle: "11111111-2222-4333-8444-555555555555",
      refKind: "provider_key",
      deduped: false,
    });
    expect(inserted[0]).toMatchObject({
      handle: "11111111-2222-4333-8444-555555555555",
      refKind: "provider_key",
      refId: "provider:anthropic",
      materialization: "env",
      usePolicy: "sandbox_local_only",
      envTarget: "ANTHROPIC_API_KEY",
      boundTargetGeneration: 4,
      ownerPrincipalKind: "agent",
      ownerPrincipalId: "agent-1",
    });
  });

  it("binds the AGENT's own secret when the provider env var is a secret_ref", async () => {
    const { stub, inserted } = repo({
      adapterType: "claude_local",
      adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", secretId: "sec-own", version: 2 } } },
    });
    await mintExecutionSecretHandleForPlacement(stub, BASE);
    expect(inserted[0]).toMatchObject({ refKind: "company_secret", refId: "sec-own" });
  });

  it("mints NOTHING when the agent carries a plain literal", async () => {
    const { stub, inserted } = repo({
      adapterType: "claude_local",
      adapterConfig: { env: { ANTHROPIC_API_KEY: "sk-literal" } },
    });
    expect(await mintExecutionSecretHandleForPlacement(stub, BASE))
      .toEqual({ minted: false, reason: "agent_plain_literal_override" });
    expect(inserted).toHaveLength(0);
  });

  it("never looks up an agent for a non-agent executor", async () => {
    const { stub } = repo({ adapterType: "claude_local", adapterConfig: {} });
    const outcome = await mintExecutionSecretHandleForPlacement(stub, {
      ...BASE, executorPrincipalKind: "user",
    });
    expect(outcome).toEqual({ minted: false, reason: "executor_not_agent" });
    expect(stub.loadAgentAdapterBinding).not.toHaveBeenCalled();
  });

  // CLI-007 (E7-F001 guard-2 correction): a real coding-agent task_run is stamped
  // `executor_principal_kind = "worker"` with the agent id in `executor_principal_id`
  // (Decision #121). The runner must look the binding up under that real shape and mint.
  it("mints for a coding-agent run stamped as a `worker` executor (the real shape)", async () => {
    const { stub, inserted } = repo({ adapterType: "claude_local", adapterConfig: {} });
    const outcome = await mintExecutionSecretHandleForPlacement(stub, {
      ...BASE, executorPrincipalKind: "worker", executorPrincipalId: "agent-1",
    });
    expect(outcome).toMatchObject({ minted: true, refKind: "provider_key" });
    expect(stub.loadAgentAdapterBinding).toHaveBeenCalledWith({ companyId: "co-1", agentId: "agent-1" });
    expect(inserted[0]).toMatchObject({ refKind: "provider_key", refId: "provider:anthropic" });
  });

  // A worker/sandbox whose principal is NOT a coding agent (missing binding) still refuses
  // at the v1-adapter gate — so the widened guard 2 does not open the mint to non-coding runs.
  it("refuses a `worker` executor whose principal is not a coding agent", async () => {
    const { stub } = repo(null); // loadAgentAdapterBinding returns null → adapter "" → guard 3
    const outcome = await mintExecutionSecretHandleForPlacement(stub, {
      ...BASE, executorPrincipalKind: "worker", executorPrincipalId: "not-an-agent",
    });
    expect(outcome).toEqual({ minted: false, reason: "adapter_not_v1_scope" });
    expect(stub.loadAgentAdapterBinding).toHaveBeenCalledWith({ companyId: "co-1", agentId: "not-an-agent" });
  });

  it("mints nothing when the agent row is missing", async () => {
    // A missing agent leaves the adapter type empty, so the v1-scope gate refuses
    // first. That is the fail-closed direction AND it is non-disclosing: the refusal
    // reason does not distinguish "no such agent" from "adapter out of scope".
    const { stub, inserted } = repo(null);
    expect(await mintExecutionSecretHandleForPlacement(stub, BASE))
      .toEqual({ minted: false, reason: "adapter_not_v1_scope" });
    expect(inserted).toHaveLength(0);
  });

  it("does not touch the database on a self-hosted deployment", async () => {
    const { stub } = repo({ adapterType: "claude_local", adapterConfig: {} });
    expect(await mintExecutionSecretHandleForPlacement(stub, { ...BASE, deploymentMode: "local_trusted" }))
      .toEqual({ minted: false, reason: "not_cloud_deployment" });
    expect(stub.insertExecutionSecretHandle).not.toHaveBeenCalled();
  });

  it("reports a deduped write without minting a second handle", async () => {
    const stub: ExecutionSecretMintRepo = {
      loadAgentAdapterBinding: vi.fn(async () => ({ adapterType: "claude_local", adapterConfig: {} })),
      insertExecutionSecretHandle: vi.fn(async () => ({ handle: "pre-existing", minted: false })),
    };
    expect(await mintExecutionSecretHandleForPlacement(stub, BASE))
      .toEqual({ minted: true, handle: "pre-existing", refKind: "provider_key", deduped: true });
  });

  it("generates a UUID handle id, never a slug the wire would reject", async () => {
    const { stub, inserted } = repo({ adapterType: "claude_local", adapterConfig: {} });
    await mintExecutionSecretHandleForPlacement(stub, { ...BASE, newHandleId: undefined });
    expect((inserted[0] as { handle: string }).handle)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("scopes the agent lookup to the job's company", async () => {
    const { stub } = repo({ adapterType: "claude_local", adapterConfig: {} });
    await mintExecutionSecretHandleForPlacement(stub, BASE);
    expect(stub.loadAgentAdapterBinding).toHaveBeenCalledWith({ companyId: "co-1", agentId: "agent-1" });
  });
});

describe("mintRunJwtHandleForPlacement — the run_jwt (AOA_API_KEY) placement mint (CLI-008 S3b)", () => {
  const RUN_JWT_BASE = {
    organizationId: "org-1",
    companyId: "co-1",
    jobId: "job-1",
    executorPrincipalKind: "agent",
    executorPrincipalId: "agent-1",
    targetGeneration: 4,
    deploymentMode: "cloud_auth",
    newHandleId: () => "99999999-2222-4333-8444-555555555555",
  } as const;

  it("short-circuits when the tool surface is OFF — NO agent load, NO insert (the inert default)", async () => {
    const { stub, inserted } = repo({ adapterType: "claude_local", adapterConfig: {} });
    const out = await mintRunJwtHandleForPlacement(stub, { ...RUN_JWT_BASE, toolSurfaceAuthorized: false });
    expect(out).toEqual({ minted: false, reason: "tool_surface_not_authorized" });
    // Zero DB touch while inert: neither the agent binding nor the handle table is read/written.
    expect(stub.loadAgentAdapterBinding).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("mints a run_jwt handle bound to the JOB id (not a run id) with the AOA_API_KEY env target", async () => {
    const { stub, inserted } = repo({ adapterType: "claude_local", adapterConfig: {} });
    const out = await mintRunJwtHandleForPlacement(stub, { ...RUN_JWT_BASE, toolSurfaceAuthorized: true });
    expect(out).toEqual({ minted: true, handle: "99999999-2222-4333-8444-555555555555", deduped: false });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      refKind: "run_jwt",
      refId: "job-1",
      envTarget: "AOA_API_KEY",
      materialization: "env",
      usePolicy: "sandbox_local_only",
      refVersion: null,
      boundTargetGeneration: 4,
      ownerPrincipalKind: "agent",
      ownerPrincipalId: "agent-1",
    });
  });

  it("mints NO run_jwt handle for a codex_local run (codex has no aoa MCP surface)", async () => {
    const { stub, inserted } = repo({ adapterType: "codex_local", adapterConfig: {} });
    const out = await mintRunJwtHandleForPlacement(stub, { ...RUN_JWT_BASE, toolSurfaceAuthorized: true });
    expect(out).toEqual({ minted: false, reason: "adapter_not_claude_local" });
    expect(inserted).toEqual([]);
  });

  it("mints NO run_jwt handle on a self-hosted deployment", async () => {
    const { stub, inserted } = repo({ adapterType: "claude_local", adapterConfig: {} });
    const out = await mintRunJwtHandleForPlacement(stub, {
      ...RUN_JWT_BASE,
      toolSurfaceAuthorized: true,
      deploymentMode: "local_trusted",
    });
    expect(out).toEqual({ minted: false, reason: "not_cloud_deployment" });
    expect(inserted).toEqual([]);
  });
});
