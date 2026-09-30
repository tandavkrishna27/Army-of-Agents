import type { UIAdapterModule } from "../types";
import type { TranscriptEntry } from "../types";
import { HermesLocalConfigFields } from "./config-fields";
import { buildHermesLocalConfig } from "./build-config";

/**
 * Simple stdout line parser for Hermes Agent.
 *
 * Hermes CLI emits plain text lines. Tool-output lines start with "┊".
 * We emit every line as a stdout entry; the transcript renderer handles
 * display styling.
 */
function parseHermesLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent (local)",
  parseStdoutLine: parseHermesLocalStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesLocalConfig,
};
