/**
 * Persist a pasted Commander API key (Plan 3 / §6.1, Codex P1 #8). The raw key
 * goes to the ENCRYPTED secrets vault; the Commander AGENT's adapterConfig.env
 * gets a `secret_ref` (never plaintext), the agent row is persisted, and the
 * env bindings are synced. `syncEnvBindingsForTarget` only writes
 * company_secret_bindings — it does NOT touch the agent row — so we merge +
 * persist adapterConfig.env ourselves, THEN sync. DI seam so the exact
 * secretService / agent-update / binding methods live at the route.
 */
export type PersistCommanderKeyDeps = {
  writeSecret: (args: {
    companyId: string;
    key: string;
    name: string;
    value: string;
  }) => Promise<{ secretId: string }>;
  updateAgentAdapterConfig: (args: {
    companyId: string;
    agentId: string;
    adapterConfig: Record<string, unknown>;
  }) => Promise<void>;
  syncEnvBindings: (args: {
    companyId: string;
    targetId: string;
    env: Record<string, unknown>;
  }) => Promise<void>;
};

export type CommanderKeyProvider = "anthropic" | "openai";

function envVarForProvider(provider: CommanderKeyProvider): string {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

export async function persistCommanderApiKey(
  deps: PersistCommanderKeyDeps,
  input: {
    companyId: string;
    agentId: string;
    provider: CommanderKeyProvider;
    apiKey: string;
    adapterConfig: Record<string, unknown>;
  },
): Promise<{ secretId: string }> {
  const envVar = envVarForProvider(input.provider);

  const { secretId } = await deps.writeSecret({
    companyId: input.companyId,
    key: envVar,
    name: `Commander ${input.provider} API key`,
    value: input.apiKey,
  });

  const existingEnv = (input.adapterConfig.env as Record<string, unknown> | undefined) ?? {};
  const env: Record<string, unknown> = {
    ...existingEnv,
    [envVar]: { type: "secret_ref", secretId, version: "latest" },
  };
  const adapterConfig: Record<string, unknown> = { ...input.adapterConfig, env };

  await deps.updateAgentAdapterConfig({ companyId: input.companyId, agentId: input.agentId, adapterConfig });
  await deps.syncEnvBindings({ companyId: input.companyId, targetId: input.agentId, env });

  return { secretId };
}
