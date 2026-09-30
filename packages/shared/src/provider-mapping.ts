// packages/shared/src/provider-mapping.ts
//
// Single source of truth for AoA internal-agent provider mappings. UI and server
// both import these so the provider↔cliTool↔adapter relationship can never drift.
//
// Two surfaces:
//   - Commander (chat): driven by internal_agent_config.cliTool. cli-mode.ts's
//     resolveCliInvocation only builds chat invocations for claude_cli + codex
//     (opencode → returns null + chat() rejects; gemini has no branch). So the
//     Commander picker is anthropic + openai ONLY.
//   - Crew (8 AoA agents): driven by internal_agent_config.provider → crew adapter.
//     resolveCrewAdapterFor (server) is the runtime authority; providerToCrewAdapter
//     is the lightweight label map and MUST agree with it (asserted in a server test).

export const CREW_PROVIDERS = ["anthropic", "openai", "google", "opencode"] as const;
export type CrewProvider = (typeof CREW_PROVIDERS)[number];

export const COMMANDER_PROVIDERS = ["anthropic", "openai"] as const;
export type CommanderProvider = (typeof COMMANDER_PROVIDERS)[number];

// cliTool column may still hold "opencode" on legacy rows; the type stays broad
// even though providerToCliTool only ever produces the two working values.
export type CliTool = "claude_cli" | "codex" | "opencode";
export type CrewAdapterType = "claude_local" | "codex_local" | "gemini_local" | "opencode_local";

/** provider → Commander cliTool (internal_agent_config.cliTool). */
export function providerToCliTool(p: CommanderProvider): "claude_cli" | "codex" {
  switch (p) {
    case "anthropic": return "claude_cli";
    case "openai": return "codex";
  }
}

/** provider → crew adapterType. Mirrors resolveCrewAdapterFor's adapter choice. */
export function providerToCrewAdapter(p: CrewProvider): CrewAdapterType {
  switch (p) {
    case "anthropic": return "claude_local";
    case "openai": return "codex_local";
    case "google": return "gemini_local";
    case "opencode": return "opencode_local";
  }
}

/** cliTool → crew-provider (inverse of providerToCliTool, used to resolve the
 *  COMMANDER agent row's adapter from its CLI — Task 5b). `opencode` is included
 *  for legacy rows; anything unknown/null defaults to anthropic (claude). */
export function cliToolToProvider(cliTool: string | null | undefined): CrewProvider {
  switch (cliTool) {
    case "codex": return "openai";
    case "opencode": return "opencode";
    case "claude_cli":
    default: return "anthropic";
  }
}
