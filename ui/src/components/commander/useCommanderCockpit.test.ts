import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { cockpitCollapsedKey, useCommanderCockpitCollapsed } from "./useCommanderCockpitCollapsed";
import { cockpitPrefsKey, useCommanderCockpitPrefs, DEFAULT_COCKPIT_PREFS } from "./useCommanderCockpitPrefs";

describe("useCommanderCockpitCollapsed", () => {
  beforeEach(() => localStorage.clear());
  it("key + default semi (collapsed=true)", () => {
    expect(cockpitCollapsedKey()).toBe("aoa:commander:cockpit-collapsed");
    const { result } = renderHook(() => useCommanderCockpitCollapsed());
    expect(result.current[0]).toBe(true);
  });
  it("persists", () => {
    const { result } = renderHook(() => useCommanderCockpitCollapsed());
    act(() => result.current[1](false));
    expect(localStorage.getItem("aoa:commander:cockpit-collapsed")).toBe("false");
  });
});

describe("useCommanderCockpitPrefs", () => {
  beforeEach(() => localStorage.clear());
  it("key + default (Running on)", () => {
    expect(cockpitPrefsKey()).toBe("aoa:commander:cockpit-prefs");
    const { result } = renderHook(() => useCommanderCockpitPrefs());
    expect(result.current[0].hidden).toEqual(DEFAULT_COCKPIT_PREFS.hidden);
  });
  it("toggling a card hidden persists", () => {
    const { result } = renderHook(() => useCommanderCockpitPrefs());
    act(() => result.current[1]({ ...result.current[0], hidden: ["running"] }));
    expect(JSON.parse(localStorage.getItem("aoa:commander:cockpit-prefs")!).hidden).toEqual(["running"]);
  });
});
