// Behavioral lock for the crew-runner provider-resolution ordering fix.
//
// The crew runner (runAoaAgent) must resolve the AGENT's own env bindings ONLY
// before the unified provider resolver runs, and defer the legacy company
// `provider:<id>` key to the resolver's Step 4 — exactly like heartbeat
// (heartbeat.ts:3217/3222). If the runner instead pre-injects the company key
// into `currentEnv` (the old behavior, via resolveAdapterConfigForRuntime), the
// resolver's Step-0 `agent_env_override` short-circuit
// (provider-resolution.ts:300-305) fires and MASKS every provider_assignments
// row — including a founder's explicit agent→connection pin.
//
// This suite pins the BEHAVIOR (assignment outranks the legacy company key when
// the agent has no own binding) against the real resolver, plus the runner
// wiring that feeds it agent-only env.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.mock("@armyofagents/db", () => ({
  providerConnections: {}, providerAssignments: {}, companyMemberships: {},
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }), isNull: (a: unknown) => ({ isNull: a }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

import { resolveProviderCredential } from "../../../provider-resolution.js";

// A verified company_default api_key assignment for company "co1".
const assignmentRow = {
  connectionId: "conn-assign", authMethod: "api_key" as const, scopeType: "company_default" as const,
  priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
  sharingPolicy: "company_agents" as const, connectionCompanyId: "co1",
  connectionOrganizationId: null, connectionOwnerUserId: null, scopeId: null,
  executionTargetId: null, config: {}, secretRef: "sec-assign",
};

// The runner's resolveDeps.legacyResolveConfig re-runs resolveAdapterConfigForRuntime,
// which injects the legacy company `provider:<id>` key. Model that here as an env
// delta so a no-assignment company still resolves the company key at Step 4.
function makeDeps(overrides: Partial<Parameters<typeof resolveProviderCredential>[2]> = {}) {
  return {
    loadCandidateRows: vi.fn(async () => []),
    resolveSecretValueForConnection: vi.fn(async () => "sk-assignment"),
    resolveSubscriptionEnv: vi.fn(async () => ({})),
    envVarForProvider: () => "ANTHROPIC_API_KEY",
    legacyResolveConfig: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "sk-legacy-company" } })),
    legacySubscriptionEnv: vi.fn(async () => null),
    selfHostedSingleTenant: true,
    bypassNewModel: false,
    ...overrides,
  };
}

const baseArgs = {
  organizationId: null, companyId: "co1", agentId: "ag1", actorKind: "crew" as const,
  adapterType: "claude_local", provider: "anthropic", executionTargetId: "control-plane",
  currentEnv: {} as Record<string, string>,
  context: { consumerType: "agent" as const, consumerId: "ag1", actorType: "agent" as const, actorId: "ag1" },
};

describe("crew runner: an assignment outranks the legacy company key (no Step-0 mask)", () => {
  it("agent-only currentEnv (no company key) + a matching assignment → source is the ASSIGNMENT", async () => {
    // What the FIXED runner passes: resolveEnvBindings output (agent env only).
    const deps = makeDeps({ loadCandidateRows: vi.fn(async () => [assignmentRow]) });
    const r = await resolveProviderCredential({} as never, { ...baseArgs, currentEnv: {} }, deps as never);
    expect(r.source).toBe("connection");
    if (r.source === "connection") {
      expect(r.connectionId).toBe("conn-assign");
      expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-assignment" });
    }
    // The legacy company-key fallback must NOT run — the assignment already won.
    expect(deps.legacyResolveConfig).not.toHaveBeenCalled();
  });

  it("pre-injecting the company key into currentEnv MASKS the assignment (the bug the fix removes)", async () => {
    // What the OLD (buggy) runner passed: resolveAdapterConfigForRuntime output,
    // i.e. the legacy company key already in env. Step 0 short-circuits and the
    // assignment lookup never runs.
    const deps = makeDeps({ loadCandidateRows: vi.fn(async () => [assignmentRow]) });
    const r = await resolveProviderCredential(
      {} as never,
      { ...baseArgs, currentEnv: { ANTHROPIC_API_KEY: "sk-legacy-company" } },
      deps as never,
    );
    expect(r.source).toBe("agent_env_override");
    expect(deps.loadCandidateRows).not.toHaveBeenCalled();
  });

  it("no assignment + agent-only env → the legacy company key still resolves (Step 4; unaffected companies)", async () => {
    const deps = makeDeps(); // loadCandidateRows → []
    const r = await resolveProviderCredential({} as never, { ...baseArgs, currentEnv: {} }, deps as never);
    expect(r.source).toBe("legacy");
    if (r.source === "legacy") expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-legacy-company" });
    expect(deps.legacyResolveConfig).toHaveBeenCalled();
  });
});

describe("crew runner wiring: feeds the resolver agent-only env, defers the company key to Step 4", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "runner.ts"), "utf8");

  it("resolves the agent's OWN env via resolveEnvBindings (no company-key fallback) up front", () => {
    expect(src).toMatch(/const resolvedEnv\s*=\s*await secretService\(db\)\.resolveEnvBindings\(/);
  });

  it("passes that agent-only resolvedEnv as the resolver's currentEnv", () => {
    expect(src).toMatch(/currentEnv:\s*resolvedEnv\b/);
  });

  it("does NOT pre-inject the company key: currentEnv is not the company-key-loaded config env", () => {
    expect(src).not.toMatch(/currentEnv:\s*\(?\s*runtimeBaseConfig\.env/);
  });

  it("still routes the company key through the resolver's legacy fallback (Step 4, no-assignment path)", () => {
    // resolveDeps.legacyResolveConfig must keep calling resolveAdapterConfigForRuntime
    // so a company WITHOUT any assignment still gets its legacy provider:<id> key.
    expect(src).toMatch(/legacyResolveConfig:\s*async[\s\S]{0,120}resolveAdapterConfigForRuntime\(/);
  });
});

describe("crew runner releases a checked-out task on a mid-run failure (Codex P2)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "runner.ts"), "utf8");
  // A throw between issueService.checkout and adapter.execute (e.g. secret
  // resolution failure) must not strand the task 'in_progress'. The outer catch
  // must release the lock back to 'todo', guarded by executionRunId===runId.
  const iCatch = src.indexOf("} catch (err) {");
  const iFinally = src.indexOf("} finally {", iCatch);
  const catchBlock = iCatch > -1 && iFinally > iCatch ? src.slice(iCatch, iFinally) : "";

  it("has a failure-path catch followed by a finally", () => {
    expect(iCatch).toBeGreaterThan(-1);
    expect(iFinally).toBeGreaterThan(iCatch);
  });
  it("releases the checked-out task back to todo inside the catch", () => {
    expect(catchBlock).toMatch(/status:\s*"todo"/);
    expect(catchBlock).toMatch(/executionRunId:\s*null/);
  });
  it("guards the release on executionRunId===runId (never clobbers a re-claimed task)", () => {
    expect(catchBlock).toMatch(/eq\(issues\.executionRunId,\s*releaseRunId\)/);
  });
  it("guards the release UPDATE atomically on status='in_progress' (no clobber of a concurrent transition)", () => {
    expect(catchBlock).toMatch(/eq\(issues\.status,\s*"in_progress"\)/);
  });
  it("only publishes the release when the guarded UPDATE actually moved a row (.returning + released.length)", () => {
    expect(catchBlock).toMatch(/\.returning\(/);
    expect(catchBlock).toMatch(/released\.length/);
  });
});
