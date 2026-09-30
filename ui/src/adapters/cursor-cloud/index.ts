import type { UIAdapterModule } from "../types";
import { buildCursorCloudConfig, parseCursorCloudStdoutLine } from "@armyofagents/adapter-cursor-cloud/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const cursorCloudUIAdapter: UIAdapterModule = {
  type: "cursor_cloud",
  label: "Cursor Cloud",
  parseStdoutLine: parseCursorCloudStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildCursorCloudConfig,
};
