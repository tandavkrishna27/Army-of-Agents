import type { UIAdapterModule } from "../types";
import { parsePiStdoutLine, buildPiLocalConfig } from "@armyofagents/adapter-pi-local/ui";
import { PiLocalConfigFields } from "./config-fields";

export const piLocalUIAdapter: UIAdapterModule = {
  type: "pi_local",
  label: "Pi (local)",
  parseStdoutLine: parsePiStdoutLine,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPiLocalConfig,
};
