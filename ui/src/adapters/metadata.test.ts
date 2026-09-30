import { describe, expect, it } from "vitest";
import type { UIAdapterModule } from "./types";
import {
  isEnabledAdapterType,
  isValidAdapterType,
  isVisualAdapterChoice,
  listAdapterOptions,
} from "./metadata";
import { setDisabledAdapterTypes } from "./disabled-store";

const externalAdapter: UIAdapterModule = {
  type: "external_test",
  label: "External Test",
  parseStdoutLine: () => [],
  ConfigFields: () => null,
  buildAdapterConfig: () => ({}),
};

describe("adapter metadata", () => {
  it("treats registered external adapters as enabled by default", () => {
    setDisabledAdapterTypes([]);
    expect(isEnabledAdapterType("external_test")).toBe(true);

    expect(listAdapterOptions((type) => type, [externalAdapter])).toEqual([
      {
        value: "external_test",
        label: "external_test",
        comingSoon: false,
        hidden: false,
        experimental: false,
      },
    ]);
  });

  it("keeps advanced built-in adapters enabled and selectable", () => {
    expect(isEnabledAdapterType("process")).toBe(true);
    expect(isEnabledAdapterType("http")).toBe(true);
    expect(isValidAdapterType("process")).toBe(true);
    expect(isValidAdapterType("http")).toBe(true);
    expect(isVisualAdapterChoice("process")).toBe(true);
    expect(isVisualAdapterChoice("http")).toBe(true);
  });

  it("keeps ACPX selectable as an experimental visual adapter", () => {
    expect(isEnabledAdapterType("acpx_local")).toBe(true);
    expect(isValidAdapterType("acpx_local")).toBe(true);
    expect(isVisualAdapterChoice("acpx_local")).toBe(true);
  });

  it("treats Grok and Pi as visible enabled product adapters", () => {
    expect(isEnabledAdapterType("grok_local")).toBe(true);
    expect(isEnabledAdapterType("pi_local")).toBe(true);
    expect(isEnabledAdapterType("cursor_cloud")).toBe(true);
    expect(isEnabledAdapterType("openclaw_gateway")).toBe(true);
    expect(isVisualAdapterChoice("grok_local")).toBe(true);
    expect(isVisualAdapterChoice("pi_local")).toBe(true);
    expect(isVisualAdapterChoice("cursor_cloud")).toBe(true);
    expect(isVisualAdapterChoice("openclaw_gateway")).toBe(true);
  });

  it("marks disabled adapters as hidden in option metadata", () => {
    setDisabledAdapterTypes(["external_test"]);
    expect(listAdapterOptions((type) => type, [externalAdapter])[0]?.hidden).toBe(true);
    setDisabledAdapterTypes([]);
  });
});
