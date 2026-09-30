import { describe, expect, it } from "vitest";
import type { AdapterConfigFieldSchema, AdapterConfigSchema } from "@armyofagents/adapter-utils";
import { buildSchemaAdapterConfig, fieldMatchesVisibleWhen } from "./schema-config-fields";

const sourceField: AdapterConfigFieldSchema = {
  key: "provider",
  label: "Provider",
  type: "select",
  options: [
    { label: "Claude", value: "claude" },
    { label: "Codex", value: "codex" },
  ],
};

const schema: AdapterConfigSchema = {
  version: 1,
  fields: [sourceField],
};

function targetWithVisibleWhen(visibleWhen: Record<string, unknown>): AdapterConfigFieldSchema {
  return {
    key: "model",
    label: "Model",
    type: "text",
    meta: { visibleWhen },
  };
}

describe("fieldMatchesVisibleWhen", () => {
  it("treats an empty values array as no match", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: [] });
    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(false);
  });

  it("matches non-empty string values", () => {
    const field = targetWithVisibleWhen({ key: "provider", values: ["claude"] });
    expect(fieldMatchesVisibleWhen(field, () => "claude", schema)).toBe(true);
    expect(fieldMatchesVisibleWhen(field, () => "codex", schema)).toBe(false);
  });
});

describe("buildSchemaAdapterConfig", () => {
  it("merges standard create values with adapter schema values", () => {
    expect(buildSchemaAdapterConfig({
      adapterType: "external",
      cwd: "/tmp/work",
      instructionsFilePath: "",
      promptTemplate: "",
      model: "model-a",
      thinkingEffort: "",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      maxTurnsPerRun: 1,
      heartbeatEnabled: false,
      intervalSec: 300,
      adapterSchemaValues: { provider: "claude" },
    })).toEqual({ cwd: "/tmp/work", model: "model-a", provider: "claude" });
  });
});
