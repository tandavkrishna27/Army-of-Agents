const BUNDLE_ORDER = ["AGENTS.md", "SOUL.md", "TOOLS.md", "HEARTBEAT.md"] as const;

type CommanderAgentShape = { id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> | null };

interface AssembleArgs {
  agent: CommanderAgentShape;
  service: { readFile: (agent: CommanderAgentShape, relativePath: string) => Promise<{ content: string }> };
}

/**
 * Concatenate an agent's instruction bundle into one persona string
 * (AGENTS → SOUL → TOOLS → HEARTBEAT). Returns null if nothing can be read, so the
 * caller falls back to runtimeConfig.aoa.instruction (crew) or SYSTEM_INSTRUCTIONS
 * (Commander). Used by BOTH Commander (agent-loop.ts) and the crew runner
 * (runner.ts) — P1 (ii).
 */
export async function assembleAgentPersona(args: AssembleArgs): Promise<string | null> {
  const { agent, service } = args;
  try {
    const parts: string[] = [];
    for (const name of BUNDLE_ORDER) {
      const f = await service.readFile(agent, name).catch(() => null);
      if (f && f.content && f.content.trim().length > 0) parts.push(f.content);
    }
    if (parts.length === 0) return null;
    return parts.join("\n\n");
  } catch {
    return null;
  }
}

/** @deprecated alias — prefer assembleAgentPersona. Kept so agent-loop + tests keep working. */
export const loadCommanderPersona = assembleAgentPersona;
