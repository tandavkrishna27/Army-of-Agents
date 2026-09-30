import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  commanderViewerCollapsedKey,
  useCommanderViewerCollapsed,
} from "./useCommanderViewerCollapsed";

describe("useCommanderViewerCollapsed", () => {
  beforeEach(() => localStorage.clear());

  it("uses one global key (no conversation id)", () => {
    expect(commanderViewerCollapsedKey()).toBe("aoa:commander:viewer-collapsed");
  });

  it("defaults to true (collapsed) when nothing stored", () => {
    const { result } = renderHook(() => useCommanderViewerCollapsed());
    expect(result.current[0]).toBe(true);
  });

  it("reads 'false' from localStorage as expanded", () => {
    localStorage.setItem("aoa:commander:viewer-collapsed", "false");
    const { result } = renderHook(() => useCommanderViewerCollapsed());
    expect(result.current[0]).toBe(false);
  });

  it("persists to the global key when set", () => {
    const { result } = renderHook(() => useCommanderViewerCollapsed());
    act(() => result.current[1](false));
    expect(localStorage.getItem("aoa:commander:viewer-collapsed")).toBe("false");
    expect(result.current[0]).toBe(false);
  });
});
