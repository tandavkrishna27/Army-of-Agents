/**
 * MCP configuration is owned by AoA (design decision D2). A user-typed
 * --mcp-config in an agent's "Extra args" box would bypass company approval,
 * per-agent enablement, env scrubbing, and audit — the entire connector
 * governance system.
 *
 * Apply this ONLY to user-supplied args, at the server-side injection points,
 * BEFORE AoA prepends its own --mcp-config/--strict-mcp-config. NEVER apply it
 * to the combined array: the claude-local adapter reads one merged args list and
 * cannot distinguish AoA's injected flags from the user's, so stripping there
 * would delete AoA's own config and break every MCP run.
 */
export function stripUserMcpArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--strict-mcp-config") continue;
    if (arg === "--mcp-config") {
      i += 1; // also drop its following value token
      continue;
    }
    if (arg.startsWith("--mcp-config=")) continue; // inline form, single token
    out.push(arg);
  }
  return out;
}
