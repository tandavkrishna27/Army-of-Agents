import type { AdapterConfigSchema } from "@armyofagents/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    version: 1,
    fields: [
      {
        key: "url",
        label: "Gateway URL",
        type: "text",
        required: true,
        hint: "OpenClaw gateway WebSocket URL, for example ws://127.0.0.1:18789/gateway.",
      },
      {
        key: "authToken",
        label: "Auth token",
        type: "secret",
        hint: "Optional shared gateway token. Prefer a company Secret for production use.",
      },
      {
        key: "password",
        label: "Password",
        type: "secret",
        hint: "Optional gateway shared password if your gateway requires one.",
      },
      {
        key: "sessionKeyStrategy",
        label: "Session strategy",
        type: "select",
        default: "issue",
        options: [
          { value: "issue", label: "Per task" },
          { value: "fixed", label: "Fixed" },
          { value: "run", label: "Per run" },
        ],
        hint: "Controls how AoA chooses the OpenClaw session key for repeated runs.",
      },
      {
        key: "sessionKey",
        label: "Fixed session key",
        type: "text",
        default: "paperclip",
        hint: "Used only when session strategy is Fixed.",
        meta: { visibleWhen: { key: "sessionKeyStrategy", values: ["fixed"] } },
      },
      {
        key: "role",
        label: "Gateway role",
        type: "text",
        default: "operator",
      },
      {
        key: "scopes",
        label: "Gateway scopes",
        type: "text",
        default: "operator.admin",
        hint: "Comma-separated scopes sent during gateway connect.",
      },
      {
        key: "payloadTemplate",
        label: "Payload template JSON",
        type: "json",
        hint: "Optional JSON object merged into gateway agent params.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: 120,
      },
      {
        key: "waitTimeoutMs",
        label: "Wait timeout ms",
        type: "number",
        default: 120000,
      },
      {
        key: "autoPairOnFirstConnect",
        label: "Auto-pair on first connect",
        type: "toggle",
        default: true,
        hint: "When pairing is required, attempt gateway device pairing once and retry.",
      },
      {
        key: "paperclipApiUrl",
        label: "AoA API URL override",
        type: "text",
        hint: "Optional absolute AoA API URL advertised to OpenClaw.",
      },
    ],
  };
}
