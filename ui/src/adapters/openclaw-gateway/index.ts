import type { UIAdapterModule } from "../types";
import {
  buildOpenClawGatewayConfig,
  parseOpenClawGatewayStdoutLine,
} from "@armyofagents/adapter-openclaw-gateway/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const openClawGatewayUIAdapter: UIAdapterModule = {
  type: "openclaw_gateway",
  label: "OpenClaw Gateway",
  parseStdoutLine: parseOpenClawGatewayStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildOpenClawGatewayConfig,
};
