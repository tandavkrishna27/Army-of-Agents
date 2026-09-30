import { expect, type APIRequestContext, type APIResponse, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";

export type RealCrewProvider = "anthropic" | "openai" | "google";

export type RealCrewConfig = {
  provider: RealCrewProvider;
  adapterType: "claude_local" | "codex_local" | "gemini_local";
  binary: "claude" | "codex" | "gemini";
  model: string;
  timeoutMs: number;
};

export type AgentConfig = {
  id: string;
  name: string;
  kind?: string | null;
  status?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
};

export const REQUIRED_CREW_NAMES = ["Adjutant", "Chronicler", "Scout", "Planner", "Engineer"] as const;

export function realCrewConfigFromEnv(): RealCrewConfig {
  const provider = (process.env.AOA_E2E_REAL_CREW_PROVIDER ?? "anthropic") as RealCrewProvider;
  if (!["anthropic", "openai", "google"].includes(provider)) {
    throw new Error(`Unsupported AOA_E2E_REAL_CREW_PROVIDER=${provider}`);
  }
  const adapterType =
    provider === "anthropic" ? "claude_local" : provider === "openai" ? "codex_local" : "gemini_local";
  const binary = provider === "anthropic" ? "claude" : provider === "openai" ? "codex" : "gemini";
  const model =
    process.env.AOA_E2E_REAL_CREW_MODEL ??
    (provider === "anthropic" ? "claude-sonnet-4-5-20250929" : provider === "openai" ? "gpt-5.5" : "gemini-2.5-pro");
  const timeoutMs = Number(process.env.AOA_E2E_REAL_CREW_TIMEOUT_MS ?? 420_000);
  return { provider, adapterType, binary, model, timeoutMs };
}

export function cliAvailable(binary: string): boolean {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    return execFileSync(locator, [binary], { encoding: "utf8", timeout: 5_000 }).trim().length > 0;
  } catch {
    return false;
  }
}

export async function configureCompanyCrewProvider(
  request: APIRequestContext,
  companyId: string,
  config: RealCrewConfig,
  autonomyLevel: number,
) {
  await jsonOrThrow(
    await request.patch(`/api/companies/${companyId}/internal-agent/config`, {
      data: {
        provider: config.provider,
        model: config.model,
        // D18: the crew dial, not Commander's.
        crewAutonomyLevel: autonomyLevel,
        crewPaused: false,
      },
    }),
    "configure company internal agent provider",
  );
}

export async function ensureRealCrew(
  request: APIRequestContext,
  companyId: string,
  config: RealCrewConfig,
): Promise<AgentConfig[]> {
  const crew = await waitForCrewAgents(request, companyId, REQUIRED_CREW_NAMES as unknown as string[]);
  for (const agent of crew) {
    const existing = agent.adapterConfig ?? {};
    const adapterConfig: Record<string, unknown> = {
      model: config.model,
      ...(config.adapterType === "claude_local"
        ? { dangerouslySkipPermissions: true }
        : config.adapterType === "codex_local"
          ? { dangerouslyBypassApprovalsAndSandbox: true }
          : {}),
      ...(typeof existing.instructionsFilePath === "string"
        ? { instructionsFilePath: existing.instructionsFilePath }
        : {}),
      ...(typeof existing.instructionsRootPath === "string"
        ? { instructionsRootPath: existing.instructionsRootPath }
        : {}),
      ...(typeof existing.instructionsEntryFile === "string"
        ? { instructionsEntryFile: existing.instructionsEntryFile }
        : {}),
      ...(typeof existing.instructionsBundleMode === "string"
        ? { instructionsBundleMode: existing.instructionsBundleMode }
        : {}),
    };
    if (agent.adapterType !== config.adapterType || JSON.stringify(agent.adapterConfig ?? {}) !== JSON.stringify(adapterConfig)) {
      await jsonOrThrow(
        await request.patch(`/api/agents/${agent.id}`, {
          data: { adapterType: config.adapterType, adapterConfig },
        }),
        `patch ${agent.name} real provider adapter`,
      );
    }
  }

  const patched = await waitForCrewAgents(request, companyId, REQUIRED_CREW_NAMES as unknown as string[]);
  for (const name of REQUIRED_CREW_NAMES) {
    const agent = patched.find((candidate) => candidate.name.toLowerCase().includes(name.toLowerCase()));
    expect(agent, `missing AoA crew agent ${name}`).toBeTruthy();
    expect(agent?.adapterType, `${name} adapter type`).toBe(config.adapterType);
    const serialized = JSON.stringify(agent?.adapterConfig ?? {});
    expect(serialized, `${name} instructions should be preserved`).toMatch(/instructions/i);
  }
  return patched;
}

export function requiredCrewId(crew: AgentConfig[], name: string): string {
  const agent = crew.find((candidate) => candidate.name.toLowerCase().includes(name.toLowerCase()));
  if (!agent) throw new Error(`Missing required AoA crew agent: ${name}`);
  return agent.id;
}

export async function listRuns(request: APIRequestContext, companyId: string) {
  const body = await jsonOrThrow<{ runs: Array<Record<string, unknown>> }>(
    await request.get(`/api/companies/${companyId}/internal-agent/runs?limit=100`),
    "list internal agent runs",
  );
  return body.runs;
}

export async function attachCrewDiagnostics(
  testInfo: TestInfo,
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  diagnostics: Record<string, unknown>,
) {
  const [discussion, scopeVersions, runs, agents, issues] = await Promise.all([
    jsonOrThrow(await request.get(`/api/companies/${companyId}/discussions/${threadId}`), "diagnostic discussion").catch(
      (error) => ({ error: String(error) }),
    ),
    jsonOrThrow(
      await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions`),
      "diagnostic scope versions",
    ).catch((error) => ({ error: String(error) })),
    listRuns(request, companyId).catch((error) => ({ error: String(error) })),
    jsonOrThrow<AgentConfig[]>(await request.get(`/api/companies/${companyId}/agents?kind=aoa`), "diagnostic agents").catch(
      (error) => [{ id: "error", name: String(error) } as AgentConfig],
    ),
    jsonOrThrow<unknown[]>(await request.get(`/api/companies/${companyId}/issues`), "diagnostic issues").catch((error) => [
      { error: String(error) },
    ]),
  ]);
  await testInfo.attach("real-crew-discussion-diagnostics.json", {
    body: JSON.stringify({ ...diagnostics, finishedAt: new Date().toISOString(), discussion, scopeVersions, runs, agents, issues }, null, 2),
    contentType: "application/json",
  });
}

export async function jsonOrThrow<T = unknown>(res: APIResponse, label: string): Promise<T> {
  if (!res.ok()) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`${label} failed: ${res.status()} ${text}`);
  }
  return (await res.json()) as T;
}

export async function poll<T, S extends T>(
  fn: () => Promise<T>,
  predicate: (value: T) => value is S,
  label: string,
  timeoutMs: number,
): Promise<S>;
export async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
): Promise<T>;
export async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let lastValue: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fn();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}

async function waitForCrewAgents(
  request: APIRequestContext,
  companyId: string,
  targetNames: string[],
): Promise<AgentConfig[]> {
  return poll(
    async () => {
      const agents = await jsonOrThrow<AgentConfig[]>(
        await request.get(`/api/companies/${companyId}/agents?kind=aoa`),
        "list AoA agents",
      );
      const matched = agents.filter((agent) =>
        targetNames.some((name) => agent.name.toLowerCase().includes(name.toLowerCase())),
      );
      return matched.length >= targetNames.length ? matched : null;
    },
    (agents): agents is AgentConfig[] => Array.isArray(agents) && agents.length >= targetNames.length,
    "seeded AoA crew agents",
    30_000,
  );
}
