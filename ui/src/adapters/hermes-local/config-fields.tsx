import type { AdapterConfigFieldsProps } from "../types";

/**
 * Hermes Agent adapter — adapter-specific config fields.
 *
 * The shared AgentConfigForm already renders the "Command" input (mapped to
 * the `command` field in CreateConfigValues). The buildAdapterConfig function
 * below maps that value to `hermesCommand` in the saved adapterConfig so that
 * the server-side wrapper can resolve the binary path correctly.
 *
 * Edit mode: the shared form writes `command` into the overlay; the server
 * wrapper normalizes `hermesCommand ?? command` at execute time, so existing
 * agents saved with `command` continue to work without a re-save.
 *
 * No adapter-specific additional fields are needed beyond what the shared form
 * provides — this component intentionally renders nothing extra.
 */
export function HermesLocalConfigFields(_props: AdapterConfigFieldsProps) {
  // The shared AgentConfigForm renders the "Command" field for all isLocal
  // adapters. No additional fields required specifically for Hermes here.
  return null;
}
