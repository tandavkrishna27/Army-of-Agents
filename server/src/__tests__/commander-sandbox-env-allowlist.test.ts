import { describe, it, expect, vi } from "vitest";
import {
  runAdapterExecutionTargetProcess,
  buildSandboxEnvAllowlist,
  type AdapterExecutionTarget,
} from "@armyofagents/adapter-utils";

// -----------------------------------------------------------------------------
// W7.5f Task 5 (F6, plan-review finding) — Commander env-allowlist sink lock.
//
// The U5 allowlist (packages/adapter-utils/src/sandbox-env-allowlist.ts) is the
// SINK that decides what crosses into the Commander VM. This drives a Commander
// env overlay through the REAL sink via runAdapterExecutionTargetProcess (the
// exact provider-sandbox execute path, execution-target.ts:680-682) and asserts
// the credential taxonomy — host secrets DROPPED, model key + run-JWT SURVIVE.
//
// It also regression-locks F4: passing the E2B INFRA id ("e2b") as
// sandboxProvider made PROVIDER_AUTH_KEYS["e2b"] undefined → the model key was
// stripped. The correct value is the MODEL family ("anthropic"/"openai").
// -----------------------------------------------------------------------------

// The overlay a Commander turn would carry: the run-JWT + model key alongside
// ambient host secrets the sink MUST drop.
const COMMANDER_OVERLAY: Record<string, string> = {
  AOA_API_KEY: "commander-run-jwt",        // run-JWT — MUST survive (ALWAYS_ALLOWED)
  ANTHROPIC_API_KEY: "sk-ant-model-key",   // model key — MUST survive (anthropic family)
  AOA_API_URL: "http://broker",            // control-plane base — MUST survive
  DATABASE_URL: "postgres://secret",       // host secret — MUST be stripped
  AOA_AGENT_JWT_SECRET: "the-signing-key", // the key that MINTS the JWT — MUST be stripped
  GITHUB_PAT: "ghp_secret",                // host secret — MUST be stripped
};

function spyTarget() {
  const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" }));
  const target = {
    type: "provider-sandbox",
    provider: "e2b",
    providerLeaseId: "e2b-1",
    remoteCwd: "/workspace",
    shell: "sh",
    env: {},
    runner: { execute },
  } as unknown as AdapterExecutionTarget;
  return { target, execute };
}

describe("Commander sandbox env allowlist (F4/F6 sink lock)", () => {
  it("through the REAL execute sink with sandboxProvider:'anthropic' — host secrets stripped, model key + run-JWT survive", async () => {
    const { target, execute } = spyTarget();
    await runAdapterExecutionTargetProcess(target, {
      runId: "run1",
      command: "claude",
      args: ["--print"],
      cwd: "/workspace",
      env: COMMANDER_OVERLAY,
      timeoutSec: 60,
      graceSec: 5,
      sandboxProvider: "anthropic", // the MODEL family (claude-local execute.ts) — NOT "e2b"
      onLog: async () => {},
      onSpawn: () => {},
    });
    const passedEnv = execute.mock.calls[0][0].env as Record<string, string>;
    // survive:
    expect(passedEnv.AOA_API_KEY).toBe("commander-run-jwt");
    expect(passedEnv.ANTHROPIC_API_KEY).toBe("sk-ant-model-key");
    expect(passedEnv.AOA_API_URL).toBeDefined();
    // stripped (never enters the Commander VM):
    expect(passedEnv.DATABASE_URL).toBeUndefined();
    expect(passedEnv.AOA_AGENT_JWT_SECRET).toBeUndefined();
    expect(passedEnv.GITHUB_PAT).toBeUndefined();
  });

  it("F4 regression lock: with the WRONG provider ('e2b' infra id), the model key is stripped (the exact bug)", () => {
    // Direct sink call proves why the provider FAMILY matters — this is the
    // assertion that would have caught F4.
    const wrong = buildSandboxEnvAllowlist(COMMANDER_OVERLAY, { provider: "e2b" });
    expect(wrong.ANTHROPIC_API_KEY).toBeUndefined();      // stripped — the F4 failure
    expect(wrong.AOA_API_KEY).toBe("commander-run-jwt");  // run-JWT is ALWAYS_ALLOWED, survives either way
    const right = buildSandboxEnvAllowlist(COMMANDER_OVERLAY, { provider: "anthropic" });
    expect(right.ANTHROPIC_API_KEY).toBe("sk-ant-model-key"); // survives with the right family
  });

  it("the AOA_AGENT_JWT_SECRET (mints the run-JWT) is stripped even though the run-JWT itself survives", () => {
    // The critical one: the key that MINTS the run-JWT must never enter the VM
    // the JWT authorizes into (spec §9 — signing secrets stay host-side; only
    // the minted value crosses).
    const out = buildSandboxEnvAllowlist(COMMANDER_OVERLAY, { provider: "anthropic" });
    expect(out.AOA_AGENT_JWT_SECRET).toBeUndefined();
    expect(out.AOA_API_KEY).toBe("commander-run-jwt");
  });

  it("codex family: OPENAI_API_KEY survives with 'openai'; DATABASE_URL / JWT-secret / PAT stripped", () => {
    const overlay = { ...COMMANDER_OVERLAY, OPENAI_API_KEY: "sk-openai" };
    const out = buildSandboxEnvAllowlist(overlay, { provider: "openai" }); // codex-local execute.ts
    expect(out.OPENAI_API_KEY).toBe("sk-openai");
    expect(out.AOA_API_KEY).toBe("commander-run-jwt");
    expect(out.DATABASE_URL).toBeUndefined();
    expect(out.AOA_AGENT_JWT_SECRET).toBeUndefined();
    expect(out.GITHUB_PAT).toBeUndefined();
  });
});
