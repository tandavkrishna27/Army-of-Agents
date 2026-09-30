// DAT-008 slice 1 — the execution-secret-handle MINT decision.
//
// Pure decision function, so this is a direct-import unit suite (the repo's
// "pure function tests" pattern) with no drizzle mocking. Every guard here is
// mutation-tested; a guard whose removal leaves this suite green is not a guard.
//
// The three-way per-agent split (design revision 1, R2) is the load-bearing part:
// an agent that carries its own provider key must NEVER be silently switched onto
// the company key by the act of cutting over.

import { describe, expect, it } from "vitest";
import {
  decideExecutionSecretHandle,
  decideRunJwtHandle,
  isActionableMintRefusal,
  RUN_JWT_ENV_TARGET,
  type ExecutionSecretMintInput,
  type ExecutionSecretMintRefusal,
  type RunJwtHandleMintInput,
} from "../services/execution-secret-handle-mint.js";

const TARGET = { ownerId: "anthropic", secretName: "provider:anthropic", envVar: "ANTHROPIC_API_KEY" } as const;

function input(overrides: Partial<ExecutionSecretMintInput> = {}): ExecutionSecretMintInput {
  return {
    deploymentMode: "cloud_auth",
    adapterType: "claude_local",
    executorPrincipalKind: "agent",
    providerKeyTarget: TARGET,
    providerBinding: null,
    placementOwner: "managed_cloud",
    credentialKind: "company_api_key",
    targetGeneration: 7,
    ...overrides,
  };
}

describe("decideExecutionSecretHandle — admission", () => {
  it("mints a provider_key handle for a v1 adapter on a cloud deployment with no agent override", () => {
    const decision = decideExecutionSecretHandle(input());
    expect(decision).toEqual({
      mint: true,
      refKind: "provider_key",
      refId: "provider:anthropic",
      envTarget: "ANTHROPIC_API_KEY",
      secretVersion: null,
      boundTargetGeneration: 7,
    });
  });

  // Both mint branches are asserted. Covering only the company-key branch left the
  // secret_ref branch free to default an unpinned generation to 0 (mutant M17
  // survived on exactly that), which would pin every agent-secret handle to a
  // generation no target has.
  it.each([
    ["company key", null],
    ["agent secret_ref", { type: "secret_ref", secretId: "sec-agent-own", version: 1 } as const],
  ])("pins the generation it was given on the %s branch, never a default", (_label, providerBinding) => {
    expect(decideExecutionSecretHandle(input({ providerBinding, targetGeneration: 12 })))
      .toMatchObject({ mint: true, boundTargetGeneration: 12 });
    // A null generation is UNPINNED and must survive as null rather than becoming 0.
    expect(decideExecutionSecretHandle(input({ providerBinding, targetGeneration: null })))
      .toMatchObject({ mint: true, boundTargetGeneration: null });
  });
});

describe("decideExecutionSecretHandle — the three-way per-agent split (R2)", () => {
  it("binds the AGENT's own secret when the provider env var is a secret_ref", () => {
    const decision = decideExecutionSecretHandle(input({
      providerBinding: { type: "secret_ref", secretId: "sec-agent-own", version: 3 },
    }));
    // The company key must NOT appear anywhere in this decision.
    expect(decision).toEqual({
      mint: true,
      refKind: "company_secret",
      refId: "sec-agent-own",
      envTarget: "ANTHROPIC_API_KEY",
      secretVersion: 3,
      boundTargetGeneration: 7,
    });
  });

  it("carries a 'latest' version selector through unchanged", () => {
    expect(decideExecutionSecretHandle(input({
      providerBinding: { type: "secret_ref", secretId: "sec-agent-own", version: "latest" },
    }))).toMatchObject({ refKind: "company_secret", secretVersion: "latest" });
  });

  it("REFUSES to mint when the agent carries a plain literal — the job stays on legacy", () => {
    expect(decideExecutionSecretHandle(input({ providerBinding: { type: "plain" } })))
      .toEqual({ mint: false, reason: "agent_plain_literal_override" });
  });

  it("treats an explicitly EMPTY plain override as an override, not as absent", () => {
    // secrets.ts:288 — "An explicitly-set empty string is an INTENTIONAL override and
    // is left alone." Canonicalization erases the value, so an empty plain arrives as
    // {type:"plain"} and must refuse exactly like a non-empty one.
    expect(decideExecutionSecretHandle(input({ providerBinding: { type: "plain" } })))
      .toEqual({ mint: false, reason: "agent_plain_literal_override" });
  });
});

describe("decideExecutionSecretHandle — refusals", () => {
  it("refuses on a non-cloud deployment (Rule #11: self-hosted uses the local CLI login)", () => {
    for (const mode of ["local_trusted", "single_tenant", "authenticated_local"]) {
      expect(decideExecutionSecretHandle(input({ deploymentMode: mode })))
        .toEqual({ mint: false, reason: "not_cloud_deployment" });
    }
  });

  it("admits every mode the shared cloud predicate admits, and only those", () => {
    expect(decideExecutionSecretHandle(input({ deploymentMode: "cloud_auth" })))
      .toMatchObject({ mint: true });
    expect(decideExecutionSecretHandle(input({ deploymentMode: "authenticated" })))
      .toMatchObject({ mint: true });
  });

  it("refuses when the executor principal does not back an agent-owned run", () => {
    // CLI-007: browser_worker + service_instance are real EXECUTOR kinds (browser/service
    // runs) that must never stage a model credential; user/system are non-execution kinds.
    for (const kind of ["user", "system", "service", "service_instance", "browser_worker"]) {
      expect(decideExecutionSecretHandle(input({ executorPrincipalKind: kind })))
        .toEqual({ mint: false, reason: "executor_not_agent" });
    }
  });

  // CLI-007 (E7-F001 guard-2 correction): a coding-agent run executes as `worker`/`sandbox`
  // (Decision #121), NEVER as `executorPrincipalKind: "agent"`. The mint must admit those
  // real kinds, else it refuses every real run (which is what E7-F001's guard-2 misdiagnosis
  // masked). `agent` stays admitted as a defensive superset.
  it("admits the real agent-backed execution kinds (worker/sandbox) and mints", () => {
    for (const kind of ["worker", "sandbox", "agent"]) {
      expect(decideExecutionSecretHandle(input({ executorPrincipalKind: kind })))
        .toMatchObject({ mint: true, refKind: "provider_key" });
    }
  });

  it("refuses when the adapter is outside the v1 sandboxed-coding scope", () => {
    expect(decideExecutionSecretHandle(input({ adapterType: "hermes_local" })))
      .toEqual({ mint: false, reason: "adapter_not_v1_scope" });
    expect(decideExecutionSecretHandle(input({ adapterType: "gemini_local" })))
      .toEqual({ mint: false, reason: "adapter_not_v1_scope" });
  });

  it("admits both v1 adapters", () => {
    expect(decideExecutionSecretHandle(input({ adapterType: "claude_local" }))).toMatchObject({ mint: true });
    expect(decideExecutionSecretHandle(input({
      adapterType: "codex_local",
      providerKeyTarget: { ownerId: "openai", secretName: "provider:openai", envVar: "OPENAI_API_KEY" },
    }))).toMatchObject({ mint: true, refId: "provider:openai", envTarget: "OPENAI_API_KEY" });
  });

  it("refuses when the adapter resolves no company key target", () => {
    expect(decideExecutionSecretHandle(input({ providerKeyTarget: null })))
      .toEqual({ mint: false, reason: "adapter_has_no_company_key" });
  });
});

describe("decideExecutionSecretHandle — deferral #3, two independent owner authorities", () => {
  it("refuses to mint a company key for an owner_desktop placement", () => {
    expect(decideExecutionSecretHandle(input({
      placementOwner: "owner_desktop",
      credentialKind: "personal_subscription",
    }))).toEqual({ mint: false, reason: "owner_desktop_target" });
  });

  it("refuses when the two authorities DISAGREE — desktop owner, company credential", () => {
    // This is the case the tautological check could never catch: the placement owner
    // and the job's own credential binding are derived independently, so a disagreement
    // means one of them is wrong and neither may be trusted.
    expect(decideExecutionSecretHandle(input({
      placementOwner: "owner_desktop",
      credentialKind: "company_api_key",
    }))).toEqual({ mint: false, reason: "owner_authority_disagreement" });
  });

  it("refuses when the two authorities DISAGREE — cloud owner, personal credential", () => {
    expect(decideExecutionSecretHandle(input({
      placementOwner: "managed_cloud",
      credentialKind: "personal_subscription",
    }))).toEqual({ mint: false, reason: "owner_authority_disagreement" });
  });

  it("admits organization_dedicated with a company credential", () => {
    expect(decideExecutionSecretHandle(input({
      placementOwner: "organization_dedicated",
      credentialKind: "company_api_key",
    }))).toMatchObject({ mint: true });
  });

  it("refuses an unplaced decision — no owner means no generation to pin to", () => {
    expect(decideExecutionSecretHandle(input({ placementOwner: null })))
      .toEqual({ mint: false, reason: "owner_authority_disagreement" });
  });
});

describe("decideExecutionSecretHandle — refusal precedence", () => {
  it("checks the deployment mode before anything else", () => {
    // Every other input is simultaneously invalid; the mode reason must still win,
    // so a self-hosted deployment can never be reported as an adapter/owner problem.
    expect(decideExecutionSecretHandle(input({
      deploymentMode: "local_trusted",
      executorPrincipalKind: "user",
      adapterType: "hermes_local",
      providerKeyTarget: null,
      placementOwner: "owner_desktop",
      credentialKind: "company_api_key",
    }))).toEqual({ mint: false, reason: "not_cloud_deployment" });
  });

  it("refuses the owner disagreement even when an agent override would otherwise bind", () => {
    expect(decideExecutionSecretHandle(input({
      placementOwner: "owner_desktop",
      credentialKind: "company_api_key",
      providerBinding: { type: "secret_ref", secretId: "sec-agent-own", version: 1 },
    }))).toEqual({ mint: false, reason: "owner_authority_disagreement" });
  });
});

describe("isActionableMintRefusal", () => {
  it("reports the two refusals an operator can act on", () => {
    // A blocked agent stays on the legacy executor indefinitely, and two owner
    // authorities disagreeing should be impossible — both need to be visible.
    expect(isActionableMintRefusal("agent_plain_literal_override")).toBe(true);
    expect(isActionableMintRefusal("owner_authority_disagreement")).toBe(true);
  });

  it("stays silent for the refusals that are the NORMAL answer for most jobs", () => {
    // Reporting these would emit a line per job per placement and bury the two above.
    for (const reason of [
      "not_cloud_deployment",
      "executor_not_agent",
      "adapter_not_v1_scope",
      "adapter_has_no_company_key",
      "owner_desktop_target",
    ] as const) {
      expect(isActionableMintRefusal(reason)).toBe(false);
    }
  });

  it("covers every refusal in the union, so a new one cannot default to silent", () => {
    // A refusal added later without a decision here would be invisible by accident.
    const ALL: ExecutionSecretMintRefusal[] = [
      "not_cloud_deployment", "executor_not_agent", "adapter_not_v1_scope",
      "adapter_has_no_company_key", "agent_plain_literal_override",
      "owner_desktop_target", "owner_authority_disagreement",
    ];
    expect(ALL.filter(isActionableMintRefusal).sort())
      .toEqual(["agent_plain_literal_override", "owner_authority_disagreement"]);
  });
});

describe("decideRunJwtHandle — the run_jwt (AOA_API_KEY) tool-surface gate (CLI-008 S3b)", () => {
  function runInput(over: Partial<RunJwtHandleMintInput> = {}): RunJwtHandleMintInput {
    return {
      deploymentMode: "cloud_auth",
      adapterType: "claude_local",
      executorPrincipalKind: "agent",
      toolSurfaceAuthorized: true,
      ...over,
    };
  }

  it("mints for a cloud, agent-backed, claude_local run once the tool surface is authorized", () => {
    expect(decideRunJwtHandle(runInput())).toEqual({ mint: true, envTarget: RUN_JWT_ENV_TARGET });
    expect(RUN_JWT_ENV_TARGET).toBe("AOA_API_KEY");
  });

  it("mints for the worker/sandbox executor kinds (Decision #121), not only the legacy agent kind", () => {
    expect(decideRunJwtHandle(runInput({ executorPrincipalKind: "worker" }))).toMatchObject({ mint: true });
    expect(decideRunJwtHandle(runInput({ executorPrincipalKind: "sandbox" }))).toMatchObject({ mint: true });
  });

  it.each([
    ["a self-hosted deployment", { deploymentMode: "local_trusted" }, "not_cloud_deployment"],
    ["a non-agent executor", { executorPrincipalKind: "system" }, "executor_not_agent"],
    ["a codex_local adapter (no aoa MCP surface)", { adapterType: "codex_local" }, "adapter_not_claude_local"],
    ["the tool surface OFF (the inert default until S4)", { toolSurfaceAuthorized: false }, "tool_surface_not_authorized"],
  ])("refuses on %s", (_label, over, reason) => {
    expect(decideRunJwtHandle(runInput(over))).toEqual({ mint: false, reason });
  });
});
