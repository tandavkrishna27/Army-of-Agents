import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UIAdapterModule } from "./types";
import {
  findUIAdapter,
  getUIAdapter,
  listUIAdapters,
  registerUIAdapter,
  syncExternalAdapters,
  unregisterUIAdapter,
} from "./registry";
import { SchemaConfigFields } from "./schema-config-fields";

const externalUIAdapter: UIAdapterModule = {
  type: "external_test",
  label: "External Test",
  parseStdoutLine: () => [],
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

describe("ui adapter registry", () => {
  beforeEach(() => {
    unregisterUIAdapter("external_test");
  });

  afterEach(() => {
    unregisterUIAdapter("external_test");
  });

  it("registers adapters for lookup and listing", () => {
    registerUIAdapter(externalUIAdapter);

    expect(findUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(getUIAdapter("external_test")).toBe(externalUIAdapter);
    expect(listUIAdapters().some((adapter) => adapter.type === "external_test")).toBe(true);
  });

  it("registers Paperclip parity adapters as built-ins", () => {
    expect(findUIAdapter("acpx_local")?.label).toMatch(/ACPX/i);
    expect(findUIAdapter("cursor_cloud")?.label).toMatch(/Cursor Cloud/i);
    expect(findUIAdapter("grok_local")?.label).toMatch(/Grok/i);
    expect(findUIAdapter("pi_local")?.label).toMatch(/Pi/i);
    expect(findUIAdapter("openclaw_gateway")?.label).toMatch(/OpenClaw Gateway/i);
  });

  it("returns a lazy schema bridge for unknown types", () => {
    const fallback = getUIAdapter("unknown_external");

    expect(fallback.type).toBe("unknown_external");
    expect(fallback.ConfigFields).toBe(SchemaConfigFields);
  });

  it("syncs non-builtin external adapters into the registry", () => {
    syncExternalAdapters([{ type: "external_test", label: "External Test" }]);

    expect(findUIAdapter("external_test")?.label).toBe("External Test");
    expect(getUIAdapter("external_test").ConfigFields).toBe(SchemaConfigFields);
  });
});
