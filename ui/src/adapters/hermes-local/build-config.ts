import type { CreateConfigValues } from "@armyofagents/adapter-utils";

/**
 * Build Hermes Agent adapter config from the shared UI form values.
 *
 * The shared CreateConfigValues.command field maps to hermesCommand in the
 * saved adapterConfig. This makes new agents consistent with the server-side
 * wrapper which reads hermesCommand (preferred) then falls back to the legacy
 * command field for back-compat with agents saved before this rename.
 */
export function buildHermesLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.model) ac.model = v.model;
  // Map the shared "command" form field to hermesCommand in adapterConfig.
  // The server wrapper reads hermesCommand first, then falls back to command.
  // Use undefined (not empty string) so the server falls back to the default
  // "hermes" via asString(agentConfig.hermesCommand ?? agentConfig.command, "hermes").
  // An empty string is falsy and would have silently kept the prior saved value
  // in edit mode — explicitly clearing to undefined ensures the reset is honoured.
  const trimmedCommand = (v.command ?? "").trim();
  ac.hermesCommand = trimmedCommand.length > 0 ? trimmedCommand : undefined;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.thinkingEffort) ac.thinkingEffort = v.thinkingEffort;
  return ac;
}
