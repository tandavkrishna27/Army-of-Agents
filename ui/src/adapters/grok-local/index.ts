import type { UIAdapterModule } from "../types";
import { parseGrokStdoutLine } from "@armyofagents/adapter-grok-local/ui";
import { buildGrokLocalConfig } from "@armyofagents/adapter-grok-local/ui";
import { GrokLocalConfigFields } from "./config-fields";

export const grokLocalUIAdapter: UIAdapterModule = {
  type: "grok_local",
  label: "Grok Build (local)",
  parseStdoutLine: parseGrokStdoutLine,
  ConfigFields: GrokLocalConfigFields,
  buildAdapterConfig: buildGrokLocalConfig,
};
